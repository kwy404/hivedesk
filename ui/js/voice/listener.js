// A thin wrapper over the Web Speech API recognizer (SpeechRecognition). The constructor is
// injected, so the unit tests pass a mock and the browser passes the real one.

/** BCP 47 tags the recognizer and the voices understand best for each UI locale. */
export const SPEECH_LANG = { en: 'en-US', 'pt-BR': 'pt-BR', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', it: 'it-IT', ja: 'ja-JP', ko: 'ko-KR', 'zh-CN': 'zh-CN', ru: 'ru-RU' };

export const speechLang = (code) => SPEECH_LANG[code] || code || 'en-US';

/** The browser's recognizer constructor, or null. */
export function recognizerClass(g = globalThis) {
  return g.SpeechRecognition || g.webkitSpeechRecognition || null;
}

/**
 * @param {Function} Recognition  a SpeechRecognition constructor
 * @param {{ lang: string, onInterim?: (text: string) => void, onFinal?: (text: string) => void,
 *   onStart?: () => void, onEnd?: () => void, onError?: (code: string) => void, onSound?: (on: boolean) => void }} o
 */
export function createListener(Recognition, o) {
  let rec = null;
  let finalText = '';
  let interimText = '';
  let active = false;

  function start() {
    if (active) return;
    rec = new Recognition();
    rec.lang = o.lang;
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    finalText = '';
    interimText = '';
    rec.onstart = () => { active = true; o.onStart?.(); };
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex ?? 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      interimText = interim;
      o.onInterim?.((finalText + interim).trim());
    };
    rec.onspeechstart = () => o.onSound?.(true);
    rec.onspeechend = () => o.onSound?.(false);
    rec.onerror = (e) => o.onError?.(e.error || 'error');
    rec.onend = () => {
      active = false;
      // released before the recognizer marked the last words final: keep them
      const text = (finalText || interimText).trim();
      finalText = '';
      interimText = '';
      o.onEnd?.();
      if (text) o.onFinal?.(text);
    };
    active = true;
    rec.start();
  }

  /** Stops listening and keeps what was said (push to talk released). */
  function stop() { if (rec && active) rec.stop(); }
  /** Stops and drops what was said. */
  function abort() { if (rec && active) { finalText = ''; interimText = ''; rec.abort(); } }

  return { start, stop, abort, get active() { return active; } };
}
