// A release without the HIVEDESK_UPDATE_KEY secret: the manifest steps warn and skip, a wrong key still
// fails, and desktop/scripts/sign-release.mjs signs it later from the owner's PC (dry run here).
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, readArgs, writeSums } from '../../desktop/scripts/sign-release.mjs';
import { tmpDir } from '../helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST = path.join(ROOT, 'desktop', 'scripts', 'manifest.mjs');
const run = (args, key) => spawnSync(process.execPath, [MANIFEST, ...args], { encoding: 'utf8', env: { ...process.env, HIVEDESK_UPDATE_KEY: key ?? '' } });

describe('a release without the update key', () => {
  it('warns and skips the key check and the manifest, and writes nothing', () => {
    const check = run(['--check', '--skip-without-key']);
    expect(check.status).toBe(0);
    expect(check.stdout).toMatch(/::warning::HIVEDESK_UPDATE_KEY is not set/);
    const dist = tmpDir();
    fs.writeFileSync(path.join(dist, 'hivedesk-windows-x64.zip'), 'zip');
    const m = run(['--skip-without-key', '--dist', dist, '--version', '1.0.0', '--tag', 'v1.0.0']);
    expect(m.status).toBe(0);
    expect(fs.existsSync(path.join(dist, 'latest.json'))).toBe(false);
  });

  it('still fails without the flag, and fails hard on a key that does not match the embedded public key', () => {
    expect(run(['--check']).status).toBe(1);
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const wrong = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const r = run(['--check', '--skip-without-key'], wrong);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/does not match the public key/);
    expect(r.stdout + r.stderr).not.toContain('PRIVATE KEY');
  });
});

describe('sign-release.mjs', () => {
  it('prints the download, manifest and upload commands in a dry run, without reading the key', () => {
    const lines = [];
    const r = main(['--tag', 'v1.0.0', '--dry-run', '--key', path.join(tmpDir(), 'nope.pem'), '--dir', 'C:/tmp/sign'], { log: (l) => lines.push(l) });
    expect(r.dryRun).toBe(true);
    const text = lines.join('\n');
    expect(text).toMatch(/gh release download v1\.0\.0 --repo kwy404\/hivedesk --dir .* --clobber/);
    expect(text).toMatch(/manifest\.mjs.* --dist .* --version 1\.0\.0 --tag v1\.0\.0/);
    expect(text).toMatch(/gh release upload v1\.0\.0 .*latest\.json .*latest\.json\.sig .*SHA256SUMS\.txt --repo kwy404\/hivedesk --clobber/);
    expect(text).toMatch(/not found here/);
    expect(() => readArgs(['--tag', 'latest'])).toThrow(/--tag/);
  });

  it('rewrites SHA256SUMS.txt over every asset, latest.json included', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'a.zip'), 'a');
    fs.writeFileSync(path.join(dir, 'latest.json'), '{}');
    fs.writeFileSync(path.join(dir, 'SHA256SUMS.txt'), 'old');
    expect(writeSums(dir)).toBe(2);
    const sums = fs.readFileSync(path.join(dir, 'SHA256SUMS.txt'), 'utf8');
    expect(sums).toContain(`${crypto.createHash('sha256').update('a').digest('hex')}  a.zip`);
    expect(sums).toContain('  latest.json');
  });
});
