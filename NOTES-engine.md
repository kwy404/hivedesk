# Notes for the engine

> **Done, thank you:** the `/i18n/` route. Item 2 of "From ui: languages" (the `cli.*` keys for the wizard) is new.
>
> **Was URGENT from ui:** please add the `/i18n/` static route described in
> "From ui: languages", item 1, at the end of this file. Without it `node src/cli.js --demo` stops
> on "Opening the Hive" with an error, because `ui/js/i18n.js` imports `/i18n/index.js` and loads
> `/i18n/<locale>.json`. One line next to the `/assets/` route in `src/server.js`:
> `if (url.pathname.startsWith('/i18n/')) { const abs = safeJoin(path.join(PACKAGE_ROOT, 'i18n'), url.pathname.slice(6)); if (abs && /\.(json|js)$/.test(abs) && serveFile(res, abs, cookie)) return; return sendError(res, 404, 'not_found', 'no such file'); }`
> and `"i18n"` in package.json `files`. Thank you.

## From lend (src/lend/, ui/lend/)

1. Plug-in loading: please call the default export of `src/lend/index.js` with
   `{ scheduler, bus, server, config }` as PROTOCOL.md section 6 says. `lend.chat` runs the
   friend's turn through `scheduler.turn({ workerId: 'lend:friend', messages, options })`
   after its own checks (size caps, rate limit, one at a time, refused after Stop). Without the
   plug-in the browser falls back to the engine's `brain.chat` (still checked in the browser).
2. Error codes: when a `server.command` handler throws an error with `err.code`
   (`rate_limited`, `busy`, `stopped`, `prompt_too_long`, `not_lending`...), please keep that
   code in the failed `reply`.
3. `--lend`: please open the browser at `/lend/?t=<token>` (the standalone Lend screen), or
   let the desktop mount it (see UI below).
4. `--join <link or six words>` (optional): open `/?t=<token>#w=word-word-word-word-word-word`
   so the "Use a friend's PC" window opens filled in and connects.
5. The e2e test `test/lend/e2e-lend.mjs` needs `playwright-core` as a devDependency (it falls
   back to the env var `PLAYWRIGHT_CORE`, a path to an installed copy). Script suggestion:
   `"e2e:lend": "node test/lend/e2e-lend.mjs"`.


## From ui (ui/)

1. The context menus send four commands the protocol does not list yet. Until the engine
   knows them the UI shows "This engine version does not support it yet" (it reads a
   `bad_request` reply whose message says unknown or not supported):
   * `task.retry { taskId }` put a failed, blocked or done task back to `ready`.
   * `task.reassign { taskId, workerId }` hand a task that is not done to another worker.
   * `task.cancel { taskId }` mark a task `skipped` (dependents become `blocked`).
   * `crew.update { workerId, paused: true | false }` the scheduler skips a paused worker's
     turns; the UI shows "Paused" when `worker.paused` is true.
2. Unknown commands: please answer `bad_request` with a message containing "unknown command"
   so the toast can say it honestly.
3. `turn.ended.tps` and `brain.stats.tps` feed the tokens per second in the top bar; the
   UI hides the number while it is 0.

## From the site (docs/, README)

The site and README now present the interactive wizard, the prompt refiner (and the improved prompt), the guided tour, the office mode and the 10 UI languages. They quote FIRST-RUN.md and PROTOCOL.md word for word, so please document there, when it lands:

1. The wizard: when it runs (every `npx hivedesk`, or only on a TTY, or only on the first run?), the steps and the flag that skips it (`--yes`?). FIRST-RUN.md still says "Zero setup, no questions".
2. The prompt refiner: what it does to the request, whether the user sees the improved prompt before the job starts and can edit or reject it.
3. The guided tour: when it starts and how to replay it.
4. Office mode: what it shows and how to switch to it.
5. The 10 languages: which parts are translated (wizard, Hive UI, crew replies?) and how the language is picked.
6. The FIRST-RUN.md "Honest limits" line still says 1.1 to 4.7 GB; the table now goes from 0.5 GB to 9.0 GB.

