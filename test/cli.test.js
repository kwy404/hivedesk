import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, joinWords, startUrl } from '../src/cli.js';
import { runDoctor, formatDoctor } from '../src/doctor.js';
import { tmpDir } from './helpers.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

describe('cli', () => {
  it('parses the options', () => {
    expect(parseArgs(['--port', '4000', '--dir=x', '--no-open', '--model', 'm.gguf', '--no-download', '--cpu'])).toMatchObject({ port: 4000, dir: 'x', open: false, model: 'm.gguf', download: false, cpu: true });
    expect(parseArgs(['--demo'])).toMatchObject({ demo: true, open: true, download: true });
    expect(() => parseArgs(['--port', 'abc'])).toThrow('--port');
    expect(() => parseArgs(['--brain', 'x'])).toThrow('--brain');
    expect(() => parseArgs(['--model'])).toThrow('needs a value');
    expect(() => parseArgs(['--wat'])).toThrow('unknown');
    expect(() => parseArgs(['file'])).toThrow('unexpected');
  });

  it('builds the start URL for lend and join', () => {
    expect(joinWords('https://kwy404.github.io/hivedesk/app/#w=apple-brave-cat-dog-eel-fox')).toBe('apple-brave-cat-dog-eel-fox');
    expect(joinWords('apple brave cat dog eel fox')).toBe('apple-brave-cat-dog-eel-fox');
    expect(joinWords('two words')).toBeNull();
    expect(startUrl(1, 'tk', {})).toBe('http://127.0.0.1:1/?t=tk');
    expect(startUrl(1, 'tk', { lend: true })).toBe('http://127.0.0.1:1/lend/?t=tk');
    expect(startUrl(1, 'tk', { join: 'a b c d e f' })).toBe('http://127.0.0.1:1/?t=tk#w=a-b-c-d-e-f');
  });

  it('prints help and version', () => {
    const h = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
    expect(h.status).toBe(0);
    expect(h.stdout).toContain('--doctor');
    const v = spawnSync(process.execPath, [CLI, '--version'], { encoding: 'utf8' });
    expect(v.stdout.trim()).toBe('0.1.1');
    const bad = spawnSync(process.execPath, [CLI, '--nope'], { encoding: 'utf8' });
    expect(bad.status).toBe(2);
  });
});

describe('doctor', () => {
  it('reports Node, GPU, RAM, disk, runtime and models', async () => {
    const offline = async () => { throw new TypeError('fetch failed'); };
    const hw = { os: 'test', cpus: 4, ramBytes: 16e9, freeRamBytes: 8e9, gpu: null, diskFreeBytes: 1e9 };
    const r = await runDoctor({ home: tmpDir(), hardware: hw, fetchImpl: offline });
    const ids = r.checks.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['node', 'gpu', 'ram', 'disk', 'model', 'runtime', 'models', 'ollama', 'lmstudio']));
    expect(r.checks.find((c) => c.id === 'disk').ok).toBe(false);
    expect(r.recommended.id).toBe('qwen2.5-coder-3b');
    expect(r.ok).toBe(false);
    expect(formatDoctor(r)).toMatch(/\[fail\] Free disk/);
  });
});

describe('app window and token', () => {
  it('builds app window arguments with its own profile, lists browsers, keeps a stable token', async () => {
    const { appArgs, chromiumCandidates, loadToken, stablePort } = await import('../src/cli.js');
    const args = appArgs('http://127.0.0.1:4174/?t=x', '/home/me/.hivedesk');
    expect(args[0]).toBe('--app=http://127.0.0.1:4174/?t=x');
    expect(args).toContain('--window-size=1440,900');
    expect(args.find((a) => a.startsWith('--user-data-dir='))).toContain('browser-profile');
    expect(chromiumCandidates('win32', { ProgramFiles: 'C:/PF', 'ProgramFiles(x86)': 'C:/PF86' })[0]).toMatch(/Edge/);
    expect(chromiumCandidates('linux')).toContain('/usr/bin/chromium');
    const home = tmpDir();
    const a = loadToken(home);
    expect(loadToken(home)).toBe(a);
    expect(loadToken(home, true)).not.toBe(a);
    expect(typeof (await stablePort(0))).toBe('number');
  });
});
