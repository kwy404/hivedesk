// The message table of PLAN section 4: for every plaintext type, its stream, who may send it,
// a size cap, a rate limit, the capability the receiver checks, and a normalizer that keeps only
// known fields (the style of ui/lend/core/frames.js). Anything not in the table closes the
// session with bad_message. Other streams register the bodies of their own types with
// registerMessage (job.* by src/compute/, remote.* by src/remote/, term.* by src/workbench/).

import { normalizeCapability, normalizeCapList } from './caps.js';

export class MessageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MessageError';
    this.code = code;
  }
}

export const STREAM = Object.freeze({ CONTROL: 1, COMPUTE: 2, MEDIA: 3 });
const KB = 1024;

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const num = (v, min, max) => (Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : undefined);
const plain = (b) => (b && typeof b === 'object' && !Array.isArray(b) ? b : {});

/** The default bounds of an unknown JSON body. */
export const JSON_BOUNDS = Object.freeze({ depth: 8, keys: 256, items: 256, string: 64 * KB, key: 64 });

/**
 * A checked copy of an unknown JSON body. Anything over a bound is refused with bad_input, never cut:
 * a body that arrives is the body that was sent (a truncated schema or answer would be wrong, not short).
 * @param {any} value
 * @param {Partial<typeof JSON_BOUNDS>} [bounds]
 */
export function checkedJson(value, bounds = {}) {
  const b = { ...JSON_BOUNDS, ...bounds };
  const walk = (v, depth, where) => {
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new MessageError('bad_input', `${where} is not a finite number`);
      return v;
    }
    if (typeof v === 'string') {
      if (v.length > b.string) throw new MessageError('bad_input', `${where} is longer than ${b.string} characters`);
      return v;
    }
    if (typeof v !== 'object') throw new MessageError('bad_input', `${where} is not JSON`);
    if (depth >= b.depth) throw new MessageError('bad_input', `${where} is nested deeper than ${b.depth} levels`);
    if (Array.isArray(v)) {
      if (v.length > b.items) throw new MessageError('bad_input', `${where} has more than ${b.items} items`);
      return v.map((x, i) => walk(x, depth + 1, `${where}[${i}]`));
    }
    const entries = Object.entries(v).filter(([, x]) => x !== undefined);
    if (entries.length > b.keys) throw new MessageError('bad_input', `${where} has more than ${b.keys} keys`);
    const out = {};
    for (const [k, x] of entries) {
      if (k.length > b.key) throw new MessageError('bad_input', `${where} has a key longer than ${b.key} characters`);
      out[k] = walk(x, depth + 1, `${where}.${k}`);
    }
    return out;
  };
  return walk(value, 0, 'the body');
}

/** checkedJson with the default bounds (the 0.x name; it refuses since 1.0, it never truncates). */
export const boundedJson = (value) => checkedJson(value);

/**
 * The bounds of an inference schema inside job.offer (job.input.schema), checked as its own subtree.
 * They follow the schema subset of src/compute/wire.js (LIMITS.schemaDepth 8 nodes, LIMITS.schemaChars):
 * a node through "properties" or "oneOf" costs two JSON levels, so 8 nodes fit in 20 levels.
 * The crew's deepest real schema (the QA tool call schema) is 6 nodes, 11 levels and about 3,700 characters.
 */
export const SCHEMA_BOUNDS = Object.freeze({ depth: 20, keys: 64, items: 64, string: 2000, key: 64, chars: 8192 });

/** A city event or a city reply carries engine events and the CityState: deeper and wider than a control body. */
const CITY_BOUNDS = Object.freeze({ depth: 24, keys: 4000, items: 4000, string: 64 * KB, key: 120 });

