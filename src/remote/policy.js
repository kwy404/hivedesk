// Rules of remote desktop (docs/1.0/PLAN.md section 12.1), as pure functions so they are table tested.

export const CAP_VIEW = 'remote.view';
export const CAP_CONTROL = 'remote.control';
export const CAP_CLIP = 'clipboard.text';
export const CAP_FILE = 'file.send';
export const REMOTE_CAPS = [CAP_VIEW, CAP_CONTROL, CAP_CLIP, CAP_FILE];

/** Grant lengths the host may pick, in minutes. Never standing. */
export const DURATIONS = [5, 15, 60];
export const DEFAULT_MINUTES = 15;

export const MAX_EVENTS_PER_SECOND = 120;
export const MAX_EVENTS_PER_MESSAGE = 240;
export const MAX_CLIP_BYTES = 64 * 1024;
/** Lock state older than this is treated as unknown, and unknown means locked. */
export const LOCK_FRESH_MS = 3000;
/** Control input is summarized in the audit log once per burst window. */
export const BURST_MS = 5000;
export const HOTKEY = 'Ctrl+Alt+Shift+K';

/** Clipboard directions a host may grant. */
export const CLIP_DIRS = ['off', 'to_viewer', 'to_host', 'both'];
/** A request waits this long for the host's click, then counts as declined. */
export const REQUEST_MS = 60_000;

/**
 * The answer of the host dialog, cleaned. Every permission is off unless its box was ticked, and a box
 * only counts for something the peer asked for. Accept with neither view nor control ticked grants nothing.
 * An agent never gets control, clipboard or files, whatever the click says.
 */
export function decideAnswer(request, answer) {
  const minutes = DURATIONS.includes(Number(answer?.minutes)) ? Number(answer.minutes) : DEFAULT_MINUTES;
  const asks = request.asks || {};
  const peer = !request.agentId;
  const control = peer && request.wants === 'control' && answer?.control === true && answer?.allow === true;
  const allow = answer?.allow === true && (answer?.view === true || control);
  let clip = answer?.clipboard === true ? 'both' : CLIP_DIRS.includes(answer?.clipboard) ? answer.clipboard : 'off';
  if (!allow || !peer || !asks.clipboard) clip = 'off';
  return {
    allow,
    minutes,
    mode: allow && control ? 'control' : 'view',
    clipboard: clip,
    files: allow && peer && !!asks.files && answer?.files === true
  };
}

/** True when clipboard content may flow from this side under a direction granted by the host. */
export function clipAllows(dir, from) {
  if (dir === 'both') return true;
  return from === 'host' ? dir === 'to_viewer' : from === 'viewer' ? dir === 'to_host' : false;
}

/** Quality presets the viewer can pick; the host window applies them (ui/remote/abr.js). */
export const QUALITY = ['auto', 'balanced', 'quality', 'speed'];

/** True when the grant exists, is not revoked and has not expired at `now` (ms). A remote grant without expiry is invalid. */
export function grantLive(grant, now) {
  if (!grant || grant.revokedAt) return false;
  if (grant.scope !== 'session' || !grant.expiresAt) return false;
  const exp = Date.parse(grant.expiresAt);
  return Number.isFinite(exp) && exp > now;
}

/** The capability names that let a peer see the screen. Control implies view. */
export const viewNames = [CAP_VIEW, CAP_CONTROL];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Cleans one input event from the wire. Unknown kinds, bad numbers and unknown fields are dropped.
 * @returns {import('./types.js').InputEvent | null}
 */
export function normalizeEvent(e) {
  if (!e || typeof e !== 'object') return null;
  const ev = normalizeOne(e);
  // d: which shared screen (track) a pointer event is on, 0 to 3. Missing means the first.
  if (ev && ev.k === 'move' && Number.isInteger(e.d) && e.d > 0 && e.d < 4) ev.d = e.d;
  return ev;
}

function normalizeOne(e) {
  switch (e.k) {
    case 'move': return isNum(e.x) && isNum(e.y) ? { k: 'move', x: clamp01(e.x), y: clamp01(e.y) } : null;
    case 'btn': return [0, 1, 2].includes(e.b) && typeof e.down === 'boolean' ? { k: 'btn', b: e.b, down: e.down } : null;
    case 'wheel': {
      if (!isNum(e.dx) || !isNum(e.dy)) return null;
      const c = (v) => Math.max(-1200, Math.min(1200, Math.round(v)));
      return { k: 'wheel', dx: c(e.dx), dy: c(e.dy) };
    }
    case 'key': return typeof e.code === 'string' && e.code.length <= 24 && typeof e.down === 'boolean' ? { k: 'key', code: e.code, down: e.down } : null;
    default: return null;
  }
}

/** A token bucket: `rate` events per second, a burst of `rate`. */
export class Bucket {
  constructor(rate = MAX_EVENTS_PER_SECOND, now = () => Date.now()) {
    this.rate = rate;
    this.now = now;
    this.tokens = rate;
    this.at = now();
  }

  take(n = 1) {
    const t = this.now();
    this.tokens = Math.min(this.rate, this.tokens + ((t - this.at) / 1000) * this.rate);
    this.at = t;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

/** Picks the display that matches the captured track size (within 2 percent), or null when it is not clear. */
export function pickDisplay(displays, width, height) {
  if (!Array.isArray(displays) || !displays.length) return null;
  if (displays.length === 1) return 0;
  if (!(width > 0 && height > 0)) return null;
  const close = (a, b) => Math.abs(a - b) / b <= 0.02;
  const hits = displays.map((d, i) => (close(width, d.w) && close(height, d.h) ? i : -1)).filter((i) => i >= 0);
  return hits.length === 1 ? hits[0] : null;
}

/** Maps a normalized point on display `d` to virtual desktop pixels. */
export function toPixels(d, x, y) {
  return { px: Math.round(d.x + x * Math.max(0, d.w - 1)), py: Math.round(d.y + y * Math.max(0, d.h - 1)) };
}

/** A capability in plain words for the host dialog (i18n keys of i18n/parts/s6-remote.en.json). */
export function capabilityKey(wants) {
  return wants === 'control' ? 'remote.ask.control' : 'remote.ask.view';
}
