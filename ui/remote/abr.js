// Adaptive bitrate for the remote screen (docs/1.0/PLAN.md section 12.2). Pure, so it is table tested.
// Up to 1080p at 30 to 60 frames per second. Text on a screen must stay sharp, so by default the encoder
// keeps the resolution (degradationPreference "maintain-resolution", contentHint "detail") and this loop
// lowers the frame rate first, then the bitrate. The quality menu picks a preset:
//   auto      300 kbps to 8 Mbps, 60 fps when the link carries 5 Mbps or more
//   balanced  up to 4 Mbps, at most 30 fps
//   quality   1.5 to 8 Mbps, at most 30 fps, never a smaller picture
//   speed     up to 3 Mbps, up to 60 fps, the picture may shrink to 720p to keep motion smooth

export const MIN_BPS = 300_000;
export const MAX_BPS = 8_000_000;
export const START_BPS = 2_500_000;

export const PRESETS = Object.freeze({
  auto: { min: MIN_BPS, max: MAX_BPS, fps: 60, degradation: 'maintain-resolution', maxScale: 1 },
  balanced: { min: MIN_BPS, max: 4_000_000, fps: 30, degradation: 'maintain-resolution', maxScale: 1 },
  quality: { min: 1_500_000, max: MAX_BPS, fps: 30, degradation: 'maintain-resolution', maxScale: 1 },
  speed: { min: MIN_BPS, max: 3_000_000, fps: 60, degradation: 'maintain-framerate', maxScale: 1.5 }
});

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Frames per second for a bitrate: fewer frames before a blurrier picture. */
export function framerateFor(bps, cap = 60) {
  const f = bps < 600_000 ? 5 : bps < 1_200_000 ? 12 : bps < 2_500_000 ? 20 : bps < 5_000_000 ? 30 : 60;
  return Math.min(f, cap);
}

/**
 * One step of the loop, run every 2 seconds from getStats().
 * @param {{ current: number, available?: number | null, loss?: number | null, preset?: string }} s
 *   current    the maxBitrate set now
 *   available  availableOutgoingBitrate of the selected candidate pair (bits per second), when known
 *   loss       fraction of packets lost reported by the receiver (remote-inbound-rtp fractionLost), 0..1
 * @returns {{ maxBitrate: number, maxFramerate: number, scale: number, degradation: string, why: string }}
 */
export function nextBitrate({ current = START_BPS, available = null, loss = null, preset = 'auto' }) {
  const p = PRESETS[preset] || PRESETS.auto;
  let target = clamp(current || START_BPS, p.min, p.max);
  let why = 'steady';
  if (loss != null && loss > 0.1) { target *= 0.7; why = 'heavy loss'; }
  else if (loss != null && loss > 0.03) { target *= 0.85; why = 'loss'; }
  else if (available != null && available > 0 && available * 0.85 < target) { target = available * 0.85; why = 'bandwidth'; }
  else if (loss == null || loss < 0.01) {
    const room = available != null && available > 0 ? available * 0.85 : p.max;
    if (room > target) { target = Math.min(room, target * 1.15); why = 'ramp up'; }
  }
  const maxBitrate = Math.round(clamp(target, p.min, p.max));
  // Speed: below 1.5 Mbps the picture shrinks (up to 1.5 times, 1080p to 720p) so the motion stays smooth.
  const scale = p.maxScale > 1 && maxBitrate < 1_500_000 ? p.maxScale : 1;
  return { maxBitrate, maxFramerate: framerateFor(maxBitrate, p.fps), scale, degradation: p.degradation, why };
}

/** Pulls the numbers nextBitrate needs out of an RTCStatsReport (a Map like object). */
export function readStats(report) {
  let available = null;
  let loss = null;
  let fps = null;
  const all = typeof report?.values === 'function' ? [...report.values()] : [];
  const pair = all.find((s) => s.type === 'candidate-pair' && (s.selected || s.nominated) && s.state === 'succeeded');
  if (pair && Number.isFinite(pair.availableOutgoingBitrate)) available = pair.availableOutgoingBitrate;
  const rin = all.find((s) => s.type === 'remote-inbound-rtp' && s.kind === 'video');
  if (rin && Number.isFinite(rin.fractionLost)) loss = rin.fractionLost;
  const out = all.find((s) => s.type === 'outbound-rtp' && s.kind === 'video');
  if (out && Number.isFinite(out.framesPerSecond)) fps = out.framesPerSecond;
  return { available, loss, fps };
}

/** Capture constraints for getDisplayMedia: a whole screen, up to 1080p and 60 fps. */
export const CAPTURE = Object.freeze({
  video: { displaySurface: 'monitor', width: { max: 1920 }, height: { max: 1080 }, frameRate: { ideal: 60, max: 60 } },
  audio: false, selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude', monitorTypeSurfaces: 'include'
});
