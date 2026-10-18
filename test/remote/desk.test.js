import { describe, it, expect, beforeEach } from 'vitest';
import { RemoteDesk } from '../../src/remote/desk.js';
import { createInprocPair, flush, FakeHelper, manualClock } from './inproc-port.js';

const WIN = { view: true, control: true, kind: 'win-input', hotkey: true, indicator: true, reason: null };
const MAC = { view: true, control: false, kind: null, hotkey: false, indicator: false, reason: 'macos_unsigned' };
const SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=fingerprint:sha-256 AA:BB\r\n';

function setup({ support = WIN, checkExpiry = true } = {}) {
  const clock = manualClock();
  const pair = createInprocPair({ now: clock.now, checkExpiry });
  const helpers = [];
  const mk = (p2p, sup) => new RemoteDesk({
    p2p, support: sup, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    startHelper: () => { const h = new FakeHelper(); helpers.push(h); return h; }
  });
  const host = mk(pair.host.port, support);
  const viewer = mk(pair.viewer.port, WIN);
  const sid = pair.open();
  return { clock, pair, host, viewer, sid, helpers, helper: () => helpers[helpers.length - 1] };
}

/** Viewer asks, host clicks, the host window shares a whole screen, the helper is ready and the screen unlocked. */
async function controlSession(t, { minutes = 15 } = {}) {
  t.viewer.ask(t.sid, { control: true });
  await flush();
  const [req] = t.host.snapshot().requests;
  t.host.answer(req.id, { allow: true, view: true, minutes, control: true });
  const h = t.helper();
  h.ready();
  h.lock(false);
  t.host.shareStarted(t.sid, { surface: 'monitor', width: 1920, height: 1080 });
  await flush();
  return h;
}

const sessionOf = (t) => t.pair.host.port.session(t.sid);

