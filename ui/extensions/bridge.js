// The widget frame contract: the document a widget runs in (sandboxed, opaque origin, strict
// CSP, no network) and the validation of every message it posts to the desktop.
// Pure functions with no DOM access, shared by the desktop and the tests.

export const API_VERSION = 1;
export const MAX_MESSAGE = 64 * 1024;

const ID = /^[A-Za-z0-9_-]{1,40}$/;
const TOOL = /^[a-z][a-z0-9_-]{0,39}$/;

/** Message types a widget may send, with the allowed keys of `data`. */
export const TYPES = {
  ready: [],
  call: ['tool', 'args'],
  'storage.get': ['key'],
  'storage.set': ['key', 'value'],
  notify: ['title', 'body'],
  resize: ['height']
};

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function size(v) {
  try { return JSON.stringify(v).length; } catch { return Infinity; }
}

/**
 * Checks a message from a widget frame. Anything that is not exactly the documented shape is
 * rejected, so a widget cannot reach more than its manifest allows.
 * @returns {{ ok: true, msg: { id: string, type: string, data: object } } | { ok: false, error: string, id?: string }}
 */
export function validateWidgetMessage(m) {
  if (!isObj(m)) return { ok: false, error: 'not an object' };
  if (m.hd !== API_VERSION) return { ok: false, error: 'not a hivedesk message' };
  const id = typeof m.id === 'string' && ID.test(m.id) ? m.id : undefined;
  if (!id) return { ok: false, error: 'bad id' };
  const bad = (error) => ({ ok: false, error, id });
  for (const k of Object.keys(m)) if (!['hd', 'id', 'type', 'data'].includes(k)) return bad(`unknown key ${k}`);
  if (typeof m.type !== 'string' || !Object.prototype.hasOwnProperty.call(TYPES, m.type)) return bad(`unknown type ${String(m.type).slice(0, 40)}`);
  const data = m.data === undefined ? {} : m.data;
  if (!isObj(data)) return bad('data must be an object');
  if (size(data) > MAX_MESSAGE) return bad('message too large');
  for (const k of Object.keys(data)) if (!TYPES[m.type].includes(k)) return bad(`unknown field ${k} for ${m.type}`);
  switch (m.type) {
    case 'call':
      if (typeof data.tool !== 'string' || !TOOL.test(data.tool)) return bad('tool must be a tool id of this extension');
      if (data.args !== undefined && !isObj(data.args)) return bad('args must be an object');
      return { ok: true, msg: { id, type: m.type, data: { tool: data.tool, args: data.args || {} } } };
    case 'storage.get':
      if (data.key !== undefined && (typeof data.key !== 'string' || data.key.length > 100)) return bad('key must be a short string');
      return { ok: true, msg: { id, type: m.type, data: data.key === undefined ? {} : { key: data.key } } };
    case 'storage.set':
      if (typeof data.key !== 'string' || !data.key || data.key.length > 100) return bad('key must be a short string');
      if (size(data.value ?? null) > 16 * 1024) return bad('value too large');
      return { ok: true, msg: { id, type: m.type, data: { key: data.key, value: data.value ?? null } } };
    case 'notify':
      if (typeof data.title !== 'string' || !data.title.trim()) return bad('title is required');
      if (data.body !== undefined && typeof data.body !== 'string') return bad('body must be a string');
      return { ok: true, msg: { id, type: m.type, data: { title: data.title.slice(0, 120), body: String(data.body || '').slice(0, 500) } } };
    case 'resize':
      if (typeof data.height !== 'number' || !Number.isFinite(data.height)) return bad('height must be a number');
      return { ok: true, msg: { id, type: m.type, data: { height: Math.round(Math.min(2000, Math.max(40, data.height))) } } };
    default:
      return { ok: true, msg: { id, type: m.type, data: {} } };
  }
}

/** The permission a widget message needs, or null when it needs none. */
export function permissionFor(type) {
  if (type === 'storage.get' || type === 'storage.set') return 'storage';
  if (type === 'notify') return 'notify';
  return null;
}

export const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; worker-src 'none'";

/** Theme variables a widget can read (also sent again on every theme change). */
export const WIDGET_VARS = ['--hd-bg', '--hd-panel', '--hd-panel-2', '--hd-line', '--hd-text', '--hd-muted', '--hd-accent', '--hd-accent-ink', '--hd-ok', '--hd-bad', '--hd-font', '--hd-mono', '--hd-radius'];