## From ui: languages (i18n/), please start with item 1

1. **Serve `/i18n/`.** The UI now loads its strings from the shared root folder `i18n/`
   (`i18n/en.json`, `pt-BR.json`, `es.json`, `fr.json`, `de.json`, `it.json`, `ja.json`,
   `ko.json`, `zh-CN.json`, `ru.json`, plus the formatter `i18n/index.js`). Please add, next to the
   `/assets/` route in `src/server.js`, a route `GET /i18n/<file>` served from
   `PACKAGE_ROOT/i18n` with `safeJoin` (only `.json` and `.js` files, same token rule and cookie
   as `/assets/`), and add `"i18n"` to `files` in package.json. Until that route exists the
   desktop shows an error with a Retry button on the boot screen.

### 2. The terminal wizard and server messages: load the same i18n/*.json, keys `cli.*`

The English source is `i18n/parts/cli.en.json` (286 flat keys, all under `cli.`). Once it is merged into `i18n/en.json` and translated into the other locale files, the wizard, `cli.js`, the brain manager and the doctor can read their strings from the same JSON as the browser UI. No key collides with an existing key in `i18n/en.json`. No key is also the prefix of another key's group.

#### Loading the messages in Node

```js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { match, translator, number, CODES, LOCALES, FALLBACK } from '../../i18n/index.js';

const I18N = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'i18n');
const read = (code) => { try { return JSON.parse(fs.readFileSync(path.join(I18N, `${code}.json`), 'utf8')); } catch { return {}; } };

export function cliTranslator(locale) {
  const code = CODES.includes(locale) ? locale : FALLBACK;
  const en = read('en');
  return translator(code, code === 'en' ? en : read(code), en); // missing key: English, then the key itself
}
```

Check that `i18n/` is in the package `files` list, so `npx hivedesk` ships it.

#### Picking the locale

1. The language saved by the wizard (`config.json`, field `lang`). Store a code from `CODES` (`pt-BR`, not `pt`). Map an old saved `pt` with `match('pt')`, which returns `pt-BR`.
2. Otherwise `match([env.LC_ALL, env.LC_MESSAGES, env.LANG, ...String(env.LANGUAGE || '').split(':')])`. `match` already skips `C` and `POSIX`, turns `pt_BR.UTF-8` into `pt-BR` and maps any `zh` to `zh-CN`.
3. Otherwise `match(Intl.DateTimeFormat().resolvedOptions().locale)`.
4. Otherwise `en`.

This replaces `detectLang` in `src/wizard/i18n.js`. The `lang` typedef in `core.js` becomes one of `CODES`.

#### Language step

The language step lists all 10 entries of `LOCALES`, with each one's native `name` as its label, `code` as its value, and the detected locale as the default. The summary line `cli.summary.language` takes `{language}` as that native name.

#### Numbers and sizes

Format every number and byte size with Intl for the chosen locale. Use `number(locale, n, opts)` from `i18n/index.js`. The placeholders take strings that are already formatted, for example `{size}`, `{ram}`, `{vram}`, `{free}`, `{received}`, `{total}`, `{speed}` and `{percent}`. `formatBytes` in `src/brain/hardware.js` could take a locale and do `number(locale, v, { maximumFractionDigits: v >= 10 ? 0 : 1 })` plus the unit. `{percent}` in the progress line was `pct.toFixed(1)`, so use `{ minimumFractionDigits: 1, maximumFractionDigits: 1 }`. A plain number given to a placeholder, and `#` inside a plural, are formatted for the locale automatically.

#### The hello frame

Add the OS locale to the `hello` frame (`src/server.js`, the `conn.sendJson({ kind: 'hello', ... })` line) as `locale: '<code>'`. That is the code picked above, or the raw OS tag when nothing matched. The browser then uses it as a fallback after its own saved choice and `navigator.languages`.

#### STRINGS.en to cli.* keys

