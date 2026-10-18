// Conversation mode: the hands free loop around the turn state machine (turn.js). It feeds the
// microphone through voice activity detection, sends each finished turn to speech to text, gives
// the text to the voice session, lets Mel speak, and stops her at once when the user talks over her.
// Every dependency is injected, so the loop and barge in are unit tested without a browser.
import { step, phaseOf } from './turn.js';
import { createVad } from './vad.js';
import { createRecorder, STT_RATE } from './audio.js';

/**
 * @param {{
 *   mic: { start: () => Promise<void>, stop: () => void, setMuted?: (on: boolean) => void },
 *   stt: (audio: Float32Array, o: { signal: AbortSignal, wake?: boolean }) => Promise<string>,
 *   session: { turn: (text: string) => Promise<any>, question?: (card: any) => Promise<any> },
 *   speaker: { stop: () => void, busy: boolean },
 *   wake?: (text: string) => { hit: boolean, rest: string },
 *   cancelReply?: () => void,
 *   chime?: (kind: 'open' | 'close') => void,
 *   onState?: (state: string, phase: string) => void,
 *   onError?: (err: any) => void,
 *   prefs: () => { handsFree: boolean, wake: boolean },
 *   followupMs?: number,
 *   vad?: object,
 *   setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout,
 * }} o
 */
