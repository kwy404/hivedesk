// The domain step of a job, between the request and the plan (called by Hive._runJob):
//   1. classify the request (keywords, plus one short model turn when they are not sure) and tell the user why;
//   2. ask the clarifying question card when something that changes the plan is missing, and wait;
//   3. bring in the specialist of the domain and start from the domain's offline skeleton;
//   4. a security audit runs read only here and proposes fixes that wait for approval, no plan at all.
// Events: job.domain, crew.question, crew.answered, security.report (documented in docs/1.0/DOMAINS.md).
import { DOMAINS, domainOf, domainNotes } from './index.js';
import { detectDomain, reasonOf } from './classify.js';
import { buildQuestions, validateCard, normalizeAnswers, decideForMe, domainFromAnswers, decisionsLine, decisionsText, rewordMessages, applyReword, REWORD_SCHEMA } from './questions.js';
import { wantsSkeleton, seedSkeleton } from './skeletons.js';
import { auditProject } from './security/scan.js';
import { proposeFixes, redact } from './security/fixes.js';
import { tr } from './text.js';
import { SPECIALISTS } from '../workers.js';
import { modelFamily } from '../prompts/index.js';
import { languageName } from '../say.js';
import { extractJson } from '../../brain/schema.js';
import { unifiedDiff } from '../../tools/diff.js';

let questionSeq = 0;

/** A crew line in the job's language with its i18n key (the desktop can show it in another language later). */
function sayLine(hive, job, from, key, params, english, extra = {}) {
  const lang = job.lang || 'en';
  return hive.chat(from, tr(lang, key, params, english), undefined, 'general', job.id, { i18n: { key, params }, ...extra });
}

const fill = (s, params) => String(s).replace(/\{(\w+)\}/g, (_, k) => (params[k] ?? `{${k}}`));

/** The reason line: "Mobile app: an installable PWA ..., because the request mentions android." */
export function reasonText(lang, cls) {
  const d = domainOf(cls.domain);
  const r = reasonOf(cls);
  const label = tr(lang, `domains.label.${d.id}`, {}, d.label);
  const stack = tr(lang, `domains.stack.${d.id}`, {}, d.stack);
  const why = r.kind === 'words' ? tr(lang, 'domains.why.words', { words: r.words.map((w) => `"${w}"`).join(', ') }, fill('the request mentions {words}', { words: r.words.map((w) => `"${w}"`).join(', ') }))
    : r.kind === 'files' ? tr(lang, 'domains.why.files', { files: r.files.join(', ') }, fill('the project has {files}', { files: r.files.join(', ') }))
      : r.kind === 'model' ? tr(lang, 'domains.why.model', {}, 'that is how the model read the request')
        : r.kind === 'answer' ? tr(lang, 'domains.why.answer', {}, 'you picked it')
          : tr(lang, 'domains.why.default', {}, 'nothing points to another kind of project');
  return { label, stack, why, text: tr(lang, 'domains.reason', { label, stack, why }, fill('{label}: {stack}, because {why}.', { label, stack, why })) };
}

/** The question card as chat text: numbered options, the recommended one marked, the defaults line. */
export function cardText(lang, card) {
  const rec = tr(lang, 'domains.ask.recommended', {}, 'Recommended');
  const lines = [tr(lang, 'domains.ask.intro', {}, 'Before I plan, a few decisions that change the result:')];
  card.questions.forEach((q, qi) => {
    lines.push('', `${card.questions.length > 1 ? `${qi + 1}. ` : ''}${q.text}${q.multi ? ` (${tr(lang, 'domains.ask.multi', {}, 'pick one or more')})` : ''}`);
    q.options.forEach((o, i) => lines.push(`   ${i + 1}) ${o.label}${o.recommended ? ` [${rec}: ${o.reason}]` : ''}: ${o.description}`));
  });
  if (card.defaults) lines.push('', tr(lang, 'domains.ask.defaults', { defaults: card.defaults }, fill('I will use: {defaults}.', { defaults: card.defaults })));
  return lines.join('\n');
}

/** The words of the card's controls in the job's language (the desktop may not have the keys yet). */
export function cardLabels(lang, card) {
  return {
    recommended: tr(lang, 'domains.ask.recommended', {}, 'Recommended'),
    other: tr(lang, 'domains.ask.other', {}, 'Other'),
    otherHint: tr(lang, 'domains.ask.otherHint', {}, 'Write your own answer'),
    decide: tr(lang, 'domains.ask.decide', {}, 'Decide for me'),
    send: tr(lang, 'domains.ask.send', {}, 'Start with these'),
    multi: tr(lang, 'domains.ask.multi', {}, 'pick one or more'),
    keys: tr(lang, 'domains.ask.keys', {}, 'Keys 1 to 5 pick, Enter starts'),
    answered: tr(lang, 'domains.ask.answered', {}, 'Decided'),
    continue: tr(lang, 'domains.ask.continue', {}, 'Continue'),
    later: tr(lang, 'domains.ask.later', {}, 'Answer later'),
    sheet: tr(lang, 'domains.ask.sheet', { n: (card.questions || []).length }, `Mel has ${(card.questions || []).length} questions`),
    defaultsLine: card.defaults ? tr(lang, 'domains.ask.defaults', { defaults: card.defaults }, fill('I will use: {defaults}.', { defaults: card.defaults })) : ''
  };
}