/** The script that defines `window.hivedesk` inside the frame. Runs before the widget's own code. */
export const BOOTSTRAP = `(function () {
  var seq = 0, waits = {}, subs = {};
  function post(type, data) {
    return new Promise(function (resolve, reject) {
      var id = 'w' + (++seq);
      waits[id] = { resolve: resolve, reject: reject };
      parent.postMessage({ hd: 1, id: id, type: type, data: data || {} }, '*');
    });
  }
  function vars(v) { var s = document.documentElement.style; for (var k in v) if (k.indexOf('--hd-') === 0) s.setProperty(k, String(v[k])); }
  addEventListener('message', function (e) {
    if (e.source !== parent) return;
    var m = e.data;
    if (!m || m.hd !== 1) return;
    if (m.type === 'reply') {
      var w = waits[m.id]; if (!w) return; delete waits[m.id];
      if (m.ok) w.resolve(m.result); else w.reject(new Error(m.error || 'failed'));
    } else if (m.type === 'theme') {
      vars(m.data || {});
      (subs.theme || []).forEach(function (fn) { try { fn(m.data); } catch (err) { console.error(err); } });
    }
  });
  window.hivedesk = Object.freeze({
    version: 1,
    call: function (tool, args) { return post('call', { tool: tool, args: args || {} }); },
    storage: Object.freeze({
      get: function (key) { return post('storage.get', key === undefined ? {} : { key: key }); },
      set: function (key, value) { return post('storage.set', { key: key, value: value === undefined ? null : value }); }
    }),
    notify: function (title, body) { return post('notify', { title: String(title), body: body == null ? '' : String(body) }); },
    resize: function (height) { return post('resize', { height: height }); },
    on: function (name, fn) { (subs[name] = subs[name] || []).push(fn); }
  });
  post('ready', {});
})();`;

// Colors, lengths and font lists only: no braces, semicolons or angle brackets.
const SAFE_VALUE = /^[#\w\s,.%()"'/-]{1,300}$/;
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const safeScript = (s) => String(s).replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
const safeStyle = (s) => String(s).replace(/<\/style/gi, '<\\/style');

/**
 * Builds the srcdoc of a widget frame: the CSP first, the theme variables, the bootstrap,
 * then the widget's HTML with its linked scripts and styles inlined (other links are dropped).
 * @param {{ html: string, files?: Record<string,string>, vars?: Record<string,string>, title?: string }} w
 */
export function buildSrcdoc({ html, files = {}, vars = {}, title = '' }) {
  let body = String(html || '');
  body = body.replace(/<script([^>]*)\ssrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (all, a, src) => {
    const code = Object.prototype.hasOwnProperty.call(files, src) ? files[src] : null;
    if (code == null) return '';
    const mod = /type=["']module["']/i.test(a) ? ' type="module"' : '';
    return `<script${mod}>${safeScript(code)}</script>`;
  });
  body = body.replace(/<link([^>]*)>/gi, (all, a) => {
    const href = (a.match(/\shref=["']([^"']+)["']/i) || [])[1];
    if (!/rel=["']?stylesheet/i.test(a) || !href || !Object.prototype.hasOwnProperty.call(files, href)) return '';
    return `<style>${safeStyle(files[href])}</style>`;
  });
  // A widget may not loosen the policy or point the document somewhere else.
  body = body.replace(/<base[^>]*>/gi, '');
  const rootVars = Object.entries(vars).filter(([k, v]) => /^--hd-[a-z0-9-]+$/.test(k) && SAFE_VALUE.test(String(v))).map(([k, v]) => `${k}:${v}`).join(';');
  const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escAttr(CSP)}"><meta name="referrer" content="no-referrer">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">${title ? `<title>${escAttr(title)}</title>` : ''}` +
    `<style>:root{${rootVars}}html,body{background:transparent;color:var(--hd-text);font-family:var(--hd-font, system-ui, sans-serif)}</style>` +
    `<script>${BOOTSTRAP}</script>`;
  if (/<head[^>]*>/i.test(body)) return body.replace(/<head[^>]*>/i, (m) => `${m}${head}`);
  if (/<html[^>]*>/i.test(body)) return body.replace(/<html[^>]*>/i, (m) => `${m}<head>${head}</head>`);
  return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
}
