// --doctor: checks Node, the GPU, RAM, disk, the runtime and the models present.
// With p2p: true (hivedesk doctor --p2p) also the control plane: identity, peers, audit chain,
// ports, the rendezvous relays and the NAT type (src/p2p/doctor.js).
import path from 'node:path';
import { detectHardware, formatBytes } from './brain/hardware.js';
import { pickModel, listModelFiles, modelsDir, isCached, MODELS } from './brain/models.js';
import { findRuntime, RUNTIME_VERSION } from './brain/runtime.js';
import { probeOllama, probeLmStudio } from './brain/http.js';
import { permissionFlag } from './tools/run.js';
import { runP2PChecks } from './p2p/doctor.js';

/**
 * @param {{ home: string, model?: string, hardware?: any, fetchImpl?: typeof fetch, p2p?: boolean | object }} opts
 */
export async function runDoctor(opts) {
  const hw = opts.hardware || (await detectHardware({ dir: opts.home }));
  const checks = [];
  const add = (id, label, ok, detail, hint) => checks.push(hint ? { id, label, ok, detail, hint } : { id, label, ok, detail });

  const [major] = process.versions.node.split('.').map(Number);
  const nodeOk = major >= 20;
  add('node', 'Node.js', nodeOk, `${process.version}`, nodeOk ? undefined : 'Install Node 20 or newer.');
  const perm = permissionFlag();
  add('sandbox', 'Node permission flags for "run"', true, perm ? `${perm} is used for "node <file>"` : 'not available in this Node; "run" still has the allow list, timeout and approvals', perm ? undefined : 'Node 22 or newer adds file system permission flags.');

  if (hw.gpu) add('gpu', 'GPU', true, `${hw.gpu.name}, ${formatBytes(hw.gpu.vramBytes)} ${hw.gpu.unified ? 'unified memory' : 'VRAM'} (${hw.gpu.backend})`);
  else add('gpu', 'GPU', true, 'no NVIDIA or Apple GPU found; the CPU is used (slow), Vulkan GPUs are tried by the runtime', 'An NVIDIA GPU with 6 GB or more runs the 7B model well.');

  const ramOk = hw.ramBytes >= 7.5e9;
  add('ram', 'RAM', ramOk, `${formatBytes(hw.ramBytes)} total, ${formatBytes(hw.freeRamBytes)} free`, ramOk ? undefined : 'With less than 8 GB only the 1.5B model is practical.');

  const rec = pickModel(hw);
  const cached = isCached(opts.home, rec);
  const needDisk = cached ? 0 : rec.bytes + 100e6;
  const diskOk = hw.diskFreeBytes == null || hw.diskFreeBytes >= needDisk;
  add('disk', 'Free disk', diskOk, `${formatBytes(hw.diskFreeBytes)} free in ${path.dirname(modelsDir(opts.home))}${needDisk ? `, the model needs ${formatBytes(needDisk)}` : ''}`,
    diskOk ? undefined : 'Free some space or use --model with a file you already have.');

  add('model', 'Recommended model', true, `${rec.name} (${formatBytes(rec.bytes)}) ${cached ? 'is downloaded' : 'will be downloaded on the first run'}`);

  const runtime = await findRuntime(opts.home);
  add('runtime', 'Local runtime (node-llama-cpp)', true, runtime ? `${runtime.version} in ${path.dirname(path.dirname(runtime.entry))}` : `not installed yet; version ${RUNTIME_VERSION} is installed on the first run`);

  const dirs = [modelsDir(opts.home)];
  if (opts.model) dirs.push(path.dirname(path.resolve(opts.model)));
  const models = listModelFiles(dirs);
  add('models', 'Models present', true, models.length ? models.map((m) => `${m.file} (${formatBytes(m.bytes)})`).join(', ') : 'none yet');

  const f = opts.fetchImpl || fetch;
  const [ollama, lms] = await Promise.all([probeOllama(undefined, f), probeLmStudio(undefined, f)]);
  add('ollama', 'Ollama', true, ollama ? `running, ${ollama.length} models${ollama.length ? ': ' + ollama.slice(0, 4).join(', ') : ''}` : 'not running (optional)');
  add('lmstudio', 'LM Studio', true, lms ? `running, ${lms.length} models` : 'not running (optional)');

  if (opts.p2p) checks.push(...(await runP2PChecks({ home: opts.home, fetchImpl: opts.fetchImpl, ...(typeof opts.p2p === 'object' ? opts.p2p : {}) })));

  const known = new Set(MODELS.map((m) => m.file));
  return {
    ok: checks.every((c) => c.ok),
    checks,
    hardware: hw,
    models: models.map((m) => ({ ...m, known: known.has(m.file) })),
    recommended: { id: rec.id, name: rec.name, bytes: rec.bytes, cached }
  };
}

export function formatDoctor(report) {
  const lines = ['hivedesk doctor', ''];
  for (const c of report.checks) {
    lines.push(`${c.ok ? '[ok]  ' : '[fail]'} ${c.label}: ${c.detail}`);
    if (c.hint) lines.push(`       ${c.hint}`);
  }
  lines.push('', report.ok ? 'Everything needed is in place.' : 'Some checks failed; see the hints above.');
  return lines.join('\n');
}
