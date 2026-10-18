// Voice intents: what Mel understood from one spoken sentence. Pure functions, no DOM, so the
// same code runs in the browser and in the unit tests.
//
// The words come from i18n (voice.lex.* and voice.win.*), as alternatives separated by "|",
// so every language has its own natural phrasing. Matching works on folded text: lower case,
// no accents, punctuation as spaces. CJK languages match substrings (no spaces between words).

export const WINDOWS = ['timeline', 'chat', 'files', 'preview', 'runlog', 'playbooks', 'replay', 'approvals', 'settings', 'lend', 'brief', 'editor', 'library', 'memory'];

/** Lower case, accents removed, punctuation turned into spaces, spaces collapsed. */
export function fold(text) {
  return String(text || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[-.,!?;:"'()[\]{}、。！？，「」‘’“”¿¡]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const isCjk = (lang) => /^(ja|ko|zh)/i.test(lang || '');

/** The alternatives of a lexicon entry, folded, longest first. */
export function phrases(t, key) {
  const raw = t(key);
  if (!raw || raw === key) return [];
  return raw.split('|').map((p) => fold(p)).filter(Boolean).sort((a, b) => b.length - a.length);
}

function findPhrase(text, list, cjk) {
  for (const p of list) {
    if (cjk) { const i = text.indexOf(p); if (i >= 0) return { p, i }; continue; }
    const i = ` ${text} `.indexOf(` ${p} `);
    if (i >= 0) return { p, i };
  }
  return null;
}

/** Removes every occurrence of the phrases and returns what is left (folded). */
function strip(text, lists, cjk) {
  let s = cjk ? text : ` ${text} `;
  for (const list of lists) {
    for (const p of list) {
      if (cjk) s = s.split(p).join(' ');
      else { let prev; do { prev = s; s = s.replace(` ${p} `, ' '); } while (s !== prev); }
    }
  }
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * A short, pure answer: "yes", "no" or null. A yes inside a longer sentence ("yes, but first
 * tell me the status") is NOT a yes: only the yes words plus filler words may be said.
 */
export function yesNo(text, t, lang) {
  const f = fold(text);
  if (!f) return null;
  const cjk = isCjk(lang);
  const yes = phrases(t, 'voice.lex.yes');
  const no = phrases(t, 'voice.lex.no');
  const filler = phrases(t, 'voice.lex.filler');
  const words = cjk ? f.replace(/\s/g, '').length : f.split(' ').length;
  if (cjk ? words > 12 : words > 5) return null;
  const hasNo = findPhrase(f, no, cjk);
  // a no phrase may contain a yes word ("bu shi" contains "shi"): read the no words first
  const afterNo = hasNo ? strip(f, [no], cjk) : f;
  const hasYes = findPhrase(afterNo, yes, cjk);
  if (!hasNo && !hasYes) return null;
  const rest = strip(afterNo, [yes, filler], cjk);
  if (cjk ? rest.replace(/\s/g, '').length > 1 : rest.length > 0) return null;
  if (hasNo && hasYes) return null; // "yes, no": not clear
  return hasYes ? 'yes' : 'no';
}

/**
 * Parses one sentence into an intent:
 *   { kind: 'yes'|'no'|'end'|'stop'|'connect'|'share'|'git'|'approve'|'reject'|'status'|'open'|'help'|'build'|'unknown', window?, request?, address?, resource?, person?, text }
 * @param {string} text
 * @param {(key: string) => string} t  translate function for the current language
 * @param {string} lang  locale code
 */
export function parseIntent(text, t, lang) {
  const raw = String(text || '').trim();
  const f = fold(raw);
  const cjk = isCjk(lang);
  const out = (kind, extra = {}) => ({ kind, text: raw, ...extra });
  if (!f) return out('unknown');
  const yn = yesNo(raw, t, lang);
  if (yn) return out(yn);
  const has = (key) => findPhrase(f, phrases(t, key), cjk);
  const short = (n) => (cjk ? f.replace(/\s/g, '').length <= n * 2 : f.split(' ').length <= n);
  // "that is all", "goodbye": the end of the conversation
  if (has('voice.lex.end') && short(5)) return out('end');
  if (has('voice.lex.stop') && (cjk ? f.replace(/\s/g, '').length <= 8 : f.split(' ').length <= 3)) return out('stop');
  // "connect to 123 456 7890": a remote desktop address has ten digits
  const digits = raw.replace(/\D/g, '');
  if (has('voice.lex.connect') && digits.length === 10) return out('connect', { address: digits });
  // "share my GPU with Ana"
  const share = has('voice.lex.share');
  if (share) {
    const resource = has('voice.lex.gpu') ? 'gpu' : has('voice.lex.cpu') ? 'cpu' : null;
    if (resource) {
      const w = findPhrase(f, phrases(t, 'voice.lex.with'), cjk);
      const after = w ? (cjk ? f.slice(w.i + w.p.length) : ` ${f} `.slice(w.i + w.p.length + 2)).trim() : '';
      const person = strip(after, [phrases(t, 'voice.lex.filler')], cjk).split(' ').slice(0, 3).join(' ');
      return out('share', { resource, person });
    }
  }
  if (has('voice.lex.git')) return out('git');
  if (has('voice.lex.approve')) return out('approve');
  if (has('voice.lex.reject')) return out('reject');
  if (has('voice.lex.status')) return out('status');
  if (has('voice.lex.help')) return out('help');
  const opener = has('voice.lex.open');
  if (opener) {
    for (const w of WINDOWS) if (has(`voice.win.${w}`)) return out('open', { window: w });
  }
  const build = has('voice.lex.build');
  if (build) return out('build', { request: raw.replace(/[\s.]+$/, '') });
  const words = cjk ? f.replace(/\s/g, '').length / 2 : f.split(' ').length;
  // a long sentence without a build word: maybe a request (the engine decides when it can)
  if (words >= 5) return out('build', { request: raw, guess: true });
  return out('unknown');
}