/** job.offer: the envelope at the default bounds, job.input.schema with its own (refused, never cut, when over). */
function readOfferBody(b) {
  const schema = b?.job?.input?.schema;
  const envelope = { string: 128 * KB, items: 64 };
  if (schema === undefined) return checkedJson(b, envelope);
  let text;
  try { text = JSON.stringify(schema); } catch { throw new MessageError('bad_input', 'the schema is not JSON'); }
  if (text.length > SCHEMA_BOUNDS.chars) throw new MessageError('bad_input', `the schema is longer than ${SCHEMA_BOUNDS.chars} characters`);
  const checkedSchema = checkedJson(schema, SCHEMA_BOUNDS);
  const { schema: _s, ...input } = b.job.input;
  const out = checkedJson({ ...b, job: { ...b.job, input } }, envelope);
  out.job.input.schema = checkedSchema;
  return out;
}

/**
 * cap: the capability the receiver checks before a handler runs. null: no check.
 * reply: only meaningful as an answer from a peer that granted us something (job.* from a worker);
 * the owning module matches ids. pre: allowed before the join is accepted.
 * rate: [count, windowMs] per session.
 */
const TABLE = new Map();

export function registerMessage(type, spec) {
  if (!/^[a-z]+(\.[a-z0-9]+){0,3}$/.test(type)) throw new TypeError(`bad message type ${type}`);
  const prev = TABLE.get(type) || {};
  TABLE.set(type, { stream: STREAM.CONTROL, max: 64 * KB, cap: null, normalize: boundedJson, ...prev, ...spec });
}

export const messageSpec = (type) => TABLE.get(type) || null;
export const messageTypes = () => [...TABLE.keys()];

// ---- control plane, owned here ----
// The local profile (docs/1.0/PROFILE.md): a display name and an avatar id; the receiver sanitizes again.
registerMessage('profile.hello', { pre: true, max: 1 * KB, rate: [10, 60_000], normalize: (b) => ({ name: str(b?.name, 64) || '', avatar: str(b?.avatar, 40) || null, ...(Number.isFinite(b?.achievements) ? { achievements: num(b.achievements, 0, 1000) } : {}) }) });
registerMessage('join.accept', { pre: true, normalize: (b) => ({ grants: Array.isArray(b?.grants) ? b.grants.slice(0, 24) : [], cityId: str(b?.cityId, 120), machineId: str(b?.machineId, 40) }) });
registerMessage('join.refuse', { pre: true, normalize: (b) => ({ reason: str(b?.reason, 200) || 'refused' }) });
registerMessage('cap.request', {
  rate: [5, 60_000],
  normalize: (b) => {
    const capability = normalizeCapability(b?.capability);
    return { capability, reason: str(b?.reason, 200) || '', minutes: num(b?.minutes, 1, 43_200) };
  },
});
registerMessage('cap.grant', { normalize: (b) => ({ grant: plain(b?.grant) }) });
registerMessage('cap.revoke', { normalize: (b) => ({ grantId: str(b?.grantId, 20), reason: str(b?.reason, 200) || '' }) });
registerMessage('ping', { pre: true, rate: [30, 10_000], normalize: (b) => ({ rtt: num(b?.rtt, 0, 600_000) }) });
registerMessage('pong', { pre: true, rate: [30, 10_000], normalize: (b) => ({ rtt: num(b?.rtt, 0, 600_000) }) });
registerMessage('presence', { cap: 'city.view', rate: [15, 1000], max: 2 * KB, normalize: (b) => ({ x: num(b?.x, -1e6, 1e6) ?? 0, y: num(b?.y, -1e6, 1e6) ?? 0, room: str(b?.room, 60), building: str(b?.building, 60) }) });
registerMessage('resource.advert', { max: 32 * KB, rate: [10, 10_000] });
registerMessage('city.cmd', { cap: 'city.member', max: 256 * KB, rate: [60, 10_000], normalize: (b) => ({ id: str(b?.id, 40), type: str(b?.type, 60) || '', data: checkedJson(b?.data ?? null, { depth: 12 }) }) });
registerMessage('city.event', { reply: true, max: 512 * KB, normalize: (b) => checkedJson(b, CITY_BOUNDS) });
// city.reply: the host's answer to one city.cmd ({ re: the cmd body id, ok, result?, error? }), docs/1.0/protocol/city.md.
registerMessage('city.reply', {
  reply: true,
  max: 512 * KB,
  normalize: (b) => ({ re: str(b?.re, 40), ok: b?.ok === true, ...(b?.ok === true ? { result: checkedJson(b?.result ?? null, CITY_BOUNDS) } : { error: { code: str(b?.error?.code, 40) || 'internal', message: str(b?.error?.message, 300) || '' } }) }),
});
registerMessage('audit.ref', { normalize: (b) => ({ entryHash: /^[0-9a-f]{64}$/.test(b?.entryHash || '') ? b.entryHash : undefined, type: str(b?.type, 40) }) });
registerMessage('session.close', { pre: true, normalize: (b) => ({ reason: str(b?.reason, 200) || 'closed' }) });
registerMessage('identity.rotated', { normalize: (b) => boundedJson(b) });
// error: the answer to a message that was refused (not_granted, rate_limited, bad_input). A growth of the table.
registerMessage('error', { pre: true, rate: [30, 10_000], normalize: (b) => ({ code: str(b?.code, 40) || 'error', message: str(b?.message, 300) || '' }) });

