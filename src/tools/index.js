// Tool definitions (each with a JSON schema) and the executor with approval mode and events.
import { Workspace } from './workspace.js';
import { unifiedDiff, diffStats } from './diff.js';
import { runCommand, splitArgs } from './run.js';
import { checkWorkspace } from './check.js';

const S = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const str = (description) => ({ type: 'string', description });

/** @type {Record<string, { description: string, parameters: object, destructive?: boolean }>} */
export const TOOLS = {
  list_files: { description: 'List the files in the workspace.', parameters: S({}) },
  read_file: { description: 'Read a text file of the workspace.', parameters: S({ path: str('relative path, for example index.html') }) },
  write_file: { description: 'Create or replace a whole file.', parameters: S({ path: str('relative path'), content: str('the full file content') }) },
  edit_file: {
    description: 'Replace one exact piece of text in a file with new text.',
    parameters: S({ path: str('relative path'), search: str('exact text that is in the file now'), replace: str('new text') })
  },
  delete_file: { description: 'Delete a file.', parameters: S({ path: str('relative path') }), destructive: true },
  run: { description: 'Run "node <file>", "npm test" or "npm run <script>" in the workspace.', parameters: S({ command: str('the command line') }), destructive: true },
  check: { description: 'Run static checks on the workspace: HTML structure, links, JS syntax, CSS, JSON.', parameters: S({}) },
  preview: { description: 'Get the local URL where the workspace is served as a site.', parameters: S({}) }
};

export const ALL_TOOLS = Object.keys(TOOLS);
/** Tools that change the workspace or run code: from a guest or a friend's model they always wait for the host. */
export const STRICT_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'run']);

export function toolList(names = ALL_TOOLS) {
  return names.filter((n) => TOOLS[n]).map((name) => ({ name, description: TOOLS[name].description, parameters: TOOLS[name].parameters }));
}

/**
 * Schema for one worker action: a tool call, a chat message, or "done".
 * Shape: { "tool": "<name>", "args": { ... } }.
 */
export function actionSchema(names = ALL_TOOLS) {
  const options = names.filter((n) => TOOLS[n]).map((name) => S({ tool: { const: name }, args: TOOLS[name].parameters }));
  options.push(S({ tool: { const: 'say' }, args: S({ text: str('a short message to the crew') }) }));
  options.push(S({ tool: { const: 'done' }, args: S({ summary: str('one sentence about what you did') }) }));
  return { oneOf: options };
}

function truncate(value, max = 4096) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > max ? s.slice(0, max) + `... [${s.length - max} more chars]` : s;
}

let callCounter = 0;

export class ToolBox {
  /**
   * @param {{ workspace: Workspace | string, bus: import('../bus.js').EventBus, approvals: import('./approvals.js').Approvals, previewUrl?: () => string | null, isApprovalMode?: () => boolean }} opts
   */
  constructor(opts) {
    this.ws = typeof opts.workspace === 'string' ? new Workspace(opts.workspace) : opts.workspace;
    this.bus = opts.bus;
    this.approvals = opts.approvals;
    this.previewUrl = opts.previewUrl || (() => null);
    this.isApprovalMode = opts.isApprovalMode || (() => this.bus.state.settings.approvalMode !== false);
    /** jobId -> origin of jobs that did not start at this PC (a guest's request) */
    this.origins = new Map();
  }

  /** Marks a job as started by someone else (a Code together guest): its writes and runs wait for the host. */
  markOrigin(jobId, origin) {
    const o = cleanOrigin(origin);
    if (jobId && o) this.origins.set(jobId, o);
  }

  /** Where a call comes from when it is not this PC's own crew: a guest or a friend's model. */
  originOf(ctx = {}) {
    return cleanOrigin(ctx.origin) || (ctx.jobId && this.origins.get(ctx.jobId)) || null;
  }

  /** True when this call must wait for the host whatever the approval mode. */
  isStrict(tool, ctx = {}) {
    return STRICT_TOOLS.has(tool) && !!this.originOf(ctx);
  }

