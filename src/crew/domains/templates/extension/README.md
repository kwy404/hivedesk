# Page Notes

A Manifest V3 browser extension: a short note per website, saved with `chrome.storage.local`. It asks only for `storage` and `activeTab`, so the install dialog shows no site access warning.

## Try it

1. Open the extensions page of a Chromium based browser (for example `chrome://extensions`), turn on Developer mode and click "Load unpacked", then pick this folder.
2. Click the toolbar button (or press Ctrl+Shift+Y) on any web page and save a note.

Publishing to a browser's extension store needs a developer account there and a store review; it is not part of this project.

## Develop

- `npm test` tests the logic in `src/notes.js` and the manifest (Node 20 or newer).
- `popup.html` and `popup.js`: the popup. `background.js`: the service worker (badge).
- All code ships in the package: no remote scripts (Manifest V3 forbids them).
