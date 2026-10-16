import { describe, expect, it } from 'vitest';
import { FrameError, LIMITS, decodeFrame, encodeFrame, readResult } from '../../ui/lend/core/frames.js';
import { RateLimiter } from '../../ui/lend/core/ratelimit.js';

const req = (extra = {}) => ({ t: 'req', id: 'r_1', messages: [{ role: 'user', content: 'hi' }], options: {}, ...extra });
const code = (fn) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(FrameError);
    return err.code;
  }
  throw new Error('expected a FrameError');
};

describe('remote brain framing', () => {
  it('round trips a request', () => {
    const text = encodeFrame(req({ options: { schema: { type: 'object' }, maxTokens: 300, temperature: 0.2 } }));
    expect(decodeFrame(text)).toEqual(req({ options: { schema: { type: 'object' }, maxTokens: 300, temperature: 0.2 } }));
  });

  it('keeps only prompts and options: no paths, tools, files or extra fields travel', () => {
    const f = decodeFrame(
      JSON.stringify({
        t: 'req',
        id: 'r_2',
        path: 'C:/secret',
        messages: [{ role: 'system', content: 'be brief', file: 'x' }],
        options: { schema: { type: 'string' }, tools: [{ name: 'run' }], signal: {}, cwd: '/', maxTokens: 10 },
      }),
    );
    expect(f).toEqual({ t: 'req', id: 'r_2', messages: [{ role: 'system', content: 'be brief' }], options: { schema: { type: 'string' }, maxTokens: 10 } });
  });

  it('caps sizes', () => {
    expect(code(() => decodeFrame('x'.repeat(LIMITS.frameBytes + 1)))).toBe('too_big');
    expect(code(() => decodeFrame(JSON.stringify(req({ messages: Array(LIMITS.messages + 1).fill({ role: 'user', content: 'a' }) }))))).toBe('too_many_messages');
    expect(code(() => encodeFrame(req({ messages: [{ role: 'user', content: 'a'.repeat(LIMITS.promptChars + 1) }] })))).toBe('prompt_too_long');
    expect(code(() => encodeFrame(req({ options: { schema: { enum: ['a'.repeat(LIMITS.schemaChars)] } } })))).toBe('schema_too_big');
    expect(code(() => readResult({ text: 'a'.repeat(LIMITS.completionChars + 1) }))).toBe('completion_too_long');
    expect(decodeFrame(encodeFrame(req({ options: { maxTokens: 1e9, temperature: 9 } }))).options).toEqual({ maxTokens: LIMITS.maxTokens, temperature: 2 });
  });

  it('counts multibyte text as UTF-8 bytes', () => {
    const limits = { ...LIMITS, frameBytes: 100 };
    expect(code(() => decodeFrame(JSON.stringify({ t: 'stop', reason: '\u00e9'.repeat(45) }), limits))).toBe('too_big');
  });

  it('rejects malformed frames', () => {
    expect(code(() => decodeFrame('{not json'))).toBe('bad_json');
    expect(code(() => decodeFrame('{"t":"exec","cmd":"rm"}'))).toBe('bad_frame');
    expect(code(() => decodeFrame(JSON.stringify(req({ id: '../../x y' }))))).toBe('bad_frame');
    expect(code(() => decodeFrame(JSON.stringify(req({ messages: [{ role: 'tool', content: 'x' }] }))))).toBe('bad_frame');
    expect(code(() => decodeFrame(JSON.stringify(req({ messages: [] }))))).toBe('bad_frame');
    expect(code(() => decodeFrame(JSON.stringify({ t: 'hello', role: 'admin' })))).toBe('bad_frame');
  });

  it('normalizes answers', () => {
    const f = decodeFrame(JSON.stringify({ t: 'res', id: 'r_1', ok: true, result: { text: '{"a":1}', json: { a: 1 }, promptTokens: 12.4, completionTokens: -3, ms: 'x', model: 'qwen', extra: 1 } }));
    expect(f.result).toEqual({ text: '{"a":1}', json: { a: 1 }, promptTokens: 12, completionTokens: 0, ms: 0, model: 'qwen' });
    const e = decodeFrame(JSON.stringify({ t: 'res', id: 'r_1', ok: false }));
    expect(e.error.code).toBe('failed');
  });
});

describe('rate limit', () => {
  it('allows perMinute requests per sliding minute', () => {
    let t = 0;
    const rl = new RateLimiter({ perMinute: 3, charsPerMinute: 1000, now: () => t });
    expect(rl.take(1).ok).toBe(true);
    t = 10000;
    expect(rl.take(1).ok).toBe(true);
    expect(rl.take(1).ok).toBe(true);
    const no = rl.take(1);
    expect(no).toMatchObject({ ok: false, reason: 'requests' });
    expect(no.retryInMs).toBe(50000);
    t = 60000;
    expect(rl.take(1).ok).toBe(true);
    expect(rl.usage().requests).toBe(3);
  });

  it('limits prompt characters per minute', () => {
    let t = 0;
    const rl = new RateLimiter({ perMinute: 100, charsPerMinute: 100, now: () => t });
    expect(rl.take(60).ok).toBe(true);
    t = 1000;
    expect(rl.take(30).ok).toBe(true);
    const no = rl.take(20);
    expect(no).toMatchObject({ ok: false, reason: 'chars', retryInMs: 59000 });
    expect(rl.take(500)).toMatchObject({ ok: false, reason: 'chars' });
    t = 60001;
    expect(rl.take(20).ok).toBe(true);
    expect(rl.usage()).toEqual({ requests: 2, chars: 50 });
  });
});
