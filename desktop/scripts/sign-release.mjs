// Signs a release that went out without latest.json (no HIVEDESK_UPDATE_KEY secret in GitHub Actions).
// On the owner's PC, with the GitHub CLI logged in:
//   node desktop/scripts/sign-release.mjs --tag v1.0.0 [--repo kwy404/hivedesk] [--key <pem>] [--dry-run]
// It downloads the release assets into a temporary folder with gh, runs desktop/scripts/manifest.mjs with the
// private key from %USERPROFILE%/.hivedesk-release/update-key.pem (the key goes to the child process in its
// environment, it is never printed or written anywhere), rewrites SHA256SUMS.txt with latest.json and its
// signature, and uploads latest.json, latest.json.sig and SHA256SUMS.txt with --clobber.
// --dry-run prints every command and runs none of them; it does not read the key.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

/** Reads the arguments: --tag is required; the rest has defaults. */
export function readArgs(argv) {
  const o = { repo: 'kwy404/hivedesk', key: path.join(os.homedir(), '.hivedesk-release', 'update-key.pem'), dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--tag' || a === '--repo' || a === '--key' || a === '--dir') o[a.slice(2)] = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(o.tag || '')) throw new Error('--tag v<x.y.z> is required');
  if (!/^[\w.-]+\/[\w.-]+$/.test(o.repo)) throw new Error('--repo owner/name');
  return o;
}

/** The steps, as [program, args] or a note, in order. */
export function plan(o, dir) {
  const version = o.tag.slice(1);
  return [
    ['gh', ['release', 'download', o.tag, '--repo', o.repo, '--dir', dir, '--clobber']],
    ['node', [path.join(ROOT, 'desktop', 'scripts', 'manifest.mjs'), '--dist', dir, '--version', version, '--tag', o.tag]],
    { note: `rewrite ${path.join(dir, 'SHA256SUMS.txt')} over every file in ${dir}` },
    ['gh', ['release', 'upload', o.tag, path.join(dir, 'latest.json'), path.join(dir, 'latest.json.sig'), path.join(dir, 'SHA256SUMS.txt'), '--repo', o.repo, '--clobber']],
  ];
}

const quote = (s) => (/[\s"']/.test(s) ? `"${String(s).replace(/"/g, '\\"')}"` : s);
export const show = (step) => (step.note ? `# ${step.note}` : [step[0], ...step[1]].map(quote).join(' '));

/** SHA256SUMS.txt in the sha256sum format, for every file in dir but itself. */
export function writeSums(dir) {
  const names = fs.readdirSync(dir).filter((f) => f !== 'SHA256SUMS.txt' && fs.statSync(path.join(dir, f)).isFile()).sort();
  const lines = names.map((f) => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex')}  ${f}`);
  fs.writeFileSync(path.join(dir, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`);
  return names.length;
}

export function main(argv = process.argv.slice(2), { log = console.log } = {}) {
  const o = readArgs(argv);
  const dir = o.dir || path.join(os.tmpdir(), `hivedesk-sign-${o.tag}`);
  const steps = plan(o, dir);
  if (o.dryRun) {
    log(`sign-release (dry run): the key would be read from ${o.key}${fs.existsSync(o.key) ? '' : ' (not found here)'}`);
    for (const s of steps) log(show(s));
    return { dryRun: true, steps: steps.map(show) };
  }
  if (!fs.existsSync(o.key)) throw new Error(`no key at ${o.key}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const s of steps) {
    log(show(s));
    if (s.note) { writeSums(dir); continue; }
    const env = s[0] === 'node' ? { ...process.env, HIVEDESK_UPDATE_KEY: fs.readFileSync(o.key, 'utf8') } : process.env;
    const r = spawnSync(s[0], s[1], { stdio: 'inherit', env, shell: process.platform === 'win32' && s[0] === 'gh' });
    if (r.status !== 0) throw new Error(`${s[0]} failed (exit ${r.status})`);
  }
  log(`sign-release: ${o.tag} has latest.json, latest.json.sig and a new SHA256SUMS.txt`);
  return { dryRun: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (err) { console.error(`sign-release: ${err.message}`); process.exit(1); }
}