  /** Whether this call needs the user's approval in approval mode. */
  needsApproval(tool, args, ctx = {}) {
    if (this.isStrict(tool, ctx)) return true;
    const mode = ctx.approval === undefined ? this.isApprovalMode() : ctx.approval && this.isApprovalMode();
    if (!mode) return false;
    if (TOOLS[tool]?.destructive) return true;
    if (tool === 'write_file' || tool === 'edit_file') {
      // Changing a file that existed before this job started is destructive; new files are not.
      const pre = ctx.preexisting;
      return !!pre && pre.has(normalize(args.path));
    }
    return false;
  }

  /**
   * Runs one tool call and emits its events.
   * @param {string} tool
   * @param {any} args
   * @param {{ jobId?: string, taskId?: string, workerId?: string, allowed?: string[], preexisting?: Set<string>, approval?: boolean, signal?: AbortSignal }} ctx
   * @returns {Promise<{ ok: boolean, result?: any, error?: string }>}
   */
  async execute(tool, args = {}, ctx = {}) {
    const callId = `call_${Date.now().toString(36)}_${++callCounter}`;
    const ev = { jobId: ctx.jobId };
    this.bus.emit('tool.called', { callId, workerId: ctx.workerId, taskId: ctx.taskId, tool, args: redactArgs(tool, args) }, ev);
    let out;
    try {
      if (!TOOLS[tool]) throw new Error(`unknown tool: ${tool}`);
      if (ctx.allowed && !ctx.allowed.includes(tool)) throw new Error(`${ctx.workerId || 'this worker'} is not allowed to use ${tool}`);
      if (this.needsApproval(tool, args, ctx)) {
        const origin = this.originOf(ctx);
        const script = tool === 'run' ? this.scriptOf(args.command) : null;
        const decision = await this.approvals.request({
          jobId: ctx.jobId, taskId: ctx.taskId, workerId: ctx.workerId, tool, args: redactArgs(tool, args),
          summary: describe(tool, args), diff: this.previewDiff(tool, args),
          ...(origin ? { origin, strict: STRICT_TOOLS.has(tool) } : {}), ...(script ? { script } : {})
        }, ctx.signal);
        if (!decision.approved) throw new Error(`the user rejected this action${decision.note ? ': ' + decision.note : ''}`);
      }
      const meta = {};
      const result = await this.run(tool, args, ctx, callId, meta);
      out = { ok: true, result, ...(typeof meta.passed === 'boolean' ? { passed: meta.passed } : {}) };
    } catch (err) {
      out = { ok: false, error: String(err && err.message ? err.message : err) };
    }
    this.bus.emit('tool.result', { callId, ok: out.ok, result: out.ok ? truncate(out.result) : undefined, error: out.error, ...(typeof out.passed === 'boolean' ? { passed: out.passed } : {}) }, ev);
    return out;
  }

  /** For "npm test" and "npm run x": the script from package.json that would really run. */
  scriptOf(command) {
    let argv;
    try { argv = splitArgs(String(command || '')); } catch { return null; }
    if (String(argv[0] || '').toLowerCase().replace(/\.(exe|cmd)$/, '') !== 'npm') return null;
    const name = ['test', 't'].includes(argv[1]) ? 'test' : ['run', 'run-script'].includes(argv[1]) ? argv[2] : null;
    if (!name) return null;
    let body = null;
    try { body = JSON.parse(this.ws.read('package.json'))?.scripts?.[name] ?? null; } catch { body = null; }
    return { name: String(name).slice(0, 80), body: typeof body === 'string' ? body.slice(0, 2000) : null };
  }

  previewDiff(tool, args) {
    try {
      if (tool === 'write_file') {
        const before = this.ws.exists(args.path) ? this.ws.read(args.path) : null;
        return unifiedDiff(normalize(args.path), before, args.content);
      }
      if (tool === 'edit_file') {
        const before = this.ws.read(args.path);
        if (!before.includes(args.search)) return undefined;
        return unifiedDiff(normalize(args.path), before, before.replace(args.search, () => args.replace));
      }
      if (tool === 'delete_file') return unifiedDiff(normalize(args.path), this.ws.read(args.path), null);
    } catch { /* no diff */ }
    return undefined;
  }

