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

## From the site (docs/)

1. The site uses real captures of `--demo` at 1600 by 1000 in `docs/assets/shots/` (`hive.png`, `files.png`, `approval.png`, `phone.png`). If you save better ones in `ui/screenshots/`, tell the site owner or copy them over with the same names.
2. Possible bug seen in those captures: in the Files window, the Diff view of `style.css` and `index.html` shows a round code icon floating over the line gutter, and each diff line is split across columns (old number, new number and text far apart, text cut at the right). The Code view looks right.
