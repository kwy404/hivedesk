# hivedesk 1.0 design

The visual system of hivedesk 1.0. One token layer (`ui/css/tokens.css`), one theme engine
(`ui/themes/core.js`), one icon family (`assets/icons/sprite.svg`), one bee renderer
(`ui/js/bees.js`) and one canvas palette reader (`ui/js/art.js`) feed every surface: the City, the
Office, the desktop windows, the workbench, the panels, the dialogs and the assets.

Owner verdict for this round: the 0.x look was too childish. Make it serious without losing the
essence.

## 1. Principles

1. **An operations console with a living world inside.** hivedesk is a premium console for a
   distributed system, crafted like a high end developer tool, with a touch of strategy game. The
   City is the map of the system, not a toy town.
2. **Keep the essence.** The City stays an isometric little world of floating islands, buildings,
   rooms and bridges. The honeycomb and the hexagon stay the shape language. Warm amber stays the
   signature. Bees stay the agents. Mel stays the brand character. Panels stay floating dark glass.
   The system still feels alive.
3. **Amber means something.** Amber marks focus, the current selection and work in progress. It is
   never decoration. Structure is cool neutral gray; meaning is semantic color.
4. **Every pixel that moves is state.** Motion, glow and color follow engine events and
   measurements (PLAN principle 1). Ambient decoration is quiet and never pretends to be data.
5. **Quiet success.** A finished task is a check mark and a short pulse; a finished job is a calm
   toast. No confetti, no jars, no level up bursts.
6. **Dense, legible, honest numbers.** Tabular figures, a mono face for identifiers, the source of
   every number one hover away, "not measured" instead of a guess.

## 2. Tokens

All tokens are CSS custom properties in `ui/css/tokens.css`. The theme engine
(`ui/themes/core.js`, `themeVars`) writes the base color, radius, font and motion tokens on
`:root` at runtime, so a theme restyles everything live; every other token is derived from those
with `color-mix()` and never hard codes a color. Canvas scenes read the same properties through
`ui/js/art.js`. New code uses only tokens.

### 2.1 Color roles

Default theme "Mel" (dark). Base values; the theme engine can replace each.

| Role | Token | Value | Use |
| --- | --- | --- | --- |
| Canvas | `--bg` | `#0A0B0D` | app background, the City void |
| Canvas raised | `--bg-2` | `#0E1013` | inputs, wells, code |
| Surface 1 | `--panel` | `#131519` | windows, cards |
| Surface 2 | `--panel-2` | `#181B20` | popovers, raised rows |
| Surface 3 | `--panel-3` | `#1F2329` | selected rows, segmented on |
| Surface 4 | `--panel-4` | `#272C33` | strong fills, tracks |
| Hairline | `--line`, `--line-2`, `--line-3` | `#E4E8EE` at 7, 11, 17 percent | 1 px borders and dividers |
| Text | `--text` | `#E6E8EB` | primary text |
| Text 2 | `--text-2` | `#B4BAC3` | secondary text |
| Muted | `--muted-t` | `#8A919B` | labels, meta |
| Faint | `--faint` | `#656C76` | hints, timestamps |
| Accent | `--honey` (alias `--accent`) | `#F2A93B` | focus, selection, work in progress |
| Accent strong text | `--honey-2` | `#F6C46F` | amber text on dark |
| On accent | `--honey-ink` | `#17110A` | text on an amber fill |
| Success | `--ok` | `#62B98C` | done, passed, online |
| Warning | `--warn` | `#D8A54F` | waiting, partial, stale |
| Danger | `--bad` | `#E0695C` | failed, revoked, offline errors |
| Info | `--info` | `#72A4DE` | reported, peer, review |
| Link | `--link` | `#7FD6F0` | GPU and CPU links, lent compute |

Derived tokens: `--accent-a` (12 percent fill), `--accent-b` (22 percent fill), `--accent-line`
(40 percent border), `--ring` (focus ring), `--ok-a`, `--warn-a`, `--bad-a`, `--info-a`,
`--hover`, `--hover-2`, `--glass`, `--glass-line`, `--scrim`.

Rules:

* Amber fills only the one primary action of a view, the selected item and progress. Everything
  else is neutral.
* Semantic colors are muted to the same lightness so no state shouts louder than another.
* Status always pairs color with a shape or a word (dot plus label, ring plus glyph), never color
  alone.
* Room colors (Design, Code, Review, Test, Ops, Library, Lobby) are kept as identifiers but used
  at low chroma: a 2 px rule, a dot, a label, never a large fill.

### 2.2 Type

* Sans: `"Inter", "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif`. Inter when installed, the platform UI face otherwise. No web font download, everything stays offline.
* Mono: `"JetBrains Mono", "Cascadia Mono", "Cascadia Code", ui-monospace, "SF Mono", Menlo, Consolas, monospace` for IDs, PeerIds, fingerprints, addresses, paths, model names, logs and code.
* Every number that changes uses `font-variant-numeric: tabular-nums` (`.num`, `--num`).

