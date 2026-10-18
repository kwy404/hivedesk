// One worker doing one task: a loop of model turns, each producing exactly one JSON action.
import { TOOLS, actionSchema } from '../tools/index.js';
import { checkWorkspace } from '../tools/check.js';
import { assembleTaskPrompt } from './prompts/index.js';

export const MAX_TURNS = 10;
const HISTORY_PAIRS = 6;
const RESULT_CAP = 2500;
const READ_CAP = 6000;

function reportAction() {
  return {
    type: 'object',
    properties: {
      tool: { const: 'report' },
      args: {
        type: 'object',
        properties: {
          passed: { type: 'boolean' },
          findings: {
            type: 'array',
            maxItems: 8,
            items: {
              type: 'object',
              properties: { severity: { enum: ['high', 'medium', 'low'] }, file: { type: 'string' }, problem: { type: 'string' }, fix: { type: 'string' } },
              required: ['severity', 'file', 'problem', 'fix'],
              additionalProperties: false
            }
          }
        },
        required: ['passed', 'findings'],
        additionalProperties: false
      }
    },
    required: ['tool', 'args'],
    additionalProperties: false
  };
}

/** The action schema for a worker: its allowed tools, say, and done (or report for QA tasks). */
const noteAction = () => ({
  type: 'object',
  properties: { tool: { const: 'note' }, args: { type: 'object', properties: { text: { type: 'string', description: 'a short decision to remember' } }, required: ['text'], additionalProperties: false } },
  required: ['tool', 'args'],
  additionalProperties: false
});

export function workerSchema(worker, task) {
  const schema = actionSchema(worker.tools);
  schema.oneOf.push(noteAction());
  if (task.kind === 'qa') {
    schema.oneOf = schema.oneOf.filter((o) => o.properties.tool.const !== 'done');
    schema.oneOf.push(reportAction());
  }
  // A short scratch plan before the call ("thought"), first in every action. Grammar engines make it
  // mandatory (they require every property); the validator accepts actions without it.
  for (const o of schema.oneOf) o.properties = { thought: { type: 'string', maxLength: 300 }, ...o.properties };
  return schema;
}

/** QA findings to issue lines; only high and medium findings fail the review. */
export function findingsToReport(args = {}) {
  const findings = Array.isArray(args.findings) ? args.findings : [];
  const legacy = Array.isArray(args.issues) ? args.issues.map((i) => ({ severity: 'high', file: '', problem: String(i), fix: '' })) : [];
  const all = [...findings, ...legacy].filter((f) => f && String(f.problem || '').trim() && !/^(none|no issues?\.?)$/i.test(String(f.problem).trim()));
  const blocking = all.filter((f) => f.severity !== 'low');
  const line = (f) => `${f.file ? f.file + ': ' : ''}${f.problem}${f.fix ? ` Fix: ${f.fix}` : ''}`;
  return {
    passed: !!args.passed && blocking.length === 0 ? true : blocking.length === 0 && !!args.passed,
    issues: blocking.map(line).slice(0, 8),
    notes: all.filter((f) => f.severity === 'low').map(line).slice(0, 8),
    findings: all.slice(0, 8)
  };
}

export function systemPrompt(worker, task) {
  const lines = [
    worker.prompt,
    '',
    'You work with a crew in a shared workspace folder. Each turn you answer with exactly one JSON action: {"tool": "<name>", "args": {...}}.',
    'Actions you can use:'
  ];
  for (const name of worker.tools) {
    const t = TOOLS[name];
    if (!t) continue;
    const args = Object.keys(t.parameters.properties).join(', ');
    lines.push(`- ${name} {${args}}: ${t.description}`);
  }
  lines.push('- say {text}: post a short message to the crew chat.');
  lines.push('- note {text}: write a short decision in your scratchpad (for example "colors: #2b1d12 on #fff8ef").');
  if (task.kind === 'qa') lines.push('- report {passed, issues}: finish your check. passed is true only when there are no real problems; each issue names the file, the problem and the fix.');
  else lines.push('- done {summary}: finish your task when the files are written.');
  lines.push('', 'Rules: relative paths only (index.html, css/style.css). Always write complete files, never placeholders. One action per turn. Do not repeat an action that already worked.');
  return lines.join('\n');
}

function planLines(job, graph, task, crewById) {
  return graph.order().map((t, i) => {
    const who = crewById.get(t.assignee)?.name || t.assignee;
    const mark = t.id === task.id ? ' <- your task' : t.status === 'done' ? ' (done)' : '';
    return `${i + 1}. [${who}] ${t.title}${mark}`;
  }).join('\n');
}

