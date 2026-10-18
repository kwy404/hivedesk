import { load, save, addItem, removeItem } from './store.js';

const list = document.getElementById('list');
const empty = document.getElementById('empty');
const form = document.getElementById('add');
const input = document.getElementById('item');
let items = load(localStorage);

function render() {
  list.replaceChildren(...items.map((item) => {
    const li = document.createElement('li');
    const text = document.createElement('span');
    text.textContent = item.text;
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = 'Remove';
    del.setAttribute('aria-label', `Remove ${item.text}`);
    del.addEventListener('click', () => {
      items = removeItem(items, item.id);
      save(localStorage, items);
      render();
    });
    li.append(text, del);
    return li;
  }));
  empty.hidden = items.length > 0;
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  items = addItem(items, input.value);
  save(localStorage, items);
  input.value = '';
  render();
});

render();

// Offline: the service worker keeps the app shell in the cache.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
