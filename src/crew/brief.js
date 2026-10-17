// Mel's prompt refiner (request to a structured brief) and the end of job report with an improved prompt.

const S = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const list = (description, maxItems = 8, minItems = 0) => ({ type: 'array', ...(minItems ? { minItems } : {}), maxItems, items: { type: 'string' }, description });

export const BRIEF_SCHEMA = S({
  goal: { type: 'string', description: 'one sentence: what the user wants and why' },
  build: list('files and features to build, one per item', 8, 1),
  constraints: list('stack, no network, style, sizes', 6),
  acceptance: list('a checklist: each item can be checked by reading or running the files', 8, 2),
  questions: { type: 'array', maxItems: 3, items: S({ question: { type: 'string' }, options: { type: 'array', maxItems: 4, items: { type: 'string' } }, answer: { type: 'string', description: 'the default, one of the options' } }) }
});

/** A request too short to build from: the refiner expands it and asks a few multiple choice questions. */
export function isVague(request) {
  const words = String(request || '').trim().split(/\s+/).filter(Boolean);
  return words.length < 7;
}

export function briefMessages(request, files = []) {
  const vague = isVague(request);
  return [
    {
      role: 'system',
      content: [
        'You are Mel, the foreman of a small crew that builds files on this computer with a local model.',
        'Rewrite the user request into a clear brief for the crew. Keep the user intent; do not add big features.',
        '- goal: one sentence.',
        '- build: the files and features, concrete (for example "index.html: hero, menu, opening hours").',
        '- constraints: plain HTML, CSS and JavaScript unless the user asked for something else; no network access; no build step; keep it small.',
        '- acceptance: 3 to 6 checks that can be verified by reading or running the files.',
        '- questions: at most 3 things the request leaves open, each with 2 to 4 short options and the default you will use (one of the options).',
        ...(vague ? [
          'The request is short and vague. Expand it into a concrete small project: pick a sensible default app type',
          '(for example a to-do list for "an app", a one page site for "a site"), list its features, and ask exactly 3',
          'multiple choice questions: the type of app, the visual style, and where the data is saved (for example',
          '"only in this browser (localStorage)", "a JSON file", "nowhere"), each with the default already chosen.'
        ] : []),
        'Answer with one JSON object.'
      ].join('\n')
    },
    { role: 'user', content: `Request: ${request}${files.length ? `\nFiles already in the workspace: ${files.slice(0, 30).join(', ')}` : ''}` }
  ];
}

const clean = (a, max = 8) => (Array.isArray(a) ? a.map((x) => String(x).trim()).filter(Boolean).slice(0, max) : []);

export function normalizeBrief(raw, request) {
  return {
    goal: String(raw?.goal || request).trim().slice(0, 400),
    build: clean(raw?.build),
    constraints: clean(raw?.constraints, 6),
    acceptance: clean(raw?.acceptance),
    questions: (Array.isArray(raw?.questions) ? raw.questions : []).slice(0, 3)
      .map((q) => {
        const options = clean(q?.options, 4);
        const answer = String(q?.answer || '').trim() || options[0] || '';
        return { question: String(q?.question || '').trim(), options: options.length && !options.includes(answer) && answer ? [answer, ...options].slice(0, 4) : options, answer };
      }).filter((q) => q.question)
  };
}

/** The brief as Markdown: what the planner and the workers read, and what the user edits. */
export function briefText(brief) {
  const out = [`Goal: ${brief.goal}`];
  const section = (title, items) => { if (items.length) out.push('', `${title}:`, ...items); };
  section('Build', brief.build.map((x) => `- ${x}`));
  section('Constraints', brief.constraints.map((x) => `- ${x}`));
  section('Acceptance criteria', brief.acceptance.map((x) => `- [ ] ${x}`));
  section('Open questions (with the answers used)', brief.questions.map((q) => `- ${q.question} Answer: ${q.answer || 'none'}${q.options?.length > 1 ? ` (options: ${q.options.join(', ')})` : ''}`));
  return out.join('\n');
}

/** Applies the answers the user picked (by question index) and rebuilds the text. */
export function answerBrief(brief, answers = []) {
  const next = { ...brief, questions: brief.questions.map((q, i) => {
    const a = Array.isArray(answers) ? answers[i] : answers?.[i];
    return typeof a === 'string' && a.trim() ? { ...q, answer: a.trim().slice(0, 200) } : q;
  }) };
  next.text = briefText(next);
  return next;
}

/** Acceptance criteria from a brief text (the user may have edited it). */
export function acceptanceFrom(text) {
  return String(text || '').split('\n').map((l) => l.match(/^\s*-\s*\[[ xX]?\]\s*(.+)$/)).filter(Boolean).map((m) => m[1].trim());
}