export function firstMessage({ job, task, graph, crewById, files, notes, userNotes, extra, scratchpad }) {
  const parts = [job.brief ? `Job brief:\n${job.brief}` : `Job: ${job.request}`];
  if (graph) parts.push(`Plan:\n${planLines(job, graph, task, crewById)}`);
  parts.push(`Your task: ${task.title}${task.detail ? '\n' + task.detail : ''}`);
  parts.push(`Files now: ${files.length ? files.join(', ') : '(none yet)'}`);
  if (notes.length) parts.push(`Crew notes:\n${notes.join('\n')}`);
  if (scratchpad && scratchpad.length) parts.push(`Your scratchpad (decisions you noted):\n${scratchpad.map((n) => `- ${n}`).join('\n')}`);
  if (userNotes.length) parts.push(`Messages from the user:\n${userNotes.join('\n')}`);
  if (extra) parts.push(extra);
  parts.push('What is your first action?');
  return parts.join('\n\n');
}

/** Shortens an action for the history, so whole files are not repeated in every prompt. */
export function compactAction(action) {
  if (action.tool === 'write_file' && typeof action.args?.content === 'string' && action.args.content.length > 300) {
    return { tool: 'write_file', args: { path: action.args.path, content: `[${action.args.content.length} chars written]` } };
  }
  if (action.tool === 'edit_file' && action.args) {
    const cut = (s) => (typeof s === 'string' && s.length > 200 ? s.slice(0, 200) + '...' : s);
    return { tool: 'edit_file', args: { path: action.args.path, search: cut(action.args.search), replace: cut(action.args.replace) } };
  }
  return action;
}

function capResult(tool, text) {
  const cap = tool === 'read_file' ? READ_CAP : RESULT_CAP;
  const s = String(text ?? '');
  return s.length > cap ? s.slice(0, cap) + `\n[cut, ${s.length - cap} more chars]` : s;
}

/**
 * Runs a task to the end.
 * @param {{
 *   job: any, task: any, worker: any, graph?: import('./taskgraph.js').TaskGraph, crewById: Map<string, any>,
 *   scheduler: import('./scheduler.js').Scheduler, toolbox: import('../tools/index.js').ToolBox, memory: import('./memory.js').Memory,
 *   bus: import('../bus.js').EventBus, signal?: AbortSignal, maxTurns?: number, extra?: string,
 *   userNotes?: () => string[], preexisting?: Set<string>, chat: (from: string, text: string, taskId?: string) => void,
 *   verify?: (wrote: string[]) => string[]
 * }} ctx
 * @returns {Promise<{ status: 'done' | 'failed', summary: string, report?: { passed: boolean, issues: string[] }, wrote: string[] }>}
 */
