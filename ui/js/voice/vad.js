// Voice activity detection and end of turn detection on the microphone level. Pure: frames of
// samples in, "start" and "end" out, so it is unit tested with synthetic audio.
//
// The noise floor follows the room while nobody speaks; speech is a level clearly above it for a
// short while. The turn ends after a pause (hangMs). While Mel is speaking the bar is higher and
// longer (bargeIn), so her own voice leaking from the speakers does not cut her off.

/** RMS level of a frame in dBFS (-100 for silence). */
export function levelDb(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  const rms = Math.sqrt(sum / Math.max(1, frame.length));
  return rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
}

/**
 * @param {{ rate?: number, marginDb?: number, minDb?: number, minSpeechMs?: number, hangMs?: number, maxTurnMs?: number, bargeMarginDb?: number, bargeMinMs?: number }} [o]
 */
export function createVad(o = {}) {
  const c = { rate: 16000, marginDb: 10, minDb: -52, minSpeechMs: 120, hangMs: 750, maxTurnMs: 30000, bargeMarginDb: 18, bargeMinMs: 260, ...o };
  let floor = -60;
  let speaking = false;
  let above = 0;      // ms above the bar in a row
  let below = 0;      // ms below the bar in a row, during speech
  let turnMs = 0;
  let barge = false;  // Mel is talking: harder to start

  function bar() {
    const margin = barge ? c.bargeMarginDb : c.marginDb;
    return Math.max(floor + margin, c.minDb + (barge ? 14 : 0));
  }

  /**
   * @param {Float32Array | number[]} frame
   * @returns {'start' | 'end' | 'max' | null}
   */
  function push(frame) {
    const ms = (frame.length / c.rate) * 1000;
    const db = levelDb(frame);
    const loud = db > bar();
    if (!speaking) {
      if (loud) {
        above += ms;
        if (above >= (barge ? c.bargeMinMs : c.minSpeechMs)) { speaking = true; below = 0; turnMs = above; return 'start'; }
      } else {
        above = 0;
        // the floor follows the room slowly, faster when it gets quieter
        const k = db < floor ? 0.2 : 0.03;
        floor = Math.min(-25, floor + (db - floor) * k);
      }
      return null;
    }
    turnMs += ms;
    if (loud) below = 0; else below += ms;
    if (below >= c.hangMs) { speaking = false; above = 0; return 'end'; }
    if (turnMs >= c.maxTurnMs) { speaking = false; above = 0; return 'max'; }
    return null;
  }

  return {
    push,
    /** Mel is speaking (true) or quiet (false). */
    setBargeIn(on) { barge = !!on; },
    /** Ends a turn now (push to talk released). */
    reset() { speaking = false; above = 0; below = 0; turnMs = 0; },
    get speaking() { return speaking; },
    get floor() { return floor; },
    get config() { return { ...c }; },
  };
}
