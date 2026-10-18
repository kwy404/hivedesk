// Mel's voice: a queue of sentences spoken one after the other with the system voices
// (speechSynthesis) or the local Piper voice (a WAV from the engine played with Web Audio). stop()
// silences her at once (barge in) and resolves everything that waited. Dependencies are injected,
// so the queue and barge in are unit tested with a fake synthesizer.
import { createChunker } from './sentences.js';

/**
 * @param {{
 *   engine: () => 'system' | 'piper' | 'none',
 *   synth?: { speak: (u: any) => void, cancel: () => void },
 *   Utterance?: new (text: string) => any,
 *   voice?: () => any, lang?: () => string, rate?: () => number,
 *   fetchWav?: (text: string, signal: AbortSignal) => Promise<ArrayBuffer>,
 *   audio?: () => AudioContext | null,
 *   onStart?: () => void, onIdle?: () => void, onSentence?: (s: string) => void,
 *   timeoutFor?: (text: string) => number,
 * }} o
 */
export function createSpeaker(o) {
  const queue = [];
  let current = null;   // { text, done, stop }
  let busy = false;
  let gen = 0;          // bumps on stop(): late callbacks of a stopped sentence do nothing
  const timeoutFor = o.timeoutFor || ((text) => Math.min(30000, 2500 + text.length * 110));

  function idle() {
    if (!busy) return;
    busy = false;
    o.onIdle?.();
  }

  function next() {
    if (current) return;
    const item = queue.shift();
    if (!item) { idle(); return; }
    if (!busy) { busy = true; o.onStart?.(); }
    current = item;
    const my = gen;
    const finish = () => {
      if (current !== item) return;
      current = null;
      item.done();
      if (my === gen) next();
    };
    o.onSentence?.(item.text);
    const engine = o.engine();
    if (engine === 'piper' && o.fetchWav && o.audio?.()) playPiper(item, finish);
    else if (engine !== 'none' && o.synth && o.Utterance) playSystem(item, finish);
    else finish();
  }

  function playSystem(item, finish) {
    try {
      const u = new o.Utterance(item.text);
      const v = o.voice?.();
      if (v) u.voice = v;
      u.lang = v?.lang || o.lang?.() || 'en-US';
      u.rate = o.rate?.() || 1;
      u.onend = finish;
      u.onerror = finish;
      item.stop = () => { try { o.synth.cancel(); } catch { /* ignore */ } };
      o.synth.speak(u);
      // some browsers never fire onend: do not hang the conversation
      const tm = setTimeout(finish, timeoutFor(item.text));
      const done = item.done;
      item.done = () => { clearTimeout(tm); done(); };
    } catch { finish(); }
  }

  async function playPiper(item, finish) {
    const ctrl = new AbortController();
    item.stop = () => { ctrl.abort(); try { item.src?.stop(); } catch { /* ignore */ } };
    try {
      const wav = await (item.wav || o.fetchWav(item.text, ctrl.signal));
      if (current !== item) return;
      const ctx = o.audio();
      const buf = await ctx.decodeAudioData(wav.slice ? wav.slice(0) : wav);
      if (current !== item) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(o.output?.() || ctx.destination);
      src.onended = finish;
      item.src = src;
      src.start();
      // fetch the next sentence while this one plays
      const after = queue[0];
      if (after && !after.wav) after.wav = o.fetchWav(after.text, ctrl.signal).catch(() => null);
    } catch {
      // Piper failed for this sentence: say it with the system voice instead of staying silent
      if (current === item && o.synth && o.Utterance) playSystem(item, finish);
      else finish();
    }
  }

  /** Speaks one text; resolves when it was said (or stopped). */
  function say(text) {
    const s = String(text || '').trim();
    if (!s) return Promise.resolve();
    return new Promise((resolve) => {
      queue.push({ text: s, done: resolve });
      next();
    });
  }

  /** A streamed answer: tokens in, sentences spoken as soon as each one is complete. */
  function stream() {
    const waits = [];
    const ch = createChunker((sentence) => waits.push(say(sentence)));
    return {
      push: (tok) => ch.push(tok),
      end: async () => { ch.flush(); await Promise.all(waits); },
    };
  }

  /** Silence now: the current sentence stops, the queue is dropped, every waiting promise resolves. */
  function stop() {
    gen++;
    const items = queue.splice(0);
    const cur = current;
    current = null;
    try { cur?.stop?.(); } catch { /* ignore */ }
    try { o.synth?.cancel(); } catch { /* ignore */ }
    cur?.done();
    for (const it of items) it.done();
    idle();
  }

  return { say, stream, stop, get busy() { return busy; }, get pending() { return queue.length + (current ? 1 : 0); } };
}
