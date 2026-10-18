// Prompt assembly: every worker call is built from tagged sections (role, objective, context, tools, rules,
// process, output), measured, and trimmed by priority so it never overflows the model's context window.
// Templates are versioned: change PROMPT_VERSION when a template changes, and update the golden snapshots.
import { TOOLS } from '../../tools/index.js';
import { ROLES, HIRED_ROLE } from './roles.js';
import { playbookSection } from '../library/index.js';
import { playbooksOf } from '../library/hook.js';

export const PROMPT_VERSION = '2026-10-17.1';

/** About 3.5 characters per token for English, code and JSON with the Qwen and most cloud tokenizers. */
export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 3.5);
}

/**
 * The model family decides the budget and how much guidance fits.
 *   small: local 0.5B to 3B (one short example, strict grammar, tight context)
 *   local: local 7B and up
 *   cloud: provider models (long context, fuller examples)
 */
export function modelFamily(brain = {}) {
  const backend = brain.backend || 'local';
  if (!['local', 'fake', 'ollama', 'lmstudio', 'none'].includes(backend)) return 'cloud';
  const name = String(brain.model || '').toLowerCase();
  if (/(^|[^0-9.])(0\.5|1\.5|3)b/.test(name) || backend === 'fake' || backend === 'none') return 'small';
  return 'local';
}

export const FAMILY = {
  small: { contextTokens: 4096, replyTokens: 1500, examples: 1 },
  local: { contextTokens: 4096, replyTokens: 1500, examples: 1 },
  cloud: { contextTokens: 32000, replyTokens: 4096, examples: 2 }
};

export const RULES = [
  'Read a file with read_file before you change it.',
  'Change existing files with small edit_file patches (exact search text, new text); use write_file for new files.',
  'No placeholder text, no TODO comments, no lorem ipsum: write the real content.',
  'Keep the style that is already there (names, indentation, colors).',
  'Accessible and responsive by default: lang, title, viewport, alt text, labels, contrast, layouts that work at 375 px.',
  'Relative paths only (index.html, css/style.css). Nothing outside the workspace, no network.',
  'If you are blocked or something is unclear, say so with say instead of guessing.',
  'One action per turn. Do not repeat an action that already worked.'
];

export const PROCESS = [
  'Put a short plan or check in "thought" (one or two sentences; it is not shown to the user).',
  'Act with one tool call.',
  'Read the check results that come back after each change and fix what they report.',
  'Before finishing, compare the files with every acceptance criterion; finish only when all are met.'
];

const EXAMPLES = {
  write_file: '{"thought": "index.html does not exist yet; write it complete.", "tool": "write_file", "args": {"path": "index.html", "content": "<!doctype html>\\n<html lang=\\"en\\">..."}}',
  edit_file: '{"thought": "the title is wrong; patch only that line.", "tool": "edit_file", "args": {"path": "index.html", "search": "<title>Page</title>", "replace": "<title>Bean There</title>"}}',
  read_file: '{"thought": "read it before changing it.", "tool": "read_file", "args": {"path": "style.css"}}',
  run: '{"thought": "check the logic.", "tool": "run", "args": {"command": "node test.mjs"}}',
  check: '{"thought": "verify the page.", "tool": "check", "args": {}}',
  list_files: '{"thought": "see what exists.", "tool": "list_files", "args": {}}',
  delete_file: '{"thought": "the old file is not used anymore.", "tool": "delete_file", "args": {"path": "old.css"}}',
  preview: '{"thought": "where is it served?", "tool": "preview", "args": {}}'
};

function tag(name, body) {
  return `<${name}>\n${body.trim()}\n</${name}>`;
}

export function roleSection(worker) {
  const t = ROLES[worker.id] || HIRED_ROLE(worker);
  const lines = [t.role, '', 'Your goals:', ...t.goals.map((g) => `- ${g}`), '', 'Never:', ...t.never.map((n) => `- ${n}`)];
  if (t.quality?.length) lines.push('', 'Quality bar:', ...t.quality.map((q) => `- ${q}`));
  return tag('role', lines.join('\n'));
}

