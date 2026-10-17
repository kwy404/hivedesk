import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventBus } from '../src/bus.js';
import { Scheduler } from '../src/crew/scheduler.js';
import { Hive } from '../src/crew/engine.js';
import { ToolBox, Workspace, TOOLS, ALL_TOOLS } from '../src/tools/index.js';
import { Approvals } from '../src/tools/approvals.js';
import { PlaybookStore } from '../src/playbooks/index.js';
import { createFakeBrain } from '../src/brain/fake.js';
import { validateManifest, hostAllowed, describePermission, MANIFEST_FILE } from '../src/extensions/manifest.js';
import { writeZip, readZip } from '../src/extensions/zip.js';
import { detectIntent, guessSpec } from '../src/extensions/intent.js';
import register from '../src/extensions/index.js';
import { validateWidgetMessage, buildSrcdoc, permissionFor, CSP } from '../ui/extensions/bridge.js';
import { BASE } from '../ui/themes/core.js';
import { tmpDir, waitFor } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES = path.join(ROOT, 'extensions');

const userTask = (messages) => (messages.find((m) => m.role === 'user')?.content.match(/Your task: ([^\n]+)/) || [])[1];
const step = (messages) => messages.filter((m) => m.role === 'assistant').length;

/** A brain that answers every engine schema; `build` scripts the build task's actions. */
function scripted(build, extra = {}) {
  return (messages, options) => {
    const s = options.schema || {};
    if (extra.theme && s.properties?.colors) return extra.theme;
    if (s.properties?.tasks) return { summary: 'one task', tasks: [{ title: 'Build it', detail: 'finish the files', assignee: 'dev', dependsOn: [] }] };
    if (s.properties?.improvedPrompt) return { improvedPrompt: 'Build it again, better.', nextPrompts: ['one', 'two'] };
    if (s.oneOf?.some((o) => o.properties?.tool?.const === 'report')) return { tool: 'report', args: { passed: true, findings: [] } };
    if (userTask(messages) === 'Build it') return build[step(messages)] || { tool: 'done', args: { summary: 'built' } };
    return { tool: 'done', args: { summary: 'ok' } };
  };
}

const live = [];
afterEach(async () => { for (const t of live.splice(0)) await t.close(); });

