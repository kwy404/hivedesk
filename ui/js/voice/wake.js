// The wake word: "Mel" at the start of a short sentence ("Mel", "hey Mel, open the files"). The
// phrases come from voice.lex.wake of the language (and English), so each language has its own
// greeting ("oi Mel", "メル"). What follows the wake word is the command itself.
import { fold, isCjk, phrases } from './intents.js';

/**
 * @param {string} text  what speech to text heard in a short turn
 * @param {(key: string) => string} t
 * @param {string} lang
 * @returns {{ hit: boolean, rest: string }}
 */
export function matchWake(text, t, lang) {
  const f = fold(text);
  if (!f) return { hit: false, rest: '' };
  const cjk = isCjk(lang);
  const list = [...new Set([...phrases(t, 'voice.lex.wake'), 'mel', 'hey mel'])].sort((a, b) => b.length - a.length);
  if (cjk) {
    const s = f.replace(/\s/g, '');
    for (const p of list) {
      const q = p.replace(/\s/g, '');
      const i = s.indexOf(q);
      if (i >= 0 && i <= 3) return { hit: true, rest: s.slice(i + q.length).trim() };
    }
    return { hit: false, rest: '' };
  }
  const words = f.split(' ');
  for (const p of list) {
    const pw = p.split(' ');
    // the wake phrase within the first three words
    for (let i = 0; i <= Math.min(2, words.length - pw.length); i++) {
      if (pw.every((w, k) => words[i + k] === w)) {
        const restWords = words.slice(i + pw.length);
        // keep the original casing of the command: cut the same number of words from the raw text
        const raw = String(text).trim().split(/\s+/);
        const rest = raw.slice(raw.length - restWords.length).join(' ').replace(/^[,.!?;:\s]+/, '');
        return { hit: true, rest: restWords.length ? rest : '' };
      }
    }
  }
  return { hit: false, rest: '' };
}
