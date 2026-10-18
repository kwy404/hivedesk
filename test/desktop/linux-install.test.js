// hivedesk-linux-install.sh: checksum first, then the versioned layout in a temporary prefix, the menu entry,
// a bad checksum installs nothing, and --uninstall. Needs a POSIX sh with tar and sha256sum; skipped without one.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeTarGz } from './fixtures.js';
import { detectInstall } from '../../desktop/update/layout.js';

const SCRIPT = path.resolve('desktop/installer/linux/hivedesk-linux-install.sh');
const shOk = (() => { try { return spawnSync('sh', ['-c', 'command -v tar && command -v sha256sum'], { encoding: 'utf8' }).status === 0; } catch { return false; } })();
const posix = (p) => p.replace(/\\/g, '/');

describe.skipIf(!shOk)('hivedesk-linux-install.sh', () => {
  let tmp;
  let from;
  let prefix;
  const pkg = (v) => makeTarGz({
    'hivedesk/': '', 'hivedesk/hivedesk': { data: `#!/bin/sh\n# ${v}\n`, mode: 0o755 }, 'hivedesk/node/bin/node': { data: '#!/bin/sh\n', mode: 0o755 },
    'hivedesk/app/desktop/main.js': `// ${v}`, 'hivedesk/hivedesk.png': 'png'
  });
  const publish = (v, tamper = false) => {
    const tar = pkg(v);
    fs.writeFileSync(path.join(from, 'hivedesk-linux-x64.tar.gz'), tar);
    const sum = crypto.createHash('sha256').update(tamper ? Buffer.from('other') : tar).digest('hex');
    fs.writeFileSync(path.join(from, 'SHA256SUMS.txt'), `${sum}  hivedesk-linux-x64.tar.gz\n${'0'.repeat(64)}  latest.json\n`);
  };
  const run = (...args) => spawnSync('sh', [posix(SCRIPT), '--prefix', posix(prefix), '--from', posix(from), ...args], { encoding: 'utf8', env: { ...process.env, PATH: process.env.PATH } });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hivedesk-linux-'));
    from = path.join(tmp, 'release');
    prefix = path.join(tmp, 'local');
    fs.mkdirSync(from);
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('checks the SHA-256, installs the versioned layout with a menu entry, and upgrades keeping one previous version', () => {
    publish('1.0.0');
    const r = run('--version', '1.0.0');
    expect(r.stderr + r.stdout).toMatch(/SHA-256 checked/);
    expect(r.status).toBe(0);
    const root = path.join(prefix, 'share', 'hivedesk');
    expect(fs.readFileSync(path.join(root, 'current.txt'), 'utf8').trim()).toBe('1.0.0');
    expect(fs.existsSync(path.join(root, 'versions', '1.0.0', 'app', 'desktop', 'main.js'))).toBe(true);
    expect(fs.readFileSync(path.join(prefix, 'share', 'applications', 'hivedesk.desktop'), 'utf8')).toMatch(/Exec=".*hivedesk" %U/);
    expect(fs.existsSync(path.join(prefix, 'share', 'icons', 'hicolor', '512x512', 'apps', 'hivedesk.png'))).toBe(true);
    // The app sees a versioned install it can update by itself.
    const install = detectInstall({ desktopDir: path.join(root, 'versions', '1.0.0', 'app', 'desktop'), home: tmp, platform: 'linux', env: {} });
    expect(install).toMatchObject({ kind: 'versioned', asset: 'linux-x64' });
    publish('1.1.0');
    expect(run('--version', '1.1.0').status).toBe(0);
    expect(fs.readdirSync(path.join(root, 'versions')).sort()).toEqual(['1.0.0', '1.1.0']);
    expect(fs.readFileSync(path.join(root, 'update-state.json'), 'utf8')).toContain('"previous":"1.0.0"');
  });

  it('installs nothing when the checksum does not match', () => {
    publish('1.0.0', true);
    const r = run('--version', '1.0.0');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/does not match its SHA-256/);
    expect(fs.existsSync(path.join(prefix, 'share', 'hivedesk'))).toBe(false);
  });

  it('refuses a copy without a version and removes an install with --uninstall', () => {
    publish('1.0.0');
    const r0 = spawnSync('sh', [posix(SCRIPT), '--prefix', posix(prefix), '--from', posix(from)], { encoding: 'utf8' });
    expect(r0.status).not.toBe(0);
    expect(run('--version', '1.0.0').status).toBe(0);
    const u = spawnSync('sh', [posix(SCRIPT), '--prefix', posix(prefix), '--uninstall'], { encoding: 'utf8' });
    expect(u.status).toBe(0);
    expect(fs.existsSync(path.join(prefix, 'share', 'hivedesk'))).toBe(false);
    expect(fs.existsSync(path.join(prefix, 'share', 'applications', 'hivedesk.desktop'))).toBe(false);
  });
});