/** The crew of a job: the setup's choice (settings.crew), hired workers, Mel, and only the specialist this job needs. */
export function jobCrew(state, specialist) {
  const active = state.settings.crew;
  return state.crew.filter((w) => {
    if (w.specialist) return w.id === specialist;
    return w.id === 'mel' || !w.builtin || !Array.isArray(active) || active.includes(w.id);
  });
}

function hireSpecialist(hive, id) {
  if (!id || hive.state.crew.some((w) => w.id === id)) return;
  const spec = SPECIALISTS.find((w) => w.id === id);
  if (spec) hive.bus.emit('crew.hired', { worker: { ...spec } });
}

/** Waits for crew.answer (or decide for me, or the demo's auto answer, or a cancel). */
function waitAnswer(hive, run, card) {
  return new Promise((resolve, reject) => {
    hive.questions.set(card.id, { card, run, resolve });
    if (hive.autoApproveBriefMs) {
      const t = setTimeout(() => resolve({ answers: decideForMe(card), decided: true, by: 'auto' }), hive.autoApproveBriefMs);
      t.unref?.();
    }
    run.ctrl.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }).finally(() => hive.questions.delete(card.id));
}

/**
 * The command crew.answer: { questionId, answers?: { [questionId]: { options: string[], other?: string } }, decide?: boolean }.
 * Partial answers are filled with the recommended options only when decide is true.
 */
export function answerQuestion(hive, questionId, { answers = {}, decide = false } = {}) {
  const open = hive.questions.get(String(questionId || ''));
  if (!open) throw Object.assign(new Error('that question is no longer open'), { code: 'conflict' });
  const merged = decide ? { ...decideForMe(open.card), ...Object.fromEntries(Object.entries(answers || {}).filter(([, v]) => v && (v.options?.length || v.other || typeof v === 'string' || Array.isArray(v)))) } : answers;
  const r = normalizeAnswers(open.card, merged);
  if (r.problems.length) throw Object.assign(new Error(`the answers are not complete: ${r.problems.join('; ')}`), { code: 'bad_request' });
  open.resolve({ answers: r.answers, decided: !!decide && !Object.keys(answers || {}).length, by: 'user' });
  return { answers: r.answers };
}

/** The open question cards (for a desktop that reconnects, and for the voice orb). */
export function openQuestions(hive) {
  return [...hive.questions.values()].map((q) => q.card);
}

async function ask(hive, job, run, cls) {
  const lang = job.lang || 'en';
  const memories = run.memories || [];
  let card = buildQuestions({ text: job.request, cls, lang, memories });
  if (!card?.questions.length) return { cls, card };
  // A bigger model rewords the curated questions for this request; the guards keep the rules.
  if (hive.scheduler.hasBrain && modelFamily(hive.state.brain) !== 'small') {
    try {
      const r = await hive.scheduler.turn({ workerId: 'mel', jobId: job.id, signal: run.ctrl.signal, messages: rewordMessages(card, job.request, languageName(lang)), options: { schema: REWORD_SCHEMA, maxTokens: 700, temperature: 0.3 } });
      card = applyReword(card, r.json ?? extractJson(r.text), job.request);
    } catch { /* the curated wording stays */ }
  }
  if (validateCard(card, job.request).length) {
    // A card that breaks the rules is never shown: the crew goes on with the defaults.
    return { cls, card: null };
  }
  card = { ...card, id: `q_${job.id.slice(2)}_${++questionSeq}`, jobId: job.id, lang };
  card.labels = cardLabels(lang, card);
  hive.bus.emit('crew.question', { id: card.id, questions: card.questions, defaults: card.defaults, domain: card.domain, subject: card.subject, inferred: card.inferred, lang, labels: card.labels }, { jobId: job.id });
  hive.chat('mel', cardText(lang, card), undefined, 'general', job.id, { i18n: { key: 'domains.ask.card', params: {} }, question: card.id });
  // The chat line carries the readable card for the CLI and the voice orb; the desktop draws the card.
  const reply = await waitAnswer(hive, run, card).catch(() => null);
  if (!reply) return { cls, card, cancelled: true };
  const summary = decisionsLine(card, reply.answers);
  hive.bus.emit('crew.answered', { id: card.id, answers: reply.answers, decided: reply.decided, by: reply.by, summary }, { jobId: job.id });
  sayLine(hive, job, 'mel', 'domains.decided', { summary }, fill('Decided: {summary}. Starting the work.', { summary }));
  job.decisions = decisionsText(card, reply.answers);
  const chosen = domainFromAnswers(card, reply.answers);
  return { cls: chosen ? { ...cls, domain: chosen, confidence: 'high', source: 'answer', words: [], files: [] } : cls, card, answers: reply.answers };
}

