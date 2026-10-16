// Lend frames: what travels on the data channel between the host (who borrows a brain) and
// the friend (who lends one). Only model prompts and completions travel, nothing else:
//
//   hello   both    { t, v, role: 'lender' | 'host', label, model?, ctx?, limits? }
//   confirm both    { t }                     the person on this side said the confirmation words match
//   req     host    { t, id, messages, options: { schema?, maxTokens?, temperature? } }
//   tok     lender  { t, id, text }           optional streamed text for a pending req
//   res     lender  { t, id, ok: true, result } or { t, id, ok: false, error: { code, message } }
//   cancel  host    { t, id }
//   stop    both    { t, reason }             lending is over, both sides close
//
// Every frame is one JSON text message. decodeFrame() checks the size first, then the shape,
// keeps only the fields listed above and clamps numbers, so a peer cannot smuggle anything else
// through (no paths, no file content fields, no tool calls to run on the other machine).

export const LEND_PROTOCOL = 1;

export const LIMITS = Object.freeze({
  frameBytes: 512 * 1024, // one frame, as UTF-8
  messages: 64, // messages in one request
  promptChars: 120000, // all message contents of one request together
  schemaChars: 16000, // the JSON schema of one request
  maxTokens: 4096, // the most completion tokens a request may ask for
  completionChars: 120000, // the completion text (and its parsed JSON) of one answer
  tokenChars: 8000, // one streamed token frame
  labelChars: 60,
});

const ROLES = new Set(['system', 'user', 'assistant']);
const TYPES = new Set(['hello', 'confirm', 'req', 'tok', 'res', 'cancel', 'stop']);
const ID = /^[A-Za-z0-9_.:-]{1,64}$/;

export class FrameError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FrameError';
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new FrameError(code, message);
};

const utf8Length = (text) => {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
};

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const count = (v) => (Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v), 1e9) : 0);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function checkId(id) {
  if (typeof id !== 'string' || !ID.test(id)) fail('bad_frame', 'A request id is missing or malformed');
  return id;
}

/** Validates and normalizes request messages. Throws a FrameError with a reason. */
export function readMessages(messages, limits = LIMITS) {
  if (!Array.isArray(messages) || messages.length === 0) fail('bad_frame', 'A request needs at least one message');
  if (messages.length > limits.messages) fail('too_many_messages', `A request may carry at most ${limits.messages} messages`);
  let chars = 0;
  const out = messages.map((m) => {
    if (!m || typeof m !== 'object' || !ROLES.has(m.role) || typeof m.content !== 'string') fail('bad_frame', 'Each message needs a role and a text content');
    chars += m.content.length;
    return { role: m.role, content: m.content };
  });
  if (chars > limits.promptChars) fail('prompt_too_long', `The prompt has ${chars} characters, the limit is ${limits.promptChars}`);
  return out;
}

/** Only schema, maxTokens and temperature travel. Signals, callbacks and tools stay home. */
export function readOptions(options, limits = LIMITS) {
  const out = {};
  if (!options || typeof options !== 'object') return out;
  if (options.schema != null) {
    if (typeof options.schema !== 'object') fail('bad_frame', 'The schema must be a JSON object');
    const text = JSON.stringify(options.schema);
    if (text.length > limits.schemaChars) fail('schema_too_big', `The schema has ${text.length} characters, the limit is ${limits.schemaChars}`);
    out.schema = JSON.parse(text);
  }
  if (Number.isFinite(options.maxTokens)) out.maxTokens = clamp(Math.round(options.maxTokens), 1, limits.maxTokens);
  if (Number.isFinite(options.temperature)) out.temperature = clamp(options.temperature, 0, 2);
  return out;
}

/** Validates and normalizes a ChatResult coming back from the lender. */
export function readResult(result, limits = LIMITS) {
  if (!result || typeof result !== 'object' || typeof result.text !== 'string') fail('bad_frame', 'An answer needs a text');
  if (result.text.length > limits.completionChars) fail('completion_too_long', `The answer has ${result.text.length} characters, the limit is ${limits.completionChars}`);
  const out = {
    text: result.text,
    promptTokens: count(result.promptTokens),
    completionTokens: count(result.completionTokens),
    ms: count(result.ms),
  };
  if (result.json !== undefined) {
    const text = JSON.stringify(result.json);
    if (text !== undefined && text.length <= limits.completionChars) out.json = JSON.parse(text);
  }
  if (typeof result.model === 'string' && result.model) out.model = result.model.slice(0, 120);
  return out;
}

function readHello(f, limits) {
  if (f.role !== 'lender' && f.role !== 'host') fail('bad_frame', 'hello needs a role');
  const out = { t: 'hello', v: Number.isInteger(f.v) ? f.v : 0, role: f.role, label: str(f.label, limits.labelChars) || (f.role === 'lender' ? 'friend' : 'host') };
  if (typeof f.model === 'string' && f.model) out.model = f.model.slice(0, 120);
  if (Number.isFinite(f.ctx) && f.ctx > 0) out.ctx = count(f.ctx);
  if (f.limits && typeof f.limits === 'object') {
    out.limits = {};
    for (const k of ['perMinute', 'promptChars', 'maxTokens']) if (Number.isFinite(f.limits[k]) && f.limits[k] > 0) out.limits[k] = count(f.limits[k]);
  }
  return out;
}

/** Turns a frame object into normalized form, or throws a FrameError. */
export function normalizeFrame(f, limits = LIMITS) {
  if (!f || typeof f !== 'object' || Array.isArray(f) || !TYPES.has(f.t)) fail('bad_frame', 'Unknown frame');
  switch (f.t) {
    case 'hello':
      return readHello(f, limits);
    case 'confirm':
      return { t: 'confirm' };
    case 'req':
      return { t: 'req', id: checkId(f.id), messages: readMessages(f.messages, limits), options: readOptions(f.options, limits) };
    case 'tok':
      return { t: 'tok', id: checkId(f.id), text: str(f.text, limits.tokenChars) };
    case 'res':
      if (f.ok === true) return { t: 'res', id: checkId(f.id), ok: true, result: readResult(f.result, limits) };
      return { t: 'res', id: checkId(f.id), ok: false, error: { code: str(f.error?.code, 40) || 'failed', message: str(f.error?.message, 400) || 'The friend could not answer' } };
    case 'cancel':
      return { t: 'cancel', id: checkId(f.id) };
    case 'stop':
      return { t: 'stop', reason: str(f.reason, 200) || 'stopped' };
  }
  return fail('bad_frame', 'Unknown frame');
}

/** Parses one received text message. Checks the size before parsing anything. */
export function decodeFrame(text, limits = LIMITS) {
  if (typeof text !== 'string') fail('bad_frame', 'Frames are text');
  if (text.length > limits.frameBytes || utf8Length(text) > limits.frameBytes) fail('too_big', `A frame may be at most ${limits.frameBytes} bytes`);
  let f;
  try {
    f = JSON.parse(text);
  } catch {
    fail('bad_json', 'A frame is not valid JSON');
  }
  return normalizeFrame(f, limits);
}

/** Normalizes and serializes a frame to send. Throws a FrameError when it breaks a limit. */
export function encodeFrame(frame, limits = LIMITS) {
  const text = JSON.stringify(normalizeFrame(frame, limits));
  if (utf8Length(text) > limits.frameBytes) fail('too_big', `A frame may be at most ${limits.frameBytes} bytes`);
  return text;
}

/** Characters of prompt in a request, for the log and the rate limiter. */
export const promptChars = (messages) => messages.reduce((n, m) => n + m.content.length, 0);
