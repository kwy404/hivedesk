// hivedesk-extension.json: validation and the permission catalog (capability based).
import { ALL_TOOLS } from '../tools/index.js';

export const MANIFEST_FILE = 'hivedesk-extension.json';
export const MANIFEST_VERSION = 1;

const ID = /^[a-z][a-z0-9-]{1,39}$/;
const LOCAL_ID = /^[a-z][a-z0-9_-]{0,39}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const HOST = /^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$/;
const REL = /^(?!\/)(?!.*\.\.)(?!.*\\)[A-Za-z0-9._/-]{1,120}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Every capability an extension can ask for. `risk` drives the color of the install prompt.
 * `http.get:<host>` is parametric: one entry per host (or `*.host` for its subdomains).
 */
export const PERMISSIONS = {
  'workspace.read': { risk: 'medium', label: 'Read the files in the workspace' },
  'workspace.write': { risk: 'high', label: 'Create and change files in the workspace (shown as diffs, approvals apply)' },
  'http.get': { risk: 'high', label: 'Download data from {host} (HTTPS GET only)' },
  storage: { risk: 'low', label: 'Keep up to 64 KB of its own settings' },
  notify: { risk: 'low', label: 'Show notifications on the desktop' },
  'crew.chat': { risk: 'low', label: 'Post messages in #general' },
  'crew.roles': { risk: 'medium', label: 'Add workers to the crew' },
  'brain.ask': { risk: 'medium', label: 'Ask the model short questions (takes turns in the shared queue)' }
};

/** Builtin tools an extension worker may get, and the permission each one needs. */
export const ROLE_TOOLS = {
  list_files: 'workspace.read',
  read_file: 'workspace.read',
  check: 'workspace.read',
  preview: 'workspace.read',
  write_file: 'workspace.write',
  edit_file: 'workspace.write'
};

/** @returns {{ name: string, host?: string } | null} */
export function parsePermission(p) {
  if (typeof p !== 'string') return null;
  if (p.startsWith('http.get:')) {
    const host = p.slice('http.get:'.length).toLowerCase();
    return HOST.test(host) ? { name: 'http.get', host } : null;
  }
  return PERMISSIONS[p] ? { name: p } : null;
}

/** Human description of one permission string. */
export function describePermission(p) {
  const parsed = parsePermission(p);
  if (!parsed) return { permission: p, risk: 'high', label: `Unknown permission ${p}` };
  const def = PERMISSIONS[parsed.name];
  return { permission: p, risk: def.risk, label: def.label.replace('{host}', parsed.host || '') };
}