  fileEvent(rel, before, after, ctx) {
    const op = after == null ? 'delete' : before == null ? 'create' : 'modify';
    const diff = unifiedDiff(rel, before, after);
    const bytes = after == null ? 0 : Buffer.byteLength(after);
    const data = { path: rel, op, diff: truncate(diff, 64 * 1024), bytes, workerId: ctx.workerId, taskId: ctx.taskId, ...diffStats(diff) };
    if (after != null && bytes <= 64 * 1024) data.content = after;
    this.bus.emit('file.changed', data, { jobId: ctx.jobId });
  }

  async run(tool, args, ctx, callId, meta = {}) {
    switch (tool) {
      case 'list_files': {
        const files = this.ws.list();
        return files.length ? files.map((f) => `${f.path} (${f.bytes} bytes)`).join('\n') : '(the workspace is empty)';
      }
      case 'read_file':
        return this.ws.read(args.path);
      case 'write_file': {
        const rel = normalize(args.path);
        const { before, after } = this.ws.write(rel, args.content);
        if (before !== after) this.fileEvent(rel, before, after, ctx);
        return `${before == null ? 'created' : 'wrote'} ${rel} (${Buffer.byteLength(after)} bytes)`;
      }
      case 'edit_file': {
        const rel = normalize(args.path);
        const { before, after } = this.ws.edit(rel, args.search, args.replace);
        if (before !== after) this.fileEvent(rel, before, after, ctx);
        return `edited ${rel}`;
      }
      case 'delete_file': {
        const rel = normalize(args.path);
        const { before } = this.ws.remove(rel);
        this.fileEvent(rel, before, null, ctx);
        return `deleted ${rel}`;
      }
      case 'run': {
        const r = await runCommand(String(args.command || ''), {
          cwd: this.ws.root,
          signal: ctx.signal,
          onOutput: (stream, text) => this.bus.live('run.output', { callId, stream, text })
        });
        this.bus.emit('run.finished', { callId, ...r }, { jobId: ctx.jobId });
        return `exit code ${r.exitCode}${r.timedOut ? ' (timed out)' : ''}\n${r.stdout}${r.stderr ? '\n[stderr]\n' + r.stderr : ''}`.trim();
      }
      case 'check': {
        const r = checkWorkspace(this.ws);
        meta.passed = !!r.passed; // tool.result.passed: the structured verdict the Office QA mark reads
        return r.passed ? `all checks passed (${r.checked.length} files)` : `issues found:\n- ${r.issues.join('\n- ')}`;
      }
      case 'preview': {
        const url = this.previewUrl();
        return url ? `the workspace is served at ${url}` : 'preview is available in the Live preview window';
      }
      default:
        throw new Error(`unknown tool: ${tool}`);
    }
  }
}

function cleanOrigin(o) {
  if (!o || typeof o !== 'object' || !['guest', 'remote'].includes(o.kind)) return null;
  const out = { kind: o.kind, label: String(o.label || (o.kind === 'guest' ? 'a guest' : "a friend's model")).slice(0, 80) };
  if (o.id) out.id = String(o.id).slice(0, 40);
  if (o.brainId) out.brainId = String(o.brainId).slice(0, 40);
  // remoteOrigin of PLAN section 5: the verified peer whose machine answered the turn (src/compute/).
  if (o.peerId) out.peerId = String(o.peerId).slice(0, 80);
  return out;
}

function normalize(p) {
  return String(p || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function redactArgs(tool, args) {
  if (tool === 'write_file' && args && typeof args.content === 'string' && args.content.length > 2000) {
    return { path: args.path, content: args.content.slice(0, 2000) + `... [${args.content.length - 2000} more chars]` };
  }
  return args;
}

function describe(tool, args) {
  switch (tool) {
    case 'run': return `Run: ${args.command}`;
    case 'delete_file': return `Delete ${args.path}`;
    case 'write_file': return `Replace ${args.path}`;
    case 'edit_file': return `Edit ${args.path}`;
    default: return `${tool}`;
  }
}

export { Workspace };
