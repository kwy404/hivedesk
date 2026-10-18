// The microphone of conversation mode: getUserMedia with echo cancellation, noise suppression and
// gain control, 20 ms blocks through an AudioWorklet (ScriptProcessor where worklets are missing),
// resampled to 16 kHz for speech to text, and an analyser for the live waveform of the orb.
// The audio stays in this page and goes only to the engine on 127.0.0.1.
import { resample } from './audio.js';

/**
 * @param {{ onFrame: (samples16k: Float32Array, raw: Float32Array) => void }} o
 */
export function createMic(o) {
  let ctx = null;
  let stream = null;
  let node = null;
  let analyser = null;
  let muted = false;
  let starting = null;

  async function start() {
    if (ctx) return;
    if (starting) return starting;
    starting = (async () => {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.6;
      src.connect(analyser);
      const rate = ctx.sampleRate;
      const deliver = (block) => { if (!muted) o.onFrame(resample(block, rate), block); };
      try {
        await ctx.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url));
        node = new AudioWorkletNode(ctx, 'hd-capture');
        node.port.onmessage = (e) => deliver(e.data);
        src.connect(node);
      } catch {
        // older engines: ScriptProcessor (deprecated but still everywhere)
        node = ctx.createScriptProcessor(1024, 1, 1);
        node.onaudioprocess = (e) => deliver(new Float32Array(e.inputBuffer.getChannelData(0)));
        src.connect(node);
        node.connect(ctx.destination);
      }
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
      if (ctx.state === 'suspended') {
        // started without a click (the wake word after a reload): the first click or key wakes it
        const wake = () => { ctx?.resume().catch(() => {}); };
        document.addEventListener('pointerdown', wake, { once: true, capture: true });
        document.addEventListener('keydown', wake, { once: true, capture: true });
      }
    })();
    try { await starting; } catch (err) { stop(); throw err; } finally { starting = null; }
  }

  function stop() {
    try { node?.disconnect(); } catch { /* ignore */ }
    stream?.getTracks().forEach((tr) => tr.stop());
    ctx?.close().catch(() => {});
    ctx = null; stream = null; node = null; analyser = null;
  }

  return {
    start, stop,
    setMuted(on) { muted = !!on; stream?.getAudioTracks().forEach((tr) => { tr.enabled = !muted; }); },
    get muted() { return muted; },
    get on() { return !!ctx; },
    get analyser() { return analyser; },
    get context() { return ctx; },
  };
}
