// Themes and extensions plug-in. src/index.js calls the default export at start (like the
// lend plug-in); without this folder the engine runs with the default look and no extensions.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExtensionHost } from './host.js';
import { ThemeStore, generateTheme } from './themes.js';
import { createExtension } from './create.js';
import { detectIntent } from './intent.js';
import { permissionFlag } from '../tools/run.js';
import { say } from '../crew/say.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let flowSeq = 0;

/**
 * @param {{
 *   scheduler: import('../crew/scheduler.js').Scheduler, bus: import('../bus.js').EventBus,
 *   server: { route: Function, command: Function }, config?: object,
 *   hive: import('../crew/engine.js').Hive, toolbox: import('../tools/index.js').ToolBox, home: string,
 *   builtinThemes?: string, builtinExtensions?: string, watch?: boolean, fetch?: typeof fetch
 * }} ctx
 */
export default function register(ctx) {
  const { scheduler, bus, server, hive, toolbox } = ctx;
  const host = new ExtensionHost({
    bus, toolbox, hive, scheduler, home: ctx.home, fetch: ctx.fetch, watch: ctx.watch,
    builtinDir: ctx.builtinExtensions ?? path.join(PACKAGE_ROOT, 'extensions'), sandbox: ctx.sandbox
  }).start();
  const themes = new ThemeStore({ builtinDir: ctx.builtinThemes ?? path.join(PACKAGE_ROOT, 'themes'), home: ctx.home, extensions: () => host.themeFiles() });
  const need = (cond, msg) => { if (!cond) throw Object.assign(new Error(msg), { code: 'bad_request' }); };
  const str = (v, name) => { need(typeof v === 'string' && v.trim(), `${name} is required`); return v.trim(); };

  /* ---------- themes ---------- */
  server.command('themes.list', () => ({ themes: themes.list() }));
  server.command('themes.save', (d) => ({ theme: themes.save(d.theme) }));
  server.command('themes.delete', (d) => themes.delete(str(d.id, 'id')));

  const runThemeFlow = (prompt) => {
    const requestId = `th_${Date.now().toString(36)}_${++flowSeq}`;
    bus.emit('theme.generating', { requestId, prompt: prompt.slice(0, 300) });
    speak(hive, 'mel', 'crew.say.themeStart', { prompt: prompt.slice(0, 200) });
    const done = generateTheme({ scheduler, prompt }).then((r) => {
      bus.emit('theme.generated', { requestId, ...r });
      speak(hive, 'mel', 'crew.say.themeReady', { name: r.theme.name, fixed: r.fixes.length ? 'yes' : 'no', keys: r.fixes.map((f) => f.key).join(', ') });
      return r;
    }, (err) => {
      bus.emit('theme.failed', { requestId, error: String(err.message || err) });
      speak(hive, 'mel', 'crew.say.themeFailed', { error: String(err.message || err) });
      throw err;
    });
    return { requestId, done };
  };
  server.command('themes.generate', async (d) => {
    const flow = runThemeFlow(str(d.prompt, 'prompt'));
    if (d.wait) return { requestId: flow.requestId, ...(await flow.done) };
    flow.done.catch(() => {});
    return { requestId: flow.requestId };
  });
  server.route('GET', '/api/themes', (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ themes: themes.list() }));
  });

  /* ---------- extensions ---------- */
  // isolated: the sandbox process gets Node's permission model (no file system, no child processes).
  const listing = () => ({ extensions: host.list(), devDir: host.dirs.dev, isolated: !!permissionFlag() });
  server.command('extensions.list', listing);
  server.command('extensions.install', (d) => host.install(d));
  server.command('extensions.approve', (d) => ({ extension: host.approve(str(d.id, 'id'), { grant: d.grant, acceptRisk: d.acceptRisk }) }));
  server.command('extensions.enable', (d) => ({ extension: host.enable(str(d.id, 'id')) }));
  server.command('extensions.disable', (d) => ({ extension: host.disable(str(d.id, 'id')) }));
  server.command('extensions.revoke', (d) => ({ extension: host.revoke(str(d.id, 'id'), str(d.permission, 'permission')) }));
  server.command('extensions.uninstall', (d) => host.uninstall(str(d.id, 'id'), { deleteFiles: !!d.deleteFiles }));
  server.command('extensions.reload', (d) => ({ extension: host.reload(str(d.id, 'id')) }));
  server.command('extensions.addDev', (d) => host.addDev(str(d.name, 'name')));
  server.command('extensions.call', async (d) => ({ result: await host.callTool(str(d.id, 'id'), str(d.tool, 'tool'), d.args && typeof d.args === 'object' ? d.args : {}, { workerId: `ext:${d.id}` }) }));
  // Widgets reach only these capabilities directly; everything else goes through their tools.
  server.command('extensions.cap', async (d) => {
    const cap = str(d.cap, 'cap');
    need(['storage.get', 'storage.set', 'notify'].includes(cap), `widgets cannot use ${cap} directly; call a tool of the extension`);
    return { result: await host.capability(str(d.id, 'id'), cap, d.args || {}) };
  });
  server.command('extensions.widget', (d) => host.widget(str(d.id, 'id'), str(d.widget, 'widget')));
  const startCreate = (prompt, spec) => createExtension({ prompt, spec, host, hive, toolbox, bus, createJob: (s) => originalCreate(s) });
  server.command('extensions.create', async (d) => {
    const r = await startCreate(str(d.prompt, 'prompt'), d.spec);
    return { id: r.id, name: r.name, kind: r.kind, jobId: r.jobId, folder: r.folder, path: r.path };
  });

  /* ---------- requests typed in the top bar ---------- */
  // "crie um tema ..." and "crie uma extensao ..." start the flows above instead of a build job.
  const originalCreate = hive.createJob.bind(hive);
  hive.createJob = (spec = {}) => {
    const intent = spec.playbookId ? null : detectIntent(spec.request);
    if (intent === 'theme') {
      const flow = runThemeFlow(String(spec.request).trim());
      flow.done.catch(() => {});
      return { jobId: null, flow: 'theme', requestId: flow.requestId, done: flow.done.catch(() => null) };
    }
    if (intent === 'extension') {
      const started = startCreate(String(spec.request).trim());
      // The scaffold is written first; the job id is known right after.
      const out = { jobId: null, flow: 'extension', done: started.then((r) => r.finished, () => null) };
      started.then((r) => { out.jobId = r.jobId; }, (err) => speak(hive, 'mel', 'crew.say.extensionFailed', { error: String(err.message || err) }));
      return out;
    }
    return originalCreate(spec);
  };

  return {
    host, themes,
    close() {
      hive.createJob = originalCreate;
      host.close();
    }
  };
}

/** A crew line in the user's language (src/crew/say.js); a host without say() gets the English one. */
function speak(hive, who, key, params, o = {}) {
  if (typeof hive?.say === 'function') return hive.say(who, key, params, o);
  return hive?.chat?.(who, say('en', key, params), undefined, o.channel || 'general', o.jobId);
}
