// Message bodies are refused when over their bounds, never cut (a cut schema or answer is wrong, not short).
import { describe, it, expect } from 'vitest';
import { checkedJson, boundedJson, readMessage, SCHEMA_BOUNDS, STREAM } from '../../src/p2p/messages.js';
import { LIMITS } from '../../src/compute/wire.js';

const nest = (n) => [...Array(n)].reduce((inner) => ({ a: inner }), 1);
const offer = (schema) => ({ t: 'job.offer', id: 'm1', ts: Date.now(), body: { job: { id: 'jb_aaaaaaaaaaaaaaaa', type: 'inference', input: { model: 'any-allowed', messages: [{ role: 'user', content: 'x' }], maxTokens: 10, schema } } } });

describe('bounded JSON bodies', () => {
  it('refuses depth, size, keys and long strings instead of truncating them', () => {
    expect(checkedJson(nest(7))).toEqual(nest(7));
    expect(() => checkedJson(nest(9))).toThrow(/deeper than 8/);
    expect(() => boundedJson({ s: 'x'.repeat(64 * 1024 + 1) })).toThrow(/longer than/);
    expect(() => checkedJson(Object.fromEntries([...Array(300)].map((_, i) => [`k${i}`, i])))).toThrow(/more than 256 keys/);
    expect(() => checkedJson([...Array(300)])).toThrow(/more than 256 items/);
  });

  it('checks job.input.schema of an offer as its own subtree: the crew schemas pass whole, a bigger one is bad_input', () => {
    const deepSchema = [...Array(8)].reduce((inner) => ({ type: 'object', properties: { x: inner } }), { type: 'string' });
    const m = readMessage(offer(deepSchema), STREAM.COMPUTE, 1000);
    expect(m.body.job.input.schema).toEqual(deepSchema);
    const tooDeep = [...Array(11)].reduce((inner) => ({ type: 'object', properties: { x: inner } }), { type: 'string' });
    expect(() => readMessage(offer(tooDeep), STREAM.COMPUTE, 1000)).toThrow(expect.objectContaining({ code: 'bad_input' }));
    const tooLong = { type: 'object', properties: Object.fromEntries([...Array(60)].map((_, i) => [`field_${i}`, { type: 'string', description: 'x'.repeat(150) }])) };
    expect(() => readMessage(offer(tooLong), STREAM.COMPUTE, 1000)).toThrow(/longer than 8192/);
  });

  it('keeps the wire bounds and the worker schema subset in step', () => {
    expect(SCHEMA_BOUNDS.chars).toBe(LIMITS.schemaChars);
    // 8 schema nodes through properties cost 16 JSON levels, inside the 20 of the wire.
    expect(SCHEMA_BOUNDS.depth).toBeGreaterThanOrEqual(2 * LIMITS.schemaDepth + 1);
  });
});