function setup(opts = {}) {
  const dir = tmpDir();
  const home = path.join(dir, 'home');
  const bus = new EventBus();
  bus.emit('settings.changed', { refine: false, approvalMode: opts.approvalMode ?? false });
  const scheduler = new Scheduler(bus);
  const approvals = new Approvals(bus);
  const ws = new Workspace(path.join(dir, 'ws'));
  const toolbox = new ToolBox({ workspace: ws, bus, approvals });
  const playbooks = new PlaybookStore(path.join(dir, 'pb'));
  const hive = new Hive({ bus, scheduler, toolbox, approvals, playbooks });
  hive.init();
  if (opts.respond) scheduler.addBrain(createFakeBrain({ respond: opts.respond }));
  const commands = new Map();
  const routes = [];
  const server = { command: (type, fn) => commands.set(type, fn), route: (method, p, fn) => routes.push({ method, p, fn }) };
  const plugin = register({ scheduler, bus, server, hive, toolbox, home, watch: opts.watch ?? false, fetch: opts.fetch, builtinExtensions: opts.examples === false ? path.join(dir, 'none') : EXAMPLES, sandbox: opts.sandbox });
  const cmd = async (type, data = {}) => {
    const fn = commands.get(type);
    if (!fn) throw new Error(`no command ${type}`);
    return fn(data, null);
  };
  const t = {
    dir, home, bus, scheduler, approvals, ws, toolbox, hive, plugin, host: plugin.host, cmd, routes,
    events: (type) => bus.events.filter((e) => e.type === type),
    async close() { plugin.close(); await hive.close?.(); await scheduler.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  };
  live.push(t);
  return t;
}

/** Writes an extension folder and returns its path. */
function makeExt(dir, manifest, files = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

const probe = (permissions = []) => ({
  manifest: 1, id: 'probe', name: 'Probe', version: '1.0.0', author: 'tests', description: 'Calls capabilities.', permissions, main: 'main.js',
  contributes: {
    tools: [
      { id: 'peek', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
      { id: 'fetch', description: 'download', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false } },
      { id: 'escape', description: 'try to leave the sandbox', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } }
    ]
  }
});
const PROBE_CODE = {
  'main.js': `import { tag } from './lib/tag.js';
export const tools = {
  async peek(args, api) { return tag(await api.workspace.read(args.path)); },
  async fetch(args, api) { const r = await api.http.get(args.url); return r.status + ' ' + r.text; },
  async escape() {
    const out = [];
    out.push(typeof process, typeof require, typeof fetch, typeof globalThis.setTimeout);
    try { await import('node:fs'); out.push('imported'); } catch (e) { out.push('no import'); }
    try { eval('1'); out.push('eval'); } catch (e) { out.push('no eval'); }
    return out.join(',');
  }
};`,
  'lib/tag.js': 'export const tag = (s) => `[${s}]`;'
};

describe('manifest validation', () => {
  it('accepts the three built-in examples', () => {
    for (const name of ['tradutor', 'seo-check', 'pomodoro']) {
      const dir = path.join(EXAMPLES, name);
      const raw = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8'));
      const v = validateManifest(raw, { files: (rel) => fs.existsSync(path.join(dir, rel)) });
      expect(v.errors, name).toEqual([]);
      expect(v.manifest.id).toBe(name);
    }
  });

  it('reports every problem with a clear message', () => {
    const v = validateManifest({
      manifest: 1, id: 'Bad Id', name: '', version: 'one', author: '', description: '',
      permissions: ['workspace.read', 'root.shell', 'http.get:not a host'],
      contributes: {
        tools: [{ id: 'write_file', description: 'x' }, { id: 'ok_tool', description: 'y' }],
        roles: [{ id: 'r', name: 'R', role: 'r', prompt: 'p', tools: ['write_file', 'run', 'nope'] }],
        widgets: [{ id: 'w', title: 'W', entry: '../outside.html' }, { id: 'v', title: 'V', entry: 'missing.js' }],
        commands: [{ id: 'c', title: 'C', action: { type: 'widget', widget: 'ghost' } }, { id: 'd', title: 'D', action: { type: 'shell' } }]
      }
    }, { files: (rel) => rel !== 'missing.js' });
    expect(v.ok).toBe(false);
    const all = v.errors.join('\n');
    for (const bit of ['"id" must be', '"name" is required', '"version" must look like', '"author" is required', '"description" is required',
      'unknown permission "root.shell"', 'unknown permission "http.get:not a host"', '"write_file" is a builtin tool name', 'tools need a "main"',
      'uses write_file, which needs the "workspace.write" permission', 'cannot use the builtin tool run', 'unknown tool nope', 'roles need the "crew.roles" permission',
      'must be a relative path inside the extension', '"missing.js" does not exist', 'must be an .html file', 'opens an unknown widget ghost', '.action must be']) {
      expect(all).toContain(bit);
    }
    expect(validateManifest('x').ok).toBe(false);
    expect(validateManifest({ manifest: 2 }).errors[0]).toMatch(/"manifest" must be 1/);
  });

  it('describes permissions and matches allowed hosts exactly', () => {
    expect(describePermission('http.get:api.open-meteo.com').label).toContain('api.open-meteo.com');
    expect(describePermission('workspace.write').risk).toBe('high');
    expect(hostAllowed(['http.get:api.example.com'], 'https://api.example.com/x')).toBe(true);
    expect(hostAllowed(['http.get:api.example.com'], 'https://evil.example.com/x')).toBe(false);
    expect(hostAllowed(['http.get:api.example.com'], 'https://api.example.com.evil.io/x')).toBe(false);
    expect(hostAllowed(['http.get:*.example.com'], 'https://a.b.example.com/')).toBe(true);
    expect(hostAllowed(['workspace.read'], 'https://api.example.com/')).toBe(false);
  });
});

describe('install, permissions and the sandbox', () => {
  it('stages a folder, runs nothing before approval, then enforces every permission', async () => {
    const t = setup({ examples: false });
    t.ws.write('secret.txt', 'hello');
    const src = makeExt(path.join(t.dir, 'probe'), probe([]), PROBE_CODE);
    const staged = await t.cmd('extensions.install', { path: src });
    expect(staged.needsApproval).toBe(true);
    expect(staged.extension.pending).toBe(true);
    expect(TOOLS['probe.peek']).toBeUndefined();
    await expect(t.cmd('extensions.call', { id: 'probe', tool: 'peek', args: { path: 'secret.txt' } })).rejects.toThrow(/not enabled/);
    await expect(t.cmd('extensions.enable', { id: 'probe' })).rejects.toThrow(/approve/);

    await t.cmd('extensions.approve', { id: 'probe' });
    expect(TOOLS['probe.peek']).toBeTruthy();
    // No permission: the capability is refused and the refusal is logged.
    await expect(t.cmd('extensions.call', { id: 'probe', tool: 'peek', args: { path: 'secret.txt' } })).rejects.toThrow(/permission denied: probe was not given "workspace.read"/);
    expect(t.events('extension.denied').at(-1).data).toMatchObject({ id: 'probe', permission: 'workspace.read' });
    // Arguments are checked against the tool schema before any code runs.
    await expect(t.cmd('extensions.call', { id: 'probe', tool: 'peek', args: {} })).rejects.toThrow(/bad arguments/);
    await expect(t.cmd('extensions.call', { id: 'probe', tool: 'nothing', args: {} })).rejects.toThrow(/no tool/);
    // The sandbox has no Node globals, no imports from outside and no eval.
    const esc = await t.cmd('extensions.call', { id: 'probe', tool: 'escape', args: {} });
    expect(esc.result).toBe('undefined,undefined,undefined,undefined,no import,no eval');
  });

  it('allows a capability once granted, and takes it back on revoke', async () => {
    const t = setup({ examples: false });
    t.ws.write('secret.txt', 'hello');
    await t.cmd('extensions.install', { path: makeExt(path.join(t.dir, 'probe'), probe(['workspace.read']), PROBE_CODE) });
    await t.cmd('extensions.approve', { id: 'probe' });
    expect((await t.cmd('extensions.call', { id: 'probe', tool: 'peek', args: { path: 'secret.txt' } })).result).toBe('[hello]');
    // Workers reach it through the normal toolbox, and only when it is in their tools list.
    const asDev = await t.toolbox.execute('probe.peek', { path: 'secret.txt' }, { workerId: 'dev', allowed: ['read_file'] });
    expect(asDev.ok).toBe(false);
    expect(asDev.error).toMatch(/not allowed/);
    const allowed = await t.toolbox.execute('probe.peek', { path: 'secret.txt' }, { workerId: 'w_x', allowed: ['probe.peek'] });
    expect(allowed).toMatchObject({ ok: true, result: '[hello]' });
    await t.cmd('extensions.revoke', { id: 'probe', permission: 'workspace.read' });
    await expect(t.cmd('extensions.call', { id: 'probe', tool: 'peek', args: { path: 'secret.txt' } })).rejects.toThrow(/permission denied/);
  });

  it('only lets http.get reach the listed domains', async () => {
    const seen = [];
    const fetch = async (url) => { seen.push(url); return new Response('sunny', { status: 200, headers: { 'content-type': 'text/plain' } }); };
    const t = setup({ examples: false, fetch });
    await t.cmd('extensions.install', { path: makeExt(path.join(t.dir, 'probe'), probe(['http.get:api.open-meteo.com']), PROBE_CODE) });
    await t.cmd('extensions.approve', { id: 'probe' });
    expect((await t.cmd('extensions.call', { id: 'probe', tool: 'fetch', args: { url: 'https://api.open-meteo.com/v1/forecast' } })).result).toBe('200 sunny');
    await expect(t.cmd('extensions.call', { id: 'probe', tool: 'fetch', args: { url: 'https://evil.example/steal' } })).rejects.toThrow(/may not download from evil.example/);
    await expect(t.cmd('extensions.call', { id: 'probe', tool: 'fetch', args: { url: 'http://api.open-meteo.com/' } })).rejects.toThrow(/https/);
    expect(seen).toEqual(['https://api.open-meteo.com/v1/forecast']);
  });

  it('gives widgets only storage and notify, each behind its permission', async () => {
    const t = setup();
    await t.cmd('extensions.approve', { id: 'pomodoro', grant: ['notify'] });
    await expect(t.cmd('extensions.cap', { id: 'pomodoro', cap: 'storage.set', args: { key: 'a', value: 1 } })).rejects.toThrow(/permission denied/);
    expect((await t.cmd('extensions.cap', { id: 'pomodoro', cap: 'notify', args: { title: 'Done' } })).result).toBe(true);
    await expect(t.cmd('extensions.cap', { id: 'pomodoro', cap: 'workspace.read', args: { path: 'x' } })).rejects.toThrow(/cannot use workspace.read directly/);
    await expect(t.cmd('extensions.cap', { id: 'seo-check', cap: 'storage.get', args: {} })).rejects.toThrow(/not enabled/);
  });

  it('installs from a zip, refuses unsafe zips, and asks for extra trust for URLs', async () => {
    const zipped = writeZip(new Map([
      ['probe/hivedesk-extension.json', JSON.stringify(probe(['storage']))],
      ['probe/main.js', PROBE_CODE['main.js']],
      ['probe/lib/tag.js', PROBE_CODE['lib/tag.js']]
    ]));
    expect([...readZip(zipped).keys()].sort()).toEqual(['hivedesk-extension.json', 'lib/tag.js', 'main.js']);
    expect(() => readZip(writeZip(new Map([['../evil.js', 'x']])))).toThrow(/unsafe path/);
    const fetch = async () => new Response(zipped, { status: 200 });
    const t = setup({ examples: false, fetch });
    const r = await t.cmd('extensions.install', { zipBase64: zipped.toString('base64') });
    expect(r.extension).toMatchObject({ id: 'probe', source: 'zip', pending: true });
    await t.cmd('extensions.uninstall', { id: 'probe' });
    await expect(t.cmd('extensions.install', { url: 'http://example.com/x.zip' })).rejects.toThrow(/https/);
    const u = await t.cmd('extensions.install', { url: 'https://example.com/probe.zip' });
    expect(u.risk).toBe('url');
    await expect(t.cmd('extensions.approve', { id: 'probe' })).rejects.toThrow(/trust/);
    const ok = await t.cmd('extensions.approve', { id: 'probe', acceptRisk: true });
    expect(ok.extension.enabled).toBe(true);
    expect(fs.existsSync(path.join(t.home, 'extensions', 'installed', 'probe', 'main.js'))).toBe(true);
    await t.cmd('extensions.uninstall', { id: 'probe' });
    expect(fs.existsSync(path.join(t.home, 'extensions', 'installed', 'probe'))).toBe(false);
    await expect(t.cmd('extensions.uninstall', { id: 'pomodoro' })).rejects.toThrow(/not found|no extension/);
  });
});

describe('loading and unloading', () => {
  it('lists the examples, adds and removes tools, roles and themes when turned on and off', async () => {
    const t = setup();
    const { extensions } = await t.cmd('extensions.list');
    expect(extensions.map((e) => e.id)).toEqual(['pomodoro', 'seo-check', 'tradutor']);
    expect(extensions.every((e) => e.source === 'builtin' && e.pending && !e.enabled)).toBe(true);

    await t.cmd('extensions.approve', { id: 'seo-check' });
    expect(ALL_TOOLS).toContain('seo-check.audit');
    t.ws.write('index.html', '<!doctype html><html><head><title>Hi</title></head><body><img src="a.png"></body></html>');
    const report = JSON.parse((await t.cmd('extensions.call', { id: 'seo-check', tool: 'audit', args: {} })).result);
    expect(report.pages[0].path).toBe('index.html');
    expect(report.pages[0].issues.join(' ')).toMatch(/lang attribute|alt text|description/);
    expect(report.score).toBeLessThan(80);
    const w = await t.cmd('extensions.widget', { id: 'seo-check', widget: 'report' });
    expect(w.html).toContain('SEO Check');
    expect(Object.keys(w.files).sort()).toEqual(['widget.css', 'widget.js']);
    await t.cmd('extensions.disable', { id: 'seo-check' });
    expect(ALL_TOOLS).not.toContain('seo-check.audit');
    expect(TOOLS['seo-check.audit']).toBeUndefined();
    await expect(t.cmd('extensions.widget', { id: 'seo-check', widget: 'report' })).rejects.toThrow(/not enabled/);

    // A role becomes a worker of the crew, with only the tools its permissions allow.
    await t.cmd('extensions.approve', { id: 'tradutor', grant: ['crew.roles', 'workspace.read'] });
    const worker = t.hive.state.crew.find((x) => x.name === 'Tradutor');
    expect(worker).toBeTruthy();
    expect(worker.tools).toEqual(['list_files', 'read_file']);
    await t.cmd('extensions.disable', { id: 'tradutor' });
    expect(t.hive.state.crew.some((x) => x.name === 'Tradutor')).toBe(false);
    await expect(t.cmd('extensions.uninstall', { id: 'tradutor' })).rejects.toThrow(/built-in/);
  });

  it('keeps enabled extensions across restarts', async () => {
    const t = setup();
    await t.cmd('extensions.approve', { id: 'pomodoro' });
    t.plugin.close();
    const again = register({ scheduler: t.scheduler, bus: t.bus, server: { command() {}, route() {} }, hive: t.hive, toolbox: t.toolbox, home: t.home, watch: false, builtinExtensions: EXAMPLES });
    expect(again.host.list().find((e) => e.id === 'pomodoro')).toMatchObject({ enabled: true, pending: false });
    again.close();
  });

  it('hot reloads an extension in development and asks again for new permissions', async () => {
    const t = setup({ examples: false, watch: true });
    const dev = path.join(t.home, 'extensions', 'dev', 'probe');
    makeExt(dev, probe(['workspace.read']), PROBE_CODE);
    t.ws.write('a.txt', 'A');
    await t.cmd('extensions.addDev', { name: 'probe' });
    await t.cmd('extensions.approve', { id: 'probe' });
    expect((await t.cmd('extensions.call', { id: 'probe', tool: 'peek', args: { path: 'a.txt' } })).result).toBe('[A]');
    const before = t.events('extension.reloaded').length;
    fs.writeFileSync(path.join(dev, 'lib', 'tag.js'), 'export const tag = (s) => `<${s}>`;');
    await waitFor(() => t.events('extension.reloaded').length > before, { timeout: 8000 });
    expect((await t.cmd('extensions.call', { id: 'probe', tool: 'peek', args: { path: 'a.txt' } })).result).toBe('<A>');
    const m = probe(['workspace.read', 'storage']);
    fs.writeFileSync(path.join(dev, MANIFEST_FILE), JSON.stringify(m));
    await waitFor(() => t.events('extension.reloaded').some((e) => e.data.needsApproval), { timeout: 8000 });
    const s = (await t.cmd('extensions.list')).extensions[0];
    expect(s).toMatchObject({ pending: true, enabled: false });
    await t.cmd('extensions.approve', { id: 'probe' });
    expect((await t.cmd('extensions.list')).extensions[0].granted).toEqual(['workspace.read', 'storage']);
  });
});

describe('widget frame messages', () => {
  it('accepts only the documented shapes', () => {
    expect(validateWidgetMessage({ hd: 1, id: 'w1', type: 'call', data: { tool: 'audit', args: { a: 1 } } })).toEqual({ ok: true, msg: { id: 'w1', type: 'call', data: { tool: 'audit', args: { a: 1 } } } });
    expect(validateWidgetMessage({ hd: 1, id: 'w2', type: 'ready' }).ok).toBe(true);
    expect(validateWidgetMessage({ hd: 1, id: 'w3', type: 'resize', data: { height: 99999 } }).msg.data.height).toBe(2000);
    const bad = [
      null, 'x', [], { hd: 2, id: 'a', type: 'ready' }, { hd: 1, type: 'ready' }, { hd: 1, id: 'has space', type: 'ready' },
      { hd: 1, id: 'a', type: 'eval', data: {} }, { hd: 1, id: 'a', type: 'call', data: { tool: '../x' } },
      { hd: 1, id: 'a', type: 'call', data: { tool: 'read_file', args: [] } }, { hd: 1, id: 'a', type: 'call', data: { tool: 'a', extra: 1 } },
      { hd: 1, id: 'a', type: 'ready', extra: true }, { hd: 1, id: 'a', type: 'storage.set', data: { key: '' } },
      { hd: 1, id: 'a', type: 'storage.set', data: { key: 'k', value: 'x'.repeat(20000) } }, { hd: 1, id: 'a', type: 'notify', data: { title: '' } },
      { hd: 1, id: 'a', type: 'call', data: { tool: 'a', args: { big: 'x'.repeat(70000) } } }, { hd: 1, id: 'a', type: 'toString' }
    ];
    for (const m of bad) expect(validateWidgetMessage(m).ok, JSON.stringify(m)?.slice(0, 80)).toBe(false);
    expect(permissionFor('storage.get')).toBe('storage');
    expect(permissionFor('notify')).toBe('notify');
    expect(permissionFor('call')).toBeNull();
  });

  it('builds a locked down document with the widget files inlined', () => {
    const doc = buildSrcdoc({
      html: '<!doctype html><html><head><base href="https://evil.example/"><link rel="stylesheet" href="w.css"><link rel="stylesheet" href="https://cdn.example/x.css"></head><body><script src="w.js"></script><script src="https://cdn.example/x.js"></script></body></html>',
      files: { 'w.js': 'console.log("</script><b>")', 'w.css': 'body{color:red}' },
      vars: { '--hd-text': '#fff', '--evil': 'x', '--hd-bg': 'red;} body{display:none' }
    });
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('w.js') === -1 ? Infinity : doc.indexOf('console.log'));
    expect(doc).toContain(CSP.replace(/'/g, "'"));
    expect(doc).toContain("connect-src 'none'");
    expect(doc).toContain('body{color:red}');
    expect(doc).toContain('console.log("<\\/script><b>")');
    expect(doc).not.toContain('cdn.example');
    expect(doc).not.toContain('<base');
    expect(doc).toContain('--hd-text:#fff');
    expect(doc).not.toContain('--evil');
    expect(doc).not.toContain('display:none');
    expect(doc.indexOf('window.hivedesk')).toBeLessThan(doc.indexOf('console.log'));
  });
});

describe('creating with the crew (fake brain)', () => {
  it('spots theme and extension requests and leaves build requests alone', () => {
    expect(detectIntent('crie um tema inspirado em pôr do sol na praia')).toBe('theme');
    expect(detectIntent('Make a dark theme')).toBe('theme');
    expect(detectIntent('crie uma extensão que mostra o clima')).toBe('extension');
    expect(detectIntent('crie um worker revisor de código')).toBe('extension');
    expect(detectIntent('create a landing page with a dark theme')).toBeNull();
    expect(detectIntent('A tiny landing page for Crumb, a bakery')).toBeNull();
    expect(guessSpec('crie uma extensão que mostra o clima')).toMatchObject({ id: 'clima', name: 'Clima', kind: 'widget', domains: ['api.open-meteo.com'] });
    expect(guessSpec('crie um worker revisor de código')).toMatchObject({ id: 'revisor-codigo', name: 'Revisor Código', kind: 'role' });
  });

  it('makes a theme from the top bar request and shows it for approval', async () => {
    const theme = { ...BASE, name: 'Pôr do sol', description: 'sunset', colors: { ...BASE.colors, text: '#3A2A20' } };
    delete theme.format; delete theme.version; delete theme.id; delete theme.author;
    const t = setup({ examples: false, respond: scripted([], { theme }) });
    const r = t.hive.createJob({ request: 'crie um tema inspirado em pôr do sol na praia' });
    expect(r.jobId).toBeNull();
    await r.done;
    const ev = t.events('theme.generated')[0];
    expect(ev.data.theme.name).toBe('Pôr do sol');
    expect(ev.data.fixes.map((f) => f.key)).toContain('text');
    expect(ev.data.failing).toEqual([]);
    expect(t.bus.state.jobs).toHaveLength(0);
    expect(t.bus.state.chat.general.at(-1).text).toMatch(/adjusted text/);
    const saved = await t.cmd('themes.save', { theme: ev.data.theme });
    expect((await t.cmd('themes.list')).themes.find((x) => x.id === saved.theme.id).source).toBe('user');
  });

  it('scaffolds an extension, lets the crew finish it as a job, then installs and tests it', async () => {
    const widget = '<!doctype html><html><head><title>Clima</title><link rel="stylesheet" href="widget.css"></head><body><p id="out">...</p><script src="widget.js"></script></body></html>\n';
    // The engine only lets a worker change a file it read first in the same task.
    const t = setup({ examples: false, respond: scripted([
      { tool: 'read_file', args: { path: 'extensions/clima/widget.html' } },
      { tool: 'write_file', args: { path: 'extensions/clima/widget.html', content: widget } },
      { tool: 'done', args: { summary: 'the weather widget is ready' } }
    ]) });
    const out = t.hive.createJob({ request: 'crie uma extensão que mostra o clima' });
    expect(out.flow).toBe('extension');
    await out.done;
    const started = t.events('extension.dev.started')[0].data;
    expect(started).toMatchObject({ id: 'clima', name: 'Clima', kind: 'widget' });
    const job = t.bus.state.jobs.find((j) => j.id === started.jobId);
    expect(job.status).toBe('done');
    expect(job.request).toContain('extensions/clima/');
    // Mel's scaffold and the crew's edit both went through the tools (diff events) and into the dev folder.
    const changed = t.events('file.changed').map((e) => e.data.path);
    expect(changed).toEqual(expect.arrayContaining(['extensions/clima/hivedesk-extension.json', 'extensions/clima/main.js', 'extensions/clima/widget.html']));
    const dev = path.join(t.home, 'extensions', 'dev', 'clima');
    expect(fs.readFileSync(path.join(dev, 'widget.html'), 'utf8')).toBe(widget);
    const manifest = JSON.parse(fs.readFileSync(path.join(dev, MANIFEST_FILE), 'utf8'));
    expect(manifest.permissions).toContain('http.get:api.open-meteo.com');
    const ready = t.events('extension.dev.ready')[0].data;
    expect(ready).toMatchObject({ id: 'clima', ok: true, status: 'done' });

    // "Install and test": register the dev folder, approve, open the widget, run its tool.
    const staged = await t.cmd('extensions.addDev', { name: 'clima' });
    expect(staged.extension).toMatchObject({ source: 'dev', pending: true });
    await t.cmd('extensions.approve', { id: 'clima' });
    const w = await t.cmd('extensions.widget', { id: 'clima', widget: 'panel' });
    expect(w.html).toBe(widget);
    expect(buildSrcdoc(w)).toContain("hivedesk.call('fetch_data'");
  });

  it('creates a worker extension that joins the crew', async () => {
    const t = setup({ examples: false, respond: scripted([{ tool: 'done', args: { summary: 'role written' } }]) });
    const r = await t.cmd('extensions.create', { prompt: 'crie um worker revisor de código' });
    expect(r).toMatchObject({ id: 'revisor-codigo', kind: 'role' });
    await waitFor(() => t.events('extension.dev.ready').length, { timeout: 20000 });
    await t.cmd('extensions.addDev', { name: 'revisor-codigo' });
    await t.cmd('extensions.approve', { id: 'revisor-codigo' });
    const worker = t.hive.state.crew.find((x) => x.name === 'Revisor Código');
    expect(worker).toBeTruthy();
    expect(worker.tools).toEqual(['list_files', 'read_file', 'check']);
    expect(worker.prompt).toContain('revisor');
  });
});
