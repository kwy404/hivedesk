# Themes

A hivedesk theme is a small JSON file of design tokens: colors, surfaces, accent, corner radius, fonts, shadows, the desktop pattern, motion intensity and a sound pack. The desktop turns the tokens into CSS custom properties and switches live, with no reload.

Open the **Themes** window from the dock or with Ctrl K, "Open Themes".

## Built-in themes

| File | Name | Scheme | Notes |
| --- | --- | --- | --- |
| `mel.hivedesk-theme.json` | Mel | dark | The default: dark honey on deep charcoal. |
| `colmeia-clara.hivedesk-theme.json` | Colmeia Clara | light | Warm paper white with honey accents. |
| `meia-noite.hivedesk-theme.json` | Meia-noite | dark | Midnight blue with a dot pattern. |
| `floresta.hivedesk-theme.json` | Floresta | dark | Forest greens, rounded type, wood sounds. |
| `neon.hivedesk-theme.json` | Neon | dark | Pink and cyan on near black, a grid, livelier motion. |
| `papel.hivedesk-theme.json` | Papel | light | Sepia paper, serif type, flat shadows. |
| `alto-contraste.hivedesk-theme.json` | Alto contraste | dark | Black, white and yellow. Text passes WCAG AAA (7 to 1), less motion. |
| `pixel.hivedesk-theme.json` | Pixel | dark | Square corners, hard shadows, pixel motif, chiptune blips. |

The gallery also has **Follow the system** ("Seguir o sistema" in Portuguese): pick one light and one dark theme and the desktop follows the light or dark setting of your computer, live.

Every built-in theme passes the contrast rules below; `test/themes.test.js` checks it.

## The file format

Files end in `.hivedesk-theme.json`. Export one from the gallery or the editor to see a full example.

```json
{
  "format": "hivedesk-theme",
  "version": 1,
  "id": "mel",
  "name": "Mel",
  "description": "Dark honey on deep charcoal. The default Hive.",
  "author": "hivedesk",
  "scheme": "dark",
  "colors": {
    "bg": "#0E0D0B", "bg2": "#141210",
    "panel": "#191613", "panel2": "#1F1B17", "panel3": "#27221D", "panel4": "#2F2923",
    "line": "#F2E9DA",
    "text": "#F2E9DA", "text2": "#CFC4B3", "muted": "#9A8F80", "faint": "#756B5F",
    "accent": "#FFB531", "accent2": "#FFD072", "accentInk": "#1A1206",
    "ok": "#7DC49B", "warn": "#E8B45C", "bad": "#E57B6E", "info": "#86A9D6"
  },
  "radius": { "window": 14, "control": 9, "small": 6 },
  "fonts": { "sans": "system", "mono": "system" },
  "shadow": { "style": "soft", "strength": 1 },
  "pattern": { "kind": "comb", "color": "#FFD072", "opacity": 0.065, "size": 56 },
  "lines": 1,
  "motion": 1,
  "sound": "chime"
}
```

