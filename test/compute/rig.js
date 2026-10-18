// Shared pieces for the compute tests: a controllable brain, a worker engine and a requester engine on the
// in process network (test/compute/inproc.js).
import { EventBus } from '../../src/bus.js';
import { Scheduler } from '../../src/crew/scheduler.js';
import { ComputeWorker } from '../../src/compute/worker.js';
import { Requester } from '../../src/compute/requester.js';
import { ResourceScheduler } from '../../src/compute/scheduler.js';
import { defaultShare, patchShare } from '../../src/compute/share.js';
import { localServing } from '../../src/compute/index.js';
import { readAdvert } from '../../src/compute/wire.js';
import { Net } from './inproc.js';

export const GiB = 1024 ** 3;
export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** A brain that answers when the test says so, streams tokens on demand and records aborts. */
export function controlledBrain({ id = 'local', model = 'qwen2.5-coder-3b', gpu = 'cuda', backend = 'local', kind = 'local', url } = {}) {
  const brain = {
    id, label: id, kind,
    calls: [],
    aborted: 0,
    info: () => ({ backend, model, gpu, fileBytes: 2_104_932_800, contextSize: 4096, ...(url ? { url } : {}) }),
    chat(messages, options = {}) {
      return new Promise((resolve, reject) => {
        const call = {
          messages, options,
          token: (t) => options.onToken?.(t),
          answer: (text = 'done', extra = {}) => resolve({ text, promptTokens: 10, completionTokens: 5, ms: 100, model, ...extra }),
          fail: (err) => reject(err)
        };
        brain.calls.push(call);
        options.signal?.addEventListener('abort', () => { brain.aborted++; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
      });
    },
    get last() { return brain.calls[brain.calls.length - 1]; }
  };
  return brain;
}

export function sharing(change = {}) {
  return patchShare(defaultShare(8), { modelAllowlist: ['qwen2.5-coder-3b'], ...change, gpu: { enabled: true, remoteInference: true, ...change.gpu } }, { threads: 8 });
}

export function resource({ free = 5 * GiB, total = 6 * GiB, ramFree = 10 * GiB } = {}) {
  return {
    sampledAt: Date.now(),
    cpu: { model: 'Test CPU', cores: 4, threads: 8, avx2: true, loadPct: 10 },
    ram: { totalBytes: 16 * GiB, freeBytes: ramFree },
    gpus: [{ index: 0, name: 'GTX 1060', vendor: 'nvidia', vramTotalBytes: total, vramFreeBytes: free, utilPct: 1, source: 'nvidia-smi' }]
  };
}

/** The lender: a bus, a crew scheduler with a brain, and the worker on node `host`. */
export function workerEngine(net, name = 'rita', opts = {}) {
  const node = net.node(name);
  const bus = new EventBus();
  const scheduler = new Scheduler(bus);
  const brain = opts.brain || controlledBrain();
  scheduler.addBrain(brain);
  const state = { share: opts.share || sharing(), resource: opts.resource || resource() };
  const servingOverride = opts.serving;
  const worker = new ComputeWorker({
    link: node, bus, now: opts.now,
    getShare: () => state.share,
    getResource: () => state.resource,
    serving: () => (servingOverride ? servingOverride(brain) : localServing(scheduler, state.resource)),
    runTurn: (req) => scheduler.turn(req)
  });
  return { node, bus, scheduler, brain, worker, state };
}

/** The borrower: a requester on node `name`, with its own local brain unless `noLocal`. */
export function requesterEngine(net, name = 'alex', opts = {}) {
  const node = net.node(name);
  const bus = new EventBus();
  const scheduler = new Scheduler(bus);
  const brain = opts.noLocal ? null : (opts.brain || controlledBrain({ gpu: 'cpu' }));
  if (brain) scheduler.addBrain(brain);
  const resources = new ResourceScheduler();
  const res = opts.resource || { ...resource(), gpus: [] };
  const requester = new Requester({
    link: node, resources, bus,
    choiceWaitMs: opts.choiceWaitMs ?? 2000, resourceWaitMs: opts.resourceWaitMs ?? 200, offerAnswerMs: opts.offerAnswerMs,
    localState: () => {
      const s = localServing(scheduler, res);
      return { resource: res, brain: s ? { device: s.device, gpuIndex: s.gpuIndex, model: s.model, bytes: s.bytes } : null, queue: { waiting: 0, running: 0 } };
    },
    runLocal: (req) => scheduler.turn({ ...req, eligible: (id) => id !== 'compute' })
  });
  // Adverts as the plug-in feeds them.
  node.onMessage((peerId, type, body) => { if (type === 'resource.advert') { resources.advert(peerId, readAdvert(body)); requester.resourcesChanged(); } });
  return { node, bus, scheduler, brain, requester, resources };
}

/** The advert a worker engine would send now. */
export function advertOf(w) {
  const s = localServing(w.scheduler, w.state.resource);
  return {
    sampledAt: Date.now(), ...w.state.resource,
    serving: s ? { model: s.model, device: s.device, gpuIndex: s.gpuIndex ?? 0, vramBytes: s.vramBytes, bytes: s.bytes } : null,
    share: w.state.share, insideHours: true, busy: { jobs: w.worker.busy().jobs, turns: 0 }
  };
}

export { Net };
