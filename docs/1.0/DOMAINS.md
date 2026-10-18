# Domains: one crew for every kind of project

hivedesk 1.0 does more than websites. Every request is sorted into a domain, the crew asks what it must know, the right specialist leads, and the work starts from a small offline skeleton that builds and has tests.

| Domain | Stack the crew builds | Specialist | Skeleton (`src/crew/domains/templates/`) |
| --- | --- | --- | --- |
| web | static HTML, CSS and JavaScript, no build step | Dev and Designer | none (the 0.2 flow) |
| mobile | an installable PWA with a Capacitor config for Android and iOS | Mobi (`mobile`) | `mobile/`: `www/` PWA, `capacitor.config.json`, tests |
| desktop | a Neutralinojs app (HTML, CSS and JavaScript in a native window) | Desk (`desktop`) | `desktop/`: `resources/`, `neutralino.config.json`, tests |
| backend | a Node HTTP API on `node:http` with `node:test` tests | Bex (`backend`) | `backend/`: router, validation, body limit, API tests |
| cli | a Node CLI with `util.parseArgs` and tests | Dev | `cli/`: `bin/cli.js`, `--help`, exit codes, spawn tests |
| extension | a Manifest V3 extension (service worker, popup) | Dev | `extension/`: manifest, popup, service worker, tests |
| game | a canvas game (requestAnimationFrame loop, keyboard and touch) | Dev and Designer | `game/`: pure rules, loop, pause on hidden tab, tests |
| data | a Node data script (CSV in, report out) | Dana (`data`) | `data/`: CSV parser, totals, sample, tests |
| security | a read only audit of the project | Sec (`security`) | none, the audit runs instead of a plan |
| devops | container, CI and service files | Ops (`devops`) | none, the crew writes the files for the project |
| chat | an answer in the chat, no job | the worker asked | none |

## How a request flows

1. **Classify** (`src/crew/domains/classify.js`). Weighted keywords in English and Portuguese plus the files already in the workspace (`capacitor.config.json`, `neutralino.config.json`, a Manifest V3 `manifest.json`, a `Dockerfile`) give a domain and a confidence. Only when two domains score and neither wins does one short model turn (JSON schema, 40 tokens) settle it. One weak word ("script", "celular") never changes the kind of project: below a score of 3 it stays a website.
2. **Say why.** Every domain other than web is announced with its reason, for example: "Mobile app: an installable PWA with a Capacitor config for Android and iOS, because the request mentions "celular"." The `job.domain` event carries the same data.
3. **Ask** (`src/crew/domains/questions.js`) when a fact that changes the plan is missing (see below). With the brief step off (`settings.refine: false`) or with `settings.questions: false` nothing is asked and a low confidence guess falls back to the website flow.
4. **Specialist and skeleton** (`src/crew/domains/flow.js`, `skeletons.js`). The specialist of the domain is hired for this job only (a later website job does not see it) and gets the first build task. When the workspace has no project of that kind (none of its marker files and at most three other files), the skeleton is written through the toolbox, so each file shows up as a normal change; existing files are never overwritten, and the skeleton files do not count as pre existing for approvals.
5. **Plan and build** as before, with the domain notes (stack, skeleton files, rules) in the planner prompt, playbooks selected per domain, and the domain checks in QA.
6. **Security** requests skip the plan and run the audit instead (below).

## Clarifying questions

Mel asks one card of 1 to 4 questions, each with 2 to 5 options, only when the answer changes the result. The rules, encoded in the curated sets and in `validateCard`:

- Ask only what changes the plan; every option leads to a visibly different result. Never generic questions ("Any preferences?").
- Questions use the request's own words: the subject is taken from the request ("Where should the recipe app keep its data?", "app de receitas: ...").
- Options are concrete decisions with the tradeoff in the description ("On the phone: IndexedDB on the device, works offline, no account, but no sync between phones"), short labels of 1 to 5 words, mutually exclusive unless the question is multi select.
- The recommended option comes first, marked, with a reason tied to the context (shared by a team: a server and accounts; a phone game: touch; something used before, from memory).
- Ordered by impact: platform, data, sign in, scope, then the rest; at most 4. Anything the request already says is inferred, not asked, and listed in `inferred`; anything with an obvious default is stated in one line under the card ("I will use: Android and iOS from one codebase; works offline; ...").
- After the answers, one line sums up the decisions before the work starts, and the decisions go into the brief, the planner notes and the improved prompt of the report.

The question sets are curated per domain (platform, web, mobile, desktop, backend, game, extension, data, cli, devops; security asks nothing and states its defaults), so a 3B model asks good questions. A 7B or cloud model may reword them for the request; each reworded piece is kept only if it still passes the guards. `test/domains/questions.test.js` holds twelve golden requests in English and Portuguese with the topics they must ask.

### Event and command contract (desktop, City box, voice)