| Key | Values |
| --- | --- |
| `scheme` | `dark` or `light` |
| `colors.*` | `#RRGGBB`. `bg` is the desktop, `panel` to `panel4` go from the window surface to raised parts, `line` is drawn at low opacity for borders, `text` to `faint` go from body text to hints, `accent` is buttons and focus, `accent2` is accent colored text, `accentInk` is text on an accent button, `ok`, `warn`, `bad` and `info` are status colors used as text. |
| `radius` | px: `window` 0 to 28, `control` 0 to 20, `small` 0 to 14 |
| `fonts.sans` | a preset: `system`, `rounded`, `humanist`, `serif`, `mono`, `pixel`, or a plain font list such as `"Inter", Arial, sans-serif` (letters, digits, spaces, quotes, commas, dots and dashes only; nothing is downloaded) |
| `fonts.mono` | `system`, `pixel`, or a plain font list |
| `shadow.style` | `soft`, `deep`, `hard` (offset, no blur) or `flat` |
| `shadow.strength` | 0 to 2 |
| `pattern.kind` | `comb` (honeycomb), `fine`, `dots`, `grid`, `pixel` or `none` |
| `pattern.opacity`, `pattern.size` | 0 to 0.3, and 16 to 120 px |
| `lines` | border strength, 0.5 to 4 (1 is normal) |
| `motion` | 0 to 1.5: scales every transition; 0 also turns on reduced motion unless you chose a motion setting yourself |
| `sound` | `chime` (the desktop's own sounds), `soft`, `wood`, `pixel` or `off` |
| `contrast` | optional, `high`: the contrast checks use the AAA level |

Unknown keys are dropped and numbers are clamped when a theme is loaded, so a theme file can never inject CSS: every color is a hex value, every number is a number, and the pattern is drawn by hivedesk itself.

## Contrast rules

The editor shows a live report, and the same check runs on every theme Mel generates.

| Text | On | Minimum ratio |
| --- | --- | --- |
| `text` | `bg`, `bg2`, `panel`, `panel2`, `panel3` | 4.5 (AA), 7 with `contrast: "high"` |
| `text2`, `muted` | `panel`, `panel2` | 4.5, 7 with `contrast: "high"` |
| `faint` (hints next to readable text) | `panel` | 3, 4.5 with `contrast: "high"` |
| `accent2`, `ok`, `warn`, `bad`, `info` | `panel` | 4.5 |
| `accent` (buttons, focus) | `panel`, `bg` | 3 |
| `accentInk` | `accent` | 4.5, 7 with `contrast: "high"` |

**Fix the text colors** moves only the text colors, never the surfaces: each failing color is mixed toward white or black by the smallest amount that reaches its target on every background it sits on.

## The editor

Duplicate any theme (or start a new one) to open the editor: color pickers with hex fields for every color, sliders for corners, borders, shadow, pattern and motion, menus for fonts, shadow style, motif and sound pack (with a Play button). The preview on the left updates as you move a control; tick **Preview on the desktop** to try it on the whole Hive before saving. **Save** keeps it in `~/.hivedesk/themes/`; **Export** downloads the `.hivedesk-theme.json` file; **Import** in the gallery reads one back after validating it.

## Create a theme with the crew

Type a request in the top bar, for example:

```text
crie um tema inspirado em pôr do sol na praia
```

or use the "Create a theme with the crew" box in the gallery. Requests that start with "create", "make", "crie", "faça", "crea" and similar words followed by "theme" or "tema" go to Mel instead of becoming a build job. Mel answers under the theme JSON schema (grammar constrained on the local model), hivedesk validates the answer, repairs what it can, runs the contrast fix, and opens the editor with the draft already previewed on the desktop. The banner lists which text colors were adjusted. Approve and apply it, edit it, save it, or close the window to discard it. If the model answer is unusable twice, the draft starts from Mel and says so.

Like every model turn, this takes a turn in the shared queue, so it can wait while the crew works.

## Themes from extensions

An extension can ship themes (`contributes.themes` in its manifest, see [EXTENSIONS.md](EXTENSIONS.md)). They show in the gallery while the extension is on, labeled with the extension's name.

## Where things live

| Path | What |
| --- | --- |
| `themes/` in the package | the built-in themes |
| `~/.hivedesk/themes/` | your saved and imported themes (`HIVEDESK_HOME` moves `~/.hivedesk`) |
| `ui/themes/core.js` | schema, validation, contrast check and fix, the mapping to CSS variables (shared by the engine, the desktop and the tests) |
| `ui/themes/index.js`, `themes.css` | the gallery, the editor and the live switch |
| `src/extensions/themes.js` | the theme store and the generation flow |

The chosen theme is remembered in the browser, with its tokens, so the next start paints it before the first frame.

## Engine commands

| Command | Data | Result |
| --- | --- | --- |
| `themes.list` | `{}` | `{ themes }` (also `GET /api/themes`) |
| `themes.save` | `{ theme }` | `{ theme }` (a new id when it would replace a built-in one) |
| `themes.delete` | `{ id }` | `{}` (your own themes only) |
| `themes.generate` | `{ prompt, wait? }` | `{ requestId }`, then the event `theme.generated { requestId, prompt, theme, fixes, failing, problemsBefore, fallback? }` or `theme.failed { requestId, error }` |