/**
 * The domain step of a job. Returns what the rest of _runJob needs.
 * @returns {Promise<{ domain: string, specialist: string | null, seeded: string[], notes: string[], done?: boolean, cancelled?: boolean }>}
 */
export async function startDomain(hive, job, run) {
  const signal = run.ctrl.signal;
  const lang = job.lang || 'en';
  const files = hive.toolbox.ws.list().map((f) => f.path);
  let manifest = null;
  if (files.includes('manifest.json')) { try { manifest = JSON.parse(hive.toolbox.ws.read('manifest.json')); } catch { manifest = null; } }
  const askModel = hive.scheduler.hasBrain
    ? (messages, schema) => hive.scheduler.turn({ workerId: 'mel', jobId: job.id, signal, messages, options: { schema, maxTokens: 40, temperature: 0 } }).then((r) => r.json ?? extractJson(r.text))
    : undefined;
  let cls = await detectDomain({ text: job.request, files, manifest, ask: askModel });
  if (signal.aborted) return { domain: cls.domain, specialist: null, seeded: [], notes: [], cancelled: true };
  // A job started on purpose (the top bar) with a question still builds, as before: on the web stack.
  if (cls.domain === 'chat') cls = { ...cls, domain: 'web', confidence: 'low', words: [], files: [], source: 'keywords' };
  const asks = job.refine !== false && !job.cityTaskId && hive.state.settings.questions !== false;
  if (asks) {
    const r = await ask(hive, job, run, cls);
    if (r.cancelled || signal.aborted) return { domain: cls.domain, specialist: null, seeded: [], notes: [], cancelled: true };
    // The user answered questions of this domain: that settles it.
    cls = r.answers && r.cls.source !== 'answer' ? { ...r.cls, confidence: 'high' } : r.cls;
  }
  // Not sure and not asked (the brief step is off): the website flow, as before.
  if (cls.confidence === 'low' && cls.source !== 'answer') cls = { ...cls, domain: 'web' };
  const d = domainOf(cls.domain);
  const reason = reasonText(lang, cls);
  const why = reasonOf(cls);
  const honest = d.honest ? tr(lang, `domains.honest.${d.id}`, {}, d.honest) : '';
  hive.bus.emit('job.domain', {
    domain: d.id, label: reason.label, stack: reason.stack, confidence: cls.confidence, source: cls.source || 'keywords',
    reason: why, text: reason.text, specialist: d.specialist, ...(honest ? { honest } : {})
  }, { jobId: job.id });
  // A website is the default and says nothing new; every other kind is announced with its reason.
  if (d.id !== 'web') sayLine(hive, job, 'mel', 'domains.reason', { label: reason.label, stack: reason.stack, why: reason.why }, reason.text);
  hireSpecialist(hive, d.specialist);
  if (d.id === 'security') {
    await runAudit(hive, job, run);
    return { domain: d.id, specialist: d.specialist, seeded: [], notes: [], done: true };
  }
  let seeded = [];
  if (wantsSkeleton(d.id, files)) {
    seeded = seedSkeleton(hive.toolbox, d.id, { jobId: job.id, workerId: d.specialist || 'dev' });
    if (seeded.length) sayLine(hive, job, d.specialist || 'dev', 'domains.skeleton', { label: reason.label, count: seeded.length }, fill('I started from the offline {label} skeleton ({count} files, tests included); now the crew shapes it for your request.', { label: reason.label.toLowerCase(), count: seeded.length }));
  }
  if (honest) sayLine(hive, job, d.specialist || 'mel', `domains.honest.${d.id}`, {}, honest);
  const notes = domainNotes(d.id, { skeleton: seeded });
  if (job.decisions) notes.push(job.decisions);
  return { domain: d.id, specialist: d.specialist, seeded, notes };
}

/** The finding as it goes into events and chat: no secret ever in full. */
function publicFinding(f) {
  return { id: f.id, severity: f.severity, category: f.category, title: f.title, file: f.file, line: f.line, snippet: redact(f.snippet || ''), fix: f.fix, ...(f.advisory ? { advisory: f.advisory, basis: f.basis } : {}) };
}

/**
 * Security mode: the audit is read only; each suggested fix waits for the user's approval (strict: even
 * with approval mode off), and only approved fixes are written.
 */