| Step | Token | Size / line | Weight | Use |
| --- | --- | --- | --- | --- |
| Caption | `--fs-11` | 11 / 16 | 500, 600 caps with 0.06 em tracking | labels, meta, chips |
| Small | `--fs-12` | 12 / 16 | 400, 500 | dense rows, secondary text |
| Body | `--fs-13` | 13 / 20 | 400 | default UI text |
| Emphasis | `--fs-14` | 14 / 20 | 600 | card and panel titles |
| Title | `--fs-16` | 16 / 24 | 600 | dialog and window section titles |
| Heading | `--fs-20` | 20 / 28 | 600 | onboarding, empty states |
| Display | `--fs-28` | 28 / 32 | 600 | big metrics only |

Weights stop at 600 (700 for a tabular metric). No 800 or 900 anywhere: heavy weights read as
playful.

### 2.3 Space, radius, lines, elevation

* 8 px grid with a 4 px half step: `--s-1` 4, `--s-2` 8, `--s-3` 12, `--s-4` 16, `--s-5` 24,
  `--s-6` 32, `--s-7` 48. Control heights 24, 28, 32 and 36 px.
* Radius: `--r-sm` 4 px (chips, inputs inside rows), `--r-ctl` 6 px (buttons, inputs), `--r-win`
  10 px (windows, cards, panels), `--r-pill` 999 px only for status pills and dots.
* Lines: 1 px hairlines everywhere (`--line`, `--line-2`). No 2 px borders except the focus ring.
* Elevation: three levels. `--elev-0` flat; `--elev-1` a hairline plus a soft 24 px shadow at 40
  percent (windows, floating panels); `--elev-2` adds a deeper 48 px shadow (popovers, menus,
  dialogs). No inner glows, no colored glows except the focus ring.
* Floating glass: `--glass` (surface 1 at 82 percent) with `backdrop-filter: blur(16px)
  saturate(1.1)`, `--glass-line` hairline and one 1 px inner top highlight.

## 3. Icons

One stroke family in `assets/icons/sprite.svg` (inlined at boot, used through `icon(name)`), with
each icon also as a single file in `assets/icons/<name>.svg`.

* 24 px grid, 2 px live area padding, 1.5 px stroke, round caps and joins, `currentColor`, no
  fills except a status dot.
* Geometry from circles, 45 and 90 degree lines and the hexagon (the hexagon is drawn with flat
  sides left and right, point up).
* Sizes: 14 px in dense rows, 16 px default, 20 px in the dock and empty states.
* `assets/icons/honey/*.svg` are the README feature tiles: the same glyph in amber on a 1 px amber
  hairline tile. Same names, same paths.

## 4. Bees and Mel

* **Agent unit** (`ui/js/bees.js`, `beeSvg`): a geometric bee seen from above. A hexagon abdomen
  in the agent color with two ink bands, a round graphite head, two hairline antennae, two
  translucent wings and the role glyph in the middle band. No eyes, no blush, no hats. The status
  ring is drawn by the container (canvas ring in the City and Office, `.bee-av` ring and dot in the
  DOM) so the same art serves every size from 20 to 96 px.
* Role glyphs: foreman (Mel) a chevron crown, developer `</>`, designer a pen nib, QA a check,
  writer three lines, reviewer a lens, architect a compass, planner a list, ops a pulse, any other
  role its initial.
* **Status ring** colors: working and thinking amber (thinking pulses), waiting warn, testing ok,
  reviewing info, error danger, idle a neutral hairline, sleeping or offline a dashed faint ring.
* **Info tag**: compact (status dot, name, quiet level `L3`) under each agent; on hover or
  selection it expands to name, role and the current task.
* **Mel**: the same unit, amber, with the foreman chevron and a hexagon badge. Used as the brand
  mark (`assets/logo.svg`, `ui/favicon.svg`), in onboarding, in empty states and the tour
  (`assets/mascot.svg`, `assets/mascot-dark.svg`, `assets/crew/mel.svg`, `assets/mel-wave.svg`).
* Movement: bees glide on eased paths at a steady speed, wings flutter at low amplitude, no squash
  and stretch, no hops.

## 5. The City

* **World**: islands float in a graphite void with a faint vertical gradient and, at night, sparse
  dim stars. No cartoon sun, no clouds; a low mist band under the islands gives depth.
* **Light**: one soft key light from the upper left. Day and night shift the void and the
  surfaces by at most a few percent; windows and lamps glow a little at night.
* **Ground**: calm basalt tops with a hairline honeycomb grid, crisp faceted sides with two strata
  lines, a dark low poly underside with two shards. A few trees (low poly cones) and lamps stay.
* **Building**: a concrete plinth, graphite walls with dark glass windows and a thin cap.
  Room floors are clean zones: a flat floor, a 2 px room color rule at the threshold, the room name
  painted on the floor, a hairline hex grid at very low contrast. Partitions are low glass walls.
