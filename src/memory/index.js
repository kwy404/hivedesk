// Local memory: small, capped entries in .hivedesk/memory.json (this project) and ~/.hivedesk/memory.json (you),
// plus one session file per job in .hivedesk/sessions/<jobId>.jsonl. Nothing here leaves the machine by itself;
// the few entries picked for a job go into the prompt of the brain that serves it.
import fs from 'node:fs';
import path from 'node:path';
import { keywords } from '../playbooks/index.js';

export const CAPS = { project: 200, user: 100, text: 280 };
const KINDS = new Set(['fact', 'preference', 'rejected', 'session', 'decision']);
let n = 0;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export class MemoryStore {
  /**
   * @param {{ projectFile?: string | null, userFile?: string | null, sessionsDir?: string | null, now?: () => number }} opts
   */
  constructor(opts = {}) {
    this.files = { project: opts.projectFile || null, user: opts.userFile || null };
    this.sessionsDir = opts.sessionsDir || null;
    this.now = opts.now || Date.now;
    this.entries = { project: [], user: [] };
    for (const scope of ['project', 'user']) {
      const f = this.files[scope];
      const data = f ? readJson(f, null) : null;
      if (data && Array.isArray(data.entries)) this.entries[scope] = data.entries.filter((e) => e && e.id && e.text);
    }
  }

  all() {
    return [...this.entries.project, ...this.entries.user];
  }

  find(id) {
    return this.all().find((e) => e.id === id) || null;
  }

  /** @param {{ text: string, scope?: 'project'|'user', kind?: string, pinned?: boolean, source?: string }} spec */
  add(spec) {
    const text = String(spec?.text || '').replace(/\s+/g, ' ').trim().slice(0, CAPS.text);
    if (!text) throw Object.assign(new Error('the memory text is empty'), { code: 'bad_request' });
    const scope = spec.scope === 'user' ? 'user' : 'project';
    const kind = KINDS.has(spec.kind) ? spec.kind : 'fact';
    const list = this.entries[scope];
    const same = list.find((e) => e.text.toLowerCase() === text.toLowerCase());
    if (same) {
      same.updatedAt = new Date(this.now()).toISOString();
      if (spec.pinned) same.pinned = true;
      this._save(scope);
      return same;
    }
    const entry = { id: `m${this.now().toString(36)}${(++n).toString(36)}`, scope, kind, text, keywords: keywords(text), pinned: !!spec.pinned, uses: 0, createdAt: new Date(this.now()).toISOString(), ...(spec.source ? { source: spec.source } : {}) };
    list.push(entry);
    this._prune(scope);
    this._save(scope);
    return entry;
  }

  update(id, patch = {}) {
    const e = this.find(id);
    if (!e) throw Object.assign(new Error('no memory with that id'), { code: 'not_found' });
    if (typeof patch.text === 'string' && patch.text.trim()) { e.text = patch.text.replace(/\s+/g, ' ').trim().slice(0, CAPS.text); e.keywords = keywords(e.text); }
    if (typeof patch.pinned === 'boolean') e.pinned = patch.pinned;
    if (KINDS.has(patch.kind)) e.kind = patch.kind;
    e.updatedAt = new Date(this.now()).toISOString();
    this._save(e.scope);
    return e;
  }

  remove(id) {
    for (const scope of ['project', 'user']) {
      const i = this.entries[scope].findIndex((e) => e.id === id);
      if (i !== -1) { this.entries[scope].splice(i, 1); this._save(scope); return true; }
    }
    return false;
  }

  /** "Forget this": removes the entry that best matches the text (not pinned ones unless asked by id). */
  forget(text) {
    const best = this.search(text, { limit: 1, includePinned: false })[0];
    if (!best || best.score < 0.2) return null;
    this.remove(best.entry.id);
    return best.entry;
  }

  /**
   * Keyword and recency scoring. Pinned entries get a bonus; sessions are a little less relevant than facts.
   * @returns {Array<{ entry: any, score: number }>}
   */
  search(query, { limit = 6, includePinned = true, min = 0.05 } = {}) {
    const q = new Set(keywords(query));
    const now = this.now();
    return this.all().filter((e) => includePinned || !e.pinned).map((e) => {
      const k = new Set(e.keywords || keywords(e.text));
      let inter = 0;
      for (const w of q) if (k.has(w)) inter++;
      const sim = q.size && k.size ? inter / Math.min(q.size, k.size) : 0;
      const ageDays = (now - Date.parse(e.updatedAt || e.createdAt)) / 86_400_000;
      const recency = Math.exp(-Math.max(0, ageDays) / 30);
      const score = sim * 0.75 + recency * 0.15 + (e.pinned ? 0.2 : 0) + (e.kind === 'preference' ? 0.05 : 0) - (e.kind === 'session' ? 0.05 : 0);
      return { entry: e, score: Math.round(score * 1000) / 1000, sim };
    }).filter((r) => r.sim > 0 || r.entry.pinned || r.entry.kind === 'preference').filter((r) => r.score >= min)
      .sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** The short "what we know" lines for a job, and marks them used. */
  forJob(request, limit = 6) {
    const hits = this.search(request, { limit });
    for (const h of hits) { h.entry.uses = (h.entry.uses || 0) + 1; h.entry.usedAt = new Date(this.now()).toISOString(); }
    for (const scope of ['project', 'user']) if (hits.some((h) => h.entry.scope === scope)) this._save(scope);
    return hits.map((h) => h.entry);
  }

  /** Over the cap: drop the oldest, least used entries that are not pinned. */
  _prune(scope) {
    const list = this.entries[scope];
    const cap = CAPS[scope];
    if (list.length <= cap) return;
    const victims = list.filter((e) => !e.pinned).sort((a, b) => (a.uses || 0) - (b.uses || 0) || String(a.usedAt || a.createdAt).localeCompare(String(b.usedAt || b.createdAt)));
    const drop = new Set(victims.slice(0, list.length - cap).map((e) => e.id));
    this.entries[scope] = list.filter((e) => !drop.has(e.id));
  }

  _save(scope) {
    const f = this.files[scope];
    if (f) writeJson(f, { version: 1, entries: this.entries[scope] });
  }

  // ---- sessions ----
  sessionFile(jobId) {
    return this.sessionsDir ? path.join(this.sessionsDir, `${String(jobId).replace(/[^\w-]/g, '')}.jsonl`) : null;
  }

  appendSession(jobId, record) {
    const f = this.sessionFile(jobId);
    if (!f) return;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify({ ts: new Date(this.now()).toISOString(), ...record }) + '\n');
  }

  readSession(jobId) {
    const f = this.sessionFile(jobId);
    if (!f || !fs.existsSync(f)) return null;
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }

  /** One line per session, newest first. */
  listSessions() {
    if (!this.sessionsDir || !fs.existsSync(this.sessionsDir)) return [];
    const out = [];
    for (const name of fs.readdirSync(this.sessionsDir)) {
      if (!name.endsWith('.jsonl')) continue;
      const id = name.slice(0, -6);
      const rec = this.readSession(id) || [];
      const req = rec.find((r) => r.type === 'request');
      const outcome = [...rec].reverse().find((r) => r.type === 'outcome');
      const report = [...rec].reverse().find((r) => r.type === 'report');
      out.push({ id, request: req?.request || '', startedAt: req?.ts || null, status: outcome?.status || 'unfinished', summary: outcome?.summary || '', improvedPrompt: report?.improvedPrompt || null, files: [...new Set(rec.filter((r) => r.type === 'files').flatMap((r) => r.files || []))] });
    }
    return out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  }
}

