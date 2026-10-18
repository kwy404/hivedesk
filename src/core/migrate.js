// Versions and migrations for files on disk (PLAN.md section 1.4 and 1.5).
// Every JSON file has `v`. A module registers one function per version step for the kinds of files it owns;
// readVersioned upgrades on read and writeVersioned writes the current version with a tmp file plus rename.
import fs from 'node:fs';
import path from 'node:path';
import { parseEvents } from './log.js';

/** @type {Map<string, { current: number, steps: Map<number, (data: any) => any> }>} */
const kinds = new Map();

/**
 * Registers the step that upgrades `kind` from version `from` to `from + 1`.
 * @param {string} kind
 * @param {number} from
 * @param {(data: any) => any} step
 */
export function registerMigration(kind, from, step) {
  const k = kinds.get(kind) || { current: 0, steps: new Map() };
  k.steps.set(from, step);
  k.current = Math.max(k.current, from + 1);
  kinds.set(kind, k);
}

/** Declares the current version of a kind that has had no migration yet. */
export function declareVersion(kind, v) {
  const k = kinds.get(kind) || { current: 0, steps: new Map() };
  k.current = Math.max(k.current, v);
  kinds.set(kind, k);
}

export function currentVersion(kind) {
  return kinds.get(kind)?.current ?? 0;
}

/**
 * Upgrades parsed data of `kind` to the current version. Files without `v` are version 0.
 * Data from a newer hivedesk is refused (code "too_new"), so an older build never rewrites it.
 */
export function migrateJson(kind, data) {
  const k = kinds.get(kind);
  if (!k) throw new Error(`no migrations are known for ${kind}`);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Object.assign(new Error(`${kind}: not a JSON object`), { code: 'bad_file' });
  let v = Number.isInteger(data.v) ? data.v : 0;
  if (v > k.current) throw Object.assign(new Error(`${kind} was written by a newer hivedesk (v${v}, this one knows v${k.current})`), { code: 'too_new' });
  let out = { ...data };
  while (v < k.current) {
    const step = k.steps.get(v);
    out = step ? step(out) : out;
    v += 1;
    out.v = v;
  }
  out.v = k.current;
  return out;
}

/** Writes JSON with a tmp file plus rename. */
export function writeJsonAtomic(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

/** Reads and upgrades a versioned file; `fallback` when it is missing or unreadable. A newer file throws. */
export function readVersioned(file, kind, fallback = null) {
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
  try {
    return migrateJson(kind, data);
  } catch (err) {
    if (err.code === 'too_new') throw err;
    return fallback;
  }
}

export function writeVersioned(file, kind, data, mode) {
  writeJsonAtomic(file, { ...data, v: currentVersion(kind) }, mode);
}

// ---------------------------------------------------------------- builtin kinds
// <project>/.hivedesk/meta.json: { v, layout, createdWith, migrations: [{ id, at, detail }] }
registerMigration('project', 0, (d) => ({ layout: 1, migrations: [], ...d }));
// <project>/.hivedesk/snapshots/<seq>.json is checked by the store version instead (src/core/store.js).

export const DEMO_EVENTS_FILE = 'demo-0.2.jsonl';

function readMeta(root) {
  return readVersioned(path.join(root, 'meta.json'), 'project', null) || migrateJson('project', {});
}

/**
 * Brings a project folder to the 1.0 layout before its log is opened. Idempotent.
 *   layout-1.0  events.jsonl stays as segment 0; new events go to events/<seq>.jsonl
 *   demo-0.2    a real project whose 0.2 log holds demo events: they move to events/demo-0.2.jsonl,
 *               and the caches built from them (state.json, city/snapshot.json, snapshots/) are dropped
 * @param {string} root the project's .hivedesk folder
 * @param {{ demo?: boolean, version?: string, now?: () => Date }} [opts]
 * @returns {{ applied: Array<{ id: string, detail: object }>, meta: object }}
 */
export function migrateProject(root, opts = {}) {
  const now = opts.now || (() => new Date());
  const meta = readMeta(root);
  const done = new Set((meta.migrations || []).map((m) => m.id));
  const applied = [];
  const legacy = path.join(root, 'events.jsonl');
  const segDir = path.join(root, 'events');

  if (!opts.demo && fs.existsSync(legacy)) {
    const text = fs.readFileSync(legacy, 'utf8');
    if (text.includes('"demo":true')) {
      const events = parseEvents(text);
      const demo = events.filter((e) => e.demo === true);
      if (demo.length) {
        const keep = events.filter((e) => e.demo !== true);
        const demoFile = path.join(segDir, DEMO_EVENTS_FILE);
        fs.mkdirSync(segDir, { recursive: true });
        // First the copy, then the rewrite: a crash in between leaves both, and the next start finishes the job.
        let earlier = [];
        try { earlier = parseEvents(fs.readFileSync(demoFile, 'utf8')); } catch { /* first time */ }
        const bySeq = new Map([...earlier, ...demo].map((e) => [e.seq, e]));
        const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
        const tmpDemo = `${demoFile}.${process.pid}.tmp`;
        fs.writeFileSync(tmpDemo, merged.map((e) => JSON.stringify(e)).join('\n') + '\n');
        fs.renameSync(tmpDemo, demoFile);
        const tmp = `${legacy}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, keep.length ? keep.map((e) => JSON.stringify(e)).join('\n') + '\n' : '');
        fs.renameSync(tmp, legacy);
        for (const f of [path.join(root, 'state.json'), path.join(root, 'city', 'snapshot.json')]) { try { fs.unlinkSync(f); } catch { /* not there */ } }
        try { for (const f of fs.readdirSync(path.join(root, 'snapshots'))) fs.unlinkSync(path.join(root, 'snapshots', f)); } catch { /* none */ }
        const machines = [...new Set(demo.filter((e) => e.type === 'city.machine.joined' && e.data?.machine?.id).map((e) => e.data.machine.id))];
        applied.push({ id: 'demo-0.2', detail: { moved: demo.length, kept: keep.length, file: `events/${DEMO_EVENTS_FILE}`, machines } });
      }
    }
  }
  if (!done.has('layout-1.0')) applied.push({ id: 'layout-1.0', detail: { segment0: fs.existsSync(legacy) ? 'events.jsonl' : null } });

  if (applied.length) {
    const at = now().toISOString();
    meta.migrations = [...(meta.migrations || []), ...applied.map((a) => ({ id: a.id, at, detail: a.detail }))].slice(-50);
    meta.layout = 2;
    if (!meta.createdWith && opts.version) meta.createdWith = opts.version;
    writeVersioned(path.join(root, 'meta.json'), 'project', meta);
  }
  return { applied, meta };
}