export function toolsSection(worker, task, family) {
  const lines = [];
  for (const name of worker.tools) {
    const t = TOOLS[name];
    if (!t) continue;
    lines.push(`- ${name} {${Object.keys(t.parameters.properties).join(', ')}}: ${t.description}`);
  }
  lines.push('- note {text}: write a short decision in your scratchpad.');
  lines.push('- say {text}: post a short message to the crew chat (also to ask when blocked).');
  if (task.kind === 'qa') lines.push('- report {passed, findings}: finish the review. Each finding: {severity: "high" | "medium" | "low", file, problem, fix}. passed is true only when no high or medium finding is left.');
  else lines.push('- done {summary}: finish, after the self check.');
  const n = FAMILY[family]?.examples ?? 1;
  const ex = (task.kind === 'qa' ? ['read_file', 'check'] : ['write_file', 'edit_file']).filter((x) => worker.tools.includes(x) && EXAMPLES[x]).slice(0, n);
  if (ex.length) lines.push('', 'Example calls:', ...ex.map((x) => EXAMPLES[x]));
  return tag('tools', lines.join('\n'));
}

export function outputSection(task) {
  const finish = task.kind === 'qa'
    ? '{"thought": "every criterion is met.", "tool": "report", "args": {"passed": true, "findings": []}}'
    : '{"thought": "all criteria are met.", "tool": "done", "args": {"summary": "index.html and style.css are written."}}';
  return tag('output', [
    'Answer with exactly one JSON object and nothing else:',
    '{"thought": "<short plan or check>", "tool": "<one of the tools>", "args": {<the arguments of that tool>}}',
    `Finishing looks like: ${finish}`
  ].join('\n'));
}

/** The workspace as a short tree: folders with their sizes, files with theirs. */
export function projectMap(files, limit = 40) {
  if (!files.length) return '(the workspace is empty)';
  const dirs = new Map();
  for (const f of files) {
    const parts = f.path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/') + '/';
      const cur = dirs.get(d) || { files: 0, bytes: 0 };
      cur.files++;
      cur.bytes += f.bytes;
      dirs.set(d, cur);
    }
  }
  const lines = [];
  for (const [d, s] of [...dirs].sort()) lines.push(`${d} (${s.files} files, ${s.bytes} B)`);
  for (const f of files.slice(0, limit)) lines.push(`${f.path} (${f.bytes} B)`);
  if (files.length > limit) lines.push(`... ${files.length - limit} more files`);
  return lines.join('\n');
}

const STOP = new Set('the a an and or of to for with in on at is are be it this that file files page add make use'.split(' '));
function words(text) {
  return new Set(String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)));
}

/**
 * Picks the files worth showing, best first: named in the task, recently changed, keyword overlap.
 * @param {Array<{ path: string, bytes: number }>} files
 * @param {{ text: string, recent?: string[] }} q
 */
export function rankFiles(files, q) {
  const w = words(q.text);
  const recent = q.recent || [];
  return files.map((f) => {
    const name = f.path.toLowerCase();
    let score = 0;
    if (q.text.toLowerCase().includes(name)) score += 10;
    const base = name.split('/').pop().replace(/\.[a-z0-9]+$/, '');
    if (w.has(base)) score += 4;
    const ext = name.split('.').pop();
    if (w.has(ext)) score += 2;
    const r = recent.indexOf(f.path);
    if (r !== -1) score += 6 - Math.min(5, r);
    if (/\.(html?|css|m?js|json|md)$/.test(name)) score += 1;
    return { ...f, score };
  }).filter((f) => f.score > 0).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

/** File text with line numbers, cut to maxChars. */
export function numbered(text, maxChars = 2400) {
  const lines = String(text).split('\n');
  const out = [];
  let size = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = `${String(i + 1).padStart(3, ' ')}| ${lines[i]}`;
    if (size + l.length > maxChars) { out.push(`... (${lines.length - i} more lines; read_file shows all)`); break; }
    out.push(l);
    size += l.length + 1;
  }
  return out.join('\n');
}

/**
 * Builds the system prompt and the first user message of a task, within the token budget.
 * The expert playbooks picked for the task (src/crew/library/, or input.playbooks) go between the
 * objective and the context, in at most about a third (37 percent) of the budget.
 * Trimming order when it does not fit (first to go last): map, memories, related files, files being edited.
 * The objective and the acceptance criteria are never cut.
 * @returns {{ system: string, user: string, budget: { family: string, limit: number, used: number, sections: Record<string, number>, trimmed: string[], version: string } }}
 */
