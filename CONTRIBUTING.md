# Contributing

Thanks for helping. hivedesk is small on purpose: plain JavaScript (ESM, JSDoc), Node 20 or newer, almost no dependencies.

## Setup

```sh
npm install
npm test            # vitest
npm run lint        # syntax check and style
npm run rules       # project rules (see below)
npm run site        # links and assets of docs/
node src/cli.js --demo   # the desktop with a scripted crew, no model needed
```

## Layout

* `src/`: the engine (CLI, server, brains, crew, tools, playbooks, replay). The UI talks to it only through PROTOCOL.md.
* `ui/`: the desktop, static files, no build step.
* `docs/`: the site.
* `test/`: vitest tests. Engine tests use a fake brain, so no model is needed.

## Rules

* Keep the protocol stable: add fields and types, never rename or remove them.
* Tools stay inside the workspace. Anything that can destroy work goes through approval mode.
* No emoji and no en or em dashes in code, docs or messages. `npm run rules` checks this.
* Honest claims only: if something does not work yet, say so in the README.
* Small pull requests with a test for the change are the easiest to review.
