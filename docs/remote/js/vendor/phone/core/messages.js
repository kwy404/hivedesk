// Copied from ui/phone/core/messages.js by scripts/phone-page.mjs. Edit the source, then run the script.
// The message table of the phone session (docs/1.0/protocol/phone.md section 4). Each type has a
// stream (1 control, 3 media signaling), the direction it may travel (up: phone to desktop, down:
// desktop to phone), a size cap, an optional rate per session and a normalizer that keeps known
// fields only. A type outside the table, or one that travels the wrong way, closes the session.

export class PhoneMessageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PhoneMessageError';
    this.code = code;
  }
}

const KB = 1024;
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const num = (v, min, max) => (Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : undefined);
const plain = (b) => (b && typeof b === 'object' && !Array.isArray(b) ? b : {});

/** Bounded copy of unknown JSON: depth 8, 512 keys or items per level, strings 256 KB. */
export function bounded(value, depth = 0) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.slice(0, 256 * KB);
  if (depth >= 8 || typeof value !== 'object') return null;
  if (Array.isArray(value)) return value.slice(0, 512).map((v) => bounded(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value).slice(0, 512)) if (v !== undefined) out[k.slice(0, 64)] = bounded(v, depth + 1);
  return out;
}

const TABLE = new Map();
const def = (t, spec) => TABLE.set(t, { s: 1, max: 16 * KB, norm: bounded, up: false, down: false, ...spec });
const both = { up: true, down: true };

def('ping', { ...both, rate: [40, 10_000], norm: () => ({}) });
def('pong', { ...both, rate: [40, 10_000], norm: () => ({}) });
def('session.close', { ...both, norm: (b) => ({ reason: str(b.reason, 120) || 'closed' }) });
def('error', { ...both, rate: [40, 10_000], norm: (b) => ({ code: str(b.code, 40) || 'error', message: str(b.message, 300) || '' }) });
// pairing answer and the session's terms
def('pair.accept', { down: true, max: 4 * KB });
def('pair.refuse', { down: true, norm: (b) => ({ reason: str(b.reason, 120) || 'refused' }) });
def('welcome', { down: true, max: 8 * KB });
def('grants', { down: true, max: 4 * KB });
// commands and their answers
def('cmd', { up: true, max: 12 * KB, rate: [40, 10_000], norm: (b) => ({ op: str(b.op, 40) || '', a: bounded(plain(b.a)) }) });
def('cmd.re', { down: true, max: 1024 * KB });
// what the desktop pushes
def('state', { down: true, max: 1024 * KB });
def('feed', { down: true, max: 64 * KB });
def('notice', { down: true, max: 4 * KB });
// remote desktop (docs/1.0/protocol/remote.md): the desktop's src/remote/ checks every one of them
def('cap.request', { up: true, max: 2 * KB, rate: [5, 60_000], norm: (b) => ({ capability: { name: str(b?.capability?.name, 40) || '', limits: { clipboard: false, files: false } }, reason: str(b.reason, 200) || '' }) });
def('remote.ready', { down: true, max: 8 * KB });
def('remote.refused', { down: true, norm: (b) => ({ reason: str(b.reason, 60) || 'declined' }) });
def('remote.state', { down: true, max: 8 * KB });
def('remote.stop', { ...both, norm: (b) => ({ reason: str(b.reason, 60) || 'viewer' }) });
def('remote.input', { up: true, max: 32 * KB, rate: [120, 1000] });
def('remote.screen', { up: true, max: 1 * KB });
def('remote.quality', { ...both, max: 1 * KB });
def('remote.chat', { ...both, max: 8 * KB, rate: [20, 10_000] });
def('remote.sdp', { ...both, s: 3, max: 40 * KB });
def('remote.ice', { ...both, s: 3, max: 4 * KB, rate: [300, 60_000] });

export const messageSpec = (t) => TABLE.get(t) || null;
export const messageTypes = () => [...TABLE.keys()];

/**
 * Validates one decrypted message for a receiver on side 'phone' or 'desktop'.
 * Returns { t, id?, re?, ts, body } or throws PhoneMessageError('bad_message').
 */
export function readMessage(obj, stream, size, side) {
  if (!obj || typeof obj !== 'object' || typeof obj.t !== 'string') throw new PhoneMessageError('bad_message', 'not a message');
  const spec = TABLE.get(obj.t);
  if (!spec) throw new PhoneMessageError('bad_message', `unknown message type ${obj.t.slice(0, 40)}`);
  if (side === 'desktop' ? !spec.up : !spec.down) throw new PhoneMessageError('bad_message', `${obj.t} does not travel this way`);
  if (spec.s !== stream) throw new PhoneMessageError('bad_message', `${obj.t} belongs on stream ${spec.s}`);
  if (size > spec.max) throw new PhoneMessageError('bad_message', `${obj.t} is larger than ${spec.max} bytes`);
  if (!Number.isFinite(obj.ts)) throw new PhoneMessageError('bad_message', 'missing ts');
  const out = { t: obj.t, ts: obj.ts, body: spec.norm(plain(obj.body)) };
  if (typeof obj.id === 'string' && obj.id.length <= 40) out.id = obj.id;
  if (typeof obj.re === 'string' && obj.re.length <= 40) out.re = obj.re;
  return out;
}

export { num, str };
