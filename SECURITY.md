# Security

## What hivedesk protects

* The server binds to 127.0.0.1 only. Every request needs the per run token (in the URL, a header or an HttpOnly SameSite=Strict cookie), the Host header must be the local address, and the WebSocket refuses other origins.
* Tools only reach files inside `.hivedesk/workspace/`. Absolute paths, `..`, drive letters, UNC paths and links that point outside are refused.
* `run` has an allow list (`node <file>`, `npm test`, `npm run <script>`), no shell, a timeout, an output cap and a small environment. With Node 20 or newer, `node` runs with file system permission flags limited to the workspace.
* Approval mode is on by default: commands, deletes and changes to files that existed before the job wait for your answer.
* Work that does not come from you always waits for your answer, even with approval mode off: writes and saves from a Code together guest, and any write or command of a task whose model turns ran on a friend's machine. The approval card says where it comes from, and `npm run` shows the script it would run. Only you can answer these.
* Code together guests are checked by the engine, not only by your browser: a viewer can read and chat; a collaborator can also post tasks, edit files under your approval and bring a building. Only you hire agents, change their tools or tie a model to a building.
* When you lend your PC, the friend's turns run only on your local models (a cloud key of yours only if you allow it for that pairing), within a lease of minutes and turns, and a cancel stops your model.
* `--demo` runs in a folder and a home of its own and refuses a folder that holds a real project.
* Each extension runs in its own sandbox process, and the engine knows which extension is calling from the process, not from what the process says.
* The live preview is served with a sandbox Content Security Policy, so a generated page cannot call the hivedesk API.
* API keys for cloud providers are kept only in `~/.hivedesk/keys.json` (mode 600 where the OS supports it). They are never sent to the browser, never written to the event log or a WebSocket frame, and are redacted from error messages. The UI only sees whether a key is set.
* The access token is kept in `~/.hivedesk/token` (mode 600) so an installed app window keeps working; `--new-token` replaces it.
* Memory and session files stay on this computer. Relevant memories go into the prompts of the brain that serves a job, so a cloud provider sees them only when it is that brain.

## Known limits

* Network access from `run` is blocked on a best effort basis only (proxy variables and npm offline). A script run through `npm run` can still reach the network. Review commands before you approve them.
* The model can write any content into the workspace, including code that is unsafe to run outside hivedesk. Review before you use it elsewhere.
* A cloud provider receives the prompts and the file contents sent to it, and bills your account.
* Lend mode sends prompts (which can contain your workspace files) to the friend you paired with. Pair only with people you trust.

## Reporting a problem

Please open a private security advisory on the GitHub repository (Security tab, "Report a vulnerability"), or contact the author through the GitHub profile https://github.com/kwy404. Please do not open a public issue for a vulnerability.
