// Builds the folder of one downloadable package. Used by .github/workflows/desktop.yml.
//   node desktop/scripts/package.mjs --target windows-x64|macos-universal|linux-x64 --node <node binary> --out <dir>
//     [--launcher <hivedesk.exe>]   (Windows: the compiled launcher)
//     [--npm <npm folder>]          (the npm package of the same Node.js build; found next to --node when left out)
// The runtime binary comes from the pinned upstream archive and is checked against desktop/platform.js.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME, BINARIES } from '../platform.js';
import { sha256 } from '../runtime.js';
import { extractEntry } from '../zip.js';
import { packagedHelperAllowed } from '../native.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const DESKTOP = path.join(ROOT, 'desktop');

const opts = {};
for (let i = 2; i < process.argv.length; i += 2) opts[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const TARGETS = {
  'windows-x64': { bin: 'win_x64', runtimeName: 'hivedesk-runtime.exe' },
  'macos-universal': { bin: 'mac_universal', runtimeName: 'hivedesk-runtime' },
  'linux-x64': { bin: 'linux_x64', runtimeName: 'hivedesk-runtime' }
};
const t = TARGETS[opts.target];
if (!t || !opts.node || !opts.out) {
  console.error('usage: package.mjs --target windows-x64|macos-universal|linux-x64 --node <node binary> --out <dir> [--launcher <exe>] [--zip <runtime zip>]');
  process.exit(2);
}
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/** Copies what npm would publish (package.json "files"), always with desktop/. */
function copyApp(dest) {
  // "!path" entries of package.json files are left out, as npm does.
  const slash = (p) => p.split(path.sep).join('/');
  const excluded = (pkg.files || []).filter((f) => f.startsWith('!')).map((f) => f.slice(1));
  const files = new Set([...(pkg.files || []).filter((f) => !f.startsWith('!')), 'desktop', 'package.json', 'LICENSE']);
  // Only the native helpers desktop/native.js lists (with a pinned hash) go into a package.
  const helperOk = (rel) => !/^desktop[\\/]helpers([\\/]|$)/.test(rel) || packagedHelperAllowed(rel.replace(/^desktop[\\/]/, ''));
  const skip = (rel) => excluded.some((x) => slash(rel) === x || slash(rel).startsWith(`${x}/`)) || !helperOk(rel) || /^desktop[\\/](scripts|launcher|bin)([\\/]|$)/.test(rel) || /^desktop[\\/]icons[\\/].*\.(icns|ico)$/.test(rel) || /(^|[\\/])node_modules([\\/]|$)/.test(rel);
  for (const f of files) {
    const src = path.join(ROOT, f);
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, path.join(dest, f), { recursive: true, filter: (s) => !skip(path.relative(ROOT, s)) });
  }
}

async function runtimeBinary() {
  let zip;
  if (opts.zip) zip = fs.readFileSync(opts.zip);
  else {
    const res = await fetch(RUNTIME.zip.url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`runtime download: HTTP ${res.status}`);
    zip = Buffer.from(await res.arrayBuffer());
  }
  if (sha256(zip) !== RUNTIME.zip.sha256) throw new Error('runtime archive checksum mismatch');
  const b = BINARIES[t.bin];
  const bin = extractEntry(zip, b.file);
  if (!bin || sha256(bin) !== b.sha256) throw new Error(`${b.file}: checksum mismatch`);
  return bin;
}

