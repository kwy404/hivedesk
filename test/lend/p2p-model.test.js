// The pure view models of the 1.0 Lend screen and Join window, and the strings file for the merge.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canLend, capLine, confirmModel, joinModel, lendingModel, minutesLeft, readForm } from '../../ui/lend/p2p-model.js';
import { P2P_EN, lineText, tx } from '../../ui/lend/p2p-text.js';
import { lendCaps } from '../../src/lend/share.js';

const GB = 1024 ** 3;

describe('Lend view models', () => {
  it('reads the form with clamps; nothing is lent without the GPU or the CPU', () => {
    const f = readForm({ gpu: { on: true, maxVramGB: '6' }, cpu: { on: false }, ram: { on: true, maxGB: '-3' }, minutes: '77' });
    expect(f.gpu.maxVramGB).toBe(6);
    expect(f.ram.maxGB).toBe(0.5);
    expect(f.minutes).toBe(60);
    expect(canLend(f)).toBe(true);
    expect(canLend(readForm({ gpu: { on: false }, cpu: { on: false } }))).toBe(false);
  });

  it('the form the window sends becomes separate capabilities with the same limits in the engine', () => {
    const f = readForm({ gpu: { on: true, maxVramGB: 6 }, cpu: { on: true, threads: 4, maxLoadPct: 30 }, ram: { on: true, maxGB: 8 }, storage: { on: true, maxGB: 20, modelDownload: true } });
    const caps = lendCaps(f);
    expect(caps.map((c) => c.name)).toEqual(['compute.inference', 'compute.gpu', 'compute.cpu', 'compute.ram', 'compute.storage']);
    expect(caps.map((c) => lineText(capLine(c)))).toEqual([
      'Run model jobs: 1 at a time, up to 120 s and 2048 tokens each',
      'GPU: up to 6 GB of VRAM',
      'CPU: 4 threads, at most 30% load',
      'RAM: up to 8 GB',
      'Storage: up to 20 GB, model downloads allowed',
    ]);
  });

  it('builds the confirm card, the lending rows and the join phases', () => {
    const now = Date.parse('2026-10-17T12:00:00Z');
    const req = { requestId: 'jr_1', peer: { name: 'Ben', fingerprint: { words: ['a', 'b', 'c', 'd', 'e', 'f'] }, knownBefore: false }, sas: ['one', 'two', 'three', 'four', 'five', 'six'], expiresAt: '2026-10-17T12:05:00Z' };
    const m = confirmModel(req, [{ name: 'compute.gpu', limits: { maxVramBytes: 4 * GB } }], now);
    expect(m).toMatchObject({ name: 'Ben', sas: req.sas, expiresIn: 5 });
    expect(lineText(m.lines[0])).toBe('GPU: up to 4 GB of VRAM');
    const rows = lendingModel([{ peerId: 'p', name: 'Ben', online: true, fingerprint: ['a'], grants: [{ id: 'gr_1', capability: { name: 'compute.ram', limits: { maxBytes: GB } }, expiresAt: '2026-10-17T13:00:00Z' }] }], now);
    expect(rows[0].lines[0]).toMatchObject({ grantId: 'gr_1', left: 60 });
    expect(minutesLeft(null)).toBeNull();
    expect(joinModel({ phase: 'failed', reason: 'weird' }).reasonKey).toBe('lend.p2p.join.failed.words');
    expect(joinModel({ phase: 'refused', reason: 'sas_mismatch', sas: ['x'] })).toMatchObject({ reason: 'sas_mismatch', sas: ['x'] });
    expect(joinModel({ phase: 'accepted', grants: [{ capability: { name: 'city.view' } }] }).lines[0].key).toBe('lend.p2p.cap.cityView');
  });

  it('every string has a key in the parts file for the merge, and tx falls back to English', () => {
    const parts = JSON.parse(fs.readFileSync(new URL('../../i18n/parts/s2-p2p.en.json', import.meta.url), 'utf8'));
    expect(parts).toEqual({ ...P2P_EN });
    expect(tx('lend.p2p.left', { n: 3 })).toBe('3 minutes left');
    for (const v of Object.values(P2P_EN)) expect(v).not.toMatch(/[\u2013\u2014]/);
  });
});