describe('remote desktop: the host dialog and grants', () => {
  let t;
  beforeEach(() => { t = setup(); });

  it('shows who is asking, with name, fingerprint words and what they want', async () => {
    t.viewer.ask(t.sid, { control: true, reason: 'help with a build' });
    await flush();
    const [r] = t.host.snapshot().requests;
    expect(r).toMatchObject({ name: 'Rita', wants: 'control', reason: 'help with a build', peerId: t.pair.viewer.peerId });
    expect(r.words).toHaveLength(6);
    expect(t.pair.auditKinds(t.pair.host)).toContain('remote.request');
    expect(t.viewer.snapshot().views[0].state).toBe('asking');
  });

  it('is view only by default even when control was asked for', async () => {
    t.viewer.ask(t.sid, { control: true });
    await flush();
    const [r] = t.host.snapshot().requests;
    const res = t.host.answer(r.id, { allow: true, view: true });
    expect(res.mode).toBe('view');
    const grants = [...t.pair.host.grants.values()];
    expect(grants.map((g) => g.capability.name)).toEqual(['remote.view']);
    expect(grants[0]).toMatchObject({ scope: 'session', grantedBy: 'user', sessionId: t.sid });
    await flush();
    expect(t.viewer.snapshot().views[0]).toMatchObject({ state: 'granted', mode: 'view', control: false });
    expect(() => t.viewer.sendInput(t.sid, [{ k: 'move', x: 0.5, y: 0.5 }])).toThrow(/view only/);
  });

  it('grants are time limited to 5, 15 or 60 minutes, 15 when anything else is sent', async () => {
    for (const [asked, got] of [[5, 5], [60, 60], [15, 15], [9999, 15], [undefined, 15]]) {
      t.viewer.ask(t.sid, {});
      await flush();
      const [r] = t.host.snapshot().requests;
      const res = t.host.answer(r.id, { allow: true, view: true, minutes: asked });
      expect(res.expiresAt - t.clock.now()).toBe(got * 60_000);
      const g = t.pair.host.grants.get(res.grantIds[0]);
      expect(Date.parse(g.expiresAt)).toBe(res.expiresAt);
    }
  });

  it('a refusal grants nothing and tells the viewer', async () => {
    t.viewer.ask(t.sid, { control: true });
    await flush();
    const [r] = t.host.snapshot().requests;
    expect(t.host.answer(r.id, { allow: false, control: true })).toEqual({ allowed: false });
    await flush();
    expect(t.pair.host.grants.size).toBe(0);
    expect(t.viewer.snapshot().views).toHaveLength(0);
    expect(t.pair.auditKinds(t.pair.viewer)).toContain('remote.refused');
  });

  it('an answer for a request that does not exist is refused', () => {
    expect(() => t.host.answer('rq_nope', { allow: true, view: true })).toThrow(/no longer waiting/);
  });

  it('control needs the box ticked on a control request; clipboard and files only when ticked', async () => {
    t.viewer.ask(t.sid, { control: false });
    await flush();
    let [r] = t.host.snapshot().requests;
    expect(t.host.answer(r.id, { allow: true, view: true, control: true }).mode).toBe('view');
    // Clipboard and files were not asked for: ticking them grants nothing.
    t.viewer.ask(t.sid, { control: true });
    await flush();
    [r] = t.host.snapshot().requests;
    let res = t.host.answer(r.id, { allow: true, view: true, control: true, clipboard: true, files: true });
    expect(res).toMatchObject({ mode: 'control', clipboard: 'off', files: false });
    t.viewer.ask(t.sid, { control: true, clipboard: true, files: true });
    await flush();
    [r] = t.host.snapshot().requests;
    expect(r.asks).toEqual({ view: true, control: true, clipboard: true, files: true });
    res = t.host.answer(r.id, { allow: true, view: true, control: true, clipboard: 'to_viewer', files: true });
    const grants = res.grantIds.map((id) => t.pair.host.grants.get(id));
    expect(grants.map((g) => g.capability.name)).toEqual(['remote.control', 'clipboard.text', 'file.send']);
    expect(grants[1].capability.limits.dir).toBe('to_viewer');
  });

  it('every permission is off unless ticked: Accept with nothing ticked grants nothing', async () => {
    t.viewer.ask(t.sid, { control: true, clipboard: true, files: true });
    await flush();
    const [r] = t.host.snapshot().requests;
    expect(t.host.answer(r.id, { allow: true })).toEqual({ allowed: false });
    expect(t.pair.host.grants.size).toBe(0);
  });

  it('a request nobody answers is declined after the countdown, and the viewer is told', async () => {
    t.viewer.ask(t.sid, { control: true });
    await flush();
    expect(t.host.snapshot().requests[0].msLeft).toBe(60_000);
    t.clock.advance(59_999);
    expect(t.host.snapshot().requests).toHaveLength(1);
    t.clock.advance(1);
    await flush();
    expect(t.host.snapshot().requests).toHaveLength(0);
    expect(t.viewer.snapshot().views).toHaveLength(0);
    expect(t.pair.auditKinds(t.pair.host)).toContain('remote.request.expired');
    expect(t.pair.host.grants.size).toBe(0);
  });

  it('the viewer gets nothing without the host: no ready, no signals, no input before Accept', async () => {
    t.viewer.ask(t.sid, { control: true });
    await flush();
    expect(t.viewer.snapshot().views[0].state).toBe('asking');
    expect(() => t.viewer.sendInput(t.sid, [{ k: 'move', x: 0, y: 0 }])).toThrow(/no remote desktop session/);
    expect(() => t.viewer.signal(t.sid, { kind: 'answer', sdp: SDP })).toThrow(/no remote desktop session/);
    // A forged ready from a peer that is not the host of this session is ignored: views are per session.
    t.pair.host.port.send(t.sid, 1, 'remote.stop', {});
    await flush();
    expect(t.pair.host.grants.size).toBe(0);
  });
});

