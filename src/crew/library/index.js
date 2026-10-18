// The prompt library: expert playbooks (one JSON file per entry under entries/<category>/) that the
// crew picks per task (select.js) and puts in the prompt under <playbook>. Each entry also lists
// automatic checks (checks.js) that the QA and Test steps run. Your own entries and favorites live in
// ~/.hivedesk/library/ (one <id>.json per entry, favorites.json).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKS } from './checks.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BUILTIN_DIR = path.join(HERE, 'entries');
export const LIBRARY_VERSION = 1;

export const CATEGORIES = Object.freeze(['web-pages', 'ui-components', 'app-types', 'stacks', 'practices', 'git-docs', 'design', 'data', 'review-qa', 'planning', 'roles',
  'mobile', 'desktop', 'backend', 'security', 'devops', 'tools', 'games', 'custom']);
/** Who can use an entry: the builtin crew, the domain specialists (workers.js SPECIALISTS) and the Hive City roles. */
export const ROLE_IDS = Object.freeze(['mel', 'architect', 'dev', 'designer', 'qa', 'reviewer', 'writer', 'ops', 'mobile', 'desktop', 'backend', 'security', 'data', 'devops']);
export const PROMPT_SECTIONS = Object.freeze(['Steps:', 'Quality bar:', 'Pitfalls:', 'Verify:', 'Output:']);
export const SIZE_MIN = 120;
export const SIZE_MAX = 450;

/** Same estimate as the prompt assembly (about 3.5 characters per token). */
export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 3.5);
}

/** The library role of a worker: builtin ids as they are, hired workers from their role text. */
export function roleOf(worker) {
  if (!worker) return null;
  if (typeof worker === 'string') return ROLE_IDS.includes(worker) ? worker : roleOf({ role: worker });
  if (ROLE_IDS.includes(worker.id)) return worker.id;
  const r = String(worker.role || worker.name || '').toLowerCase();
  if (/(mobile|android|ios|phone app)/.test(r)) return 'mobile';
  if (/desktop/.test(r)) return 'desktop';
  if (/back ?end|api|server/.test(r)) return 'backend';
  if (/secur|audit|pentest/.test(r)) return 'security';
  if (/data|analyst|etl|scrap/.test(r)) return 'data';
  if (/architect|plan|lead|foreman/.test(r)) return 'architect';
  if (/review/.test(r)) return 'reviewer';
  if (/\b(qa|test|check|quality)/.test(r)) return 'qa';
  if (/design|\bui\b|\bux\b|css|style/.test(r)) return 'designer';
  if (/doc|writ|copy|readme|seo|content/.test(r)) return 'writer';
  if (/ops|deploy|git|release|devops|infra/.test(r)) return 'ops';
  return 'dev';
}

/**
 * Problems with an entry, empty when it is valid.
 * @param {any} e
 * @param {{ user?: boolean }} [opts] user entries may use the "custom" category
 */