/**
 * Wires the memory to the engine events: writes the session files, turns decisions and outcomes into
 * short memories, and remembers the user's approval mode choice.
 */
export function attachMemory(bus, store, { enabled = () => true } = {}) {
  return bus.on((e) => {
    const d = e.data || {};
    const job = e.jobId;
    try {
      switch (e.type) {
        case 'job.created': store.appendSession(job, { type: 'request', request: d.job?.request, approval: d.job?.approval }); break;
        case 'brief.approved': store.appendSession(job, { type: 'brief', source: d.source, text: d.text }); break;
        case 'worker.note':
          store.appendSession(job, { type: 'decision', workerId: d.workerId, text: d.text });
          if (enabled()) store.add({ text: `${d.workerId}: ${d.text}`, kind: 'decision', source: job });
          break;
        case 'file.changed': store.appendSession(job, { type: 'files', files: [d.path], op: d.op }); break;
        case 'job.done':
        case 'job.failed':
        case 'job.cancelled': {
          const status = e.type.slice(4);
          store.appendSession(job, { type: 'outcome', status, summary: d.summary || d.error || '' });
          const req = bus.state.jobs.find((j) => j.id === job)?.request || '';
          if (enabled() && req) store.add({ text: `Session ${job}: "${req.slice(0, 120)}" ${status}${d.files?.length ? `, files ${d.files.slice(0, 6).join(', ')}` : ''}.`, kind: 'session', source: job });
          break;
        }
        case 'job.report': store.appendSession(job, { type: 'report', report: d.report, improvedPrompt: d.improvedPrompt, nextPrompts: d.nextPrompts }); break;
        case 'settings.changed':
          if (enabled() && typeof d.approvalMode === 'boolean') store.add({ text: d.approvalMode ? 'Prefers approval mode on: ask before risky steps.' : 'Prefers automatic mode: the crew acts without asking.', scope: 'user', kind: 'preference' });
          break;
        default: break;
      }
    } catch { /* memory must never break the job */ }
  });
}
