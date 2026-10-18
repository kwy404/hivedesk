// The service worker: wakes up for events only, keeps no state in variables (it can stop at any time).
import { siteKey, badgeFor } from './src/notes.js';

async function updateBadge(tabId, url) {
  const key = siteKey(url || '');
  const saved = key ? await chrome.storage.local.get(key) : {};
  await chrome.action.setBadgeText({ tabId, text: badgeFor(key ? saved[key] : '') });
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type !== 'note-saved') return false;
  chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => tab && updateBadge(tab.id, tab.url)).then(() => reply({ ok: true }), () => reply({ ok: false }));
  return true;
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId).then((tab) => updateBadge(tabId, tab.url)).catch(() => {});
});
