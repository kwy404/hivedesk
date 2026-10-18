// The models.* commands of the engine (PROTOCOL.md style: { type, data } in, a result or an error out).
//
//   models.catalog   {}                         the catalog without file URLs, light enough for the UI
//   models.analyze   { ctx?, task? }            hardware, ranked options, recommended / faster / smarter, installed
//   models.consent   { id, via?, answer? }      the yes for one file: remember it, download (resume, SHA-256), load
//   models.later     {}                         "Agora não": nothing downloads, the dialog stays closed
//   models.cancel    { id? }                    stop the running download, or one queued install (the .part stays for resume)
//   models.install   { id, yes: true }          the yes for one file, then a background download that does not switch models
//   models.disk      {}                         installed files, total size, free space, the install queue
//   models.switch    { id }                     load an installed model (or ask for the yes)
//   models.delete    { id }                     delete a downloaded model that is not in use
//   models.pool      { id, ctx? }               the pooled giant model meter for the City
//   models.router.get {}                        automatic rotation: on or off, pins, overrides, loaded models, a preview per role
//   models.router.set { auto?, maxResident?, pins?, overrides? }   null removes a pin or an override
import fs from 'node:fs';
import path from 'node:path';
import { loadCatalog, pick } from './index.js';
import { poolMeter } from './pool.js';

let light = null;

/** The catalog for the UI: everything but the download URLs and the per file checksums. */
export function lightCatalog() {
  if (light) return light;
  const c = loadCatalog();
  light = {
    version: c.version, generated: c.generated, quants: c.quants, heuristics: c.heuristics,
    models: c.models.map((m) => ({
      id: m.id, family: m.family, name: m.name, tasks: m.tasks, params: m.params, activeParams: m.activeParams || null,
      contextLength: m.contextLength, license: m.license, base: m.base, quality: m.quality, speedClass: m.speedClass, giant: m.giant, notes: m.notes || null,
      variants: m.variants.map((v) => ({ quant: v.quant, bits: v.bits, bytes: v.bytes, repo: v.repo, trust: v.trust, parts: v.files.length, giant: v.giant, vram: v.vram }))
    }))
  };
  return light;
}

/** City machines of friends, as the pool meter reads them (only what they explicitly shared counts). */
export function cityPeers(state) {
  const machines = Object.values(state?.city?.machines || {});
  return machines.filter((m) => !m.host).map((m) => ({
    id: m.id, name: m.name, online: m.online !== false, share: m.share || null, sharedUntil: m.sharedUntil || null,
    network: m.network === 'lan' ? 'lan' : 'internet', hw: m.hw || { gpu: m.gpu ? { name: m.gpu, vramBytes: m.vramBytes || 0 } : null, ramBytes: m.ramBytes || 0, cpus: m.cpus || 0 }
  }));
}

/**
 * @param {(type: string, fn: (d: any, client?: any) => any) => void} command
 * @param {() => import('../manager.js').BrainManager | null} getBrains
 * @param {new (code: string, message: string) => Error} CommandError
 * @param {import('../../bus.js').EventBus} bus
 */
export function registerModelCommands(command, getBrains, CommandError, bus) {
  const need = () => {
    const b = getBrains();
    if (!b) throw new CommandError('conflict', 'models are not available in this mode');
    return b;
  };
  const wrap = (fn) => async (d) => {
    try { return await fn(d || {}); } catch (err) {
      if (err instanceof CommandError) throw err;
      throw new CommandError(err.code === 'not_found' || err.code === 'conflict' || err.code === 'bad_request' ? err.code : 'internal', String(err.message || err));
    }
  };
  command('models.catalog', wrap(() => lightCatalog()));
  command('models.analyze', wrap((d) => need().analyze({ ctx: d.ctx, task: d.task })));
  command('models.consent', wrap((d) => {
    if (typeof d.id !== 'string' || !d.id) throw new CommandError('bad_request', 'id is required');
    if (d.yes !== true) throw new CommandError('bad_request', 'models.consent needs yes: true from the user');
    return need().consentTo(d);
  }));
  command('models.later', wrap(() => need().later()));
  command('models.cancel', wrap((d) => need().cancelDownload(typeof d.id === 'string' ? d.id : undefined)));
  command('models.install', wrap((d) => {
    if (typeof d.id !== 'string' || !d.id) throw new CommandError('bad_request', 'id is required');
    if (d.yes !== true) throw new CommandError('bad_request', 'models.install needs yes: true from the user');
    return need().install(d.id);
  }));
  command('models.disk', wrap(() => ({ ...need().disk(), queue: need().queueState() })));
  command('models.switch', wrap((d) => need().switchTo(d.id)));
  command('models.delete', wrap((d) => need().deleteModel(d.id)));
  command('models.router.get', wrap(() => need().routerState()));
  command('models.router.set', wrap((d) => {
    const patch = {};
    if (typeof d.auto === 'boolean') patch.auto = d.auto;
    if (d.maxResident != null) patch.maxResident = Number(d.maxResident);
    if (d.pins && typeof d.pins === 'object') patch.pins = d.pins;
    if (d.overrides && typeof d.overrides === 'object') patch.overrides = d.overrides;
    need().setRouter(patch);
    return need().routerState();
  }));
  command('models.pool', wrap(async (d) => {
    const p = pick(...String(d.id || '').split(':'));
    if (!p) throw new CommandError('not_found', 'no such model in the catalog');
    const b = need();
    const hw = await b.hw();
    const ctx = Number(d.ctx) || 4096;
    // With the p2p plane: the friends who granted pooling, over their real links, and runnable only when
    // the flag, the build, the model and the granted memory all are there (src/brain/pool/index.js).
    if (b.pool?.meterFor) return { id: p.id, ctx, ...(await b.pool.meterFor(p, ctx)) };
    const meter = poolMeter(p, ctx, hw, cityPeers(bus.state), Date.now());
    let experimental = false;
    try { experimental = JSON.parse(fs.readFileSync(path.join(b.home, 'pool', 'flag.json'), 'utf8')).experimental === true; } catch { experimental = false; }
    return { id: p.id, ctx, ...meter, runnable: false, execution: experimental ? 'experimental' : 'off' };
  }));
}