describe('remote desktop: grant enforcement on input', () => {
  let t;
  beforeEach(() => { t = setup(); });

  it('input before any grant is dropped and audited once per window', async () => {
    const r = t.host.handleInput(sessionOf(t), { events: [{ k: 'move', x: 0.1, y: 0.1 }] });
    t.host.handleInput(sessionOf(t), { events: [{ k: 'move', x: 0.1, y: 0.1 }] });
    expect(r).toMatchObject({ applied: 0, reason: 'no_share' });
    expect(t.pair.auditKinds(t.pair.host).filter((k) => k === 'remote.input.refused')).toHaveLength(1);
  });

  it('a view grant never lets input through, even sent straight to the host', async () => {
    t.viewer.ask(t.sid, { control: true });
    await flush();
    const [rq] = t.host.snapshot().requests;
    t.host.answer(rq.id, { allow: true, view: true });
    t.helper().ready();
    t.helper().lock(false);
    t.host.shareStarted(t.sid, { surface: 'monitor', width: 1920, height: 1080 });
    const r = t.host.handleInput(sessionOf(t), { events: [{ k: 'move', x: 0.5, y: 0.5 }] });
    expect(r.reason).toBe('not_granted');
    expect(t.helper().calls.filter((c) => c[0] === 'move')).toHaveLength(0);
  });

  it('a live control grant moves the pointer on the chosen screen', async () => {
    const h = await controlSession(t);
    const r = t.viewer.sendInput(t.sid, [{ k: 'move', x: 0.5, y: 0.25 }, { k: 'btn', b: 0, down: true }, { k: 'btn', b: 0, down: false }, { k: 'wheel', dx: 0, dy: 120 }]);
    expect(r.sent).toBe(4);
    await flush();
    expect(h.calls).toContainEqual(['move', 960, 270]);
    expect(h.calls).toContainEqual(['button', 0, true]);
    expect(h.calls).toContainEqual(['wheel', 0, 120]);
  });

  it('a revoked grant stops input at once, and ends the share', async () => {
    const h = await controlSession(t);
    const share = t.host.shares.get(t.sid);
    t.pair.host.port.caps.revoke(share.grantIds[0], 'peers panel');
    await flush();
    expect(t.host.shares.size).toBe(0);
    const r = t.host.handleInput(sessionOf(t), { events: [{ k: 'move', x: 0.5, y: 0.5 }] });
    expect(r.applied).toBe(0);
    expect(h.calls).toContainEqual(['release']);
    expect(t.pair.auditKinds(t.pair.host)).toContain('remote.revoked');
  });

  it('drops keys that are not in the allowlist and the secure attention combinations', async () => {
    const h = await controlSession(t);
    const s = sessionOf(t);
    expect(t.host.handleInput(s, { events: [{ k: 'key', code: 'LaunchMail', down: true }] }).applied).toBe(0);
    t.host.handleInput(s, { events: [
      { k: 'key', code: 'ControlLeft', down: true }, { k: 'key', code: 'AltLeft', down: true },
      { k: 'key', code: 'Delete', down: true }, { k: 'key', code: 'Delete', down: false },
      { k: 'key', code: 'AltLeft', down: false }, { k: 'key', code: 'ControlLeft', down: false },
      { k: 'key', code: 'MetaLeft', down: true }, { k: 'key', code: 'KeyL', down: true }, { k: 'key', code: 'KeyL', down: false }, { k: 'key', code: 'MetaLeft', down: false },
      { k: 'key', code: 'KeyA', down: true }, { k: 'key', code: 'KeyA', down: false }
    ] });
    const keys = h.calls.filter((c) => c[0] === 'key');
    expect(keys.some((c) => c[1] === 0x2e)).toBe(false); // Delete never reached the helper
    expect(keys.some((c) => c[1] === 0x4c)).toBe(false); // L with Win never reached it
    expect(keys.filter((c) => c[1] === 0x41)).toHaveLength(2);
  });

  it('rate limits to 120 events per second and caps a message at 240', async () => {
    await controlSession(t);
    const many = Array.from({ length: 300 }, (_, i) => ({ k: 'move', x: i / 300, y: 0.5 }));
    const r = t.host.handleInput(sessionOf(t), { events: many });
    expect(r.applied).toBe(120);
    expect(r.dropped).toBe(180);
    t.clock.advance(1000);
    expect(t.host.handleInput(sessionOf(t), { events: many.slice(0, 50) }).applied).toBe(50);
  });

  it('audits control as counts per burst, never the keys', async () => {
    await controlSession(t);
    t.host.handleInput(sessionOf(t), { events: [{ k: 'key', code: 'KeyH', down: true }, { k: 'key', code: 'KeyH', down: false }, { k: 'move', x: 0, y: 0 }] });
    t.clock.advance(5000);
    const burst = t.pair.host.audit.map((l) => l.entry).find((e) => e.kind === 'remote.control.burst');
    expect(burst).toMatchObject({ events: 3, keys: 2, pointer: 1, dropped: 0 });
    expect(JSON.stringify(t.pair.host.audit)).not.toMatch(/KeyH/);
  });

  it('a shared window gives view only: control needs a whole screen', async () => {
    t.viewer.ask(t.sid, { control: true });
    await flush();
    const [rq] = t.host.snapshot().requests;
    t.host.answer(rq.id, { allow: true, view: true, control: true });
    t.helper().ready();
    t.helper().lock(false);
    t.host.shareStarted(t.sid, { surface: 'window', width: 800, height: 600 });
    expect(t.host.handleInput(sessionOf(t), { events: [{ k: 'move', x: 0.5, y: 0.5 }] }).reason).toBe('window_shared');
    await flush();
    expect(t.viewer.snapshot().views[0]).toMatchObject({ control: false, reason: 'window_shared' });
  });

  it('with two screens of the same size the host picks which one', async () => {
    t.viewer.ask(t.sid, { control: true });
    await flush();
    const [rq] = t.host.snapshot().requests;
    t.host.answer(rq.id, { allow: true, view: true, control: true });
    t.helper().ready([{ x: 0, y: 0, w: 1920, h: 1080 }, { x: 1920, y: 0, w: 1920, h: 1080 }]);
    t.helper().lock(false);
    t.host.shareStarted(t.sid, { surface: 'monitor', width: 1920, height: 1080 });
    expect(t.host.handleInput(sessionOf(t), { events: [{ k: 'move', x: 0, y: 0 }] }).reason).toBe('pick_display');
    t.host.setDisplay(t.sid, 1);
    t.host.handleInput(sessionOf(t), { events: [{ k: 'move', x: 0, y: 0 }] });
    expect(t.helper().calls).toContainEqual(['move', 1920, 0]);
  });

  it('macOS without a signed app is view only, and says why', async () => {
    const m = setup({ support: MAC });
    m.viewer.ask(m.sid, { control: true });
    await flush();
    const [rq] = m.host.snapshot().requests;
    m.host.answer(rq.id, { allow: true, view: true, control: true });
    await flush();
    expect(m.helpers).toHaveLength(0);
    expect(m.viewer.snapshot().views[0]).toMatchObject({ mode: 'control', control: false, reason: 'macos_unsigned' });
    expect(m.host.handleInput(m.pair.host.port.session(m.sid), { events: [{ k: 'move', x: 0, y: 0 }] }).reason).toBe('macos_unsigned');
  });
});