export function createConversation(o) {
  let state = 'off';
  let muted = false;
  let inFlight = 0;
  let turnSeq = 0;
  let sttCtrl = null;
  let sttText = null;  // the text promise of the turn being transcribed
  let held = null;     // an earlier part of the same turn (the user went on talking)
  let followTimer = null;
  const setT = o.setTimer || setTimeout;
  const clearT = o.clearTimer || clearTimeout;
  const vad = createVad(o.vad);
  const rec = createRecorder();

  const ctx = () => { const p = o.prefs(); return { handsFree: p.handsFree !== false, wake: !!p.wake, muted, inFlight: inFlight > 0 }; };

  function dispatch(ev) {
    const prev = state;
    const r = step(state, ev, ctx());
    state = r.state;
    for (const fx of r.effects) run(fx, ev);
    if (state !== prev) o.onState?.(state, phaseOf(state));
    return state;
  }

  function run(fx) {
    const [name, arg] = Array.isArray(fx) ? fx : [fx];
    switch (name) {
      case 'mic.on':
        o.mic.start().catch((err) => { o.onError?.(err); dispatch({ type: 'disable' }); });
        break;
      case 'mic.off':
        o.mic.stop();
        vad.reset();
        break;
      case 'stt': {
        const audio = arg || new Float32Array(0);
        sttCtrl?.abort();
        const ctrl = new AbortController();
        sttCtrl = ctrl;
        const before = held;
        held = null;
        // the text of this part, after the text of the part before it (if the user paused and went on)
        const p = o.stt(audio, { signal: ctrl.signal }).then(async (text) => [before ? await before.catch(() => '') : '', text].map((x) => String(x || '').trim()).filter(Boolean).join(' '));
        sttText = p;
        p.then((text) => { if (sttCtrl === ctrl) { sttCtrl = null; sttText = null; dispatch({ type: 'transcript', text }); } })
          .catch((err) => { if (ctrl.signal.aborted || sttCtrl !== ctrl) return; sttCtrl = null; sttText = null; o.onError?.(err); dispatch({ type: 'error' }); });
        break;
      }
      case 'stt.hold':
        // the pause was not the end of the turn: this part keeps transcribing and joins the next one
        held = sttText;
        sttText = null;
        sttCtrl = null;
        break;
      case 'stt.cancel':
        sttCtrl?.abort();
        sttCtrl = null;
        sttText = null;
        held = null;
        break;
      case 'handle':
        handle((s) => o.session.turn(s), arg);
        break;
      case 'speech.stop':
        o.speaker.stop();
        break;
      case 'reply.cancel':
        o.cancelReply?.();
        break;
      case 'followup.arm':
        clearT(followTimer);
        followTimer = setT(() => dispatch({ type: 'followup.timeout' }), o.followupMs ?? 12000);
        break;
      case 'followup.clear':
        clearT(followTimer);
        followTimer = null;
        break;
      case 'chime.open': case 'chime.close':
        o.chime?.(name === 'chime.open' ? 'open' : 'close');
        break;
      case 'wake.check': {
        const audio = arg;
        // only short sentences can be the wake word; long talk in the room is ignored
        if (!o.wake || !audio || audio.length > STT_RATE * 4) break;
        const ctrl = new AbortController();
        o.stt(audio, { signal: ctrl.signal, wake: true }).then((text) => {
          const w = o.wake(text);
          if (w.hit && state === 'dormant') dispatch({ type: 'wake', rest: w.rest });
        }).catch(() => {});
        break;
      }
      default:
    }
  }

  function handle(fn, arg) {
    const id = ++turnSeq;
    inFlight++;
    Promise.resolve().then(() => fn(arg)).catch((err) => o.onError?.(err)).finally(() => {
      inFlight--;
      if (id === turnSeq) dispatch({ type: 'turn.done' });
    });
  }

  /** A block of 16 kHz microphone samples. */
  function frame(samples) {
    if (state === 'off' || muted) return;
    rec.push(samples);
    vad.setBargeIn(o.speaker.busy);
    const ev = vad.push(samples);
    if (ev === 'start') {
      rec.begin();
      o.onSpeechStart?.(state);
      dispatch({ type: 'speech.start' });
    } else if (ev === 'end' || ev === 'max') {
      const audio = rec.end();
      dispatch({ type: 'speech.end', audio });
    }
  }

  return {
    frame,
    dispatch,
    /** A tap, the shortcut or a click on the orb. */
    open: () => dispatch({ type: 'open' }),
    close: () => dispatch({ type: 'close' }),
    toggle: () => dispatch({ type: state === 'off' || state === 'dormant' ? 'open' : 'close' }),
    /** Wake word on or off: the mic waits for "Mel" or turns off. */
    rest: () => { const c = ctx(); if (c.wake && state === 'off') { o.mic.start().catch((err) => o.onError?.(err)); state = 'dormant'; o.onState?.(state, phaseOf(state)); } else if (!c.wake && state === 'dormant') dispatch({ type: 'disable' }); },
    disable: () => dispatch({ type: 'disable' }),
    /** Push to talk: pressed and released. */
    pttDown: () => { if (state === 'off') { dispatch({ type: 'ptt.down' }); rec.begin(); return; } rec.begin(); vad.reset(); dispatch({ type: 'ptt.down' }); },
    pttUp: () => { if (state !== 'hearing') return; vad.reset(); dispatch({ type: 'ptt.up', audio: rec.end() }); },
    /** Typed or clicked text handled like a spoken turn. */
    say: (text) => { if (state === 'off' || state === 'dormant') return o.session.turn(text); dispatch({ type: 'speech.start' }); state = 'thinking'; handle((s) => o.session.turn(s), text); o.onState?.(state, phaseOf(state)); return null; },
    /** Mel has something to say by herself (a question card): only while the conversation is open. */
    announce: (fn) => {
      if (state === 'off' || state === 'dormant') return false;
      if (state === 'listening') { state = 'thinking'; o.onState?.(state, phaseOf(state)); run('followup.clear'); }
      handle(fn);
      return true;
    },
    speakStart: () => dispatch({ type: 'speak.start' }),
    speakEnd: () => dispatch({ type: 'speak.end' }),
    mute: (on) => { muted = !!on; o.mic.setMuted?.(muted); if (muted && state === 'hearing') { rec.end(); vad.reset(); dispatch({ type: 'error' }); } },
    get state() { return state; },
    get phase() { return phaseOf(state); },
    get muted() { return muted; },
    get inFlight() { return inFlight; },
  };
}