export function validateEntry(e, opts = {}) {
  const p = [];
  if (!e || typeof e !== 'object') return ['not an object'];
  const str = (k, min, max) => { if (typeof e[k] !== 'string' || e[k].trim().length < min || e[k].length > max) p.push(`${k}: a string of ${min} to ${max} characters`); };
  if (typeof e.id !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(e.id) || e.id.length > 64) p.push('id: lowercase words joined by hyphens, at most 64 characters');
  str('title', 3, 70);
  if (!CATEGORIES.includes(e.category) || (e.category === 'custom' && !opts.user)) p.push(`category: one of ${CATEGORIES.join(', ')}`);
  if (!Array.isArray(e.roles) || !e.roles.length || e.roles.some((r) => !ROLE_IDS.includes(r))) p.push(`roles: a non empty list of ${ROLE_IDS.join(', ')}`);
  if (!Array.isArray(e.tags) || e.tags.length < 3 || e.tags.length > 12 || e.tags.some((t) => typeof t !== 'string' || !t.trim() || t !== t.toLowerCase() || t.length > 40)) p.push('tags: 3 to 12 lowercase strings');
  str('when', 20, 260);
  if (!Array.isArray(e.inputs) || e.inputs.length > 8 || e.inputs.some((t) => typeof t !== 'string' || !t.trim())) p.push('inputs: a list of up to 8 strings');
  if (typeof e.prompt !== 'string') p.push('prompt: a string');
  else {
    for (const s of PROMPT_SECTIONS) if (!e.prompt.includes(s)) p.push(`prompt: missing the "${s}" section`);
    const n = estimateTokens(e.prompt);
    if (n < SIZE_MIN || n > SIZE_MAX) p.push(`prompt: ${n} tokens, keep it between ${SIZE_MIN} and ${SIZE_MAX}`);
    if (e.size !== n) p.push(`size: ${e.size} but the prompt is ${n} tokens`);
  }
  if (!Array.isArray(e.checks) || e.checks.some((c) => !CHECKS[c])) p.push(`checks: known check ids only (${(e.checks || []).filter((c) => !CHECKS[c]).join(', ')})`);
  else if (!e.checks.length && !['planning', 'custom'].includes(e.category)) p.push('checks: at least one check');
  if (!Array.isArray(e.examples) || e.examples.length !== 1 || typeof e.examples[0]?.input !== 'string' || typeof e.examples[0]?.output !== 'string' || !e.examples[0].input.trim() || !e.examples[0].output.trim()) p.push('examples: one { input, output } sketch');
  if (!Number.isInteger(e.version) || e.version < 1) p.push('version: an integer from 1');
  return p;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Every builtin entry, read from entries/<category>/<id>.json. */
export function loadBuiltin(dir = BUILTIN_DIR) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const cat of fs.readdirSync(dir).sort()) {
    const sub = path.join(dir, cat);
    if (!fs.statSync(sub).isDirectory()) continue;
    for (const f of fs.readdirSync(sub).sort()) {
      if (!f.endsWith('.json')) continue;
      const e = readJson(path.join(sub, f));
      if (e) out.push({ ...e, source: 'builtin', file: `${cat}/${f}` });
    }
  }
  return out;
}

export class Library {
  /** @param {{ builtinDir?: string, userDir?: string | null }} [opts] */
  constructor(opts = {}) {
    this.builtinDir = opts.builtinDir || BUILTIN_DIR;
    this.userDir = opts.userDir || null;
    this.rev = 0;
    /** @type {Map<string, any> | null} */
    this._map = null;
    this._favorites = null;
  }

  _load() {
    if (this._map) return this._map;
    const map = new Map();
    for (const e of loadBuiltin(this.builtinDir)) map.set(e.id, e);
    if (this.userDir && fs.existsSync(this.userDir)) {
      for (const f of fs.readdirSync(this.userDir).sort()) {
        if (!f.endsWith('.json') || f === 'favorites.json') continue;
        const e = readJson(path.join(this.userDir, f));
        if (e && !validateEntry(e, { user: true }).length && !map.has(e.id)) map.set(e.id, { ...e, source: 'user' });
      }
    }
    this._map = map;
    return map;
  }

  all() { return [...this._load().values()]; }
  get(id) { return this._load().get(String(id)) || null; }
  get size() { return this._load().size; }

  favorites() {
    if (!this._favorites) {
      const f = this.userDir ? readJson(path.join(this.userDir, 'favorites.json')) : null;
      this._favorites = new Set(Array.isArray(f) ? f.filter((x) => typeof x === 'string') : []);
    }
    return this._favorites;
  }

  setFavorite(id, on = true) {
    if (!this.get(id)) throw Object.assign(new Error(`no library entry ${id}`), { code: 'not_found' });
    const fav = this.favorites();
    if (on) fav.add(id); else fav.delete(id);
    if (this.userDir) {
      fs.mkdirSync(this.userDir, { recursive: true });
      fs.writeFileSync(path.join(this.userDir, 'favorites.json'), JSON.stringify([...fav], null, 2));
    }
    this.rev++;
    return [...fav];
  }