// ---- compute plane: src/compute/wire.js normalizes every body itself (docs/1.0/protocol/compute.md);
// here only the stream, the size cap, the rate and the grant check of job.offer ----
const jobIdOf = (b) => (typeof b?.job?.id === 'string' && /^jb_[a-z2-7]{16}$/.test(b.job.id) ? b.job.id : null);
registerMessage('job.offer', {
  stream: STREAM.COMPUTE,
  cap: 'compute.inference',
  max: 640 * KB,
  rate: [30, 60_000],
  // The prompt messages are long strings (up to 120,000 characters in all, src/compute/wire.js).
  normalize: (b) => readOfferBody(b),
  refuse: (b) => (jobIdOf(b) ? ['job.reject', { jobId: jobIdOf(b), code: 'not_granted', detail: 'you do not hold compute.inference on this machine' }] : null),
});
// A result carries the answer text (up to 512 KB) and the parsed JSON answer, as deep as its schema allows.
for (const t of ['job.accept', 'job.reject', 'job.heartbeat']) registerMessage(t, { stream: STREAM.COMPUTE, reply: true, max: 16 * KB });
for (const t of ['job.result', 'job.error']) registerMessage(t, { stream: STREAM.COMPUTE, reply: true, max: 1100 * KB, normalize: (b) => checkedJson(b, { depth: 24, keys: 1000, items: 1000, string: 1024 * KB }) });
registerMessage('job.token', { stream: STREAM.COMPUTE, reply: true, max: 16 * KB, rate: [50, 1000] });
registerMessage('job.cancel', { stream: STREAM.CONTROL, max: 1 * KB });
registerMessage('job.revoke', { stream: STREAM.CONTROL, reply: true, max: 1 * KB });

/** Checks the capability list in a join request (inside hs.3). */
export const readRequestedCaps = (list) => normalizeCapList(list);

/**
 * Validates one decrypted message: { t, id?, re?, ts, body } on the stream its type belongs to.
 * Returns the clean message or throws MessageError('bad_message').
 */
export function readMessage(obj, stream, size) {
  if (!obj || typeof obj !== 'object' || typeof obj.t !== 'string') throw new MessageError('bad_message', 'not a message');
  const spec = TABLE.get(obj.t);
  if (!spec) throw new MessageError('bad_message', `unknown message type ${obj.t.slice(0, 40)}`);
  if (spec.stream !== stream) throw new MessageError('bad_message', `${obj.t} belongs on stream ${spec.stream}`);
  if (size > spec.max) throw new MessageError('bad_message', `${obj.t} is larger than ${spec.max} bytes`);
  if (!Number.isFinite(obj.ts)) throw new MessageError('bad_message', 'missing ts');
  let body;
  try {
    body = spec.normalize(plain(obj.body));
  } catch (err) {
    throw new MessageError('bad_input', err.message);
  }
  const out = { t: obj.t, ts: obj.ts, body };
  if (typeof obj.id === 'string' && obj.id.length <= 64) out.id = obj.id;
  if (typeof obj.re === 'string' && obj.re.length <= 64) out.re = obj.re;
  return out;
}
