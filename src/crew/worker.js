// One worker doing one task: a loop of model turns, each producing exactly one JSON action.
import { TOOLS, actionSchema } from '../tools/index.js';

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
          issues: { type: 'array', maxItems: 8, items: { type: 'string' } }
        },
        required: ['passed', 'issues'],
        additionalProperties: false
      }
    },
    required: ['tool', 'args'],
    additionalProperties: false
  };
}

/** The action schema for a worker: its allowed tools, say, and done (or report for QA tasks). */
export function workerSchema(worker, task) {
  const schema = actionSchema(worker.tools);
  if (task.kind === 'qa') {
    schema.oneOf = schema.oneOf.filter((o) => o.properties.tool.const !== 'done');
    schema.oneOf.push(reportAction());
  }
  return schema;
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

export function firstMessage({ job, task, graph, crewById, files, notes, userNotes, extra }) {
  const parts = [`Job: ${job.request}`];
  if (graph) parts.push(`Plan:\n${planLines(job, graph, task, crewById)}`);
  parts.push(`Your task: ${task.title}${task.detail ? '\n' + task.detail : ''}`);
  parts.push(`Files now: ${files.length ? files.join(', ') : '(none yet)'}`);
  if (notes.length) parts.push(`Crew notes:\n${notes.join('\n')}`);
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
 *   userNotes?: () => string[], preexisting?: Set<string>, chat: (from: string, text: string, taskId?: string) => void
 * }} ctx
 * @returns {Promise<{ status: 'done' | 'failed', summary: string, report?: { passed: boolean, issues: string[] }, wrote: string[] }>}
 */
export async function runTask(ctx) {
  const { job, task, worker, scheduler, toolbox, memory, bus, signal } = ctx;
  const maxTurns = ctx.maxTurns || MAX_TURNS;
  const schema = workerSchema(worker, task);
  const system = systemPrompt(worker, task);
  /** @type {Array<{ action: any, result: string }>} */
  const steps = [];
  const wrote = new Set();
  let invalid = 0;
  let lastKey = '';
  let repeats = 0;
  const jobOpt = { jobId: job.id };
  const finish = task.kind === 'qa' ? 'report' : 'done';

  for (let n = 1; n <= maxTurns; n++) {
    if (signal?.aborted) throw new Error('cancelled');
    // Rebuilt every turn: the file list and the user's messages change while the task runs.
    const first = firstMessage({
      job, task, graph: ctx.graph, crewById: ctx.crewById, files: toolbox.ws.list().map((f) => f.path),
      notes: memory.crew(6), userNotes: ctx.userNotes ? ctx.userNotes() : [], extra: ctx.extra
    });
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
      result = await scheduler.turn({ workerId: worker.id, taskId: task.id, jobId: job.id, messages, options: { schema, maxTokens: 3000, temperature: 0.2 }, signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      invalid++;
      bus.emit('worker.status', { workerId: worker.id, status: 'error', detail: String(err.message).slice(0, 200), taskId: task.id }, jobOpt);
      if (invalid >= 2) return { status: 'failed', summary: `stopped: ${err.message}`, wrote: [...wrote] };
      continue;
    }
    invalid = 0;
    const action = result.json;
    const key = JSON.stringify(compactAction(action));
    repeats = key === lastKey ? repeats + 1 : 0;
    lastKey = key;

    if (action.tool === 'done') {
      const summary = String(action.args?.summary || 'done').slice(0, 300);
      memory.add(worker.id, `${task.title}: ${summary}${wrote.size ? ` (files: ${[...wrote].join(', ')})` : ''}`);
      return { status: 'done', summary, wrote: [...wrote] };
    }
    if (action.tool === 'report') {
      const report = { passed: !!action.args?.passed, issues: (action.args?.issues || []).map(String).filter(Boolean).slice(0, 8) };
      if (report.passed) report.issues = report.issues.filter((i) => !/^(none|no issues?\.?)$/i.test(i.trim()));
      memory.add(worker.id, `${task.title}: ${report.passed ? 'passed' : 'found ' + report.issues.length + ' issues'}`);
      return { status: 'done', summary: report.passed ? 'all checks passed' : `${report.issues.length} issues`, report, wrote: [...wrote] };
    }
    if (action.tool === 'say') {
      ctx.chat(worker.id, String(action.args?.text || '').slice(0, 600), task.id);
      steps.push({ action, result: `Posted. If your task is complete, answer with ${finish}. Otherwise do the next step.` });
      continue;
    }
    if (repeats >= 2) {
      steps.push({ action, result: 'You already did exactly this. Do the next step of your task, or finish.' });
      continue;
    }
    bus.emit('worker.status', { workerId: worker.id, status: 'tool', detail: `${action.tool}${action.args?.path ? ' ' + action.args.path : ''}`, taskId: task.id }, jobOpt);
    const out = await toolbox.execute(action.tool, action.args, {
      jobId: job.id, taskId: task.id, workerId: worker.id, allowed: worker.tools,
      preexisting: ctx.preexisting, approval: job.approval, signal
    });
    if (out.ok && (action.tool === 'write_file' || action.tool === 'edit_file')) wrote.add(String(action.args.path).replace(/^\.\//, ''));
    let observation = out.ok ? `Result: ${capResult(action.tool, out.result)}` : `Error: ${out.error}`;
    // Small models often keep polishing; remind them how to finish after every change.
    if (out.ok && ['write_file', 'edit_file', 'delete_file', 'preview', 'check'].includes(action.tool)) observation += `\nIf your task is complete, answer with ${finish}.`;
    if (!out.ok && action.tool === 'edit_file') observation += '\nRead the file first, or write the whole file with write_file.';
    steps.push({ action, result: observation });
  }
  // Out of turns.
  if (task.kind === 'qa') return { status: 'done', summary: 'QA ran out of turns', report: { passed: false, issues: ['QA could not finish the review in time'] }, wrote: [...wrote] };
  if (wrote.size) {
    memory.add(worker.id, `${task.title}: wrote ${[...wrote].join(', ')}`);
    return { status: 'done', summary: `wrote ${[...wrote].join(', ')} (stopped after ${maxTurns} turns)`, wrote: [...wrote] };
  }
  return { status: 'failed', summary: `no result after ${maxTurns} turns`, wrote: [...wrote] };
}
