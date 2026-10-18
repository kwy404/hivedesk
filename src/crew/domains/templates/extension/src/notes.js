// The extension's logic without the browser APIs, so node:test can test it.

/** The key a note is stored under: the site (origin), not the full URL. */
export function siteKey(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? `note:${u.origin}` : null;
  } catch {
    return null;
  }
}

export function cleanNote(text) {
  return String(text ?? '').replace(/\u0000/g, '').slice(0, 2000);
}

/** The badge text: a dot when the site has a note. */
export function badgeFor(note) {
  return note && note.trim() ? '•' : '';
}
