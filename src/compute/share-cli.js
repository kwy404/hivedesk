// `hivedesk share`: shows and changes ShareSettings (PLAN section 9). Stream 1's CLI shell calls runShare().
//
//   hivedesk share                          show the settings
//   hivedesk share --on | --off             --on turns GPU sharing on (with remote inference); --off turns GPU and CPU off
//   hivedesk share --gpu on|off --cpu on|off
//   hivedesk share --max-vram 6GB|auto --max-jobs 1 --max-seconds 120 --remote-inference on|off --download on|off
//   hivedesk share --threads 4 --max-ram 8GB|auto
//   hivedesk share --max-tokens 2048 --models 3b,7b|none --hours 09:00-18:00|off --peers known|<peerId>,<peerId>
import os from 'node:os';
import { loadShare, saveShare, patchShare, parseSize, describeShare } from './share.js';
import { modelById } from '../brain/models.js';

export const SHARE_HELP = `Usage: hivedesk share [options]

  --on                      share the GPU (and allow peer inference jobs on it)
  --off                     stop sharing the GPU and the CPU
  --gpu on|off              GPU sharing
  --cpu on|off              CPU sharing (separate from the GPU, off by default)
  --max-vram <size>|auto    the most VRAM peer jobs may hold, for example 6GB; auto is "free minus 1 GB"
  --max-jobs <1..4>         peer jobs at once on the GPU
  --max-seconds <10..1800>  the longest a peer job may run
  --remote-inference on|off peer inference jobs on the GPU
  --download on|off         download a built in model when a peer asks for one (off by default)
  --threads <n>             CPU threads for peer jobs
  --max-ram <size>|auto     the most RAM a CPU peer job may hold; auto is "free minus 2 GB"
  --max-tokens <1..8192>    tokens per job
  --models <list>|none      models peers may use: 0.5b, 1.5b, 3b, 7b, 14b, a GGUF file name or an Ollama model name
  --hours <HH:MM-HH:MM>|off only lend inside this local time window
  --peers known|<ids>       who may use it: known peers with compute.inference, or a comma separated list of peer ids`;

const onOff = (flag, v) => {
  if (v === 'on' || v === 'true' || v === 'yes') return true;
  if (v === 'off' || v === 'false' || v === 'no') return false;
  throw new Error(`${flag} must be on or off`);
};

/** Turns argv into a ShareSettings change. Throws a plain message on bad input. */
export function parseShareArgs(argv) {
  const change = { gpu: {}, cpu: {} };
  const takes = new Set(['gpu', 'cpu', 'max-vram', 'max-jobs', 'max-seconds', 'remote-inference', 'download', 'threads', 'max-ram', 'max-tokens', 'models', 'hours', 'peers']);
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument: ${a}`);
    let [key, val] = a.slice(2).split(/=(.*)/s);
    if (key === 'help') { help = true; continue; }
    if (key === 'on') { change.gpu.enabled = true; change.gpu.remoteInference = true; continue; }
    if (key === 'off') { change.gpu.enabled = false; change.cpu.enabled = false; continue; }
    if (!takes.has(key)) throw new Error(`unknown option: --${key}`);
    if (val === undefined) {
      val = argv[++i];
      if (val === undefined || val.startsWith('--')) throw new Error(`--${key} needs a value`);
    }
    const flag = `--${key}`;
    const num = (lo, hi) => {
      const n = Number(val);
      if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${flag} must be a number from ${lo} to ${hi}`);
      return n;
    };
    switch (key) {
      case 'gpu': change.gpu.enabled = onOff(flag, val); if (change.gpu.enabled && change.gpu.remoteInference === undefined) change.gpu.remoteInference = true; break;
      case 'cpu': change.cpu.enabled = onOff(flag, val); break;
      case 'remote-inference': change.gpu.remoteInference = onOff(flag, val); break;
      case 'download': change.gpu.modelDownload = onOff(flag, val); break;
      case 'max-jobs': change.gpu.maxConcurrentJobs = num(1, 4); break;
      case 'max-seconds': change.gpu.maxJobSeconds = num(10, 1800); break;
      case 'threads': change.cpu.maxThreads = num(1, 1024); break;
      case 'max-tokens': change.maxTokensPerJob = num(1, 8192); break;
      case 'max-vram':
      case 'max-ram': {
        const size = val === 'auto' ? null : parseSize(val);
        if (size === undefined || (size === null && val !== 'auto') || size === 0) throw new Error(`${flag} must be a size like 6GB, or auto`);
        if (key === 'max-vram') change.gpu.maxVramBytes = size;
        else change.cpu.maxRamBytes = size;
        break;
      }
      case 'models':
        change.modelAllowlist = val === 'none' ? [] : val.split(',').map((s) => s.trim()).filter(Boolean).map((m) => modelById(m)?.id || m);
        break;
      case 'hours': {
        if (val === 'off') { change.hours = null; break; }
        const m = val.match(/^(\d\d:\d\d)-(\d\d:\d\d)$/);
        if (!m) throw new Error('--hours must look like 09:00-18:00, or off');
        change.hours = { from: m[1], to: m[2] };
        break;
      }
      case 'peers':
        change.peers = val === 'known' ? 'known' : val.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
        break;
      default: break;
    }
  }
  return { change, help };
}

/**
 * @param {string[]} argv the arguments after "share"
 * @param {{ home: string, out?: (line: string) => void, threads?: number }} opts
 * @returns {number} exit code
 */
export function runShare(argv, opts) {
  const out = opts.out || ((l) => process.stdout.write(l + '\n'));
  const threads = opts.threads || os.cpus().length || 1;
  let parsed;
  try {
    parsed = parseShareArgs(argv);
  } catch (err) {
    out(`hivedesk share: ${err.message}`);
    out(SHARE_HELP);
    return 2;
  }
  if (parsed.help) { out(SHARE_HELP); return 0; }
  const current = loadShare(opts.home, { threads });
  const changed = argv.length > 0;
  const next = changed ? saveShare(opts.home, patchShare(current, parsed.change, { threads }), { threads }) : current;
  if (changed && Array.isArray(parsed.change.peers) && next.peers !== 'known' && next.peers.length < parsed.change.peers.length) {
    out('Some peer ids were not valid and were left out (a peer id starts with hd1 and has 52 characters).');
  }
  for (const line of describeShare(next)) out(line);
  if (changed) out('Saved. A running hivedesk applies it within a few seconds.');
  return 0;
}
