import { siteKey, cleanNote } from './src/notes.js';

const site = document.getElementById('site');
const note = document.getElementById('note');
const status = document.getElementById('status');
let key = null;

async function start() {
  // activeTab: the popup may read the URL of the tab the user clicked on, nothing else.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  key = siteKey(tab?.url || '');
  if (!key) {
    site.textContent = 'this page';
    note.disabled = true;
    status.textContent = 'Notes work on http and https pages.';
    return;
  }
  site.textContent = new URL(tab.url).hostname;
  const saved = await chrome.storage.local.get(key);
  note.value = saved[key] || '';
}

document.getElementById('save').addEventListener('click', async () => {
  if (!key) return;
  try {
    await chrome.storage.local.set({ [key]: cleanNote(note.value) });
    await chrome.runtime.sendMessage({ type: 'note-saved', key });
    status.textContent = 'Saved.';
  } catch (err) {
    status.textContent = `Could not save: ${err.message}`;
  }
});

start().catch((err) => { status.textContent = `Could not load: ${err.message}`; });