export function assembleTaskPrompt(input) {
  const { worker, task, job, family = 'small', files = [], readFile = () => '', recent = [], memories = [], previous = [], scratchpad = [], userNotes = [], plan = '', extra = '' } = input;
  const fam = FAMILY[family] || FAMILY.small;
  const limit = (input.contextTokens || fam.contextTokens) - (input.replyTokens || fam.replyTokens) - 300;
  const system = [roleSection(worker), toolsSection(worker, task, family), tag('rules', RULES.map((r) => `- ${r}`).join('\n')), tag('process', PROCESS.map((p, i) => `${i + 1}. ${p}`).join('\n')), outputSection(task)].join('\n\n');

  const criteria = job.acceptance?.length ? job.acceptance : [];
  const objective = tag('objective', [
    job.brief ? `Approved brief:\n${job.brief}` : `Request: ${job.request}`,
    plan ? `\nPlan of the crew:\n${plan}` : '',
    `\nYour task: ${task.title}${task.detail ? `\n${task.detail}` : ''}`,
    criteria.length && !String(job.brief || '').includes('- [ ]') ? `\nAcceptance criteria:\n${criteria.map((c) => `- [ ] ${c}`).join('\n')}` : ''
  ].join('\n'));

  // Candidate context pieces, with their priority (lower is kept first).
  const q = { text: `${task.title} ${task.detail || ''} ${job.brief || job.request}`, recent };
  const ranked = rankFiles(files, q);
  const editing = ranked.filter((f) => q.text.toLowerCase().includes(f.path.toLowerCase())).slice(0, 2);
  const related = ranked.filter((f) => !editing.includes(f)).slice(0, 3);
  const pieces = [];
  for (const f of editing) pieces.push({ kind: 'editing', priority: 1, text: `File ${f.path} (being changed):\n${numbered(readFile(f.path))}` });
  if (previous.length) pieces.push({ kind: 'previous', priority: 2, text: `From the previous steps:\n${previous.map((p) => `- ${p}`).join('\n')}` });
  if (userNotes.length) pieces.push({ kind: 'user', priority: 2, text: `Messages from the user:\n${userNotes.map((n) => `- ${n}`).join('\n')}` });
  if (scratchpad.length) pieces.push({ kind: 'scratchpad', priority: 2, text: `Your scratchpad:\n${scratchpad.map((n) => `- ${n}`).join('\n')}` });
  if (extra) pieces.push({ kind: 'review', priority: 1, text: extra });
  for (const f of related) pieces.push({ kind: 'related', priority: 3, text: `File ${f.path}:\n${numbered(readFile(f.path), 1200)}` });
  if (memories.length) pieces.push({ kind: 'memories', priority: 4, text: `What we know (memory):\n${memories.map((m) => `- ${m}`).join('\n')}` });
  pieces.push({ kind: 'map', priority: 5, text: `Project map:\n${projectMap(files)}` });

  const playbook = playbookSection(input.playbooks || playbooksOf(task) || [], { maxTokens: Math.floor(limit * 0.37) });
  const sections = { system: estimateTokens(system), objective: estimateTokens(objective) };
  if (playbook) sections.playbook = estimateTokens(playbook.text);
  let used = sections.system + sections.objective + (sections.playbook || 0);
  // Drop from the lowest priority up (map, memories, related files, ...) until it fits; a piece of
  // priority 1 (the file being changed, the review data) is cut down instead of dropped.
  const kept = [...pieces].sort((x, y) => x.priority - y.priority);
  const trimmed = [];
  const cost = () => kept.reduce((n, piece) => n + estimateTokens(piece.text), used);
  for (let guard = 0; kept.length && cost() > limit && guard < 100; guard++) {
    const last = kept[kept.length - 1];
    if (last.priority > 1) { trimmed.push(last.kind); kept.pop(); continue; }
    const over = cost() - limit;
    const CUT = '\n... (cut to fit; use read_file for the rest)';
    const base = last.text.endsWith(CUT) ? last.text.slice(0, -CUT.length) : last.text;
    const keepChars = Math.max(0, base.length - Math.ceil((over + 20) * 3.5) - CUT.length);
    if (keepChars < 200) { trimmed.push(last.kind); kept.pop(); continue; }
    last.text = base.slice(0, keepChars) + CUT;
    if (!trimmed.includes(`${last.kind} (cut)`)) trimmed.push(`${last.kind} (cut)`);
  }
  for (const piece of kept) {
    const c = estimateTokens(piece.text);
    used += c;
    sections[piece.kind] = (sections[piece.kind] || 0) + c;
  }
  const order = ['editing', 'review', 'related', 'previous', 'user', 'scratchpad', 'memories', 'map'];
  kept.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  const context = tag('context', kept.map((p) => p.text).join('\n\n') || '(nothing yet)');
  const user = `${objective}\n\n${playbook ? `${playbook.text}\n\n` : ''}${context}\n\nWhat is your first action?`;
  return { system, user, budget: { family, limit, used, sections, trimmed, version: PROMPT_VERSION, ...(playbook ? { playbooks: playbook.used } : {}) } };
}
