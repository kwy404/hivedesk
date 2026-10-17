// What happens inside a room: the prompts and checks of the Design, Review and Test hops.
// Work rooms (Code, Library, Ops) run a crew job with one task; see City._work in index.js.
import { checkWorkspace } from '../tools/check.js';

export const DESIGN_SCHEMA = {
  type: 'object',
  properties: {
    spec: { type: 'string', description: 'a short spec for the builder: what to change, in which files, how it should look' },
    criteria: { type: 'array', items: { type: 'string' }, maxItems: 6, description: 'checkable acceptance criteria' }
  },
  required: ['spec', 'criteria'],
  additionalProperties: false
};

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    approved: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'string' }, maxItems: 6, description: 'each a concrete problem and its fix; empty when approved' }
  },
  required: ['approved', 'issues'],
  additionalProperties: false
};

const cut = (s, n) => (s.length > n ? `${s.slice(0, n)}\n[cut]` : s);

export function designMessages(agent, task, files = []) {
  return [
    { role: 'system', content: `You are ${agent.name}, ${agent.role}, working in the Design room of a small crew. You do not write files here: you write a short, concrete spec that a developer can build from, and acceptance criteria that a tester can check. Answer with JSON only.` },
    {
      role: 'user',
      content: [
        `Task: ${task.title}`,
        task.detail ? `Detail: ${task.detail}` : '',
        task.criteria?.length ? `Criteria so far:\n- ${task.criteria.join('\n- ')}` : '',
        files.length ? `Files in the workspace: ${files.join(', ')}` : 'The workspace is empty.',
        'Write the spec (at most 12 lines) and up to 6 criteria.'
      ].filter(Boolean).join('\n\n')
    }
  ];
}

/** diffs: [{ path, diff }] from the file.changed events of the work hop. */
export function reviewMessages(agent, task, diffs, checks) {
  let budget = 9000;
  const shown = [];
  for (const d of diffs) {
    if (budget <= 0) break;
    const text = cut(String(d.diff || ''), Math.min(4000, budget));
    budget -= text.length;
    shown.push(`--- ${d.path}\n${text}`);
  }
  return [
    { role: 'system', content: `You are ${agent.name}, ${agent.role}, in the Review room. A teammate changed files for a task. Read the diff and check it against the task and its criteria. Approve only when the change does what the task asks and nothing is broken. Each issue is one concrete problem with its fix. Answer with JSON only.` },
    {
      role: 'user',
      content: [
        `Task: ${task.title}`,
        task.detail ? `Detail: ${task.detail}` : '',
        task.spec ? `Spec from Design:\n${task.spec}` : '',
        task.criteria?.length ? `Criteria:\n- ${task.criteria.join('\n- ')}` : '',
        `Automatic checks on the changed files: ${checks.issues.length ? `issues:\n- ${checks.issues.join('\n- ')}` : 'all passed'}`,
        shown.length ? `The diff:\n${shown.join('\n')}` : 'No file changed in this task.'
      ].filter(Boolean).join('\n\n')
    }
  ];
}

/**
 * The static checks of the changed files.
 * links: false ignores "links to" issues (another task may not have written that file yet).
 */
export function checkFiles(ws, files, { links = true } = {}) {
  const exist = files.filter((f) => { try { return ws.exists(f); } catch { return false; } });
  if (!exist.length) return { passed: true, issues: [], checked: [] };
  const r = checkWorkspace(ws, exist);
  const issues = links ? r.issues : r.issues.filter((i) => !/ links to /.test(i));
  return { passed: issues.length === 0, issues: issues.slice(0, 12), checked: exist };
}

/** Normalizes a model's review answer; the checks win over an approval. */
export function readReview(json, checks) {
  const issues = Array.isArray(json?.issues) ? json.issues.map((x) => String(x).trim()).filter(Boolean).slice(0, 6) : [];
  let approved = json?.approved === true && issues.length === 0;
  for (const i of checks.issues) if (!issues.includes(i)) issues.push(i);
  if (checks.issues.length) approved = false;
  if (!approved && !issues.length) issues.push('The reviewer did not approve the change.');
  return { passed: approved, issues };
}

export function readDesign(json, task) {
  const spec = String(json?.spec || '').trim().slice(0, 3000);
  const criteria = Array.isArray(json?.criteria) ? json.criteria.map((x) => String(x).trim()).filter(Boolean).slice(0, 6) : [];
  return { spec: spec || task.detail || task.title, criteria: criteria.length ? criteria : task.criteria || [] };
}