describe('remote desktop: expiry', () => {
  it('ends the share when the time is up: grants revoked, viewer told, input refused, audited', async () => {
    const t = setup();
    const h = await controlSession(t, { minutes: 5 });
    t.clock.advance(5 * 60_000 - 1);
    expect(t.host.shares.size).toBe(1);
    t.clock.advance(1);
    await flush();
    expect(t.host.shares.size).toBe(0);
    expect([...t.pair.host.grants.values()].every((g) => g.revokedAt)).toBe(true);
    expect(t.viewer.snapshot().views).toHaveLength(0);
    expect(t.pair.auditKinds(t.pair.host)).toContain('remote.expired');
    expect(h.closed).toBe(true);
    expect(t.host.handleInput(sessionOf(t), { events: [{ k: 'move', x: 0, y: 0 }] }).applied).toBe(0);
  });

  it('checks expiry itself on every message, even when the p2p layer would still accept the grant', async () => {
    const t = setup({ checkExpiry: false });
    await controlSession(t, { minutes: 5 });
    // Simulate a timer that never fired (a sleeping laptop): move the clock without running timers.
    const share = t.host.shares.get(t.sid);
    share.expiresAt = t.clock.now() - 1;
    expect(t.host.handleInput(sessionOf(t), { events: [{ k: 'move', x: 0, y: 0 }] }).applied).toBe(0);
    expect(t.host.shares.size).toBe(0);
  });

  it('a grant without an expiry is never accepted for control', async () => {
    const t = setup();
    await controlSession(t);
    const share = t.host.shares.get(t.sid);
    const g = t.pair.host.grants.get(share.grantIds[0]);
    g.expiresAt = null;
    expect(t.host.handleInput(sessionOf(t), { events: [{ k: 'move', x: 0, y: 0 }] }).reason).toBe('not_granted');
  });

  it('a local agent may view only while its grant lasts, and may never ask for control', async () => {
    const t = setup();
    expect(() => t.host.agentRequest('ag_mel', { wants: 'control' })).toThrow(/only view/);
    const { requestId } = t.host.agentRequest('ag_mel', { name: 'Mel' });
    expect(t.host.agentMayView('ag_mel')).toBe(false);
    const res = t.host.answer(requestId, { allow: true, view: true, minutes: 5, control: true, clipboard: true, files: true });
    expect(res).toMatchObject({ mode: 'view' });
    expect(t.host.shares.get('agent:ag_mel')).toMatchObject({ clipboard: 'off', files: false, mode: 'view' });
    expect(t.host.agentMayView('ag_mel')).toBe(true);
    t.clock.advance(5 * 60_000);
    expect(t.host.agentMayView('ag_mel')).toBe(false);
    expect(t.pair.auditKinds(t.pair.host)).toEqual(expect.arrayContaining(['remote.refuse', 'remote.request', 'remote.grant', 'remote.expired']));
  });
});

