// The app's logic without the window: what is saved and how, so node:test can test it.

export const FILE_NAME = 'notes.json';

/** The JSON text saved to disk for a note. */
export function serialize(text, now = new Date()) {
  return JSON.stringify({ version: 1, savedAt: now.toISOString(), text: String(text ?? '') }, null, 2);
}

/** The note in a saved file; a broken or foreign file gives an empty note, never an exception. */
export function parse(json) {
  try {
    const data = JSON.parse(json);
    return data && data.version === 1 && typeof data.text === 'string' ? data.text : '';
  } catch {
    return '';
  }
}

/** Word and character counts for the status line. */
export function stats(text) {
  const s = String(text || '');
  const words = s.trim() ? s.trim().split(/\s+/).length : 0;
  return { words, chars: s.length };
}
