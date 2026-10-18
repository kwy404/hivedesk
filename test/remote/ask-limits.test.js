// The host dialog cannot be spammed: per peer, in all, and right after a Decline (ASK_LIMITS).
import { describe, it, expect } from 'vitest';
import { RemoteDesk, ASK_LIMITS } from '../../src/remote/desk.js';
import { createInprocPair, flush, FakeHelper, manualClock } from './inproc-port.js';

const WIN = { view: true, control: true, kind: 'win-input', hotkey: true, indicator: true, reason: null };

function setup() {
  const clock = manualClock();
  const pair = createInprocPair({ now: clock.now });
  const mk = (p2p) => new RemoteDesk({ p2p, support: WIN, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, startHelper: () => new FakeHelper() });
  const host = mk(pair.host.port);
  const viewer = mk(pair.viewer.port);
  const sid = pair.open();
  const refusals = () => pair.host.sent.filter((m) => m.t === 'remote.refused').map((m) => m.body.reason);
  return { clock, pair, host, viewer, sid, refusals };
}

describe('remote desktop: limits on asking', () => {
  it('a Decline holds the next ask of that peer back for a while', async () => {
    const t = setup();
    t.viewer.ask(t.sid, {});
    await flush();
    t.host.answer(t.host.snapshot().requests[0].id, { allow: false });
    t.viewer.ask(t.sid, {});
    await flush();
    expect(t.host.snapshot().requests).toHaveLength(0);
    expect(t.refusals()).toEqual(['declined', 'busy']);
    t.clock.advance(ASK_LIMITS.afterDeclineMs + 1);
    t.viewer.ask(t.sid, {});
    await flush();
    expect(t.host.snapshot().requests).toHaveLength(1);
  });

  it('at most a few unanswered asks per peer in two minutes, and an Accept starts the count again', async () => {
    const t = setup();
    for (let i = 0; i < ASK_LIMITS.perPeer + 2; i++) { t.viewer.ask(t.sid, {}); await flush(); }
    expect(t.refusals().filter((r) => r === 'busy')).toHaveLength(2);
    expect(t.pair.host.audit.map((l) => l.entry).filter((e) => e.kind === 'remote.request.dropped').map((e) => e.reason)).toEqual(['too_many_from_peer', 'too_many_from_peer']);
    t.clock.advance(ASK_LIMITS.perPeerMs + 1);
    t.viewer.ask(t.sid, {});
    await flush();
    t.host.answer(t.host.snapshot().requests[0].id, { allow: true, view: true, minutes: 5 });
    for (let i = 0; i < ASK_LIMITS.perPeer; i++) { t.viewer.ask(t.sid, {}); await flush(); }
    expect(t.refusals().filter((r) => r === 'busy')).toHaveLength(2);
  });
});