describe('remote desktop: kill switch', () => {
  for (const [what, fire] of [
    ['the hotkey', (h) => h.emit('hotkey')],
    ['Stop on the always on top indicator', (h) => h.emit('stop')]
  ]) {
    it(`${what} ends every share and request, revokes grants, releases input and closes the helper`, async () => {
      const t = setup();
      const h = await controlSession(t);
      t.host.handleInput(sessionOf(t), { events: [{ k: 'key', code: 'ShiftLeft', down: true }] });
      fire(h);
      await flush();
      expect(t.host.shares.size).toBe(0);
      expect([...t.pair.host.grants.values()].every((g) => g.revokedAt)).toBe(true);
      expect(h.calls).toContainEqual(['release']);
      expect(h.closed).toBe(true);
      expect(t.viewer.snapshot().views).toHaveLength(0);
      expect(t.pair.auditKinds(t.pair.host)).toContain('remote.kill');
    });
  }

  it('the window button (stopAll) also clears waiting requests', async () => {
    const t = setup();
    t.viewer.ask(t.sid, {});
    await flush();
    expect(t.host.snapshot().requests).toHaveLength(1);
    t.host.stopAll('banner');
    expect(t.host.snapshot().requests).toHaveLength(0);
  });

  it('the indicator says who is watching and that the hotkey stops it', async () => {
    const t = setup();
    const h = await controlSession(t);
    const ind = h.calls.filter((c) => c[0] === 'indicator').pop();
    expect(ind[1]).toBe('control');
    expect(ind[2]).toMatch(/Rita/);
    expect(ind[2]).toMatch(/Ctrl\+Alt\+Shift\+K/);
  });

  it('a disconnect ends the share like a stop', async () => {
    const t = setup();
    await controlSession(t);
    t.pair.close(t.sid);
    expect(t.host.shares.size).toBe(0);
    expect(t.pair.auditKinds(t.pair.host)).toContain('remote.stop');
  });
});

describe('remote desktop: lock detection', () => {
  it('no control while the screen is locked; the viewer sees a locked card', async () => {
    const t = setup();
    const h = await controlSession(t);
    h.lock(true);
    await flush();
    expect(h.calls).toContainEqual(['release']);
    expect(t.host.handleInput(sessionOf(t), { events: [{ k: 'move', x: 0, y: 0 }] }).reason).toBe('locked');
    expect(t.viewer.snapshot().views[0]).toMatchObject({ locked: true, control: false });
    expect(t.pair.auditKinds(t.pair.host)).toContain('remote.locked');
    h.lock(false);
    await flush();
    expect(t.host.handleInput(sessionOf(t), { events: [{ k: 'move', x: 0, y: 0 }] }).applied).toBe(1);
    expect(t.viewer.snapshot().views[0]).toMatchObject({ locked: false, control: true });
  });

  it('an unknown or stale lock state counts as locked', async () => {
    const t = setup();
    const h = await controlSession(t);
    t.clock.advance(3001);
    expect(t.host.handleInput(sessionOf(t), { events: [{ k: 'move', x: 0, y: 0 }] }).reason).toBe('lock_unknown');
    h.lock(false);
    expect(t.host.handleInput(sessionOf(t), { events: [{ k: 'move', x: 0, y: 0 }] }).applied).toBe(1);
    h.lock(null);
    expect(t.host.handleInput(sessionOf(t), { events: [{ k: 'move', x: 0, y: 0 }] }).reason).toBe('lock_unknown');
  });

  it('when the helper dies, control stops until it is back', async () => {
    const t = setup();
    const h = await controlSession(t);
    h.emit('exit', { code: 1 });
    await flush();
    expect(t.host.handleInput(sessionOf(t), { events: [{ k: 'move', x: 0, y: 0 }] }).reason).toMatch(/helper/);
    expect(t.viewer.snapshot().views[0].control).toBe(false);
  });
});

