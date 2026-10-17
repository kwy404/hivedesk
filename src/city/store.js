// Hive City on disk.
//   <home>/city/machine.json         this machine's stable id and name
//   <home>/city/agents/<id>.json     one persistent agent per file, with its full private memory
//   <dir>/.hivedesk/city/snapshot.json  the last city snapshot of this project and its seq (a cache for city.sync)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/** Agent ids become file names: keep them to a safe set of characters. */
export function agentFileName(id) {
  return `${String(id).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80)}.json`;
}

export class CityStore {
  /** @param {{ home?: string | null, projectDir?: string | null }} opts home: the shared cache (~/.hivedesk); projectDir: <dir>/.hivedesk/city */
  constructor(opts = {}) {
    this.root = opts.home ? path.join(opts.home, 'city') : null;
    this.projectDir = opts.projectDir || null;
    this._machine = null;
  }

  /** This machine's card, created once: { id: "m_" + 8 hex, name }. */
  machine() {
    if (this._machine) return this._machine;
    const file = this.root ? path.join(this.root, 'machine.json') : null;
    let m = file ? readJson(file, null) : null;
    if (!m || typeof m.id !== 'string' || !/^m_[0-9a-f]{8}$/.test(m.id)) {
      m = { id: `m_${crypto.randomBytes(4).toString('hex')}`, name: 'My PC', createdAt: new Date().toISOString() };
      if (file) { try { writeJson(file, m); } catch { /* read only home: the id lives for this run */ } }
    }
    this._machine = m;
    return m;
  }

  setMachineName(name) {
    const m = { ...this.machine(), name: String(name).slice(0, 40) };
    this._machine = m;
    if (this.root) { try { writeJson(path.join(this.root, 'machine.json'), m); } catch { /* ignore */ } }
    return m;
  }

  agentsDir() {
    return this.root ? path.join(this.root, 'agents') : null;
  }

  /** Every agent saved on this machine. */
  loadAgents() {
    const dir = this.agentsDir();
    if (!dir || !fs.existsSync(dir)) return [];
    const out = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const a = readJson(path.join(dir, f), null);
      if (a && typeof a.id === 'string') out.push(a);
    }
    return out;
  }

  loadAgent(id) {
    const dir = this.agentsDir();
    return dir ? readJson(path.join(dir, agentFileName(id)), null) : null;
  }

  saveAgent(agent) {
    const dir = this.agentsDir();
    if (!dir || !agent?.id) return false;
    try { writeJson(path.join(dir, agentFileName(agent.id)), { ...agent, savedAt: new Date().toISOString() }); return true; } catch { return false; }
  }

  loadSnapshot() {
    if (!this.projectDir) return null;
    const s = readJson(path.join(this.projectDir, 'snapshot.json'), null);
    return s && typeof s.seq === 'number' && s.city ? s : null;
  }

  saveSnapshot(seq, city) {
    if (!this.projectDir) return false;
    try { writeJson(path.join(this.projectDir, 'snapshot.json'), { seq, city }); return true; } catch { return false; }
  }
}
