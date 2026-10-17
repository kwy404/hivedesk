// Wires everything together. The CLI and the tests both start the hive through here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventBus, initHome, hasRealLog } from './bus.js';
import { Scheduler } from './crew/scheduler.js';
import { Hive } from './crew/engine.js';
import { ToolBox, Workspace } from './tools/index.js';
import { Approvals } from './tools/approvals.js';
import { PlaybookStore } from './playbooks/index.js';
import { createServer, PACKAGE_ROOT } from './server.js';
import { BrainManager } from './brain/manager.js';
import { createDemoBrain, DEMO_NOTICE, DEMO_REQUEST } from './demo.js';
import { runDoctor } from './doctor.js';
import { PROTOCOL } from './replay/reduce.js';
import { MemoryStore, attachMemory } from './memory/index.js';
import { City } from './city/index.js';
import { runCityDemo } from './city/demo.js';

export const VERSION = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;

/** The shared cache folder for the runtime and the models. */
export function cacheHome() {
  return process.env.HIVEDESK_HOME ? path.resolve(process.env.HIVEDESK_HOME) : path.join(os.homedir(), '.hivedesk');
}

/**
 * @param {{
 *   dir: string, port?: number, demo?: boolean, lend?: boolean, home?: string,
 *   flags?: { brain?: string, model?: string, url?: string, key?: string, noDownload?: boolean, gpu?: boolean, ctx?: number },
 *   brain?: import('./brain/types.js').Brain,  a brain to use instead of the manager (tests)
 *   log?: (line: string) => void, progress?: (text: string | null) => void,
 *   maxTurns?: number, demoDelayMs?: number, autoStartDemo?: boolean, uiDir?: string, token?: string
 * }} opts
 */
