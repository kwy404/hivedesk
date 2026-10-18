// The app's data: plain functions over a list, so node:test can test them without a phone or a DOM.
// Saved through a storage object (localStorage in the app, a Map in the tests).

const KEY = 'my-app.items.v1';

/** Reads the saved items; a blocked or broken storage gives an empty list. */
export function load(storage) {
  try {
    const raw = storage.getItem(KEY);
    const items = raw ? JSON.parse(raw) : [];
    return Array.isArray(items) ? items.filter((x) => x && typeof x.text === 'string') : [];
  } catch {
    return [];
  }
}

/** Saves the items; returns false when the storage is full or blocked. */
export function save(storage, items) {
  try {
    storage.setItem(KEY, JSON.stringify(items));
    return true;
  } catch {
    return false;
  }
}

export function addItem(items, text, now = Date.now()) {
  const clean = String(text || '').trim().slice(0, 200);
  if (!clean) return items;
  return [{ id: `${now.toString(36)}-${items.length}`, text: clean, createdAt: now }, ...items];
}

export function removeItem(items, id) {
  return items.filter((x) => x.id !== id);
}
