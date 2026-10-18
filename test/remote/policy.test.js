import { describe, it, expect } from 'vitest';
import { decideAnswer, clipAllows, grantLive, normalizeEvent, Bucket, pickDisplay, toPixels } from '../../src/remote/policy.js';
import { KeyFilter, KEYS } from '../../src/remote/keys.js';
import { cleanSignal } from '../../src/remote/desk.js';

const peerReq = (wants) => ({ wants });

describe('remote policy', () => {
  it.each([
    [peerReq('view'), { allow: true, view: true, control: true }, { allow: true, mode: 'view', minutes: 15 }],
    [peerReq('view'), { allow: true }, { allow: false }],
    [peerReq('control'), { allow: true, view: true }, { allow: true, mode: 'view' }],
    [peerReq('control'), { allow: true, control: true, minutes: 60 }, { allow: true, mode: 'control', minutes: 60 }],
    [peerReq('control'), { allow: 'yes', view: true, control: true }, { allow: false, mode: 'view' }],
    [{ wants: 'control', agentId: 'a1', asks: { clipboard: true, files: true } }, { allow: true, view: true, control: true, clipboard: true, files: true }, { allow: true, mode: 'view', clipboard: 'off', files: false }],
    [{ wants: 'view', asks: { clipboard: true } }, { allow: true, view: true, clipboard: 'to_host' }, { clipboard: 'to_host' }],
    [{ wants: 'view', asks: { clipboard: true } }, { allow: true, view: true, clipboard: 'sideways' }, { clipboard: 'off' }],
    [{ wants: 'view', asks: {} }, { allow: true, view: true, clipboard: 'both', files: true }, { clipboard: 'off', files: false }],
    [peerReq('view'), { allow: true, view: true, minutes: 7 }, { minutes: 15 }]
  ])('decideAnswer %j %j', (req, ans, want) => {
    expect(decideAnswer(req, ans)).toMatchObject(want);
  });

  it('clipboard directions', () => {
    expect(clipAllows('both', 'host')).toBe(true);
    expect(clipAllows('to_viewer', 'host')).toBe(true);
    expect(clipAllows('to_viewer', 'viewer')).toBe(false);
    expect(clipAllows('to_host', 'viewer')).toBe(true);
    expect(clipAllows('off', 'host')).toBe(false);
  });

  it('grantLive needs a session grant with a future expiry and no revoke', () => {
    const now = Date.parse('2026-10-17T12:00:00Z');
    const g = { scope: 'session', expiresAt: '2026-10-17T12:05:00Z' };
    expect(grantLive(g, now)).toBe(true);
    expect(grantLive({ ...g, revokedAt: 'x' }, now)).toBe(false);
    expect(grantLive({ ...g, scope: 'standing' }, now)).toBe(false);
    expect(grantLive({ ...g, expiresAt: null }, now)).toBe(false);
    expect(grantLive(g, Date.parse(g.expiresAt))).toBe(false);
    expect(grantLive(null, now)).toBe(false);
  });

  it('normalizes input events and drops anything else', () => {
    expect(normalizeEvent({ k: 'move', x: 2, y: -1, extra: 1 })).toEqual({ k: 'move', x: 1, y: 0 });
    expect(normalizeEvent({ k: 'move', x: NaN, y: 0 })).toBe(null);
    expect(normalizeEvent({ k: 'btn', b: 3, down: true })).toBe(null);
    expect(normalizeEvent({ k: 'wheel', dx: 99999, dy: -5.4 })).toEqual({ k: 'wheel', dx: 1200, dy: -5 });
    expect(normalizeEvent({ k: 'key', code: 'KeyA', down: 'yes' })).toBe(null);
    expect(normalizeEvent({ k: 'exec', cmd: 'rm' })).toBe(null);
    expect(normalizeEvent('move')).toBe(null);
  });

  it('the bucket allows 120 per second and refills', () => {
    let t = 0;
    const b = new Bucket(120, () => t);
    let n = 0;
    while (b.take()) n++;
    expect(n).toBe(120);
    t = 500;
    n = 0;
    while (b.take()) n++;
    expect(n).toBe(60);
  });

  it('picks the screen that matches the capture, or asks', () => {
    const one = [{ x: 0, y: 0, w: 1920, h: 1080 }];
    const two = [{ x: 0, y: 0, w: 1920, h: 1080 }, { x: 1920, y: 0, w: 2560, h: 1440 }];
    expect(pickDisplay(one, 0, 0)).toBe(0);
    expect(pickDisplay(two, 2560, 1440)).toBe(1);
    expect(pickDisplay(two, 1280, 720)).toBe(null);
    expect(pickDisplay([...two, { x: 4480, y: 0, w: 2560, h: 1440 }], 2560, 1440)).toBe(null);
    expect(pickDisplay([], 1, 1)).toBe(null);
    expect(toPixels(two[1], 1, 1)).toEqual({ px: 1920 + 2559, py: 1439 });
  });

  it('the key filter drops Ctrl+Alt+Del, Ctrl+Alt+End, Win+L and the kill hotkey, with their key ups', () => {
    const f = new KeyFilter();
    expect(f.check('ControlRight', true)).toBe('ok');
    expect(f.check('AltLeft', true)).toBe('ok');
    expect(f.check('Delete', true)).toBe('blocked');
    expect(f.check('Delete', false)).toBe('blocked');
    expect(f.check('End', true)).toBe('blocked');
    expect(f.check('ShiftLeft', true)).toBe('ok');
    expect(f.check('KeyK', true)).toBe('blocked');
    expect(f.release().sort()).toEqual(['AltLeft', 'ControlRight', 'ShiftLeft']);
    expect(f.check('MetaLeft', true)).toBe('ok');
    expect(f.check('KeyL', true)).toBe('blocked');
    expect(f.check('Fn', true)).toBe('unknown');
    expect(f.check('__proto__', true)).toBe('unknown');
    expect(KEYS.KeyA).toEqual({ vk: 0x41, x: 'a' });
    expect(KEYS.ArrowUp).toEqual({ vk: 0x26, ext: true, x: 'Up' });
  });

  it('cleans signaling messages', () => {
    expect(cleanSignal({ kind: 'offer', sdp: 'v=0\r\n', extra: 1 })).toEqual({ kind: 'offer', sdp: 'v=0\r\n' });
    expect(cleanSignal({ kind: 'offer', sdp: 'v=0' + 'x'.repeat(40000) })).toBe(null);
    expect(cleanSignal({ kind: 'ice', candidate: null })).toEqual({ kind: 'ice', candidate: null });
    expect(cleanSignal({ kind: 'ice', candidate: { candidate: 'c', sdpMid: 0, sdpMLineIndex: 99 } })).toEqual({ kind: 'ice', candidate: { candidate: 'c', sdpMid: null, sdpMLineIndex: null } });
    expect(cleanSignal({ kind: 'bye' })).toBe(null);
  });
});