  /**
   * Adds (or replaces) one of your own entries. The id gets a "my-" prefix, size and version are filled in.
   * @returns {any} the saved entry
   */
  add(input) {
    const base = String(input?.id || input?.title || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56);
    const id = base.startsWith('my-') ? base : `my-${base}`;
    const prompt = String(input?.prompt || '').trim();
    const e = {
      id, title: String(input?.title || '').trim().slice(0, 70), category: CATEGORIES.includes(input?.category) ? input.category : 'custom',
      roles: Array.isArray(input?.roles) && input.roles.length ? input.roles.filter((r) => ROLE_IDS.includes(r)) : ['dev'],
      tags: (Array.isArray(input?.tags) ? input.tags : String(input?.tags || '').split(',')).map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 12),
      when: String(input?.when || '').trim().slice(0, 260), inputs: Array.isArray(input?.inputs) ? input.inputs.map(String).filter(Boolean).slice(0, 8) : [],
      prompt, checks: Array.isArray(input?.checks) ? input.checks.filter((c) => CHECKS[c]) : [],
      examples: [{ input: String(input?.examples?.[0]?.input || input?.exampleInput || 'a request').trim(), output: String(input?.examples?.[0]?.output || input?.exampleOutput || 'the result').trim() }],
      size: estimateTokens(prompt), version: Number.isInteger(input?.version) ? input.version : 1
    };
    const existing = this.get(id);
    if (existing && existing.source === 'builtin') throw Object.assign(new Error('that id belongs to a builtin entry'), { code: 'conflict' });
    const problems = validateEntry(e, { user: true });
    if (problems.length) throw Object.assign(new Error(`the entry is not valid: ${problems.join('; ')}`), { code: 'bad_request' });
    if (this.userDir) {
      fs.mkdirSync(this.userDir, { recursive: true });
      fs.writeFileSync(path.join(this.userDir, `${id}.json`), JSON.stringify(e, null, 2));
    }
    this._load().set(id, { ...e, source: 'user' });
    this.rev++;
    return { ...e, source: 'user' };
  }

  remove(id) {
    const e = this.get(id);
    if (!e) return false;
    if (e.source !== 'user') throw Object.assign(new Error('builtin entries cannot be removed'), { code: 'forbidden' });
    if (this.userDir) fs.rmSync(path.join(this.userDir, `${e.id}.json`), { force: true });
    this._load().delete(e.id);
    this.favorites().delete(e.id);
    this.rev++;
    return true;
  }

  /** Counts per category. */
  stats() {
    const out = {};
    for (const e of this.all()) out[e.category] = (out[e.category] || 0) + 1;
    return out;
  }
}

let shared = new Library();

/** The library the crew uses. */
export function getLibrary() {
  return shared;
}

/** Points the shared library at your folder of own entries (called once at startup). */
export function configureLibrary({ userDir = null, builtinDir } = {}) {
  shared = new Library({ userDir, builtinDir });
  return shared;
}

const HEAD = 'Follow these expert playbooks where they apply to your task.';
/** Tokens of the <playbook> frame around the entries. */
export const SECTION_OVERHEAD = estimateTokens(`<playbook>\n${HEAD}\n\n\n</playbook>`) + 1;

/**
 * One entry as it goes into a prompt: the title line and the instructions. Its checks are not listed
 * (they cost tokens); QA runs them and the worker sees the results.
 */
export function renderEntry(e) {
  return `Playbook "${e.title}" (${e.id}):\n${e.prompt.trim()}`;
}

/**
 * The <playbook> section for the selected entries, within maxTokens (entries that do not fit are left out).
 * @param {Array<{ id: string } | string>} picks
 * @param {{ maxTokens?: number, library?: Library }} [opts]
 * @returns {{ text: string, used: string[] } | null}
 */
export function playbookSection(picks, opts = {}) {
  const lib = opts.library || shared;
  const max = opts.maxTokens ?? Infinity;
  const parts = [];
  const used = [];
  let cost = SECTION_OVERHEAD;
  for (const p of picks || []) {
    const e = lib.get(typeof p === 'string' ? p : p.id);
    if (!e) continue;
    const text = renderEntry(e);
    const c = estimateTokens(text) + 1; // plus the blank line between entries
    if (cost + c > max) continue;
    cost += c;
    parts.push(text);
    used.push(e.id);
  }
  if (!parts.length) return null;
  return { text: `<playbook>\n${HEAD}\n\n${parts.join('\n\n')}\n</playbook>`, used };
}