* **Workstations**: a light desk slab, a thin monitor whose screen line lights in the agent color
  while it works, a simple chair. Props kept only where they say something: Library storage racks,
  Ops server racks with real activity lights, the Review wall display, the Test verdict light.
* **Bridges**: precise steel decks with hairline rails. Traffic is shown as data particles flowing
  along the deck (a task or a GPU turn is one bright packet; a streaming job is a steady particle
  stream that stops when the tokens stop). A failed job breaks the deck with the reason.
* **Links**: borrowed GPU or CPU time is a clean glowing cyan line (`--link`) from the borrower to
  the lender, nothing else glows cyan.
* **Machine buildings** carry small data driven indicators: a load ring around the roof core
  (measured GPU use), a VRAM bar on the facade (used of total when measured or reported), and the
  name sign with its online state. No measurement, no ring and no bar.
* **Task notes**: dark cards with a status rule, not sticky notes.

## 6. The Office

Same world rules indoors: a graphite floor with a hairline hex grid and a team zone, dark glass
windows, the kanban as a wall display with dark cards, clean workstations, Mel at a hexagon
podium. Progress is a segmented timeline (one segment per task, colored by state). A finished task
gives its bee a check mark and a 300 ms success pulse; a finished job shows a calm activity toast
with the summary and "Open preview". The task count replaces honey jars. Levels stay as a quiet
`L3` in the name tag.

## 7. Desktop, workbench, panels and dialogs

* Windows and panels: surface 1, 10 px radius, hairline, `--elev-1`; title bars 36 px with a 16
  px glyph and 13 px semibold title.
* Data displays (Machines, Activity, Jobs): label column in caption caps, values in tabular
  figures, measurement state as a 6 px dot, bars 4 px tall on a `--panel-4` track, sparklines of
  the samples this window received (never invented, the line starts empty).
* Dock: a glass shelf with neutral tiles; amber marks only the focused window.
* Dialogs: 12 px radius at most, title 16 px, footer actions right aligned, one primary button.
* The workbench reads the same tokens through its `--wb-*` aliases; nothing in it needs its own
  colors.

## 8. Motion

* Durations: `--t-fast` 150 ms (hover, press, color), `--t` 200 ms (enter, leave, small moves),
  `--t-slow` 250 ms (panels, dialogs, camera settle start). Nothing in the UI is longer than 250
  ms except camera glides and continuous status loops.
* Easing: `--ease` `cubic-bezier(.2, 0, 0, 1)` for everything; `--ease-in` `cubic-bezier(.4, 0,
  1, 1)` for exits. No overshoot, no bounce, no spring.
* Status loops (thinking, live link, running cell) are slow (1.6 s or more) and low amplitude.
* One shot feedback (success pulse, check mark) lasts at most 400 ms.
* `prefers-reduced-motion` and the Motion setting (`data-motion=reduce`) stop every loop and
  every glide; state changes then appear instantly.

## 9. Before and after

| Area | 0.x | 1.0 |
| --- | --- | --- |
| Palette | warm brown surfaces, honey everywhere | graphite and near black, cool neutral structure, amber for state and focus |
| Type | 800 and 900 weights, mixed sizes | 400 to 600, seven step scale, tabular figures, mono for IDs |
| Shape | 14 px radii, glows, thick borders | 10, 6 and 4 px radii, 1 px hairlines, three elevations |
| Sky | blue sky, sun, moon, clouds | graphite void, faint stars at night, low mist |
| Ground | bright green hex meadow, brown rock | calm basalt with hairline honeycomb grid |
| Rooms | brown hex tiles, rugs, wallpaper | clean floor zones with painted labels |
| Props | fountain, rocket, flowers, easel, armchair, honey tank | trees, lamps, racks, displays, a hexagon core mast |
| Bridges | wooden arch with lanterns | steel deck, hairline rails, data particles |
| Bees | cartoon faces, eyes, blush, hats | geometric unit, role glyph, status ring |
| Feedback | confetti, honey jars, "Level 2!" bursts, sparkles, z's | check mark, success pulse, calm toast, quiet level badge |
| Office | sticky notes, honey shelf, honey cooler | wall display, task count, segmented timeline |
| Mel | cartoon bee with a hard hat | geometric foreman mark |
| Icons | 1.7 px mixed geometry | 1.5 px consistent family |
| Motion | up to 700 ms with overshoot | 150 to 250 ms, one easing, no bounce |

## 10. Contract for other streams

* Element ids, `data-*` hooks, `window.hivedesk*` test hooks and class names stay. New classes are
  additive.
* Use tokens, never literal colors. For canvas, `artTokens()` from `ui/js/art.js`.
* Use `icon(name)` from the sprite; a new icon follows section 3 and goes into the sprite and its
  own file.
* Hand off: the README and `i18n/README.pt-BR.md` describe `assets/illustrations/hardware.svg` as
  "honey jars"; the art now shows hexagon cells filled by tier. The site stream should update the
  alt texts. `docs/assets/shots/` keeps the 0.x screenshots until the release gate retakes them.
