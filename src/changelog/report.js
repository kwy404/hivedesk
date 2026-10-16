// The job report: what a job asked for, who did what, which files changed and what QA said.
// Built from the event log only, so it works for any past job too. Shared by the changelog
// and the GitHub integration (commit message and pull request body).

/**
 * @param {any[]} events the full event log
 * @param {string} [jobId] defaults to the last job that finished
 * @param {{ crew?: any[] }} [state]
 */
export function jobReport(events, jobId, state = {}) {
  if (!jobId) {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'job.done' && events[i].jobId) { jobId = events[i].jobId; break; }
    }
  }
  if (!jobId) return null;
  const names = new Map((state.crew || []).map((w) => [w.id, w.name]));
  const r = { jobId, request: '', status: 'running', summary: '', createdAt: null, finishedAt: null, tasks: [], files: [], workers: [], qa: { passed: null, issues: [] }, changelog: null };
  const tasks = new Map();
  const files = new Map();
  const workers = new Set();
  let found = false;
  for (const e of events) {
    if (e.jobId !== jobId) continue;
    found = true;
    const d = e.data || {};
    switch (e.type) {
      case 'job.created':
        r.request = d.job?.request || '';
        r.createdAt = d.job?.createdAt || e.ts;
        break;
      case 'job.planned':
        for (const t of d.tasks || []) tasks.set(t.id, { id: t.id, title: t.title, kind: t.kind || 'build', assignee: t.assignee, status: t.status || 'pending' });
        break;
      case 'task.added':
        if (d.task) tasks.set(d.task.id, { id: d.task.id, title: d.task.title, kind: d.task.kind || 'build', assignee: d.task.assignee, status: d.task.status || 'pending' });
        break;
      case 'task.updated': {
        const t = d.task && tasks.get(d.task.id);
        if (t) Object.assign(t, pick(d.task, ['title', 'kind', 'assignee', 'status']));
        break;
      }
      case 'task.status': {
        const t = tasks.get(d.taskId);
        if (t) t.status = d.status;
        break;
      }
      case 'file.changed': {
        if (!d.path) break;
        const f = files.get(d.path) || { path: d.path, op: d.op, added: 0, removed: 0, by: [] };
        if (f.op === 'create' && d.op === 'modify') { /* still a new file */ } else f.op = d.op;
        f.added += d.added || 0;
        f.removed += d.removed || 0;
        const who = d.workerId || 'user';
        if (!f.by.includes(who)) f.by.push(who);
        workers.add(who);
        files.set(d.path, f);
        break;
      }
      case 'qa.report':
        r.qa = { passed: !!d.passed, issues: Array.isArray(d.issues) ? d.issues.slice(0, 20) : [] };
        break;
      case 'job.done':
        r.status = 'done';
        r.summary = d.summary || '';
        r.finishedAt = e.ts;
        break;
      case 'job.failed':
        r.status = 'failed';
        r.summary = typeof d.error === 'string' ? d.error : d.error?.message || 'failed';
        r.finishedAt = e.ts;
        break;
      case 'job.cancelled':
        r.status = 'cancelled';
        r.finishedAt = e.ts;
        break;
      case 'job.resumed':
        r.status = 'running';
        break;
      case 'changelog.written':
        r.changelog = { markdown: d.markdown || '', version: d.version || null };
        break;
      default:
        break;
    }
    if (d.workerId && e.type === 'turn.started') workers.add(d.workerId);
  }
  if (!found) return null;
  r.tasks = [...tasks.values()].map((t) => ({ ...t, assigneeName: names.get(t.assignee) || t.assignee }));
  r.files = [...files.values()].sort((a, b) => a.path.localeCompare(b.path)).map((f) => ({ ...f, byNames: f.by.map((w) => names.get(w) || (w === 'user' ? 'you' : w)) }));
  r.workers = [...workers].map((w) => names.get(w) || w);
  return r;
}

