# Extensions

An extension is a folder with a `hivedesk-extension.json` manifest and, when it needs code, a few ES modules. It can add:

* **crew roles**: workers with a prompt and a tools list;
* **tools** that workers, widgets and commands can call, running in a sandbox;
* **commands** for the Ctrl K palette;
* **widgets**: windows rendered in a sandboxed frame that talk to hivedesk through a message API;
* **themes** (see [THEMES.md](THEMES.md)).

Extensions never get Node.js or the file system. Everything they do goes through a small API, and every call is checked against the permissions the user approved.

Open the **Extensions** window from the dock or with Ctrl K, "Open Extensions".

## Built-in examples

They ship in `extensions/` and start turned off. Turning one on shows its permissions first.

| Folder | What it shows |
| --- | --- |
| `extensions/tradutor` | **Tradutor**: a translator worker (a crew role) plus two palette commands that start translation jobs. |
| `extensions/seo-check` | **SEO Check**: a tool (`seo-check.audit`) that reads the HTML pages of the workspace and scores title, description, headings, image text, language, viewport and link preview tags, plus a widget that shows the report. |
| `extensions/pomodoro` | **Pomodoro**: a widget only. A focus timer that keeps its settings with `storage` and ends each block with `notify`. |

## The manifest

```json
{
  "manifest": 1,
  "id": "seo-check",
  "name": "SEO Check",
  "version": "1.0.0",
  "author": "hivedesk",
  "description": "Checks the HTML pages in the workspace for SEO basics.",
  "permissions": ["workspace.read", "storage"],
  "main": "main.js",
  "contributes": {
    "tools": [
      {
        "id": "audit",
        "description": "Check the HTML pages and return a score with the issues per page.",
        "parameters": {
          "type": "object",
          "properties": { "path": { "type": "string" } },
          "required": [],
          "additionalProperties": false
        }
      }
    ],
    "widgets": [{ "id": "report", "title": "SEO Check", "entry": "widget.html", "size": [420, 460], "icon": "qa" }],
    "commands": [
      { "id": "open", "title": "SEO Check: open the report", "action": { "type": "widget", "widget": "report" } },
      { "id": "run", "title": "SEO Check: check every page now", "action": { "type": "tool", "tool": "audit", "args": {} } }
    ]
  }
}
```

