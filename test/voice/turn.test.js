// The turn state machine of conversation mode: listen, end of turn, think, speak, barge in, follow up, end.
import { describe, it, expect } from 'vitest';
import { step, phaseOf, STATES } from '../../ui/js/voice/turn.js';

const names = (fx) => fx.map((f) => (Array.isArray(f) ? f[0] : f));
const run = (events, ctx = { handsFree: true }, from = 'off') => {
  let s = from;
  const log = [];
  for (const ev of events) { const r = step(s, ev, ctx); s = r.state; log.push([s, names(r.effects)]); }
  return { state: s, log };
};

describe('turn state machine', () => {
  it('one tap starts a hands free loop that answers and listens again without a tap', () => {
    const r = run([
      { type: 'open' }, { type: 'speech.start' }, { type: 'speech.end', audio: 'a' },
      { type: 'transcript', text: 'what is the crew doing' }, { type: 'speak.start' }, { type: 'turn.done' }, { type: 'speak.end' },
    ]);
    expect(r.log.map((x) => x[0])).toEqual(['listening', 'hearing', 'transcribing', 'thinking', 'speaking', 'speaking', 'listening']);
    expect(r.log[0][1]).toContain('mic.on');
    expect(r.log[2][1]).toContain('stt');
    expect(r.log[3][1]).toContain('handle');
    expect(r.log[6][1]).toContain('followup.arm');
    expect(r.log.flatMap((x) => x[1])).not.toContain('mic.off');
  });

  it('barge in: speech while Mel speaks stops her at once and listens', () => {
    const r = step('speaking', { type: 'speech.start' }, { handsFree: true });
    expect(r.state).toBe('hearing');
    expect(names(r.effects)).toEqual(expect.arrayContaining(['speech.stop', 'reply.cancel']));
    const t = step('thinking', { type: 'speech.start' }, { handsFree: true });
    expect(t.state).toBe('hearing');
    expect(names(t.effects)).toContain('reply.cancel');
  });

  it('a pause that was not the end of the turn keeps what was said and listens on', () => {
    const r = step('transcribing', { type: 'speech.start' }, {});
    expect(r.state).toBe('hearing');
    expect(names(r.effects)).toEqual(['stt.hold']);
  });

  it('a turn still running after Mel spoke goes back to thinking, not listening', () => {
    expect(step('speaking', { type: 'speak.end' }, { inFlight: true }).state).toBe('thinking');
    expect(step('speaking', { type: 'speak.end' }, { inFlight: false }).state).toBe('listening');
  });

  it('silence after a turn ends the conversation; with the wake word on it waits for "Mel"', () => {
    const off = step('listening', { type: 'followup.timeout' }, { wake: false });
    expect(off.state).toBe('off');
    expect(names(off.effects)).toContain('mic.off');
    const dormant = step('listening', { type: 'followup.timeout' }, { wake: true });
    expect(dormant.state).toBe('dormant');
    expect(names(dormant.effects)).not.toContain('mic.off');
  });

  it('a clear way to end from any state', () => {
    for (const s of STATES.filter((x) => x !== 'off')) {
      const r = step(s, { type: 'close' }, { wake: false });
      expect(r.state).toBe('off');
      expect(names(r.effects)).toEqual(expect.arrayContaining(['speech.stop', 'reply.cancel', 'mic.off']));
    }
  });

  it('the wake word opens the conversation, and a command after it runs directly', () => {
    expect(step('dormant', { type: 'speech.end', audio: 'x' }, { wake: true }).effects[0][0]).toBe('wake.check');
    expect(step('dormant', { type: 'wake' }, { wake: true }).state).toBe('listening');
    const r = step('dormant', { type: 'wake', rest: 'open the files' }, { wake: true });
    expect(r.state).toBe('thinking');
    expect(r.effects).toContainEqual(['handle', 'open the files']);
    // the wake word does nothing outside the wait
    expect(step('listening', { type: 'wake' }, {}).state).toBe('listening');
  });

  it('push to talk: press, release, answer, then off', () => {
    const ctx = { handsFree: false };
    const r = run([{ type: 'ptt.down' }, { type: 'ptt.up', audio: 'a' }, { type: 'transcript', text: 'hi' }, { type: 'turn.done' }], ctx);
    expect(r.log.map((x) => x[0])).toEqual(['hearing', 'transcribing', 'thinking', 'off']);
    expect(r.log[0][1]).toContain('mic.on');
    expect(r.log[3][1]).toContain('mic.off');
  });

  it('muted: speech does not start a turn; an empty transcript listens again', () => {
    expect(step('listening', { type: 'speech.start' }, { muted: true }).state).toBe('listening');
    expect(step('transcribing', { type: 'transcript', text: '  ' }, { handsFree: true }).state).toBe('listening');
  });

  it('maps states to the orb phases', () => {
    expect(phaseOf('hearing')).toBe('listening');
    expect(phaseOf('transcribing')).toBe('thinking');
    expect(phaseOf('speaking')).toBe('speaking');
    expect(phaseOf('off')).toBe('idle');
  });
});
