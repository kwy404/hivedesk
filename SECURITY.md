# Security

## What hivedesk protects

* The server binds to 127.0.0.1 only. Every request needs the per run token (in the URL, a header or an HttpOnly SameSite=Strict cookie), the Host header must be the local address, and the WebSocket refuses other origins.
* Tools only reach files inside `.hivedesk/workspace/`. Absolute paths, `..`, drive letters, UNC paths and links that point outside are refused.
* `run` has an allow list (`node <file>`, `npm test`, `npm run <script>`), no shell, a timeout, an output cap and a small environment. With Node 20 or newer, `node` runs with file system permission flags limited to the workspace.
* Approval mode is on by default: commands, deletes and changes to files that existed before the job wait for your answer.
* The live preview is served with a sandbox Content Security Policy, so a generated page cannot call the hivedesk API.
* An API key for an endpoint is kept in memory only and is never written to the event log.

## Known limits

* Network access from `run` is blocked on a best effort basis only (proxy variables and npm offline). A script run through `npm run` can still reach the network. Review commands before you approve them.
* The model can write any content into the workspace, including code that is unsafe to run outside hivedesk. Review before you use it elsewhere.
* Lend mode sends prompts (which can contain your workspace files) to the friend you paired with. Pair only with people you trust.

## Reporting a problem

Please open a private security advisory on the GitHub repository (Security tab, "Report a vulnerability"), or contact the author through the GitHub profile https://github.com/kwy404. Please do not open a public issue for a vulnerability.
