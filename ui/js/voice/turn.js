// The turn state machine of conversation mode. Pure: (state, event) -> { state, effects }, so the
// whole loop (listen, end of turn, think, speak, barge in, follow up, end) is unit tested without a
// microphone. The controller (conversation.js) runs the effects.
//
// States
//   off           nothing listens
//   dormant       the microphone waits for the wake word "Mel" (only when the user turned it on)
//   listening     waiting for the user to speak (a follow up needs no tap)
//   hearing       the user is speaking
//   transcribing  speech to text of the turn
//   thinking      Mel works on the answer
//   speaking      Mel speaks (the user can talk over her: barge in)
//
// Effects (strings or [name, arg]): mic.on, mic.off, stt [audio], stt.cancel, stt.hold, handle [text],
// speech.stop, reply.cancel, followup.arm, followup.clear, chime.open, chime.close, wake.check [audio]

export const STATES = ['off', 'dormant', 'listening', 'hearing', 'transcribing', 'thinking', 'speaking'];

/** Where the loop rests when a conversation ends: waiting for the wake word, or off. */
const rest = (ctx) => (ctx.wake ? 'dormant' : 'off');

/**
 * @param {string} state
 * @param {{ type: string, audio?: any, text?: string, rest?: string }} ev
 * @param {{ handsFree?: boolean, wake?: boolean, muted?: boolean, inFlight?: boolean }} ctx
 * @returns {{ state: string, effects: any[] }}
 */
export function step(state, ev, ctx = {}) {
  const handsFree = ctx.handsFree !== false;
  const out = (s, ...effects) => ({ state: s, effects });
  const stopAll = ['speech.stop', 'reply.cancel', 'followup.clear'];
  switch (ev.type) {
    case 'open':
      // a tap or the shortcut: talk now (also from the wake word wait)
      if (state === 'off' || state === 'dormant') return out('listening', ...(state === 'off' ? ['mic.on'] : []), 'chime.open', 'followup.arm');
      if (state === 'speaking' || state === 'thinking') return out('listening', ...stopAll, 'followup.arm');
      return out(state);
    case 'close': {
      // the end: a tap on the orb, Esc, "that is all"; with the wake word on, the mic waits for "Mel" again
      if (state === 'off') return out('off');
      const r = rest(ctx);
      return out(r, ...stopAll, 'stt.cancel', 'chime.close', ...(r === 'off' ? ['mic.off'] : []));
    }
    case 'disable':
      return out('off', ...stopAll, 'stt.cancel', 'mic.off');
    case 'wake':
      if (state !== 'dormant') return out(state);
      if (ev.rest) return out('thinking', 'chime.open', ['handle', ev.rest]);
      return out('listening', 'chime.open', 'followup.arm');
    case 'ptt.down':
      // push to talk: the user is speaking from the press on
      if (state === 'speaking' || state === 'thinking') return out('hearing', ...stopAll, ...(state === 'off' ? ['mic.on'] : []));
      if (state === 'off') return out('hearing', 'mic.on');
      return out('hearing', 'followup.clear');
    case 'speech.start':
      if (ctx.muted) return out(state);
      if (state === 'listening') return out('hearing', 'followup.clear');
      // barge in: Mel stops at once and listens
      if (state === 'speaking' || state === 'thinking') return out('hearing', ...stopAll);
      // the pause was not the end of the turn: what was said so far joins what comes next
      if (state === 'transcribing') return out('hearing', 'stt.hold');
      return out(state);
    case 'speech.end':
    case 'ptt.up':
      if (state === 'hearing') return out('transcribing', ['stt', ev.audio]);
      if (state === 'dormant' && ev.type === 'speech.end') return out('dormant', ['wake.check', ev.audio]);
      return out(state);
    case 'transcript': {
      if (state !== 'transcribing') return out(state);
      const text = String(ev.text || '').trim();
      if (!text) return handsFree ? out('listening', 'followup.arm') : out(rest(ctx), ...(rest(ctx) === 'off' ? ['mic.off'] : []));
      return out('thinking', ['handle', text]);
    }
    case 'speak.start':
      // Mel's voice started (an answer, a read back, the next question)
      if (state === 'thinking' || state === 'listening') return out('speaking', 'followup.clear');
      return out(state);
    case 'speak.end':
      // she is quiet again: listen for the follow up, or wait for the turn that is still running
      if (state !== 'speaking') return out(state);
      if (ctx.inFlight) return out('thinking');
      if (handsFree) return out('listening', 'followup.arm');
      return out(rest(ctx), ...(rest(ctx) === 'off' ? ['mic.off'] : []));
    case 'turn.done':
      // the turn is over (said, or now waiting for a yes): a follow up needs no tap in hands free mode
      if (state !== 'thinking') return out(state);
      if (handsFree) return out('listening', 'followup.arm');
      return out(rest(ctx), ...(rest(ctx) === 'off' ? ['mic.off'] : []));
    case 'followup.timeout':
      if (state !== 'listening') return out(state);
      return out(rest(ctx), 'chime.close', ...(rest(ctx) === 'off' ? ['mic.off'] : []));
    case 'error':
      if (state === 'off' || state === 'dormant') return out(state);
      return handsFree ? out('listening', 'followup.arm') : out(rest(ctx), ...(rest(ctx) === 'off' ? ['mic.off'] : []));
    default:
      return out(state);
  }
}

/** The orb's look for a state: idle, listening, thinking or speaking. */
export function phaseOf(state) {
  if (state === 'listening' || state === 'hearing') return 'listening';
  if (state === 'transcribing' || state === 'thinking') return 'thinking';
  if (state === 'speaking') return 'speaking';
  if (state === 'dormant') return 'dormant';
  return 'idle';
}
