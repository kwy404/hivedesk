// Splits a streamed answer into sentences, so Mel starts speaking the first one while the model is
// still writing the rest. Works for spaced scripts (". ! ?" followed by a space) and for Chinese and
// Japanese (。！？ need no space). A number like 3.5 or a short "e.g." does not end a sentence.

const END = /([.!?…]+["')\]»”]*)(\s+)|([。！？；]+["」』）]*)|(\n+)/g;

/** Cleans text for speaking: no Markdown marks, no code fences, no URLs read letter by letter. */
export function speakable(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[*_#>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {(sentence: string) => void} onSentence
 * @param {{ minChars?: number }} [o]  a fragment shorter than this waits for more text
 */
export function createChunker(onSentence, { minChars = 12 } = {}) {
  let buf = '';
  function drain(final) {
    let start = 0;
    END.lastIndex = 0;
    let m;
    while ((m = END.exec(buf))) {
      const cut = m.index + m[0].length;
      const piece = buf.slice(start, cut);
      if (speakable(piece).length >= minChars || /[。！？]/.test(piece)) {
        const s = speakable(piece);
        if (s) onSentence(s);
        start = cut;
      }
    }
    buf = buf.slice(start);
    if (final) {
      const s = speakable(buf);
      buf = '';
      if (s) onSentence(s);
    }
  }
  return {
    push(text) { buf += String(text || ''); drain(false); },
    /** The stream ended: speak what is left. */
    flush() { drain(true); },
    reset() { buf = ''; },
  };
}

/** All sentences of a finished text (for replies that did not stream). */
export function sentencesOf(text) {
  const out = [];
  const c = createChunker((s) => out.push(s));
  c.push(text);
  c.flush();
  return out;
}
