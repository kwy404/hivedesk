// Wires everything together. The CLI and the tests both start the hive through here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventBus, initHome } from './bus.js';
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
import { migrateProject } from './core/migrate.js';
import { prepareDemoDir, demoHome, isDemoFolder, markerFile } from './core/demo.js';
import { createRouter } from './core/router.js';
import { TaskEngine } from './tasks/engine.js';
import { attachCrewExecutor } from './tasks/crew-executor.js';
import { registerTaskCommands } from './tasks/commands.js';
import { attachLibrary } from './crew/library/hook.js';
import { attachDomains } from './crew/domains/attach.js';

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
  // A demo runs only in a demo folder (empty or marked) and with its own home, never ~/.hivedesk (PLAN.md section 1.5).
  const dir = opts.demo ? prepareDemoDir(opts.dir) : path.resolve(opts.dir);
  // A real run makes a demo folder a real project: the marker goes, so no later demo writes into it.
  if (!opts.demo && isDemoFolder(dir)) { try { fs.rmSync(markerFile(dir), { force: true }); } catch { /* read only: the next demo is refused anyway by the log */ } }
  const paths = initHome(dir);
  const home = opts.demo ? demoHome(dir) : opts.home || cacheHome();
  const log = opts.log || (() => {});
  // The 1.0 layout and the one time move of 0.2 demo events out of a real project, before the log is read.
  const migration = migrateProject(paths.root, { demo: !!opts.demo, version: VERSION });
  const bus = new EventBus({ dir: paths.root, snapshotFile: paths.state, demo: !!opts.demo, version: VERSION, lend: !!opts.lend, strict: opts.strict });
  const router = createRouter();
  const scheduler = new Scheduler(bus);
  const approvals = new Approvals(bus, { autoApproveMs: opts.demo ? (opts.demoApproveMs ?? 2500) : 0 });
  const playbooks = new PlaybookStore(paths.playbooks);
  const workspace = new Workspace(paths.workspace);
  let server;
  const previewUrl = () => server?.previewUrl() || null;
  const toolbox = new ToolBox({ workspace, bus, approvals, previewUrl });
  const memory = new MemoryStore({ projectFile: path.join(paths.root, 'memory.json'), userFile: opts.memoryHome === null ? null : path.join(opts.demo ? home : opts.memoryHome || home, 'memory.json'), sessionsDir: path.join(paths.root, 'sessions') });
  attachMemory(bus, memory, { enabled: () => bus.state.settings.memory !== false });
  const hive = new Hive({ bus, scheduler, toolbox, approvals, playbooks, maxTurns: opts.maxTurns, previewUrl, memoryStore: memory, autoApproveBriefMs: opts.demo ? (opts.demoApproveMs ?? 2500) : 0 });
  const brains = opts.demo || opts.brain ? null : new BrainManager({ bus, scheduler, home, flags: opts.flags, log, progress: opts.progress });

  bus.emit('session.started', { version: VERSION, protocol: PROTOCOL, dir, workspace: paths.workspace, demo: !!opts.demo, lend: !!opts.lend, pid: process.pid });
  for (const m of migration.applied) bus.emit('store.migrated', { migration: m.id, detail: m.detail });
  hive.init();

  server = createServer({
    bus, hive, scheduler, approvals, playbooks, toolbox, brains, memory,
    doctor: () => runDoctor({ home, model: opts.flags?.model }),
    token: opts.token, port: opts.port, uiDir: opts.uiDir, demo: !!opts.demo, lend: !!opts.lend, version: VERSION, dir, city: opts.city !== false, router
  });

  // The 1.0 task engine (src/tasks/): one board for native, crew and city tasks.
  const tasks = new TaskEngine({ bus, hive, dispatch: (type, data, origin) => router.dispatch(type, data, { origin }), localPeerId: opts.localPeerId || (() => 'local') });
  registerTaskCommands(server, tasks);
  server.command('store.info', () => bus.info(), { local: true });
  // Restore City: the state came back from the last snapshot plus the log tail; work that was running is not pretended.
  const interrupted = tasks.restore();
  bus.emit('store.restored', { snapshotSeq: bus.restore.snapshotSeq, replayed: bus.restore.replayed, ms: bus.restore.ms, interrupted });

  // Optional lend plug-in (PROTOCOL.md section 6), with the p2p control plane since 1.0 (src/p2p/, Stream 2).
  // It loads before the City so the host building carries this engine's PeerId. The engine works without it.
  let p2p = null;
  const lendEntry = path.join(PACKAGE_ROOT, 'src', 'lend', 'index.js');
  if (fs.existsSync(lendEntry)) {
    try {
      const mod = await import(pathToFileURL(lendEntry).href);
      if (typeof mod.default === 'function') {
        // toolbox and approvals: Code together saves editor files through the same tools and approvals (src/collab/).
        const lend = await mod.default({ scheduler, bus, toolbox, approvals, server: { route: server.route, command: server.command }, config: { dir, home, name: opts.name, port: opts.port, token: server.token, lend: !!opts.lend, demo: !!opts.demo, version: VERSION } });
        p2p = lend?.p2p || null;
      }
    } catch (err) {
      log(`lend plug-in failed to load: ${err.message}`);
    }
  }
  // This engine's PeerId once the p2p identity exists (src/p2p/); "local" without it.
  const peerId = () => {
    if (opts.localPeerId) return opts.localPeerId();
    try { return p2p?.node?.().info?.().peerId || 'local'; } catch { return 'local'; }
  };
  tasks.localPeerId = peerId;
  let profile = null; // the local profile (src/profile/, docs/1.0/PROFILE.md), started below
  server.setHelloExtra(() => {
    const id = peerId();
    // hello.state.share and hello.state.resources (src/compute/), hello.state.peers (src/p2p/), for the City and Machines.
    const state = {};
    if (compute) {
      state.share = compute.share;
      if (compute.resource) state.resources = { machine: 'local', ...compute.resource, share: compute.share };
    }
    if (p2p?.started) { try { state.peers = p2p.node().listPeers(); } catch { /* not ready */ } }
    if (profile) { try { state.profile = profile.view(); } catch { /* not ready */ } }
    return { ...(id !== 'local' ? { peerId: id } : {}), ...(Object.keys(state).length ? { state } : {}) };
  });
  // The prompt library (src/crew/library/): playbooks per task, their checks in QA and Test, the Library window.
  attachLibrary({ bus, hive, server, scheduler, dir: opts.memoryHome === null ? null : path.join(opts.memoryHome || home, 'library') });
  // The domains (src/crew/domains/): the question card answers and the read only security audit.
  attachDomains({ hive, server });

  // Hive City (src/city/, CITY-PROTOCOL.md): agents, rooms, the task bus and machines on the same log.
  let city = null;
  if (opts.city !== false) {
    try {
      const id = peerId();
      city = new City({ bus, hive, scheduler, toolbox, home, projectDir: paths.city, version: VERSION, ...(id !== 'local' ? { peerId: id } : {}) });
      city.start();
      city.register(server);
    } catch (err) {
      log(`city failed to start: ${err.message}`);
    }
  }

  try { await (await import('./github/index.js')).default({ bus, hive, scheduler, toolbox, server: { route: server.route, command: server.command }, config: { dir, home, workspace: paths.workspace, demo: !!opts.demo, version: VERSION, github: opts.github } }); } catch (err) { log(`github plug-in failed to load: ${err.message}`); }
  // The code workbench (src/workbench/, PLAN section 11): roots, file operations, search, terminals, git, shared documents.
  // Its commands are for the person at this machine; peers reach it only through their sessions (src/p2p/workbench-port.js).
  let workbench = null;
  let workbenchPort = null;
  if (fs.existsSync(path.join(PACKAGE_ROOT, 'src', 'workbench', 'index.js'))) {
    try {
      workbenchPort = p2p ? (await import('./p2p/workbench-port.js')).createWorkbenchPort(p2p.node(), { live: (type, data) => bus.live(type, data) }) : null;
      const localCommand = (type, fn, spec) => server.command(type, (d, client, ctx) => {
        const kind = ctx?.origin?.kind || 'user';
        if (kind !== 'user') throw Object.assign(new Error(`${type} is for the person at this computer`), { code: 'forbidden' });
        return fn(d, client, ctx);
      }, { local: true, ...(spec || {}) });
      workbench = (await import('./workbench/index.js')).default({
        bus, toolbox, approvals,
        server: { route: server.route, command: localCommand },
        config: { dir, home, workspace: paths.workspace, demo: !!opts.demo },
        p2p: workbenchPort
      });
      workbenchPort?.attach(workbench);
      if (workbenchPort) server.command('p2p.workbench.send', (d) => workbenchPort.sendFromWindow(String(d.peerId || ''), String(d.t || ''), d.body), { local: true });
    } catch (err) { log(`workbench plug-in failed to load: ${err.message}`); }
  }
  // Themes and extensions (src/extensions/); the engine runs without them.
  let extensions = null;
  try { extensions = (await import('./extensions/index.js')).default({ bus, hive, scheduler, toolbox, home, server: { route: server.route, command: server.command } }); } catch (err) { log(`extensions plug-in failed to load: ${err.message}`); }

  // The compute plane (src/compute/, docs/1.0/protocol/compute.md): probes, ShareSettings, the job worker and requester.
  // Without a p2p link it runs local only. Its commands are local user only (src/core/router.js).
  let compute = null;
  if (fs.existsSync(path.join(PACKAGE_ROOT, 'src', 'compute', 'index.js'))) {
    try {
      compute = (await import('./compute/index.js')).default({ bus, scheduler, home, link: typeof p2p?.computeLink === 'function' ? p2p.computeLink() : p2p?.computeLink ?? null, viewers: () => server.clients.size, server: { route: server.route, command: server.command } });
    } catch (err) {
      log(`compute plug-in failed to load: ${err.message}`);
    }
  }

  // City membership over p2p (src/city/membership.js, Stream 4): friends' buildings through verified sessions.
  // Peers reach engine commands only through their sessions; the router checks their grants again (src/core/router.js).
  if (p2p) {
    try {
      const node = p2p.node();
      router.setGrantChecker((peerId, cap) => !!node.can(peerId, cap) || (cap === 'city.view' && !!node.can(peerId, 'city.member')));
      router.onCommand((rec) => { if (rec.origin?.kind === 'peer' && (rec.type !== 'city.presence' || !rec.ok)) node._audit({ type: 'command', peerId: rec.origin.peerId, command: rec.type, ok: rec.ok, ...(rec.code ? { code: rec.code } : {}) }); });
    } catch (err) { log(`p2p router check failed to start: ${err.message}`); }
  }
  let membership = null;
  if (city && p2p && fs.existsSync(path.join(PACKAGE_ROOT, 'src', 'city', 'membership.js'))) {
    try {
      const { startMembership, VIEW_COMMANDS } = await import('./city/membership.js');
      const { createCityPort } = await import('./p2p/city-port.js');
      membership = startMembership({ city, p2p: createCityPort(p2p.node(), { viewCommands: VIEW_COMMANDS }), compute, server, bus, router });
    } catch (err) { log(`city membership failed to start: ${err.message}`); }
  }

  // Pooled giant models between friends (src/brain/pool/p2p.js) over the p2p sessions: experimental, off by default,
  // gated by the compute.pool, compute.gpu, compute.cpu and compute.ram grants of the lender.
  if (p2p && server.pool) {
    try {
      const { createPoolPort } = await import('./p2p/pool-port.js');
      server.pool.attachP2P(createPoolPort(p2p.node()));
    } catch (err) { log(`pooled models over p2p failed to start: ${err.message}`); }
  }

  // The phone remote (src/phone/, docs/1.0/protocol/phone.md): a paired phone, by QR, with grants per phone.
  // Its commands are local only; what a phone may start runs as the person who paired it, within those grants.
  let phone = null;
  if (fs.existsSync(path.join(PACKAGE_ROOT, 'src', 'phone', 'index.js'))) {
    try {
      phone = await (await import('./phone/index.js')).default({ bus, server: { route: server.route, command: server.command }, home, p2p, hostName: () => opts.name || os.hostname(), run: (type, data) => server.runCommand(type, data, null, { kind: 'user' }) });
    } catch (err) { log(`phone remote failed to load: ${err.message}`); }
  }

  // Remote desktop (src/remote/, docs/1.0/protocol/remote.md) over the p2p sessions and the phone sessions; without either it says "unavailable".
  let remote = null;
  if (fs.existsSync(path.join(PACKAGE_ROOT, 'src', 'remote', 'index.js'))) {
    try {
      const p2pPort = p2p && typeof p2p.remotePort === 'function' ? p2p.remotePort() : null;
      const port = phone ? (p2pPort ? phone.combine(p2pPort) : phone.port) : p2pPort;
      remote = (await import('./remote/index.js')).default({ bus, server: { route: server.route, command: server.command }, p2p: port, home, downloadsDir: undefined });
    } catch (err) { log(`remote desktop failed to load: ${err.message}`); }
  }
  // Voice mode (src/voice/): local speech to text and voices, the streamed spoken answer; the engine runs without it.
  let voice = null;
  try { voice = (await import('./voice/index.js')).default({ bus, hive, scheduler, toolbox, server: { route: server.route, command: server.command }, config: { home, demo: !!opts.demo } }); } catch (err) { log(`voice plug-in failed to load: ${err.message}`); }
  // The local profile: name, avatar, real stats and achievements from this log; peers see only { name, avatar }.
  try {
    const { default: startProfile } = await import('./profile/index.js');
    const { deriveAddress } = await import('./remote/address.js');
    profile = startProfile({
      bus, home, server: { command: server.command, route: server.route }, p2p, dir,
      doctor: () => runDoctor({ home }),
      address: () => { const k = p2p?.started ? p2p.node().identity?.publicKey : null; return k ? deriveAddress(k) : null; },
    });
  } catch (err) { log(`profile failed to start: ${err.message}`); }

  await server.listen(opts.port || 0);
  const crewRunner = attachCrewExecutor({ bus, hive, tasks });
  // The task side of the compute failure matrix: a failed job moves its task to waiting or failed (PLAN section 8).
  const computeTasks = compute ? (await import('./compute/task-bridge.js')).attachTaskBridge({ bus, tasks }) : null;

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
    bus, hive, scheduler, approvals, playbooks, toolbox, server, brains, paths, home, memory, city, tasks, router, dir, compute, p2p, remote, workbench, phone,
    url: server.url,
    async close() {
      if (demoTimer) clearInterval(demoTimer);
      if (demoFallback) clearTimeout(demoFallback);
      demoCtrl.abort();
      crewRunner.close();
      membership?.close();
      try { await workbench?.close(); } catch { /* closing anyway */ }
      workbenchPort?.close();
      try { remote?.close(); } catch { /* closing anyway */ }
      try { await phone?.close(); } catch { /* closing anyway */ }
      profile?.close();
      computeTasks?.close();
      await city?.close();
      extensions?.close();
      voice?.close();
      await hive.close();
      tasks.close();
      await brains?.close();
      await compute?.close();
      try { await p2p?.close?.(); } catch { /* closing anyway */ }
      await scheduler.close();
      bus.emit('session.stopped', { reason: 'closed' });
      bus.close();
      await server.close();
      // The demo home is ephemeral: identity, peers, settings and agents of a demo do not outlive it.
      if (opts.demo) { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* still open: the OS temp cleanup takes it */ } }
    }
  };
}

export { EventBus, Scheduler, Hive, ToolBox, Workspace, Approvals, PlaybookStore, createServer, BrainManager, runDoctor };