/** True when `granted` allows a GET to `url`'s host. */
export function hostAllowed(granted, url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  for (const p of granted) {
    const parsed = parsePermission(p);
    if (!parsed || parsed.name !== 'http.get') continue;
    if (parsed.host === host) return true;
    if (parsed.host.startsWith('*.') && host.endsWith(parsed.host.slice(1))) return true;
  }
  return false;
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * Validates a manifest and returns a normalized copy.
 * @param {any} m
 * @param {{ files?: (rel: string) => boolean }} [opts] files: tells whether a file exists in the extension folder
 * @returns {{ ok: boolean, errors: string[], warnings: string[], manifest: object | null }}
 */
export function validateManifest(m, opts = {}) {
  const errors = [];
  const warnings = [];
  const exists = opts.files || (() => true);
  if (!isObj(m)) return { ok: false, errors: ['the manifest must be a JSON object'], warnings, manifest: null };
  if (m.manifest !== MANIFEST_VERSION) errors.push(`"manifest" must be ${MANIFEST_VERSION}`);
  if (typeof m.id !== 'string' || !ID.test(m.id)) errors.push('"id" must be 2 to 40 lowercase letters, digits or dashes, starting with a letter');
  if (!str(m.name, 60)) errors.push('"name" is required');
  if (typeof m.version !== 'string' || !SEMVER.test(m.version)) errors.push('"version" must look like 1.0.0');
  if (!str(m.description, 300)) errors.push('"description" is required');
  const author = isObj(m.author) ? str(m.author.name, 80) : str(m.author, 80);
  if (!author) errors.push('"author" is required');

  const permissions = [];
  if (m.permissions != null && !Array.isArray(m.permissions)) errors.push('"permissions" must be a list');
  for (const p of Array.isArray(m.permissions) ? m.permissions : []) {
    if (!parsePermission(p)) errors.push(`unknown permission "${p}"`);
    else if (!permissions.includes(p)) permissions.push(p);
  }
  const has = (p) => permissions.includes(p);

  const checkFile = (rel, what) => {
    if (typeof rel !== 'string' || !REL.test(rel)) { errors.push(`${what} must be a relative path inside the extension`); return null; }
    if (!exists(rel)) errors.push(`${what} "${rel}" does not exist`);
    return rel;
  };

  const main = m.main == null ? null : checkFile(m.main, '"main"');
  if (main && !/\.m?js$/.test(main)) errors.push('"main" must be an ES module (.js or .mjs)');

  const c = isObj(m.contributes) ? m.contributes : {};
  if (m.contributes != null && !isObj(m.contributes)) errors.push('"contributes" must be an object');
  const seen = new Set();
  const uniq = (kind, id) => {
    const k = `${kind}:${id}`;
    if (seen.has(k)) errors.push(`duplicate ${kind} id "${id}"`);
    seen.add(k);
  };

  const tools = [];
  for (const [i, t] of (Array.isArray(c.tools) ? c.tools : []).entries()) {
    const at = `contributes.tools[${i}]`;
    if (!isObj(t) || !LOCAL_ID.test(t.id || '')) { errors.push(`${at}.id must be a short lowercase name`); continue; }
    if (ALL_TOOLS.includes(t.id) || ['say', 'done', 'report'].includes(t.id)) errors.push(`${at}.id "${t.id}" is a builtin tool name`);
    uniq('tool', t.id);
    if (!str(t.description, 300)) errors.push(`${at}.description is required`);
    const params = isObj(t.parameters) ? t.parameters : { type: 'object', properties: {}, required: [], additionalProperties: false };
    if (params.type !== 'object' || (params.properties != null && !isObj(params.properties))) errors.push(`${at}.parameters must be an object schema`);
    tools.push({ id: t.id, description: str(t.description, 300), parameters: params, destructive: !!t.destructive });
  }
  if (tools.length && !main) errors.push('tools need a "main" module that exports them');

  const roles = [];
  for (const [i, r] of (Array.isArray(c.roles) ? c.roles : []).entries()) {
    const at = `contributes.roles[${i}]`;
    if (!isObj(r) || !LOCAL_ID.test(r.id || '')) { errors.push(`${at}.id must be a short lowercase name`); continue; }
    uniq('role', r.id);
    if (!str(r.name, 32)) errors.push(`${at}.name is required`);
    if (!str(r.role, 64)) errors.push(`${at}.role is required`);
    if (!str(r.prompt, 2000)) errors.push(`${at}.prompt is required`);
    const list = Array.isArray(r.tools) ? r.tools : ['list_files', 'read_file'];
    for (const tool of list) {
      if (ROLE_TOOLS[tool]) { if (!has(ROLE_TOOLS[tool])) errors.push(`${at} uses ${tool}, which needs the "${ROLE_TOOLS[tool]}" permission`); }
      else if (ALL_TOOLS.includes(tool)) errors.push(`${at} cannot use the builtin tool ${tool}`);
      else if (!tools.some((t) => t.id === tool)) errors.push(`${at} uses an unknown tool ${tool}`);
    }
    roles.push({
      id: r.id, name: str(r.name, 32), role: str(r.role, 64), prompt: str(r.prompt, 2000),
      color: HEX.test(r.color || '') ? r.color : '#E8C27A', avatar: str(r.avatar, 2) || str(r.name, 1).toUpperCase(), tools: list
    });
  }
  if (roles.length && !has('crew.roles')) errors.push('roles need the "crew.roles" permission');

  const widgets = [];
  for (const [i, w] of (Array.isArray(c.widgets) ? c.widgets : []).entries()) {
    const at = `contributes.widgets[${i}]`;
    if (!isObj(w) || !LOCAL_ID.test(w.id || '')) { errors.push(`${at}.id must be a short lowercase name`); continue; }
    uniq('widget', w.id);
    if (!str(w.title, 60)) errors.push(`${at}.title is required`);
    const entry = checkFile(w.entry, `${at}.entry`);
    if (entry && !/\.html?$/.test(entry)) errors.push(`${at}.entry must be an .html file`);
    const size = Array.isArray(w.size) && w.size.length === 2 && w.size.every((n) => Number.isFinite(n)) ? w.size.map((n) => Math.round(Math.min(1200, Math.max(220, n)))) : [380, 320];
    widgets.push({ id: w.id, title: str(w.title, 60), entry, size, icon: typeof w.icon === 'string' ? w.icon.slice(0, 24) : 'hive' });
  }

  const commands = [];
  for (const [i, cmd] of (Array.isArray(c.commands) ? c.commands : []).entries()) {
    const at = `contributes.commands[${i}]`;
    if (!isObj(cmd) || !LOCAL_ID.test(cmd.id || '')) { errors.push(`${at}.id must be a short lowercase name`); continue; }
    uniq('command', cmd.id);
    if (!str(cmd.title, 80)) errors.push(`${at}.title is required`);
    const a = isObj(cmd.action) ? cmd.action : {};
    let action = null;
    if (a.type === 'widget' && typeof a.widget === 'string') {
      if (!widgets.some((w) => w.id === a.widget)) errors.push(`${at} opens an unknown widget ${a.widget}`);
      action = { type: 'widget', widget: a.widget };
    } else if (a.type === 'tool' && typeof a.tool === 'string') {
      if (!tools.some((t) => t.id === a.tool)) errors.push(`${at} runs an unknown tool ${a.tool}`);
      action = { type: 'tool', tool: a.tool, args: isObj(a.args) ? a.args : {} };
    } else if (a.type === 'job' && str(a.request, 2000)) {
      action = { type: 'job', request: str(a.request, 2000) };
    } else if (a.type === 'theme' && typeof a.theme === 'string') {
      action = { type: 'theme', theme: a.theme };
    } else {
      errors.push(`${at}.action must be { type: "widget" | "tool" | "job" | "theme", ... }`);
    }
    commands.push({ id: cmd.id, title: str(cmd.title, 80), action });
  }

  const themes = [];
  for (const [i, t] of (Array.isArray(c.themes) ? c.themes : []).entries()) {
    const rel = checkFile(t, `contributes.themes[${i}]`);
    if (rel && !/\.json$/.test(rel)) errors.push(`contributes.themes[${i}] must be a .json file`);
    if (rel) themes.push(rel);
  }

  if (!tools.length && !roles.length && !widgets.length && !commands.length && !themes.length) warnings.push('this extension contributes nothing yet');
  for (const k of Object.keys(m)) {
    if (!['manifest', 'id', 'name', 'version', 'author', 'description', 'permissions', 'main', 'contributes', 'homepage', 'engines', 'icon', 'license'].includes(k)) warnings.push(`unknown key "${k}" is ignored`);
  }

  const manifest = {
    manifest: MANIFEST_VERSION, id: m.id, name: str(m.name, 60), version: m.version, author, description: str(m.description, 300),
    permissions, main, contributes: { tools, roles, widgets, commands, themes }
  };
  if (typeof m.homepage === 'string' && /^https:\/\//.test(m.homepage)) manifest.homepage = m.homepage.slice(0, 200);
  return { ok: errors.length === 0, errors, warnings, manifest: errors.length ? null : manifest };
}