Some of the old keys were labels that code then joined with a value (`${S.size}: ${...}`). Those now have one whole message with a placeholder. The old bare label is kept as a `...Label` key for any place that still needs it.

| `STRINGS.en` key | New key | Note |
| --- | --- | --- |
| welcome | cli.wizard.welcome | |
| pressEnter | cli.wizard.pressEnter | |
| lang | cli.wizard.language.title | |
| folder | cli.wizard.folder.title | |
| folderHere | cli.wizard.folder.here | `{folder}`; bare label: cli.wizard.folder.hereLabel |
| folderOther | cli.wizard.folder.other | |
| folderPath | cli.wizard.folder.path | |
| hardware | cli.wizard.hardware | `{hardware}` is the cli.hardware.line text; bare label: cli.wizard.hardwareLabel |
| noGpu | cli.hardware.noGpu | |
| brain | cli.wizard.brain.title | |
| recommended | cli.wizard.recommended | tty tag: cli.wizard.recommendedTag with `{label}`; brain hint: cli.wizard.brain.recommendedHint with `{reason}` |
| downloaded | cli.wizard.brain.downloaded | option label: cli.wizard.brain.modelDownloaded (`{model}`, `{size}`); not cached: cli.wizard.brain.model |
| download | cli.wizard.brain.download | not used in core.js today |
| otherSize | cli.wizard.brain.otherSize | |
| ollama | cli.wizard.brain.ollama | hint with the model names: cli.wizard.brain.serverModels `{models}` |
| lmstudio | cli.wizard.brain.lmstudio | |
| key | cli.wizard.brain.endpoint | reworded, see below |
| demo | cli.wizard.brain.demo | also the summary brain for demo |
| keyUrl | cli.wizard.endpoint.url | a bad scheme now has cli.wizard.endpoint.badUrl |
| keyModel | cli.wizard.endpoint.model | |
| keySecret | cli.wizard.endpoint.key | |
| confirmDownload | cli.wizard.download.title | |
| size | cli.wizard.download.size | `{size}`; bare: cli.wizard.download.sizeLabel |
| source | cli.wizard.download.source | `{source}`; bare: cli.wizard.download.sourceLabel |
| destination | cli.wizard.download.destination | `{path}`; bare: cli.wizard.download.destinationLabel |
| mode | cli.wizard.mode.title | |
| modeApprove | cli.wizard.mode.approve | short form for the summary: cli.summary.modeApprove |
| modeAuto | cli.wizard.mode.auto | short form for the summary: cli.summary.modeAuto |
| crew | cli.wizard.crew.title | |
| crewDefault | cli.wizard.crew.default | |
| crewPick | cli.wizard.crew.pick | |
| crewRoles | cli.wizard.crew.roles | role labels: cli.wizard.crew.role.dev, .designer, .qa, .writer |
| summary | cli.summary.title | |
| openBrowser | cli.wizard.open.title | |
| reuse | cli.wizard.reuse.title | |
| yes | cli.wizard.hint.yes | accepted key: cli.wizard.keys.yes (accept it plus `y`) |
| no | cli.wizard.hint.no | accepted key: cli.wizard.keys.no (accept it plus `n`) |
| required | cli.wizard.required | |
| warning | cli.wizard.warning | `{message}`; bare: cli.wizard.warningLabel |

#### The other cli.* keys and where they belong

