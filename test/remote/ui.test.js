import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { CODES, placeholders, format } from '../../i18n/index.js';
import { EN } from '../../ui/remote/strings.js';
import { nextBitrate, framerateFor, readStats, PRESETS, MIN_BPS, MAX_BPS, CAPTURE } from '../../ui/remote/abr.js';
import { normalizePoint, wheelUnits, InputBatcher, HeldInput } from '../../ui/remote/pointer.js';
import { checkAddress, groupDigits } from '../../ui/remote/digits.js';
import { deriveAddress } from '../../src/remote/address.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const part = (code) => JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n', 'parts', `s6-remote.${code}.json`), 'utf8'));
const DASH = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);
const EMOJI = /\p{Extended_Pictographic}/u;

describe('remote strings in 10 languages', () => {
  it('the English part equals the window strings', () => {
    expect(part('en')).toEqual(EN);
  });

  it.each(CODES)('%s has every key with the same placeholders and nothing forbidden', (code) => {
    const p = part(code);
    expect(Object.keys(p).sort()).toEqual(Object.keys(EN).sort());
    for (const [k, en] of Object.entries(EN)) {
      const v = p[k];
      expect(v, `${code} ${k}`).toBeTruthy();
      expect(new Set(placeholders(v)), `${code} ${k}`).toEqual(new Set(placeholders(en)));
      expect(DASH.test(v), `${code} ${k}`).toBe(false);
      expect(EMOJI.test(v), `${code} ${k}`).toBe(false);
      const params = Object.fromEntries(placeholders(en).map((n) => [n, 2]));
      expect(() => format(code, v, params)).not.toThrow();
    }
  });

  it('never names another product', () => {
    const all = CODES.map((c) => JSON.stringify(part(c))).join(' ');
    expect(all).not.toMatch(/TeamViewer|AnyDesk|RustDesk|Chrome Remote|Parsec|VNC/i);
  });
});

describe('adaptive bitrate and quality presets', () => {
  it.each([
    [{ current: 2_500_000, loss: 0.2 }, { maxBitrate: 1_750_000, why: 'heavy loss' }],
    [{ current: 2_500_000, loss: 0.05 }, { maxBitrate: 2_125_000, why: 'loss' }],
    [{ current: 4_000_000, available: 2_000_000, loss: 0 }, { maxBitrate: 1_700_000, why: 'bandwidth' }],
    [{ current: 2_000_000, available: 10_000_000, loss: 0 }, { maxBitrate: 2_300_000, why: 'ramp up' }],
    [{ current: 100_000, loss: 0.5 }, { maxBitrate: MIN_BPS }],
    [{ current: 9_000_000, available: 50_000_000, loss: 0 }, { maxBitrate: MAX_BPS }]
  ])('auto %j', (input, want) => expect(nextBitrate(input)).toMatchObject(want));

  it('lowers the frame rate before the resolution, and the presets cap what they promise', () => {
    expect(framerateFor(400_000)).toBe(5);
    expect(framerateFor(2_000_000)).toBe(20);
    expect(framerateFor(6_000_000)).toBe(60);
    expect(framerateFor(6_000_000, 30)).toBe(30);
    expect(nextBitrate({ current: 6_000_000, preset: 'balanced' })).toMatchObject({ maxBitrate: 4_000_000, maxFramerate: 30, scale: 1 });
    expect(nextBitrate({ current: 500_000, preset: 'quality', loss: 0.05 }).maxBitrate).toBe(1_500_000);
    expect(nextBitrate({ current: 1_000_000, preset: 'speed', loss: 0.05 })).toMatchObject({ scale: 1.5, degradation: 'maintain-framerate' });
    expect(nextBitrate({ current: 7_000_000, available: 20_000_000, loss: 0 })).toMatchObject({ maxFramerate: 60, scale: 1, degradation: 'maintain-resolution' });
    expect(Object.keys(PRESETS)).toEqual(['auto', 'balanced', 'quality', 'speed']);
    expect(CAPTURE.video).toMatchObject({ displaySurface: 'monitor', width: { max: 1920 }, height: { max: 1080 } });
  });

  it('reads the numbers from WebRTC stats', () => {
    const r = new Map([
      ['a', { type: 'candidate-pair', nominated: true, state: 'succeeded', availableOutgoingBitrate: 3e6 }],
      ['b', { type: 'remote-inbound-rtp', kind: 'video', fractionLost: 0.02 }],
      ['c', { type: 'outbound-rtp', kind: 'video', framesPerSecond: 29 }]
    ]);
    expect(readStats(r)).toEqual({ available: 3e6, loss: 0.02, fps: 29 });
  });
});

describe('viewer input', () => {
  it('maps a point through the letterbox of a contained video', () => {
    const rect = { left: 0, top: 0, width: 1000, height: 1000 };
    expect(normalizePoint(500, 500, rect, 1920, 1080)).toMatchObject({ x: 0.5, y: 0.5, inside: true });
    expect(normalizePoint(500, 100, rect, 1920, 1080).inside).toBe(false);
    const p0 = normalizePoint(0, 218.75, rect, 1920, 1080);
    expect(p0.inside).toBe(true);
    expect(p0.x).toBeCloseTo(0, 9);
    expect(p0.y).toBeCloseTo(0, 9);
    expect(normalizePoint(1, 1, rect, 0, 0)).toBe(null);
  });

  it('converts wheel deltas and batches moves', () => {
    expect(wheelUnits({ deltaMode: 0, deltaY: 100, deltaX: 0 })).toEqual({ dx: 0, dy: 120 });
    expect(wheelUnits({ deltaMode: 1, deltaY: 3, deltaX: 0 }).dy).toBe(144);
    const sent = [];
    let fire;
    const b = new InputBatcher((e) => sent.push(e), { setTimeout: (fn) => { fire = fn; return 1; } });
    b.push({ k: 'move', x: 0.1, y: 0.1 });
    b.push({ k: 'move', x: 0.2, y: 0.2 });
    b.push({ k: 'btn', b: 0, down: true });
    fire();
    expect(sent).toEqual([[{ k: 'move', x: 0.2, y: 0.2 }, { k: 'btn', b: 0, down: true }]]);
    const held = new HeldInput();
    held.key('ShiftLeft', true);
    held.button(0, true);
    expect(held.releaseEvents()).toEqual([{ k: 'key', code: 'ShiftLeft', down: false }, { k: 'btn', b: 0, down: false }]);
  });

  it('the window checks addresses like the engine', () => {
    const a = deriveAddress(Buffer.alloc(32, 7));
    expect(checkAddress(a)).toBe(null);
    expect(checkAddress(groupDigits(a))).toBe(null);
    expect(checkAddress(a.slice(0, 9) + String((Number(a[9]) + 3) % 10))).toBe('check_digit');
    expect(checkAddress('123')).toBe('length');
    expect(checkAddress('abc')).toBe('format');
    expect(groupDigits('12a34567890123')).toBe('123 456 789 0');
  });
});

describe('remote control accept dialog', () => {
  it('shows the address derived avatar large; the self chosen picture only small and labeled', () => {
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../ui/remote/host.js'), 'utf8');
    const who = src.slice(src.indexOf("h('div', { class: 'rd-who' }"), src.indexOf("r.words?.length"));
    expect(who).toMatch(/^h\('div', \{ class: 'rd-who' \}, avatar\(r\.avatar, 52\),/);
    expect(who).not.toMatch(/avatarEl\([^)]*, 52\)/);
    expect(who).toMatch(/avatarEl\(hub\.peers\.peers\[r\.peerId\]\.profile, 20\)[^\n]*remote\.ask\.selfChosen/);
  });
});