Events (in the log, with the job's `jobId`):

```json
{ "type": "crew.question", "data": {
  "id": "q_3_1", "domain": "mobile", "subject": "the recipe app", "lang": "en",
  "questions": [{ "id": "mobile.data", "topic": "data", "multi": false, "text": "Where should the recipe app keep its data?",
    "options": [{ "id": "device", "label": "On the phone", "description": "IndexedDB on the device: ...", "recommended": true, "reason": "it works offline and needs nothing else running" },
                { "id": "server", "label": "Synced through a server", "description": "..." }] }],
  "defaults": "Android and iOS from one codebase; works offline; ...",
  "inferred": [],
  "labels": { "recommended": "Recommended", "other": "Other", "decide": "Decide for me", "send": "Start with these", "...": "..." } } }

{ "type": "crew.answered", "data": { "id": "q_3_1", "answers": { "mobile.data": { "options": ["server"] } }, "decided": false, "by": "user", "summary": "Synced through a server" } }
```

The chat line that announces the card has the i18n key `domains.ask.card` and a plain text version of the whole card (numbered options, the recommended one marked, the defaults line), which the CLI and the voice orb can read as it is.

Commands (host only; guests cannot use them):

| Command | Data | Result |
| --- | --- | --- |
| `crew.answer` | `{ questionId, answers: { [questionId]: { options: string[], other?: string } } }` or `{ questionId, decide: true }` | `{ answers }`; `bad_request` for unknown options, two options on a single choice question or a missing answer; `conflict` when the card is no longer open |
| `crew.questions` | `{}` | `{ questions: [card] }`, the open cards (for a desktop that reconnects) |
| `crew.match` | `{ questionId, question?, text }` | `{ question, match: { options, decide? } \| null }`: what a spoken or typed answer picks ("the second one", "a segunda", "3", a label, a distinctive word of a label, "decide for me", "voce decide") |
| `security.audit` | `{}` | the audit of the workspace, read only (findings with masked snippets) |

The voice stream reads `crew.question` (text and options in order), sends the utterance to `crew.match`, and answers with `crew.answer`. In the demo (and in tests with `autoApproveBriefMs`) the card is answered with the recommended options by itself.

The desktop draws the card under its chat line (`ui/js/widgets/question.js`): each option is a button with its tradeoff, the recommended one first and marked, "Other" with free text, "Decide for me", keys 1 to 5 pick an option of the focused question, arrow keys move between questions, Enter starts.

## Security mode

A request like "audit my project for leaked keys" or "faca uma auditoria de seguranca" runs `src/crew/domains/security/scan.js` on the workspace, read only:

- **Secrets**: private keys, cloud and repository tokens, payment and AI provider keys, JSON Web Tokens, passwords inside connection URLs, and secret named assignments with a high entropy value. Example files (`.env.example`), tests and placeholders are skipped or rated low. A secret is never shown in full, not in the report, the events, the approval or the log.
- **Risky code**: `eval` and `new Function`, `innerHTML` from data, `document.write`, SQL built from strings, shell commands built from input, MD5 and SHA-1, `Math.random` for secrets, TLS checks turned off, `pickle` and `yaml.load`, CORS for every origin, debug mode on, plain `http://` requests, pages without a Content-Security-Policy, `.env` missing from `.gitignore`.
- **Dependencies**: `package.json` (with the versions locked in `package-lock.json` when present) and `requirements.txt` against an offline list of well known advisories (`security/advisories.json`, dated). The list is small and not complete; the report says so and suggests the package manager's audit when online.

The report goes to the chat with severity, file, line and a fix, and as the `security.report` event. Then each fix that has a safe mechanical patch (`security/fixes.js`: add a CSP, `textContent` for `innerHTML`, SHA-256 for MD5, TLS checks back on, `yaml.safe_load`, a hardcoded key read from the environment, `.env` in `.gitignore`) is asked as a strict approval, which waits for the user even with approval mode off. Only approved fixes are written. SQL, shell and `eval` findings get advice only, since their right fix needs a person.

## Chat mode

Questions and small talk still get a model answer in the user's language without a job (0.2 behavior). When the question is about a field (mobile, desktop, backend, CLI, extension, game, data, security, DevOps), the answer prompt adds that field's expertise and asks for the concrete steps, commands or API names and the main tradeoff, and to say plainly when something needs a tool or an account the user may not have.

## Playbooks and checks

The library has seven new categories with 175 playbooks: `mobile`, `desktop`, `backend`, `security`, `devops`, `tools` (CLIs and browser extensions) and `games`, each with its checks. Selection weighs the job's domain: its own categories by 1.4, other domains' categories by 0.6, plus the domain's words in the query. New checks: `pwa.manifest`, `pwa.service-worker`, `capacitor.config`, `neu.config`, `ext.manifest-v3`, `ext.no-remote-code`, `game.loop`, `node.test-runner`, `cli.help`, `sec.no-secrets`, `sec.no-shell-input`, `sec.sql-params`, `sec.csp`, `sec.weak-crypto`, `container.nonroot`, `container.pinned`, `ci.workflow`. The checks of the job's domain always run in QA.

## Honest limits

- **Model size.** A local 3B or 7B model does small and medium projects well: a skeleton plus a few screens, routes or commands, with its tests. A big app (many screens, real sync, payments, a large API) needs a bigger model: a larger local model on a stronger GPU, GPUs pooled across PCs (the experimental RPC mode), or a cloud key. The skeletons, the curated questions and the checks are there so a small model starts from working code instead of a blank page; they do not make it a large model.
- **Native builds.** The mobile skeleton is an installable PWA that runs everywhere. Android and iOS packages need Android Studio or Xcode on that computer (iOS only on a Mac); store releases need developer accounts. The crew never claims to have built an APK or an IPA.
- **Desktop.** Running and packaging needs the Neutralinojs binaries (`neu update`, then `neu run` or `neu build`, network once). Installers and code signing per OS are separate steps.
- **Extensions.** Loaded unpacked in developer mode; publishing needs a store account and review.
- **DevOps.** The crew writes the files (Dockerfile, CI YAML, service units); it never runs deploys or touches remote servers.
- **Security.** The scan is pattern based and offline. It finds common mistakes, not every vulnerability, and the advisory list covers well known packages only. It is a first pass before a real review, not a certification.
- **Languages.** The classifier and the question rules read English and Portuguese best; other languages fall back to the model and to the website flow when unsure. The crew's lines and the cards come in the 10 desktop languages through `i18n/parts/domains.<locale>.json`.