describe('remote desktop: signaling and clipboard', () => {
  it('carries the SDP only inside a granted session, on stream 3', async () => {
    const t = setup();
    expect(() => t.viewer.signal(t.sid, { kind: 'answer', sdp: SDP })).toThrow(/no remote desktop session/);
    t.viewer.ask(t.sid, {});
    await flush();
    const [rq] = t.host.snapshot().requests;
    t.host.answer(rq.id, { allow: true, view: true });
    await flush();
    const got = [];
    t.viewer.on('signal', (s) => got.push(s));
    t.host.signal(t.sid, { kind: 'offer', sdp: SDP });
    t.host.signal(t.sid, { kind: 'ice', candidate: { candidate: 'candidate:1 1 udp 1 192.0.2.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 } });
    await flush();
    expect(got.map((s) => s.kind)).toEqual(['offer', 'ice']);
    expect(t.pair.host.sent.filter((m) => m.t.startsWith('remote.sdp') || m.t === 'remote.ice').every((m) => m.stream === 3)).toBe(true);
    expect(() => t.host.signal(t.sid, { kind: 'offer', sdp: 'not sdp' })).toThrow(/bad signaling/);
  });

});

describe('remote desktop: pause, screens, quality and chat', () => {
  it('pause blocks input until resumed, and the viewer sees it', async () => {
    const t = setup();
    await controlSession(t);
    t.host.pause(t.sid, true);
    await flush();
    expect(t.host.handleInput(sessionOf(t), { events: [{ k: 'move', x: 0, y: 0 }] }).reason).toBe('paused');
    expect(t.viewer.snapshot().views[0]).toMatchObject({ paused: true, control: false });
    t.host.pause(t.sid, false);
    await flush();
    expect(t.host.handleInput(sessionOf(t), { events: [{ k: 'move', x: 0, y: 0 }] }).applied).toBe(1);
    expect(t.pair.auditKinds(t.pair.host)).toEqual(expect.arrayContaining(['remote.pause', 'remote.resume']));
  });

  it('a second shared screen maps the pointer to its own monitor', async () => {
    const t = setup();
    await controlSession(t);
    t.helper().ready([{ x: 0, y: 0, w: 1920, h: 1080 }, { x: 1920, y: 0, w: 2560, h: 1440 }]);
    t.helper().lock(false);
    t.host.shareStarted(t.sid, { surface: 'monitor', width: 1920, height: 1080, index: 0 });
    t.host.shareStarted(t.sid, { surface: 'monitor', width: 2560, height: 1440, index: 1 });
    await flush();
    expect(t.viewer.snapshot().views[0]).toMatchObject({ tracks: 2 });
    expect(t.viewer.snapshot().views[0].displays).toHaveLength(2);
    t.host.handleInput(sessionOf(t), { events: [{ k: 'move', x: 0, y: 0, d: 1 }, { k: 'btn', b: 0, down: true }] });
    expect(t.helper().calls).toContainEqual(['move', 1920, 0]);
    expect(t.helper().calls).toContainEqual(['button', 0, true]);
  });

  it('the viewer can ask for another screen and a quality; the host decides', async () => {
    const t = setup();
    await controlSession(t);
    t.viewer.askScreen(t.sid, { op: 'switch', display: 1 });
    t.viewer.setQuality(t.sid, 'speed');
    await flush();
    const share = t.host.snapshot().shares[0];
    expect(share.screenAsk).toMatchObject({ op: 'switch', display: 1 });
    expect(share.quality).toBe('speed');
    expect(() => t.viewer.setQuality(t.sid, 'ultra')).toThrow(/unknown quality/);
  });

  it('chat works both ways inside a live session, audits only sizes, and stops with the session', async () => {
    const t = setup();
    await controlSession(t);
    t.viewer.chat(t.sid, 'hello there');
    await flush();
    t.host.chat(t.sid, 'hi');
    await flush();
    expect(t.host.chatLog(t.sid).map((l) => [l.mine, l.text])).toEqual([[false, 'hello there'], [true, 'hi']]);
    expect(t.viewer.chatLog(t.sid).map((l) => l.text)).toEqual(['hello there', 'hi']);
    expect(JSON.stringify(t.pair.host.audit)).not.toMatch(/hello there/);
    t.host.stopAll('banner');
    await flush();
    expect(() => t.viewer.chat(t.sid, 'still there?')).toThrow(/no remote desktop session/);
  });

  it('the viewer side kill switch ends its views too', async () => {
    const t = setup();
    await controlSession(t);
    t.viewer.stopAll('banner');
    await flush();
    expect(t.viewer.snapshot().views).toHaveLength(0);
    expect(t.host.shares.size).toBe(0);
  });
});