| Keys | File and function |
| --- | --- |
| cli.wizard.title, cli.wizard.pressEnter | `src/wizard/core.js` question(), step welcome |
| cli.wizard.mel | `src/wizard/tty.js` MEL, line 3 (the art stays, the sentence is translated) |
| cli.wizard.cancelled | `src/cli.js` main(), the `err.code === 'cancelled'` branch (was `bye`) |
| cli.wizard.savedTo | `src/wizard/index.js` wizardSetup() |
| cli.wizard.folder.notWritable | `src/wizard/core.js` answer(), steps folder and folderPath (new: check that the folder is writable) |
| cli.summary.language, .folder, .brain, .brainCpu, .brainEndpoint, .mode, .crew | `src/wizard/core.js` summaryLines(); `{key}` is `set` or `missing`, `{roles}` is the joined role labels |
| cli.summary.model | the summary, when the model is shown on its own line (new) |
| cli.summary.workspace, cli.summary.url, cli.summary.stop | `src/cli.js` main(), the lines after startHive (`folder:`, `open:`, `press Ctrl+C to stop`) |
| cli.hardware.line, .gpu, .gpuUnnamed, .noGpu | `src/wizard/core.js` hardwareLine() |
| cli.hardware.log, .logGpu, .logNoGpu | `src/brain/manager.js` hw(); `{threads}` is a number (plural) |
| cli.hardware.unknown | `src/brain/hardware.js` formatBytes(), for a null size |
| cli.brain.choice.* | `src/brain/models.js` chooseModel(): gpu, cpu and cpuLowRam are the reason, `{why}` is noGpu or smallGpu, `{gpu}` is gpuNamed or gpuUnnamed, warning is the 0.5B warning; forced is `src/brain/manager.js` _localAuto() (`{where}` is `gpu` or `cpu`) |
| cli.brain.status.*, cli.brain.statusLine*, cli.brain.hint | `src/brain/manager.js` status(); the key suffix is the state name |
| cli.brain.ollama.*, cli.brain.lmstudio.* | `src/brain/manager.js` _ollama(), _lmstudio() |
| cli.brain.endpoint.* | `src/brain/manager.js` _openai(); `{endpoint}` is the flag value |
| cli.brain.local.uriOnly*, fileNotFound* | `src/brain/manager.js` _localFromFlag() |
| cli.brain.local.noDisk*, diskFallback* | `src/brain/manager.js` _localAuto() |
| cli.brain.local.loadFailed*, gpuFallback*, gpu, cpu, layers, layersNoTotal | `src/brain/manager.js` _load() |
| cli.brain.local.noRam*, layersTooFew, noGpuBackend, busy, schemaMismatch, notJson | `src/brain/local.js` createLocalBrain(); `{backends}` is `CUDA, Vulkan or Metal` |
| cli.brain.remote.* | `src/brain/relay.js` |
| cli.brain.select.* | `src/brain/manager.js` select() |
| cli.brain.probe.* | `src/brain/manager.js` probe(), the `reason` and the endpoint `label` of each option; runtimeNeeded wraps another reason |
| cli.provider.using, noKey*, noModel* | `src/brain/manager.js` _cloud() |
| cli.provider.workerNoKey | `src/brain/manager.js` applyWorkerBrains() |
| cli.provider.noKeySaved | `src/brain/manager.js` testProvider() |
| cli.provider.unknown, keyNeeded, baseUrlNeeded, baseUrlScheme | `src/brain/keys.js` set(), and `src/brain/cloud.js` for unknown |
| cli.provider.timeout, network, auth, rateLimit, http, httpDetail, streamError, refused, aborted | `src/brain/cloud.js` request() and the stream readers; `{label}` is the provider label from PROVIDERS |
| cli.download.confirm | a one line download confirmation, if one is needed outside the wizard (new) |
| cli.download.required, noDownloadHint, started, checksumRetry | `src/brain/manager.js` _ensureModel() |
| cli.download.progress, progressSpeed, progressSpeedLeft, leftMinutes, leftSeconds | `src/brain/manager.js` bar(); `{bar}` is the `#` and `.` bar; leftMinutes when the ETA is over 90 s |
| cli.download.done | `src/brain/manager.js` _ensureModel(), after brain.download.finished (new) |
| cli.download.failedGeneric | a single line that wraps any failure message (new) |
| cli.download.failed.* | `src/brain/models.js` downloadModel() through DownloadError: no_disk (before the download), diskFull (ENOSPC), no_network (no connection, `{host}` is `huggingface.co`), dropped (cut in the middle), http, aborted, io, checksum; each one has a `...Hint` key |
| cli.runtime.installing | `src/brain/manager.js` _runtime() onInstall |
| cli.runtime.ready | `src/brain/manager.js` _runtime(), after brain.runtime ready (new) |
| cli.runtime.retryPrivateCache, failed.install*, failed.no_network*, failed.notFound* | `src/brain/runtime.js` installRuntime() |
| cli.runtime.unavailable | `src/brain/manager.js` _runtime() |
| cli.server.banner, bannerDemo, bannerLend | `src/cli.js` main(), the first line |
| cli.server.listening, opening, openFailed | `src/cli.js` main() and openBrowser() (new) |
| cli.server.stopping | `src/cli.js` main() stop() |
| cli.server.pluginFailed | `src/index.js` startHive(), for the lend and github plug-ins |
| cli.errors.prefix, runHelp | `src/cli.js` main(), the catch around parseArgs and the final catch |
| cli.errors.unexpectedArgument, unknownOption, missingValue, portRange, ctxMin, brainValue | `src/cli.js` parseArgs() |
| cli.errors.joinValue | `src/cli.js` main(), the --join check |
| cli.errors.portInUse, folderNotWritable | `src/server.js` listen (EADDRINUSE) and initHome in `src/bus.js` (EACCES, EPERM, EROFS) (new) |
| cli.help.* | `src/cli.js` HELP: build it from intro, usage, one `option.*` line per flag (the flag names and the column padding stay in code) and footer; option.join takes `{label}` = cli.help.joinLabel, option.brain takes `{endpoint}` |
| cli.doctor.* | `src/doctor.js` runDoctor() labels, details and hints, formatDoctor() title, the ok and fail tags and the last line; gpu.none takes `{vendors}` = `NVIDIA or Apple` and `{others}` = `Vulkan`; gpu.hint takes `{vendor}` = `NVIDIA` |

