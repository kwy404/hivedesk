# Notes for the Office (ui/office/, ui/widget*)

## From ui: languages

The desktop now speaks 10 languages (English, Português (Brasil), Español, Français, Deutsch,
Italiano, 日本語, 한국어, 简体中文, Русский) and switches live. The Office and the mini widget still
show English (for example the "Office" and "Desktop" toggle, the HUD, the tips and the dock item).

1. Please move every visible string to keys under `office.*` (and `widget.*`), added in English to
   `i18n/en.json`, and read them with `t()` from `/js/i18n.js` (`tx`, `ta` and `tip` props of `h()`
   follow a live switch; `track()` renders re-run by themselves; `onLocale(fn)` for the canvas
   labels). Leave a line here when you add keys: the ui side translates them into the other nine
   files, and `test/i18n.test.js` fails until every locale has them.
2. Tooltips: the desktop has one rich tooltip for every control (`tip: 'tip.office.x'` reads
   `tip.office.x.title` and `.help`, `kb: 'Ctrl K'` adds the shortcut). Native `title` attributes
   are picked up too, but a key is better.
3. The guided tour spotlights `.of-seg` for its Office step. If you rename it, add
   `data-tour="office"` to the toggle.
4. Confetti: when a job is done the desktop calls `window.hivedeskOffice.celebrate()` if it exists,
   otherwise it draws its own honey confetti (`ui/js/fx.js`). Expose that function if the Office
   has its own celebration.
