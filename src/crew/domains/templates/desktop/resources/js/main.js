import { FILE_NAME, serialize, parse, stats } from './notes.js';

const note = document.getElementById('note');
const status = document.getElementById('status');
// In the desktop window Neutralino is defined; opened in a plain browser the app falls back to localStorage.
const native = typeof globalThis.Neutralino !== 'undefined';

function show(text) { status.textContent = text; }

async function dataFile() {
  const dir = `${await Neutralino.os.getPath('data')}/my-desktop-app`;
  try { await Neutralino.filesystem.createDirectory(dir); } catch { /* it exists */ }
  return `${dir}/${FILE_NAME}`;
}

async function load() {
  try {
    note.value = native ? parse(await Neutralino.filesystem.readFile(await dataFile())) : parse(localStorage.getItem(FILE_NAME) || '');
  } catch {
    note.value = '';
  }
  const s = stats(note.value);
  show(`${s.words} words`);
}

async function save() {
  try {
    const json = serialize(note.value);
    if (native) await Neutralino.filesystem.writeFile(await dataFile(), json);
    else localStorage.setItem(FILE_NAME, json);
    show(`Saved, ${stats(note.value).words} words`);
  } catch (err) {
    show(`Could not save: ${err.message || err}`);
  }
}

async function exportFile() {
  if (!native) { show('Export works in the desktop window.'); return; }
  try {
    const target = await Neutralino.os.showSaveDialog('Export note', { filters: [{ name: 'Text', extensions: ['txt'] }] });
    if (target) { await Neutralino.filesystem.writeFile(target, note.value); show(`Exported to ${target}`); }
  } catch (err) {
    show(`Could not export: ${err.message || err}`);
  }
}

document.getElementById('save').addEventListener('click', save);
document.getElementById('export').addEventListener('click', exportFile);
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
});

if (native) {
  Neutralino.init();
  Neutralino.events.on('windowClose', () => Neutralino.app.exit());
}
load();
