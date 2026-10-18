// Which speech to text and which voice run a turn. Pure, unit tested.
//
// Speech to text is local by default (whisper.cpp on this computer, audio never leaves it). The
// browser's recognizer is an opt in fallback only: it is used when the user picked it AND said yes
// to the notice that the browser maker may process the audio in its cloud. Nothing falls back to
// the browser by itself.

/**
 * @param {{ engine?: 'local' | 'browser', browserOk?: boolean }} prefs
 * @param {{ localReady?: boolean, localInstalled?: { model?: boolean, runtime?: boolean }, browserAvailable?: boolean }} env
 * @returns {{ engine: 'local' | 'browser' | null, reason: null | 'needs_download' | 'needs_browser_consent' | 'browser_unsupported' }}
 */
export function chooseStt(prefs = {}, env = {}) {
  const want = prefs.engine === 'browser' ? 'browser' : 'local';
  if (want === 'browser') {
    if (!env.browserAvailable) return { engine: null, reason: 'browser_unsupported' };
    if (prefs.browserOk !== true) return { engine: null, reason: 'needs_browser_consent' };
    return { engine: 'browser', reason: null };
  }
  if (env.localReady) return { engine: 'local', reason: null };
  return { engine: null, reason: 'needs_download' };
}

/**
 * The voice for Mel's replies: Piper when the user turned it on and a voice of the language is
 * installed, the system voices (speechSynthesis) otherwise, or text only.
 * @returns {'piper' | 'system' | 'none'}
 */
export function chooseTts(prefs = {}, env = {}) {
  if (prefs.tts === 'piper' && (env.piperReady || []).includes(env.lang)) return 'piper';
  if (env.systemAvailable) return 'system';
  return 'none';
}

/**
 * What the consent dialog shows for the local speech to text: the files that are still missing
 * (the recommended model and the server build), their total size, the RAM they need.
 * @param {any} status  the result of voice.status
 * @param {{ model?: string, runtime?: string }} [pick]
 */
export function sttPlan(status, pick = {}) {
  const stt = status?.stt || {};
  const rec = stt.recommended || {};
  const model = (stt.models || []).find((m) => m.id === (pick.model || rec.model)) || null;
  const needRuntime = !stt.runtime;
  const runtime = needRuntime ? (stt.runtimes || []).find((r) => r.id === (pick.runtime || rec.runtime)) || null : null;
  const files = [model && !model.installed ? model : null, runtime && !runtime.installed ? runtime : null].filter(Boolean);
  return {
    model, runtime, files,
    bytes: files.reduce((n, f) => n + (f.bytes || 0), 0),
    possible: !!model && (!needRuntime || !!runtime),
    // macOS has no published build: a whisper-server from Homebrew is needed
    needsSystem: needRuntime && !(stt.runtimes || []).length,
  };
}

/** Speed and quality hints for the model list (honest about tiny on a slow CPU). */
export function modelHint(m, device) {
  if (!m) return null;
  if (device === 'gpu') return 'fast';
  if (m.cpuRtf <= 0.2) return 'fast';
  if (m.cpuRtf <= 0.4) return 'ok';
  return 'slow';
}
