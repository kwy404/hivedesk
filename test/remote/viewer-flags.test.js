// The viewer keeps only what it asked for: a host's remote.ready can never turn on clipboard or files by itself.
import { describe, it, expect } from 'vitest';
import { RemoteDesk } from '../../src/remote/desk.js';
import { createInprocPair, flush, FakeHelper, manualClock } from './inproc-port.js';

const WIN = { view: true, control: true, kind: 'win-input', hotkey: true, indicator: true, reason: null };

function setup() {
  const clock = manualClock();
  const pair = createInprocPair({ now: clock.now });
  const mk = (p2p) => new RemoteDesk({ p2p, support: WIN, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, startHelper: () => new FakeHelper() });
  return { pair, host: mk(pair.host.port), viewer: mk(pair.viewer.port), sid: pair.open() };
}

describe('remote viewer flags', () => {
  it('uses the intersection of what the viewer asked and what remote.ready says', async () => {
    const t = setup();
    t.viewer.ask(t.sid, { clipboard: false, files: false });
    await flush();
    // A forged ready from the host side grants more than was asked.
    t.pair.host.port.send(t.sid, 1, 'remote.ready', { mode: 'view', clipboard: 'both', files: true, expiresAt: Date.now() + 60_000 });
    await flush();
    const v = t.viewer.snapshot().views[0];
    expect(v.state).toBe('granted');
    expect(v.clipboard).toBe('off');
    expect(v.files).toBe(false);
  });

  it('keeps what was asked for when the host grants it', async () => {
    const t = setup();
    t.viewer.ask(t.sid, { clipboard: true, files: true });
    await flush();
    t.pair.host.port.send(t.sid, 1, 'remote.ready', { mode: 'view', clipboard: 'to_viewer', files: true });
    await flush();
    expect(t.viewer.snapshot().views[0]).toMatchObject({ clipboard: 'to_viewer', files: true });
  });
});