function pick(o, keys) {
  const out = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

/** Plain text of a report, used as the model prompt. */
export function reportText(r) {
  if (!r) return '';
  const lines = [`Request: ${r.request}`, `Result: ${r.status}${r.summary ? `. ${r.summary}` : ''}`];
  if (r.tasks.length) {
    lines.push('Tasks:');
    for (const t of r.tasks) lines.push(`- [${t.status}] (${t.kind}) ${t.title} by ${t.assigneeName}`);
  }
  if (r.files.length) {
    lines.push('Files:');
    for (const f of r.files) lines.push(`- ${f.path} (${f.op}, +${f.added} -${f.removed})`);
  }
  if (r.qa.passed !== null) lines.push(r.qa.passed ? 'QA: passed' : `QA: ${r.qa.issues.length} open issues: ${r.qa.issues.join('; ')}`);
  return lines.join('\n');
}

const tidy = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** Cuts at a word boundary, without a trailing period. */
export function shorten(s, max = 72) {
  let t = tidy(s).replace(/[.\s]+$/, '');
  if (t.length <= max) return t;
  t = t.slice(0, max + 1);
  const cut = t.lastIndexOf(' ');
  return (cut > max * 0.5 ? t.slice(0, cut) : t.slice(0, max)).replace(/[,;:\s]+$/, '');
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** The commit subject from a request: one line, capitalized, at most 72 characters. */
export function commitSubject(r) {
  const req = tidy(r?.request) || 'Update the workspace';
  return cap(shorten(req, 72));
}

/** The commit message written from the job report without a model. */
export function templateCommitMessage(r) {
  if (!r) return 'Update the workspace';
  const body = [];
  if (r.summary) body.push(r.summary);
  const done = r.tasks.filter((t) => t.status === 'done' && t.kind !== 'qa');
  if (done.length) {
    body.push('');
    for (const t of done.slice(0, 15)) body.push(`- ${tidy(t.title)} (${t.assigneeName})`);
  }
  if (r.files.length) {
    body.push('', `Files: ${r.files.slice(0, 20).map((f) => f.path).join(', ')}${r.files.length > 20 ? `, and ${r.files.length - 20} more` : ''}`);
  }
  if (r.qa.passed === true) body.push('QA passed.');
  else if (r.qa.passed === false) body.push(`QA still reports ${r.qa.issues.length} issue${r.qa.issues.length === 1 ? '' : 's'}.`);
  return `${commitSubject(r)}\n${body.length ? `\n${wrap(body.join('\n'))}` : ''}`.trimEnd();
}

/** Wraps lines at 72 characters (list items keep their indent). */
export function wrap(text, width = 72) {
  return String(text).split('\n').map((line) => {
    if (line.length <= width) return line;
    const indent = /^- /.test(line) ? '  ' : '';
    const words = line.split(' ');
    const out = [];
    let cur = '';
    for (const w of words) {
      if (cur && (cur + ' ' + w).length > width) { out.push(cur); cur = indent + w; } else cur = cur ? `${cur} ${w}` : w;
    }
    if (cur) out.push(cur);
    return out.join('\n');
  }).join('\n');
}

/** The schema Mel answers with when a model writes the commit message. */
export const COMMIT_SCHEMA = {
  type: 'object',
  properties: {
    subject: { type: 'string', maxLength: 72 },
    body: { type: 'string', maxLength: 1500 }
  },
  required: ['subject', 'body']
};

export function commitPrompt(r) {
  return [
    { role: 'system', content: 'You are Mel, the foreman of a small software crew. Write a git commit message for the work below. Subject: imperative mood, at most 72 characters, no trailing period. Body: two to six short lines that say what changed and why, plain text, no markdown headings. Use only facts from the report.' },
    { role: 'user', content: reportText(r) }
  ];
}

export function messageFromModel(json) {
  const subject = shorten(json?.subject || '', 72);
  if (!subject) return null;
  const body = String(json?.body || '').trim();
  return `${cap(subject)}${body ? `\n\n${wrap(body)}` : ''}`;
}

const md = (s) => String(s ?? '').replace(/([\\`*_[\]<>|])/g, '\\$1');

/** The pull request body: the job report, plus the changelog entry when there is one. */
export function prBody(r, { changelog } = {}) {
  if (!r) return 'Changes from the hivedesk crew.';
  const out = [];
  out.push('## Request', '', `> ${md(tidy(r.request))}`, '');
  if (r.summary) out.push('## Result', '', md(r.summary), '');
  const tasks = r.tasks.filter((t) => t.kind !== 'qa' || t.status !== 'skipped');
  if (tasks.length) {
    out.push('## What the crew did', '');
    for (const t of tasks) out.push(`- [${t.status === 'done' ? 'x' : ' '}] ${md(tidy(t.title))} (${md(t.assigneeName)})${t.status === 'done' ? '' : `: ${t.status}`}`);
    out.push('');
  }
  if (r.files.length) {
    out.push('## Files', '', '| File | Change | Lines | By |', '| --- | --- | --- | --- |');
    for (const f of r.files.slice(0, 60)) out.push(`| \`${String(f.path).replace(/[`|]/g, '')}\` | ${f.op} | +${f.added} -${f.removed} | ${md(f.byNames.join(', '))} |`);
    if (r.files.length > 60) out.push(`| and ${r.files.length - 60} more | | | |`);
    out.push('');
  }
  out.push('## Checks', '');
  if (r.qa.passed === true) out.push('QA passed.');
  else if (r.qa.passed === false) { out.push(`QA still reports ${r.qa.issues.length} issue${r.qa.issues.length === 1 ? '' : 's'}:`, ''); for (const i of r.qa.issues) out.push(`- ${md(i)}`); }
  else out.push('QA did not run for this job.');
  out.push('');
  const cl = changelog ?? r.changelog?.markdown;
  if (cl && cl.trim()) out.push('## Changelog', '', cl.trim(), '');
  out.push('---', '', 'Planned by Mel and built by the hivedesk crew with a local model. Every change was reviewed and approved in hivedesk before it was pushed.');
  return out.join('\n');
}
