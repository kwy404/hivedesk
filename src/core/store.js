// The state store by domain (PLAN.md section 1.3). Each domain is a pure reducer over the one log.
//   crew      src/replay/reduce.js   mounted at the root of bus.state (the 0.x shape, PROTOCOL.md section 5)
//   city      src/city/state.js      bus.state.city
//   tasks     src/tasks/state.js     bus.state.board (bus.state.tasks stays the 0.x crew task map)
// Other streams add theirs with registerDomain (peers, jobs, resources, workbench, remote).
import { initialState as initialCrew, reduce as reduceCrew } from '../replay/reduce.js';
import { initialCity, reduceCity } from '../city/state.js';
import { initialTasks, reduceTasks, TASKS_VERSION } from '../tasks/state.js';

/** Bump when a builtin reducer changes in a way that makes old snapshots wrong. */
export const STORE_VERSION = 1;

/**
 * @typedef {{
 *   name: string, version: number, mount: string,
 *   initial: (meta: object) => any, reduce: (state: any, event: any) => any,
 *   file?: string
 * }} Domain
 * mount: the key in bus.state ('' for the root, only the crew domain); file: the pure module the UI loads at /lib/<name>.js
 */

/** @type {Map<string, Domain>} */
const registry = new Map();

const RESERVED = new Set(['', 'city', 'board', 'tasks', 'jobs', 'crew', 'workers', 'settings', 'chat', 'files', 'brain', 'brains', 'queue', 'approvals']);

export function registerDomain(def) {
  if (!def || typeof def.name !== 'string' || !/^[a-z][a-z0-9_]{1,30}$/.test(def.name)) throw new Error('a domain needs a short lower case name');
  if (typeof def.reduce !== 'function' || typeof def.initial !== 'function') throw new Error(`domain ${def.name} needs initial and reduce`);
  const builtin = BUILTIN.some((b) => b.name === def.name);
  const mount = def.mount ?? def.name;
  if (!builtin && RESERVED.has(mount)) throw new Error(`domain ${def.name} cannot mount at "${mount}"`);
  registry.set(def.name, { version: 1, ...def, mount });
}

export function unregisterDomain(name) {
  if (BUILTIN.some((b) => b.name === name)) throw new Error('builtin domains stay');
  registry.delete(name);
}

export const BUILTIN = Object.freeze([
  { name: 'crew', version: 1, mount: '', initial: (meta) => initialCrew(meta), reduce: reduceCrew, file: 'src/replay/reduce.js' },
  { name: 'city', version: 1, mount: 'city', initial: () => initialCity(), reduce: reduceCity, file: 'src/city/state.js' },
  { name: 'tasks', version: TASKS_VERSION, mount: 'board', initial: () => initialTasks(), reduce: reduceTasks, file: 'src/tasks/state.js' }
]);
for (const d of BUILTIN) registry.set(d.name, d);

export function domains() {
  return [...registry.values()];
}

export class Store {
  /** @param {{ meta?: object, domains?: Domain[] }} [opts] */
  constructor(opts = {}) {
    this.meta = opts.meta || {};
    this.domains = (opts.domains || domains()).map((d) => ({ version: 1, ...d, mount: d.mount ?? d.name }));
    /** @type {Array<{ domain: string, seq: number, type: string, message: string }>} */
    this.errors = [];
    this.reset();
  }

  reset() {
    const crew = this.domains.find((d) => d.mount === '');
    this.state = crew ? crew.initial(this.meta) : {};
    for (const d of this.domains) if (d.mount !== '') this.state[d.mount] = d.initial(this.meta);
    return this;
  }

  /** The state of one domain by name. */
  get(name) {
    const d = this.domains.find((x) => x.name === name);
    if (!d) return undefined;
    return d.mount === '' ? this.state : this.state[d.mount];
  }

  apply(event) {
    for (const d of this.domains) {
      try {
        if (d.mount === '') d.reduce(this.state, event);
        else d.reduce(this.state[d.mount], event);
      } catch (err) {
        // A reducer must never break the log. The error is kept so tests and the doctor can see it.
        if (this.errors.length < 20) this.errors.push({ domain: d.name, seq: event.seq, type: event.type, message: String(err?.message || err) });
      }
    }
    return this.state;
  }

  replay(events, upto = Infinity) {
    for (const e of events) {
      if (e.seq > upto) break;
      this.apply(e);
    }
    return this.state;
  }

  /** What a snapshot keeps: each domain on its own, with the versions it was made with. */
  dump() {
    const mounts = new Set(this.domains.filter((d) => d.mount !== '').map((d) => d.mount));
    const state = {};
    for (const d of this.domains) {
      if (d.mount === '') {
        const root = {};
        for (const [k, v] of Object.entries(this.state)) if (!mounts.has(k)) root[k] = v;
        state[d.name] = root;
      } else {
        state[d.name] = this.state[d.mount];
      }
    }
    return { v: STORE_VERSION, domains: Object.fromEntries(this.domains.map((d) => [d.name, d.version])), state: JSON.parse(JSON.stringify(state)) };
  }

  /** True when the dump was made by this code: same store version and the same domains at the same versions. */
  accepts(dump) {
    if (!dump || dump.v !== STORE_VERSION || !dump.domains || !dump.state) return false;
    const want = Object.fromEntries(this.domains.map((d) => [d.name, d.version]));
    const keys = Object.keys(want);
    if (keys.length !== Object.keys(dump.domains).length) return false;
    return keys.every((k) => dump.domains[k] === want[k] && dump.state[k] && typeof dump.state[k] === 'object');
  }

  load(dump) {
    if (!this.accepts(dump)) return false;
    const copy = JSON.parse(JSON.stringify(dump.state));
    const crew = this.domains.find((d) => d.mount === '');
    this.state = crew ? copy[crew.name] : {};
    for (const d of this.domains) if (d.mount !== '') this.state[d.mount] = copy[d.name];
    return true;
  }
}