export async function runTask(ctx) {
  const { job, task, worker, scheduler, toolbox, memory, bus, signal } = ctx;
  const maxTurns = ctx.maxTurns || MAX_TURNS;
  const schema = workerSchema(worker, task);
  const legacySystem = systemPrompt(worker, task);
  /** @type {Array<{ action: any, result: string }>} */
  const steps = [];
  const wrote = new Set();
  let invalid = 0;
  let lastKey = '';
  let repeats = 0;
  let rejected = 0;
  const jobOpt = { jobId: job.id };
  const finish = task.kind === 'qa' ? 'report' : 'done';

  /** Files this worker read or created in this task: changing any other existing file needs a read first. */
  const known = new Set();
  // Untrusted origin: a worker brought by a guest, or any turn of this task that a friend's machine
  // answered. Its writes and runs then always wait for the host (src/tools/index.js, STRICT_TOOLS).
  let origin = worker.origin && typeof worker.origin === 'object' ? worker.origin : null;
  let hint = '';
  let nothingAsked = false;
  for (let n = 1; n <= maxTurns; n++) {
    if (signal?.aborted) throw new Error('cancelled');
    if (ctx.budget) {
      if (ctx.budget.turns >= ctx.budget.max) return { status: 'failed', summary: `stopped by Mel: the job used its ${ctx.budget.max} model turns`, wrote: [...wrote] };
      ctx.budget.turns++;
    }
    // Rebuilt every turn: the files, the notes and the user's messages change while the task runs.
    const listed = toolbox.ws.list();
    const assembled = assembleTaskPrompt({
      worker, task, job, family: ctx.family || 'small', contextTokens: ctx.contextTokens,
      files: listed, readFile: (p) => { try { return toolbox.ws.read(p); } catch { return ''; } },
      recent: [...wrote, ...(ctx.recent ? ctx.recent() : [])], memories: ctx.memories || [],
      previous: memory.crew(6), scratchpad: memory.get(`pad:${worker.id}`),
      userNotes: ctx.userNotes ? ctx.userNotes() : [], extra: ctx.extra,
      plan: ctx.graph ? planLines(job, ctx.graph, task, ctx.crewById) : ''
    });
    const system = ctx.legacyPrompts ? legacySystem : assembled.system;
    const first = ctx.legacyPrompts ? firstMessage({
      job, task, graph: ctx.graph, crewById: ctx.crewById, files: listed.map((f) => f.path),
      notes: memory.crew(6), userNotes: ctx.userNotes ? ctx.userNotes() : [], extra: ctx.extra,
      scratchpad: memory.get(`pad:${worker.id}`)
    }) : assembled.user;
    const messages = [{ role: 'system', content: system }, { role: 'user', content: first }];
    const older = steps.slice(0, Math.max(0, steps.length - HISTORY_PAIRS));
    if (older.length) {
      messages[1] = { role: 'user', content: `${first}\n\nEarlier steps: ${older.map((s) => `${s.action.tool}${s.action.args?.path ? ' ' + s.action.args.path : ''}`).join('; ')}` };
    }
    for (const s of steps.slice(-HISTORY_PAIRS)) {
      messages.push({ role: 'assistant', content: JSON.stringify(compactAction(s.action)) });
      messages.push({ role: 'user', content: s.result });
    }
    if (n === maxTurns) messages[messages.length - 1].content += `\n\nThis is your last turn: finish with ${task.kind === 'qa' ? 'report' : 'done'}.`;

    let result;
    try {
      if (hint) messages[messages.length - 1] = { ...messages[messages.length - 1], content: `${messages[messages.length - 1].content}\n\n${hint}` };
      result = await scheduler.turn({ workerId: worker.id, taskId: task.id, jobId: job.id, messages, options: { schema, maxTokens: ctx.family === 'cloud' ? 4096 : 2000, temperature: 0.2 }, budget: assembled.budget, signal });
      hint = '';
    } catch (err) {
      if (signal?.aborted) throw err;
      invalid++;
      bus.emit('worker.status', { workerId: worker.id, status: 'error', detail: String(err.message).slice(0, 200), taskId: task.id }, jobOpt);
      if (invalid >= 3) return { status: 'failed', summary: `stopped: ${err.message}`, wrote: [...wrote] };
      // Tell the model what went wrong: most often the answer ran too long (a whole file, or a loop).
      hint = 'Your last answer was cut off before the JSON ended. Keep the thought to one sentence and make a smaller change: one edit_file patch, or a short file.';
      continue;
    }
    invalid = 0;
    if (result?.remote && (!origin || origin.kind !== 'remote')) origin = { kind: 'remote', brainId: result.remote.brainId, label: result.remote.label, ...(result.remote.peerId ? { peerId: result.remote.peerId } : {}) };
    const action = result.json;
    const key = JSON.stringify(compactAction(action));
    repeats = key === lastKey ? repeats + 1 : 0;
    lastKey = key;

    if (action.tool === 'done') {
      // Do not take "done" at face value when the static checks still fail on this task's files.
      const remaining = ctx.verify ? ctx.verify([...wrote]) : [];
      // "Done" without a single file written is asked about once: often the model just forgot to write.
      if (!wrote.size && !nothingAsked && task.kind !== 'qa') {
        nothingAsked = true;
        steps.push({ action, result: 'You have not written or changed any file in this task. If the task needs a file, write it now with write_file (or edit_file). If nothing needs to change, answer with done again and say why.' });
        continue;
      }
      if (remaining.length && rejected < 2) {
        rejected++;
        const list = remaining.map((i) => `- ${i}`).join('\n');
        steps.push({ action, result: `Not done yet. These problems remain:\n${list}\nFix them (read the file, then write it again), then answer with done.` });
        continue;
      }
      const summary = String(action.args?.summary || 'done').slice(0, 300);
      memory.add(worker.id, `${task.title}: ${summary}${wrote.size ? ` (files: ${[...wrote].join(', ')})` : ''}`);
      return { status: 'done', summary, wrote: [...wrote] };
    }
    if (action.tool === 'report') {
      const report = findingsToReport(action.args);
      // A model that says "not passed" with no blocking finding is taken at its word, with a generic finding.
      if (!action.args?.passed && !report.issues.length) report.issues.push('QA did not pass the work but gave no finding');
      report.passed = !!action.args?.passed && report.issues.length === 0;
      memory.add(worker.id, `${task.title}: ${report.passed ? 'passed' : 'found ' + report.issues.length + ' issues'}`);
      return { status: 'done', summary: report.passed ? 'all checks passed' : `${report.issues.length} issues`, report, wrote: [...wrote] };
    }
    if (action.tool === 'note') {
      const text = String(action.args?.text || '').trim().slice(0, 240);
      if (text) {
        memory.add(`pad:${worker.id}`, text);
        bus.emit('worker.note', { workerId: worker.id, taskId: task.id, text }, jobOpt);
      }
      steps.push({ action, result: 'Noted. Now do the next step.' });
      continue;
    }
    if (action.tool === 'say') {
      ctx.chat(worker.id, String(action.args?.text || '').slice(0, 600), task.id);
      steps.push({ action, result: `Posted. If your task is complete, answer with ${finish}. Otherwise do the next step.` });
      continue;
    }
    if (repeats >= 4) break; // Mel stops the loop: the same action five times in a row
    if (repeats >= 2) {
      steps.push({ action, result: `You already did exactly this. Do the next step of your task, or finish with ${finish}.` });
      continue;
    }
    // Read before you change: an existing file must be read (or created) by this worker in this task first.
    const target = typeof action.args?.path === 'string' ? action.args.path.trim().replace(/\\/g, '/').replace(/^\.\//, '') : '';
    if ((action.tool === 'edit_file' || action.tool === 'write_file') && target && !known.has(target) && toolbox.ws.exists(target)) {
      steps.push({ action, result: `Error: ${target} already exists and you have not read it. Read it first with read_file, then change it with a small edit_file.` });
      continue;
    }
    bus.emit('worker.status', { workerId: worker.id, status: 'tool', detail: `${action.tool}${action.args?.path ? ' ' + action.args.path : ''}`, taskId: task.id }, jobOpt);
    const out = await toolbox.execute(action.tool, action.args, {
      jobId: job.id, taskId: task.id, workerId: worker.id, allowed: worker.tools,
      preexisting: ctx.preexisting, approval: job.approval, signal, ...(origin ? { origin } : {})
    });
    if (out.ok && (action.tool === 'write_file' || action.tool === 'edit_file')) wrote.add(String(action.args.path).replace(/^\.\//, ''));
    if (out.ok && target && ['read_file', 'write_file', 'edit_file'].includes(action.tool)) known.add(target);
    let observation = out.ok ? `Result: ${capResult(action.tool, out.result)}` : `Error: ${out.error}`;
    // After each change, the checks run on the changed file and the exact result goes back to the worker.
    if (out.ok && (action.tool === 'write_file' || action.tool === 'edit_file') && target) {
      const r = checkWorkspace(toolbox.ws, [target]);
      const own = r.issues.filter((i) => !/ links to /.test(i) || task.kind === 'fix');
      observation += own.length ? `\nChecks on ${target} found problems:\n- ${own.join('\n- ')}` : `\nChecks on ${target}: ok.`;
    }
    // Small models often keep polishing; remind them how to finish after every change.
    if (out.ok && ['write_file', 'edit_file', 'delete_file', 'preview', 'check'].includes(action.tool)) observation += `\nIf your task is complete, answer with ${finish}.`;
    if (!out.ok && action.tool === 'edit_file') observation += '\nRead the file first, or write the whole file with write_file.';
    steps.push({ action, result: observation });
  }
  // Out of turns, or stopped in a loop. QA reports what the checks say.
  if (task.kind === 'qa') {
    const r = checkWorkspace(toolbox.ws);
    return { status: 'done', summary: 'QA stopped before its report; the checks decide', report: { passed: r.passed, issues: r.passed ? [] : r.issues.slice(0, 8) }, wrote: [...wrote] };
  }
  if (wrote.size) {
    memory.add(worker.id, `${task.title}: wrote ${[...wrote].join(', ')}`);
    return { status: 'done', summary: `wrote ${[...wrote].join(', ')} (stopped after ${maxTurns} turns)`, wrote: [...wrote] };
  }
  return { status: 'failed', summary: `no result after ${maxTurns} turns`, wrote: [...wrote] };
}