export const REPORT_SCHEMA = S({
  improvedPrompt: { type: 'string', description: 'a self contained prompt that would rebuild or extend this result next time' },
  nextPrompts: { type: 'array', minItems: 2, maxItems: 3, items: { type: 'string' } }
});

export function reportMessages({ request, brief, report }) {
  return [
    {
      role: 'system',
      content: [
        'You are Mel. The job is over. Write:',
        '- improvedPrompt: the request itself, written so that it would produce this result in one go next time.',
        '  Write it as an instruction that starts with a verb, for example "Build a one page site for ... in index.html and style.css: ...".',
        '  Name the files, the features, the constraints and the acceptance checks. Do not describe the prompt; write it.',
        '- nextPrompts: 2 or 3 short follow up requests that extend the result (for example "add a dark mode").',
        'Answer with one JSON object.'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        `Original request: ${request}`,
        brief ? `Approved brief:\n${brief}` : '',
        `Files: ${report.files.map((f) => f.path).join(', ') || 'none'}`,
        `Checks: ${report.checks.map((c) => `${c.name}: ${c.ok ? 'ok' : 'failed'}`).join('; ') || 'none'}`,
        report.missing.length ? `Still missing: ${report.missing.join('; ')}` : 'Nothing reported missing.'
      ].filter(Boolean).join('\n\n')
    }
  ];
}

/** The deterministic part of the report, from the event log of one job. */
export function buildReport(events, jobId, state) {
  const job = state.jobs.find((j) => j.id === jobId);
  const files = new Map();
  const checks = [];
  let qaLast = null;
  let turns = 0;
  let first = null;
  let last = null;
  for (const e of events) {
    if (e.jobId !== jobId) continue;
    if (!first) first = e.ts;
    last = e.ts;
    const d = e.data || {};
    if (e.type === 'file.changed') {
      const f = files.get(d.path) || { path: d.path, op: d.op, added: 0, removed: 0 };
      if (f.op === 'create' && d.op === 'modify') f.op = 'create';
      else f.op = d.op;
      f.added += d.added || 0;
      f.removed += d.removed || 0;
      files.set(d.path, f);
    } else if (e.type === 'run.finished') {
      checks.push({ name: d.command, ok: d.exitCode === 0 && !d.timedOut, detail: d.timedOut ? 'timed out' : `exit code ${d.exitCode}` });
    } else if (e.type === 'qa.report') {
      qaLast = d;
      checks.push({ name: 'QA review and static checks', ok: !!d.passed, detail: d.passed ? 'passed' : `${d.issues.length} issues` });
    } else if (e.type === 'turn.ended') {
      turns++;
    }
  }
  const tasks = (job?.taskIds || []).map((id) => state.tasks[id]).filter(Boolean);
  const missing = [];
  if (qaLast && !qaLast.passed) missing.push(...qaLast.issues);
  for (const t of tasks) if (t.status === 'failed' || t.status === 'blocked') missing.push(`Task "${t.title}" ${t.status === 'failed' ? 'failed' : 'did not run'}${t.note ? `: ${t.note}` : ''}`);
  const done = tasks.filter((t) => t.status === 'done' && t.kind !== 'qa' && t.kind !== 'fix');
  const built = done.length ? done.map((t) => t.note && t.note !== 'done' ? `${t.title}: ${t.note}` : t.title).join('; ') : 'Nothing was finished.';
  return {
    built: built.slice(0, 1200),
    files: [...files.values()],
    checks: checks.slice(-12),
    missing: missing.slice(0, 12),
    turns,
    seconds: first && last ? Math.round((Date.parse(last) - Date.parse(first)) / 1000) : 0
  };
}

/** When the model cannot write the improved prompt: a plain one from the brief and the files. */
export function fallbackPrompt({ request, brief, report }) {
  const files = report.files.filter((f) => f.op !== 'delete').map((f) => f.path);
  const improvedPrompt = [
    brief || `Goal: ${request}`,
    files.length ? `\nFiles to create: ${files.join(', ')}.` : '',
    '\nWrite complete files, no placeholders. Plain HTML, CSS and JavaScript, no network, no build step.'
  ].join('');
  const nextPrompts = [
    files.some((f) => /\.css$/.test(f)) ? 'Add a dark mode that follows the system setting.' : 'Add simple, clean styles in style.css.',
    files.some((f) => /\.m?js$/.test(f)) ? `Add a small test file that checks the logic in ${files.find((f) => /\.m?js$/.test(f))}.` : 'Make the page work well on phones.',
    'Write a short README.md that explains the files and how to open them.'
  ];
  return { improvedPrompt, nextPrompts };
}