| Key | Rules |
| --- | --- |
| `manifest` | `1` |
| `id` | 2 to 40 lowercase letters, digits or dashes, starting with a letter. Unique. |
| `name`, `description`, `author` | required text (`author` may also be `{ "name": "..." }`) |
| `version` | `1.2.3` style |
| `permissions` | the capabilities below; anything else is an error |
| `main` | the ES module that exports the tools (needed when there are tools) |
| `contributes.tools[]` | `{ id, description, parameters, destructive? }`. `parameters` is a JSON schema (the engine's subset: type, properties, required, additionalProperties, items, enum, const, oneOf, anyOf, minLength, maxLength, minItems, maxItems). The tool is registered as `<extension id>.<tool id>`. `destructive: true` makes it ask for approval in approval mode. |
| `contributes.roles[]` | `{ id, name, role, prompt, color?, avatar?, tools }`. Needs `crew.roles`. `tools` may hold the extension's own tool ids and the builtin `list_files`, `read_file`, `check`, `preview` (need `workspace.read`), `write_file`, `edit_file` (need `workspace.write`). `run` and `delete_file` are never available to extension workers. |
| `contributes.widgets[]` | `{ id, title, entry, size?, icon? }`. `entry` is an `.html` file in the folder. |
| `contributes.commands[]` | `{ id, title, action }` where `action` is `{ "type": "widget", "widget": "<id>" }`, `{ "type": "tool", "tool": "<id>", "args": {} }`, `{ "type": "job", "request": "..." }` or `{ "type": "theme", "theme": "<id>" }` |
| `contributes.themes[]` | paths of `.hivedesk-theme.json` files in the folder |

The Extensions window lists every problem of a manifest in plain words, and an invalid manifest never runs.

## Permissions

hivedesk uses capabilities: an extension can only do what its manifest asks for and the user approved. On install, enable or a new version that asks for more, the user sees each permission with its risk and can untick the ones they do not want. A permission can also be taken back later by clicking its chip in the Extensions window.

| Permission | Risk | Allows |
| --- | --- | --- |
| `workspace.read` | medium | `api.workspace.list()`, `api.workspace.read(path)` (up to 256 KB per read) |
| `workspace.write` | high | `api.workspace.write(path, content)`. Goes through the normal write tool: the change shows as a diff, and replacing an existing file asks for approval in approval mode. |
| `http.get:<host>` | high | `api.http.get(url)` to that exact host over HTTPS, GET only, 10 s timeout, 512 KB cap, redirects followed only to allowed hosts. `http.get:*.example.com` allows the subdomains. |
| `storage` | low | `api.storage.get(key)`, `api.storage.set(key, value)`: 64 KB of JSON in `~/.hivedesk/extensions/data/<id>.json` |
| `notify` | low | `api.notify(title, body)`: a desktop notification |
| `crew.chat` | low | `api.chat(text)`: a message in #general, prefixed with the extension's name |
| `crew.roles` | medium | adding the manifest's roles as workers |
| `brain.ask` | medium | `api.ask(prompt, schema?)`: one model turn in the shared queue (it waits its turn like a worker) |

A call without the permission fails with `permission denied: <id> was not given "<permission>"`, the event `extension.denied` is logged, and the desktop shows a notice.

## Tools: the sandbox and the `api` object

`main` exports the tools, either as `export const tools = { ... }` or `export default { tools: { ... } }`. Each tool gets the validated arguments and the `api`:

```js
// main.js
import { checkPage } from './rules.js';

export const tools = {
  async audit(args, api) {
    const files = await api.workspace.list();
    const pages = files.map((f) => f.path).filter((p) => p.endsWith('.html'));
    const results = [];
    for (const path of pages) results.push({ path, ...checkPage(await api.workspace.read(path)) });
    await api.storage.set('last', results);
    return { pages: results };
  }
};
```

The return value is sent back as JSON (workers see it as text).

```text
api.workspace.list()              -> [{ path, bytes }]
api.workspace.read(path)          -> string
api.workspace.write(path, text)   -> string (the tool result)
api.http.get(url)                 -> { status, contentType, text, json?, truncated }
api.storage.get(key?)             -> value (all keys without a key)
api.storage.set(key, value)       -> true
api.notify(title, body?)          -> true
api.chat(text)                    -> true
api.ask(prompt, schema?)          -> string, or the parsed JSON when a schema is given
```

How the code runs:

* All extension code runs in **one separate Node.js process**, started on the first tool call and stopped after a quiet minute, so idle extensions use no memory. It has a 64 MB heap.
* That process runs under Node's **permission model** when the runtime has it (Node 20 and newer: `--permission`, or `--experimental-permission`): no file system access beyond its own launcher file, no child processes, no worker threads, no native addons. The Extensions window says so, or warns when the runtime lacks it.
* Inside it, each extension runs in its own **vm context** as real ES modules, with no `process`, `require`, `fetch` or timers, code generation from strings turned off, and `import` limited to relative paths inside the extension folder. The only way out is `api`, whose calls travel to the engine and are checked there.
* A call that takes longer than 20 s stops the sandbox process (it restarts on the next call).

Honest limits: the vm context alone is not a security boundary; the separate process with the permission model is the real wall. Node's permission model does not block network access in every Node version, so a crafted extension that escaped the vm context could reach the network from that process. Install extensions you trust.

## Widgets: the frame and the message API

A widget is one HTML file. Its `<script src>` and `<link rel="stylesheet" href>` tags that point at files in the extension folder are inlined; any other link is dropped. The page is rendered in an `<iframe sandbox="allow-scripts">` from `srcdoc`, which makes it an opaque origin with no access to the desktop, its cookies or its storage, under this policy:

```text
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;
media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; worker-src 'none'
```

So a widget cannot load anything or talk to any server. It talks to hivedesk only through `window.hivedesk`, defined before the widget's own scripts run:

```js
const report = await hivedesk.call('audit', {});        // a tool of this extension
const last = await hivedesk.storage.get('last');        // needs "storage"
await hivedesk.storage.set('focus', 25);                // needs "storage"
await hivedesk.notify('Focus block done', 'Break time'); // needs "notify"
hivedesk.resize(480);                                    // a minimum height in px
hivedesk.on('theme', (vars) => { /* new theme values */ });
```

`hivedesk.call` reaches only the tools of the same extension. The theme is available as CSS variables that follow the desktop live: `--hd-bg`, `--hd-panel`, `--hd-panel-2`, `--hd-line`, `--hd-text`, `--hd-muted`, `--hd-accent`, `--hd-accent-ink`, `--hd-ok`, `--hd-bad`, `--hd-font`, `--hd-mono`, `--hd-radius`.

Under the hood each call is a `postMessage` of `{ hd: 1, id, type, data }` and the answer is `{ hd: 1, type: "reply", id, ok, result | error }`. The desktop accepts a message only from the frame it created (and an opaque `null` origin), and only in these exact shapes; anything else is rejected without reaching the engine:

| type | data |
| --- | --- |
| `ready` | `{}` |
| `call` | `{ tool, args? }` (tool id: lowercase letters, digits, `_` or `-`) |
| `storage.get` | `{ key? }` |
| `storage.set` | `{ key, value }` (value up to 16 KB of JSON) |
| `notify` | `{ title, body? }` |
| `resize` | `{ height }` (40 to 2000) |

Messages are capped at 64 KB. See `ui/extensions/bridge.js` and its tests.

## Installing

In the Extensions window, **Add**:

* **A folder or a .zip on this computer**: type its path. A `.zip` can also be picked with the file chooser. The files are copied to `~/.hivedesk/extensions/installed/<id>/`.
* **A URL** (`https://` only, a `.zip` of up to 5 MB): the window shows a strong warning, and the permission prompt needs an extra "I trust the author" tick before anything runs.

Zips with paths that leave the folder, more than 200 files or more than 5 MB unpacked are refused. Nothing from an extension runs before the user approves its permissions. Built-in examples can be turned off but not removed; uninstalling any other extension deletes its files and its stored data.

## Create an extension with the crew

Type a request in the top bar or in **Create with the crew**:

```text
crie uma extensão que mostra o clima
crie um worker revisor de código
make a weather widget
```

1. Mel scaffolds the folder: a valid manifest and code stubs for a widget (with an `http.get` permission when the request talks about the weather, for example) or for a worker. The files are written with the normal tools into the workspace under `extensions/<id>/`, so they show as diffs.
2. A normal job starts with a precise request: the crew finishes the manifest and the code with the usual plan, turns, diffs, approvals and QA.
3. Every change under `extensions/<id>/` is mirrored to `~/.hivedesk/extensions/dev/<id>/`.
4. When the job ends, a notification and the Create tab offer **Install and test** ("Instalar e testar"): the folder is registered as an extension in development, the permission prompt opens, and its widget or worker opens after approval.

Extensions in development **hot reload**: hivedesk watches their folder, and saving a file restarts the extension and reloads its widgets. A new version that asks for more permissions is turned off until the user approves them again. The Reload button does the same by hand.

You can also make a folder in `~/.hivedesk/extensions/dev/` yourself and ask the engine to add it (`extensions.addDev`).

## Engine commands and events

Commands (PROTOCOL.md section 4 style):

| Command | Data | Result |
| --- | --- | --- |
| `extensions.list` | `{}` | `{ extensions, devDir, isolated }` |
| `extensions.install` | `{ path }`, `{ zipBase64 }` or `{ url }` | `{ extension, warnings, needsApproval, risk: "local" \| "url" }` |
| `extensions.approve` | `{ id, grant?, acceptRisk? }` | `{ extension }` (grant defaults to every requested permission) |
| `extensions.enable` / `extensions.disable` | `{ id }` | `{ extension }` |
| `extensions.revoke` | `{ id, permission }` | `{ extension }` |
| `extensions.uninstall` | `{ id, deleteFiles? }` | `{}` |
| `extensions.reload` | `{ id }` | `{ extension }` |
| `extensions.addDev` | `{ name }` | like `extensions.install` |
| `extensions.create` | `{ prompt }` | `{ id, name, kind, jobId, folder, path }` |
| `extensions.call` | `{ id, tool, args }` | `{ result }` |
| `extensions.cap` | `{ id, cap: "storage.get" \| "storage.set" \| "notify", args }` | `{ result }` (used by widget frames) |
| `extensions.widget` | `{ id, widget }` | `{ widget, html, files, granted, name }` |

Events: `extension.installed`, `extension.enabled`, `extension.disabled`, `extension.revoked`, `extension.uninstalled`, `extension.reloaded { id, ok, errors?, needsApproval?, added? }`, `extension.denied { id, permission, cap }`, `extension.dev.started { id, name, kind, jobId, folder, path }`, `extension.dev.ready { id, name, jobId, status, ok, errors, path }`. Live frames: `extension.notify`, `extension.log`.

## Where things live

| Path | What |
| --- | --- |
| `extensions/` in the package | the built-in examples |
| `~/.hivedesk/extensions/registry.json` | which extensions are installed, on, and what they were granted |
| `~/.hivedesk/extensions/installed/<id>/` | installed copies |
| `~/.hivedesk/extensions/dev/<id>/` | extensions in development (hot reloaded) |
| `~/.hivedesk/extensions/data/<id>.json` | `storage` data |
| `src/extensions/` | the host, the manifest checks, the sandbox, the zip reader and the create flow |
| `ui/extensions/` | the Extensions window, the permission prompt, widget frames and the bridge |