export async function startHive(opts) {
  const dir = path.resolve(opts.dir);
  // A demo never writes into the log of a real project (CHANGELOG 0.2.1).
  if (opts.demo && hasRealLog(dir)) throw Object.assign(new Error(`the demo will not run in ${dir}: it holds a real hivedesk project`), { code: 'demo_dir' });
  const paths = initHome(dir);
  const home = opts.home || cacheHome();
  const log = opts.log || (() => {});
  const bus = new EventBus({ file: paths.events, snapshotFile: paths.state, demo: !!opts.demo, version: VERSION, lend: !!opts.lend });
  const scheduler = new Scheduler(bus);
  const approvals = new Approvals(bus, { autoApproveMs: opts.demo ? (opts.demoApproveMs ?? 2500) : 0 });
  const playbooks = new PlaybookStore(paths.playbooks);
  const workspace = new Workspace(paths.workspace);
  let server;
  const previewUrl = () => server?.previewUrl() || null;
  const toolbox = new ToolBox({ workspace, bus, approvals, previewUrl });
  const memory = new MemoryStore({ projectFile: path.join(paths.root, 'memory.json'), userFile: opts.memoryHome === null ? null : path.join(opts.memoryHome || home, 'memory.json'), sessionsDir: path.join(paths.root, 'sessions') });
  attachMemory(bus, memory, { enabled: () => bus.state.settings.memory !== false });
  const hive = new Hive({ bus, scheduler, toolbox, approvals, playbooks, maxTurns: opts.maxTurns, previewUrl, memoryStore: memory, autoApproveBriefMs: opts.demo ? (opts.demoApproveMs ?? 2500) : 0 });
  const brains = opts.demo || opts.brain ? null : new BrainManager({ bus, scheduler, home, flags: opts.flags, log, progress: opts.progress });

  bus.emit('session.started', { version: VERSION, protocol: PROTOCOL, dir, workspace: paths.workspace, demo: !!opts.demo, lend: !!opts.lend, pid: process.pid });
  hive.init();

  server = createServer({
    bus, hive, scheduler, approvals, playbooks, toolbox, brains, memory,
    doctor: () => runDoctor({ home, model: opts.flags?.model }),
    token: opts.token, port: opts.port, uiDir: opts.uiDir, demo: !!opts.demo, lend: !!opts.lend, version: VERSION, dir, city: opts.city !== false
  });

  // Hive City (src/city/, CITY-PROTOCOL.md): agents, rooms, the task bus and machines on the same log.
  let city = null;
  if (opts.city !== false) {
    try {
      city = new City({ bus, hive, scheduler, toolbox, home, projectDir: paths.city, version: VERSION });
      city.start();
      city.register(server);
    } catch (err) {
      log(`city failed to start: ${err.message}`);
    }
  }

  // Optional lend plug-in (PROTOCOL.md section 6). The engine works without it.
  const lendEntry = path.join(PACKAGE_ROOT, 'src', 'lend', 'index.js');
  if (fs.existsSync(lendEntry)) {
    try {
      const mod = await import(pathToFileURL(lendEntry).href);
      if (typeof mod.default === 'function') {
        // toolbox and approvals: Code together saves editor files through the same tools and approvals (src/collab/).
        await mod.default({ scheduler, bus, toolbox, approvals, server: { route: server.route, command: server.command }, config: { dir, port: opts.port, token: server.token, lend: !!opts.lend, demo: !!opts.demo, version: VERSION } });
      }
    } catch (err) {
      log(`lend plug-in failed to load: ${err.message}`);
    }
  }
  try { await (await import('./github/index.js')).default({ bus, hive, scheduler, toolbox, server: { route: server.route, command: server.command }, config: { dir, home, workspace: paths.workspace, demo: !!opts.demo, version: VERSION, github: opts.github } }); } catch (err) { log(`github plug-in failed to load: ${err.message}`); }
  // Themes and extensions (src/extensions/); the engine runs without them.
  let extensions = null;
  try { extensions = (await import('./extensions/index.js')).default({ bus, hive, scheduler, toolbox, home, server: { route: server.route, command: server.command } }); } catch (err) { log(`extensions plug-in failed to load: ${err.message}`); }

  await server.listen(opts.port || 0);

  let demoTimer = null;
  let demoFallback = null;
  const demoCtrl = new AbortController();
  if (opts.demo) {
    scheduler.addBrain(createDemoBrain({ delayMs: opts.demoDelayMs, tokenDelayMs: opts.demoDelayMs === 0 ? 0 : undefined }));
    bus.emit('brain.status', { state: 'ready', backend: 'fake', model: 'demo script', detail: 'demo: no model is running' });
    hive.chat('mel', DEMO_NOTICE);
    if (opts.autoStartDemo !== false) {
      // Start when the first window connects (so it can be watched), or after a few seconds anyway.
      let started = false;
      const go = () => {
        if (started) return;
        started = true;
        clearInterval(demoTimer);
        clearTimeout(demoFallback);
        hive.createJob({ request: DEMO_REQUEST });
        if (city) {
          const stepMs = opts.demoDelayMs === 0 ? 0 : (opts.demoCityStepMs ?? 1800);
          setTimeout(() => { runCityDemo({ city, scheduler, bus, stepMs, signal: demoCtrl.signal }).catch((err) => log(`city demo stopped: ${err.message}`)); }, stepMs ? 1500 : 0).unref?.();
        }
      };
      demoTimer = setInterval(() => { if (server.clients.size) { clearInterval(demoTimer); setTimeout(go, 1500).unref?.(); } }, 300);
      demoFallback = setTimeout(go, 8000);
      demoFallback.unref?.();
    }
  } else if (opts.brain) {
    scheduler.addBrain(opts.brain);
    bus.emit('brain.status', { state: 'ready', backend: opts.brain.info?.().backend || 'custom', model: opts.brain.info?.().model });
  } else {
    if (!bus.state.brain || bus.state.brain.state !== 'none') bus.emit('brain.status', { state: 'none', backend: 'none', detail: 'starting' });
    brains.start();
  }

  return {
    bus, hive, scheduler, approvals, playbooks, toolbox, server, brains, paths, home, memory, city,
    url: server.url,
    async close() {
      if (demoTimer) clearInterval(demoTimer);
      if (demoFallback) clearTimeout(demoFallback);
      demoCtrl.abort();
      await city?.close();
      extensions?.close();
      await hive.close();
      await brains?.close();
      await scheduler.close();
      bus.emit('session.stopped', { reason: 'closed' });
      bus.close();
      await server.close();
    }
  };
}

export { EventBus, Scheduler, Hive, ToolBox, Workspace, Approvals, PlaybookStore, createServer, BrainManager, runDoctor };
