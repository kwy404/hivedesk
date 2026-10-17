# Translating the hivedesk site

`en.json` holds every string of `docs/index.html` (from `python docs/_i18n/build.py --export`).
A translation is `docs/_i18n/<lang>.json`:

```json
{ "units": { "<id>": "translated text", "...": "..." }, "js": { "<key>": "translated text" } }
```

Rules for every language:

1. Translate every unit and every `js` string. Keep each `id` and `key` exactly.
2. Placeholders are markup: `<x1>...</x1>`, `<x2/>`, `<c3/>`. Keep every placeholder of the source, each exactly once, with the same number, and keep pairs balanced. You may move them to fit the sentence. Never translate or invent placeholders. `<c3/>` stands for code or a keyboard key.
3. Keep as they are: `hivedesk`, `Hive City`, `Mel`, `Dev`, `Designer`, `QA`, `Writer`, `Code together`, `npx hivedesk`, file names, flags, URLs, numbers with units, `MIT`, `GitHub`, `LinkedIn`, `Windows`, `macOS`, `Linux`, `Ctrl`, the theme names (Mel, Meia-noite, Floresta, Neon, Pixel, Alto contraste, Colmeia Clara, Papel), `Alexandre Kohler`, the room names `Design`, `Code`, `Review`, `Test`, `Ops`, `Library`, `Lobby`.
4. Keep HTML entities such as `&middot;`, `&ldquo;`, `&rdquo;`, `&rsquo;`, `&hellip;`, `&uarr;`, `&darr;` (or write the character itself).
5. No emoji. No en dash or em dash characters anywhere: use a comma, a colon, parentheses or a new sentence.
6. Do not name any AI product, AI company or model family. Use generic words ("open source models", "local runtimes you already use", "your own API key for a cloud model").
7. Natural, idiomatic, friendly and precise, like a good product page written in that language, not a word by word translation. Keep the meaning and every honest limit exactly; do not add claims.
8. Keep the length close to the English, especially for buttons, tabs, menu items and table headers.
9. Units with `"kind": "attr"` are attribute values (alt text, aria labels, tooltips, meta descriptions): plain text, no placeholders. The `<title>` and meta descriptions should read well in search results (title under 65 characters, description under 160).
10. Short terminal lines that imitate the app's wizard may be translated like the app would show them; keep the `$` command lines in English.
