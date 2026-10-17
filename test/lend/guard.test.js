import { describe, expect, it } from 'vitest';
import register, { cleanLogEntry, findLocalChat } from '../../src/lend/index.js';
import { createLendGuard } from '../../src/lend/guard.js';

const msg = (content = 'hi') => ({ messages: [{ role: 'user', content }], options: { maxTokens: 20, tools: ['run'] } });

function fakeEngine(config = { lend: true }) {
  const events = [];
  const commands = new Map();
  const routes = new Map();
  const seen = [];
  const ctx = {
    config,
    bus: { emit: (type, data) => events.push({ type, data }), on: () => {} },
    server: { command: (t, h) => commands.set(t, h), route: (m, p, h) => routes.set(`${m} ${p}`, h) },
    scheduler: {
      localBrain: {
        chat: async (messages, options) => {
          seen.push({ messages, options });
          return { text: 'ok', promptTokens: 2, completionTokens: 1, ms: 5 };
        },
      },
    },
  };
  return { ctx, events, commands, routes, seen };
}

describe('lend server guard', () => {
  it('runs a checked turn on the local brain and logs counts only', async () => {
    const e = fakeEngine();
    register(e.ctx);
    const result = await e.commands.get('lend.chat')(msg('secret prompt'));
    expect(result).toEqual({ text: 'ok', promptTokens: 2, completionTokens: 1, ms: 5 });
    expect(e.seen[0].options).toMatchObject({ maxTokens: 20 });
    expect(e.seen[0].options.tools).toBeUndefined();
    expect(e.events).toEqual([{ type: 'lend.served', data: { messages: 1, chars: 13, completionTokens: 1, ms: 5 } }]);
    expect(JSON.stringify(e.events)).not.toContain('secret');
  });

  it('refuses everything after stop, and when not started with --lend', async () => {
    const e = fakeEngine();
    register(e.ctx);
    e.commands.get('lend.stop')({ reason: 'bed time' });
    await expect(e.commands.get('lend.chat')(msg())).rejects.toMatchObject({ code: 'stopped' });
    expect(e.events.map((x) => x.type)).toEqual(['lend.stopped', 'lend.refused']);
    e.commands.get('lend.resume')();
    await expect(e.commands.get('lend.chat')(msg())).resolves.toMatchObject({ text: 'ok' });

    const off = fakeEngine({ lend: false });
    register(off.ctx);
    expect(() => off.commands.get('lend.chat')(msg())).toThrow(/--lend/);
  });

  it('rate limits and caps sizes on the server too', async () => {
    let t = 0;
    const g = createLendGuard({ chat: async () => ({ text: 'x' }), rate: { perMinute: 1, charsPerMinute: 1000 }, now: () => t });
    await g.handle(msg());
    await expect(g.handle(msg())).rejects.toMatchObject({ code: 'rate_limited' });
    t = 61000;
    await expect(g.handle(msg('a'.repeat(200000)))).rejects.toMatchObject({ code: 'prompt_too_long' });
    await expect(g.handle({ messages: [{ role: 'tool', content: 'x' }] })).rejects.toMatchObject({ code: 'bad_frame' });
    expect(g.status()).toMatchObject({ lending: true, served: 1, refused: 3 });
  });

  it('refuses a second turn while one runs', async () => {
    let release;
    const g = createLendGuard({ chat: () => new Promise((r) => (release = r)) });
    const first = g.handle(msg());
    await expect(g.handle(msg())).rejects.toMatchObject({ code: 'busy' });
    release({ text: 'done' });
    await expect(first).resolves.toMatchObject({ text: 'done' });
  });

  it('finds the local brain in the shapes the engine may hand over', () => {
    const chat = async () => ({ text: '' });
    expect(findLocalChat({ chatLocal: chat })).toBe(chat);
    expect(typeof findLocalChat({ brain: { chat } })).toBe('function');
    expect(typeof findLocalChat({ scheduler: { getLocalBrain: async () => ({ chat }) } })).toBe('function');
    const turns = [];
    const viaQueue = findLocalChat({ scheduler: { turn: async (req) => (turns.push(req), { text: 'q' }) } });
    return viaQueue([{ role: 'user', content: 'x' }], {}).then((r) => {
      expect(r.text).toBe('q');
      expect(turns[0]).toMatchObject({ workerId: 'lend:friend' });
      expect(findLocalChat({})).toBeNull();
    });
  });

  it('keeps prompt text out of browser log entries', () => {
    expect(cleanLogEntry({ id: 'r_1', status: 'done', chars: 10, preview: 'my secret', completionTokens: 4, ms: 9 })).toEqual({ id: 'r_1', status: 'done', chars: 10, completionTokens: 4, ms: 9 });
    expect(cleanLogEntry({ status: 'weird' })).toBeNull();
  });
});