#### Things to know

1. Parameterized product names. Message text may only name Ollama, LM Studio, node-llama-cpp and Qwen. Other names are passed in from code as parameters: provider labels as `{label}`, `huggingface.co` as `{host}`, `CUDA, Vulkan or Metal` as `{backends}`, the GPU vendors in the doctor, and the `openai` flag value as `{endpoint}`. To keep the old wording exactly, pass the old words.
2. The endpoint option is reworded. `cli.wizard.brain.endpoint` reads "An endpoint with a key (any server with the chat completions API)". `cli.brain.probe.endpointLabel` reads "Endpoint with a key".
3. Two mixed status lines are not covered. `bannerDemo` and `bannerLend` cover one mode each. If demo and lend can both be on at once, print both suffixes or add a key.
4. New messages. Some keys have no current source string: folder.notWritable, endpoint.badUrl, summary.model, download.confirm, download.done, download.failedGeneric, runtime.ready, server.listening, server.opening, server.openFailed, errors.portInUse and errors.folderNotWritable. The table above marks each of them "(new)", with where it should go.
5. Tests. `test/brain.test.js` matches the English output of `bar()`. `progressSpeed` keeps that text exactly in English when `{percent}` is `50.0`.

The `cli.*` keys are translated into all 10 locale files by the UI side. If you add or change a
`cli.*` message, add the English to `i18n/en.json` and leave a line here; the UI side translates it.
The test `test/i18n.test.js` fails when a locale misses a key or has an empty value, or when a
translation drops a `{placeholder}` the English uses.

## From the Office (ui/office/, ui/widget*)

The Office view and the mini widget only read existing events. Two small additions would make
them more exact; until then the UI infers them and works without them:

1. `task.handoff { fromWorkerId, toWorkerId, taskId, nextTaskId }` when a finished task unblocks a
   task owned by another worker. Today the Office infers it from `task.status: done` plus the
   `dependsOn` lists, so a bee flies a parcel to every other assignee whose task depended on it.
2. `tool.result` for `check`: a boolean `passed` next to the text result. Today the Office reads
   "issues found" in the text to choose the green check or the red X.