export async function runAudit(hive, job, run) {
  const lang = job.lang || 'en';
  const ev = { jobId: job.id };
  const ws = hive.toolbox.ws;
  if (!ws.list().length) {
    sayLine(hive, job, 'security', 'domains.audit.empty', {}, 'There are no files in this project to audit yet. Open the project folder first.');
    hive.bus.emit('job.done', { summary: 'nothing to audit', files: [] }, ev);
    return;
  }
  hive.bus.emit('worker.status', { workerId: 'security', status: 'working', detail: 'auditing the project' }, ev);
  const audit = auditProject({ root: ws.root });
  const findings = audit.findings.map(publicFinding);
  hive.bus.emit('security.report', { scanned: audit.scanned, counts: audit.counts, dependencies: audit.dependencies, advisoriesUpdated: audit.advisoriesUpdated, findings }, ev);
  const head = tr(lang, 'domains.audit.summary', { files: audit.scanned, critical: audit.counts.critical, high: audit.counts.high, medium: audit.counts.medium, low: audit.counts.low },
    fill('Security audit (read only): {files} files read. {critical} critical, {high} high, {medium} medium, {low} low.', { files: audit.scanned, critical: audit.counts.critical, high: audit.counts.high, medium: audit.counts.medium, low: audit.counts.low }));
  const lines = findings.slice(0, 15).map((f, i) => `${i + 1}. [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''} ${f.title}${f.snippet && f.category !== 'code' ? ` (${f.snippet})` : ''}\n   ${f.fix}`);
  if (findings.length > 15) lines.push(tr(lang, 'domains.audit.more', { count: findings.length - 15 }, `... and ${findings.length - 15} more in the report.`));
  const deps = audit.dependencies ? tr(lang, 'domains.audit.deps', { count: audit.dependencies, date: audit.advisoriesUpdated || '' }, `Dependencies were checked against the offline advisory list of ${audit.advisoriesUpdated}; when you are online, also run your package manager's audit.`) : '';
  hive.chat('security', [head, ...lines, deps].filter(Boolean).join('\n'), undefined, 'general', job.id, { i18n: { key: 'domains.audit.report', params: { files: audit.scanned } } });
  const read = (p) => { try { return ws.read(p); } catch { return null; } };
  const fixes = proposeFixes(audit.findings, read);
  let applied = 0;
  let declined = 0;
  if (fixes.length) sayLine(hive, job, 'security', 'domains.audit.fixes', { count: fixes.length }, fill('I can fix {count} of these with small patches. Each one waits for your approval; nothing is written without it.', { count: fixes.length }));
  for (const fix of fixes) {
    if (run.ctrl.signal.aborted) return;
    const before = read(fix.path);
    const after = fix.create ? fix.content : before == null ? null : before.replace(fix.search, () => fix.replace);
    if (after == null) continue;
    const diff = fix.secret ? undefined : unifiedDiff(fix.path, fix.create ? null : before, after);
    let decision;
    try {
      decision = await hive.approvals.request({
        jobId: job.id, workerId: 'security', tool: fix.create ? 'write_file' : 'edit_file',
        args: fix.create ? { path: fix.path, content: '(new file)' } : { path: fix.path, search: fix.secret ? '(a line with a secret)' : redact(fix.search), replace: redact(fix.replace) },
        summary: fix.summary, ...(diff ? { diff } : {}), strict: true
      }, run.ctrl.signal);
    } catch {
      return;
    }
    if (!decision.approved) { declined++; continue; }
    try {
      const r = fix.create ? ws.write(fix.path, fix.content) : ws.edit(fix.path, fix.search, fix.replace);
      // A secret fix is logged without its diff or content.
      if (fix.secret) hive.bus.emit('file.changed', { path: fix.path, op: 'modify', bytes: Buffer.byteLength(r.after), workerId: 'security', redacted: true }, ev);
      else hive.toolbox.fileEvent(fix.path, r.before, r.after, { jobId: job.id, workerId: 'security' });
      applied++;
    } catch (err) {
      sayLine(hive, job, 'security', 'domains.audit.fixFailed', { file: fix.path, error: String(err.message || err).slice(0, 160) }, `Could not apply the fix to ${fix.path}: ${String(err.message || err).slice(0, 160)}`);
    }
  }
  hive.bus.emit('worker.status', { workerId: 'security', status: 'idle' }, ev);
  const summary = tr(lang, 'domains.audit.done', { findings: findings.length, applied, declined }, fill('Audit finished: {findings} findings, {applied} fixes applied, {declined} declined.', { findings: findings.length, applied, declined }));
  sayLine(hive, job, 'security', 'domains.audit.done', { findings: findings.length, applied, declined }, summary);
  hive.bus.emit('job.done', { summary, files: [] }, ev);
}

export { DOMAINS };
