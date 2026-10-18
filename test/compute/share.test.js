import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers.js';
import { defaultShare, normalizeShare, patchShare, loadShare, saveShare, insideHours, parseSize, describeShare } from '../../src/compute/share.js';
import { parseShareArgs, runShare } from '../../src/compute/share-cli.js';

const GiB = 1024 ** 3;

describe('ShareSettings', () => {
  it('shares nothing by default: GPU and CPU are separate and both off', () => {
    const s = defaultShare(8);
    expect(s.enabled).toBe(false);
    expect(s.gpu).toEqual({ enabled: false, maxVramBytes: null, maxConcurrentJobs: 1, maxJobSeconds: 120, remoteInference: false, modelDownload: false });
    expect(s.cpu).toEqual({ enabled: false, maxThreads: 4, maxRamBytes: null });
    expect(s.modelAllowlist).toEqual([]);
    expect(s.peers).toBe('known');
    // The frozen top level fields of PLAN section 2 mirror the GPU block.
    expect(s).toMatchObject({ remoteInference: false, modelDownload: false, maxConcurrentJobs: 1, maxVramBytes: null, maxJobSeconds: 120, maxTokensPerJob: 2048 });
  });

  it('clamps and cleans anything it reads', () => {
    const s = normalizeShare({
      gpu: { enabled: 'yes', maxConcurrentJobs: 99, maxJobSeconds: 1, maxVramBytes: -5 },
      cpu: { enabled: true, maxThreads: 500, maxRamBytes: 10 },
      maxTokensPerJob: 100000, modelAllowlist: ['7b', 7, '', 'x'.repeat(300)], peers: ['nope', 'hd1' + 'a'.repeat(49)],
      hours: { from: '25:00', to: '10:00' }, evil: true
    }, { threads: 8 });
    expect(s.gpu.enabled).toBe(false);
    expect(s.gpu.maxConcurrentJobs).toBe(4);
    expect(s.gpu.maxJobSeconds).toBe(10);
    expect(s.gpu.maxVramBytes).toBe(null);
    expect(s.cpu).toEqual({ enabled: true, maxThreads: 8, maxRamBytes: 512 * 1024 ** 2 });
    expect(s.enabled).toBe(true);
    expect(s.maxTokensPerJob).toBe(8192);
    expect(s.modelAllowlist).toEqual(['7b']);
    expect(s.peers).toEqual(['hd1' + 'a'.repeat(49)]);
    expect(s.hours).toBeUndefined();
    expect(s.evil).toBeUndefined();
  });

  it('reads a flat 0.x style object as the GPU block', () => {
    const s = normalizeShare({ enabled: true, remoteInference: true, maxVramBytes: 6 * GiB });
    expect(s.gpu).toMatchObject({ enabled: true, remoteInference: true, maxVramBytes: 6 * GiB });
    expect(s.cpu.enabled).toBe(false);
  });

  it('patches parts and keeps the rest', () => {
    const a = patchShare(defaultShare(8), { gpu: { enabled: true }, hours: { from: '22:00', to: '06:00' } }, { threads: 8 });
    const b = patchShare(a, { cpu: { enabled: true }, hours: null }, { threads: 8 });
    expect(b.gpu.enabled).toBe(true);
    expect(b.cpu.enabled).toBe(true);
    expect(b.hours).toBeUndefined();
  });

  it('checks the hours window, also across midnight', () => {
    const at = (h, m = 0) => new Date(2026, 9, 17, h, m);
    const day = { hours: { from: '09:00', to: '18:00' } };
    expect(insideHours(day, at(9))).toBe(true);
    expect(insideHours(day, at(18))).toBe(false);
    const night = { hours: { from: '22:00', to: '06:00' } };
    expect(insideHours(night, at(23))).toBe(true);
    expect(insideHours(night, at(5, 59))).toBe(true);
    expect(insideHours(night, at(12))).toBe(false);
    expect(insideHours({}, at(3))).toBe(true);
  });

  it('saves into settings.json and keeps the other sections', () => {
    const home = tmpDir();
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ v: 1, workbench: { tabSize: 2 } }));
    saveShare(home, patchShare(defaultShare(4), { cpu: { enabled: true } }, { threads: 4 }), { threads: 4 });
    const doc = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));
    expect(doc.workbench).toEqual({ tabSize: 2 });
    expect(loadShare(home, { threads: 4 }).cpu.enabled).toBe(true);
    expect(fs.readdirSync(home).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('a broken settings file means everything off', () => {
    const home = tmpDir();
    fs.writeFileSync(path.join(home, 'settings.json'), '{ not json');
    expect(loadShare(home).enabled).toBe(false);
  });

  it('parses sizes', () => {
    expect(parseSize('6GB')).toBe(6 * GiB);
    expect(parseSize('512m')).toBe(512 * 1024 ** 2);
    expect(parseSize('0.5 g')).toBe(GiB / 2);
    expect(parseSize('lots')).toBe(null);
  });

  it('describes itself in plain words', () => {
    const lines = describeShare(patchShare(defaultShare(8), { gpu: { enabled: true, remoteInference: true, maxVramBytes: 6 * GiB } }, { threads: 8 }));
    expect(lines).toContain('GPU sharing: on');
    expect(lines).toContain('  VRAM for peer jobs: at most 6.0 GB');
    expect(lines).toContain('CPU sharing: off');
  });
});

describe('hivedesk share', () => {
  it('parses the flags', () => {
    const { change } = parseShareArgs(['--on', '--max-vram', '6GB', '--max-jobs', '2', '--max-seconds=300', '--models', '3b,7b', '--download', 'off', '--cpu', 'on', '--threads', '4', '--max-ram', 'auto', '--hours', '09:00-18:00']);
    expect(change.gpu).toEqual({ enabled: true, remoteInference: true, maxVramBytes: 6 * GiB, maxConcurrentJobs: 2, maxJobSeconds: 300, modelDownload: false });
    expect(change.cpu).toEqual({ enabled: true, maxThreads: 4, maxRamBytes: null });
    expect(change.modelAllowlist).toEqual(['qwen2.5-coder-3b', 'qwen2.5-coder-7b']);
    expect(change.hours).toEqual({ from: '09:00', to: '18:00' });
    expect(parseShareArgs(['--off']).change).toMatchObject({ gpu: { enabled: false }, cpu: { enabled: false } });
    expect(() => parseShareArgs(['--max-jobs', '9'])).toThrow(/1 to 4/);
    expect(() => parseShareArgs(['--gpu', 'maybe'])).toThrow(/on or off/);
    expect(() => parseShareArgs(['--max-vram', 'big'])).toThrow(/size/);
    expect(() => parseShareArgs(['--frobnicate'])).toThrow(/unknown option/);
  });

  it('shows, changes and saves', () => {
    const home = tmpDir();
    const out = [];
    expect(runShare([], { home, out: (l) => out.push(l), threads: 8 })).toBe(0);
    expect(out).toContain('GPU sharing: off');
    out.length = 0;
    expect(runShare(['--cpu', 'on', '--threads', '2'], { home, out: (l) => out.push(l), threads: 8 })).toBe(0);
    expect(out).toContain('CPU sharing: on');
    expect(out).toContain('  threads for peer jobs: at most 2');
    expect(loadShare(home, { threads: 8 }).cpu).toEqual({ enabled: true, maxThreads: 2, maxRamBytes: null });
    expect(loadShare(home, { threads: 8 }).gpu.enabled).toBe(false);
    out.length = 0;
    expect(runShare(['--bad'], { home, out: (l) => out.push(l) })).toBe(2);
  });
});