const out = path.resolve(opts.out);
fs.rmSync(out, { recursive: true, force: true });
const bin = await runtimeBinary();
let appDir;
let nodeDest;
if (opts.target === 'macos-universal') {
  const contents = path.join(out, 'hivedesk.app', 'Contents');
  appDir = path.join(contents, 'Resources', 'app');
  nodeDest = path.join(contents, 'Resources', 'node', 'bin', 'node');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(contents, 'Info.plist'), fs.readFileSync(path.join(DESKTOP, 'launcher', 'macos', 'Info.plist'), 'utf8').replaceAll('@VERSION@', pkg.version));
  fs.copyFileSync(path.join(DESKTOP, 'launcher', 'macos', 'hivedesk'), path.join(contents, 'MacOS', 'hivedesk'));
  fs.chmodSync(path.join(contents, 'MacOS', 'hivedesk'), 0o755);
  fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
  fs.copyFileSync(path.join(DESKTOP, 'icons', 'hivedesk.icns'), path.join(contents, 'Resources', 'hivedesk.icns'));
} else if (opts.target === 'windows-x64') {
  if (!opts.launcher) throw new Error('--launcher <hivedesk.exe> is needed for Windows');
  appDir = path.join(out, 'hivedesk', 'app');
  nodeDest = path.join(out, 'hivedesk', 'node', 'node.exe');
  fs.mkdirSync(path.join(out, 'hivedesk'), { recursive: true });
  fs.copyFileSync(opts.launcher, path.join(out, 'hivedesk', 'hivedesk.exe'));
} else {
  const base = path.join(out, 'hivedesk');
  appDir = path.join(base, 'app');
  nodeDest = path.join(base, 'node', 'bin', 'node');
  fs.mkdirSync(base, { recursive: true });
  for (const f of ['hivedesk', 'hivedesk.desktop']) fs.copyFileSync(path.join(DESKTOP, 'launcher', 'linux', f), path.join(base, f));
  fs.chmodSync(path.join(base, 'hivedesk'), 0o755);
  fs.copyFileSync(path.join(DESKTOP, 'icons', 'icon-512.png'), path.join(base, 'hivedesk.png'));
}
copyApp(appDir);
fs.mkdirSync(path.join(appDir, 'desktop', 'bin'), { recursive: true });
fs.writeFileSync(path.join(appDir, 'desktop', 'bin', t.runtimeName), bin, { mode: 0o755 });
// Licenses of the bundled runtimes.
const lic = await fetch(RUNTIME.license);
if (!lic.ok) throw new Error('runtime license: HTTP ' + lic.status);
fs.writeFileSync(path.join(appDir, 'desktop', 'bin', 'LICENSE-neutralinojs.txt'), Buffer.from(await lic.arrayBuffer()));
fs.mkdirSync(path.dirname(nodeDest), { recursive: true });
const nodeLicense = [path.dirname(opts.node), path.dirname(path.dirname(opts.node))].map((d) => path.join(d, 'LICENSE')).find((f) => fs.existsSync(f));
if (nodeLicense) fs.copyFileSync(nodeLicense, path.join(path.dirname(nodeDest), 'LICENSE'));
else console.warn('package: no Node.js LICENSE found next to the node binary');
fs.copyFileSync(opts.node, nodeDest);
fs.chmodSync(nodeDest, 0o755);
// npm goes with the bundled Node.js: the local model runtime (node-llama-cpp) is installed with it on first use,
// and a PC without Node.js has no other npm. It sits where src/brain/runtime.js looks for it: next to node.exe on
// Windows, in ../lib/node_modules on macOS and Linux, the layout of the official Node.js archives.
const npmSrc = opts.npm || [path.join(path.dirname(opts.node), 'node_modules', 'npm'), path.join(path.dirname(path.dirname(opts.node)), 'lib', 'node_modules', 'npm')]
  .find((d) => fs.existsSync(path.join(d, 'bin', 'npm-cli.js')));
if (!npmSrc || !fs.existsSync(path.join(npmSrc, 'bin', 'npm-cli.js'))) throw new Error('package: npm was not found next to the bundled Node.js; pass --npm <folder>');
const npmDest = opts.target === 'windows-x64'
  ? path.join(path.dirname(nodeDest), 'node_modules', 'npm')
  : path.join(path.dirname(path.dirname(nodeDest)), 'lib', 'node_modules', 'npm');
fs.cpSync(npmSrc, npmDest, { recursive: true });

const readme = [
  `hivedesk ${pkg.version} (${opts.target})`,
  '',
  'Start it:',
  opts.target === 'windows-x64' ? '  double click hivedesk.exe' : opts.target === 'macos-universal' ? '  open hivedesk.app' : '  ./hivedesk  (or install hivedesk.desktop in ~/.local/share/applications)',
  '',
  'Inside:',
  '  the hivedesk app (the same files as the npm package),',
  `  a Node.js runtime (${path.basename(opts.node)}), so nothing else needs to be installed,`,
  `  the desktop runtime ${RUNTIME.name} ${RUNTIME.version} (MIT), which shows the app in the system web view.`,
  '',
  'The app is not signed. See https://github.com/kwy404/hivedesk/blob/main/desktop/README.md for the first launch prompts.',
  'Logs: ~/.hivedesk/desktop/launcher.log. Projects default to ~/hivedesk.',
  ''
].join(os.EOL);
fs.writeFileSync(path.join(opts.target === 'macos-universal' ? out : path.join(out, 'hivedesk'), 'README.txt'), readme);
console.log(`package: ${opts.target} staged in ${out}`);
