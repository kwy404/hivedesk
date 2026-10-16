# Notes for the UI

## From lend (src/lend/, ui/lend/)

1. Window type and dock slot:
   ```js
   import { lendWindow, mountLend } from '/lend/index.js';
   // lendWindow = { type: 'lend', title, icon: 'link', dock: { slot: 'lend', label }, mount(el) }
   ```
   and link `/lend/lend.css` once. The window needs about 560 by 520 px; it works at 375 px.
2. When `hello.lend` is true, show the Lend screen full size: `mountLend(el)`, or send the
   browser to `/lend/`.
3. When the page opens with `#w=...` in the hash, open the lend window: it fills the six
   boxes and connects by itself.
