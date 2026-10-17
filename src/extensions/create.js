// "Create an extension with the crew": Mel sets up the folder (manifest, code stubs), then a
// normal job finishes it with diffs and approvals. The crew writes in the workspace under
// extensions/<id>/ and every change is mirrored to ~/.hivedesk/extensions/dev/<id>, where
// the host hot reloads it. When the job ends the UI offers "Install and test".
import fs from 'node:fs';
import path from 'node:path';
import { guessSpec } from './intent.js';
import { inside, readManifest } from './host.js';
import { MANIFEST_FILE } from './manifest.js';

const pretty = (o) => JSON.stringify(o, null, 2) + '\n';

/** The starting files for a widget or a worker extension. */
export function scaffold(spec) {
  const { id, name, goal, domains } = spec;
  const files = {};
  if (spec.kind === 'role') {
    files[MANIFEST_FILE] = pretty({
      manifest: 1, id, name, version: '0.1.0', author: 'You and the hivedesk crew',
      description: goal,
      permissions: ['crew.roles', 'workspace.read'],
      contributes: {
        roles: [{
          id: 'main', name: name.slice(0, 32), role: name.slice(0, 64), color: '#9BC7FF', avatar: name.slice(0, 1).toUpperCase(),
          prompt: `You are ${name}, a member of the crew. Your job: ${goal}. Read the files, explain what you find in short clear points and give concrete fixes. You never write files.`,
          tools: ['list_files', 'read_file', 'check']
        }]
      }
    });
    files['README.md'] = `# ${name}\n\nA hivedesk extension that adds a worker to the crew.\n\nGoal: ${goal}\n`;
    return files;
  }
  const permissions = ['storage', 'notify', ...domains.map((d) => `http.get:${d}`)];
  files[MANIFEST_FILE] = pretty({
    manifest: 1, id, name, version: '0.1.0', author: 'You and the hivedesk crew',
    description: goal,
    permissions,
    main: 'main.js',
    contributes: {
      tools: [{
        id: 'fetch_data', description: `Get the data the ${name} widget shows.`,
        parameters: { type: 'object', properties: { query: { type: 'string', description: 'what to look up' } }, required: [], additionalProperties: false }
      }],
      widgets: [{ id: 'panel', title: name, entry: 'widget.html', size: [360, 320], icon: 'hive' }],
      commands: [{ id: 'open', title: `Open ${name}`, action: { type: 'widget', widget: 'panel' } }]
    }
  });
  const url = domains.length ? `https://${domains[0]}/` : null;
  files['main.js'] = [
    '// Tools run in the hivedesk sandbox: no fetch, no Node, no imports from outside this folder.',
    '// Everything goes through `api` and the permissions in hivedesk-extension.json.',
    'export const tools = {',
    '  async fetch_data(args, api) {',
    url ? `    const r = await api.http.get('${url}');` : "    const saved = await api.storage.get('last');",
    url ? '    return r.json ?? r.text;' : "    return { message: 'Hello from the sandbox', query: args.query || '', saved };",
    '  }',
    '};',
    ''
  ].join('\n');
  files['widget.html'] = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    `  <title>${name}</title>`,
    '  <link rel="stylesheet" href="widget.css">',
    '</head>',
    '<body>',
    '  <main>',
    `    <h1>${name}</h1>`,
    '    <p id="out">Loading...</p>',
    '    <button id="refresh" type="button">Refresh</button>',
    '  </main>',
    '  <script src="widget.js"></script>',
    '</body>',
    '</html>',
    ''
  ].join('\n');
  files['widget.js'] = [
    "// The widget runs in a sandboxed frame. `hivedesk.call` runs a tool of this extension.",
    "const out = document.getElementById('out');",
    'async function load() {',
    "  out.textContent = 'Loading...';",
    '  try {',
    "    const data = await hivedesk.call('fetch_data', {});",
    "    out.textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);",
    '  } catch (err) {',
    '    out.textContent = err.message;',
    '  }',
    '}',
    "document.getElementById('refresh').addEventListener('click', load);",
    'load();',
    ''
  ].join('\n');
  files['widget.css'] = [
    'body { margin: 0; font: 14px/1.5 var(--hd-font, system-ui, sans-serif); color: var(--hd-text, #F2E9DA); background: transparent; }',
    'main { padding: 14px; }',
    'h1 { font-size: 16px; margin: 0 0 8px; }',
    '#out { white-space: pre-wrap; color: var(--hd-muted, #9A8F80); }',
    'button { font: inherit; padding: 6px 12px; border-radius: 8px; border: 0; background: var(--hd-accent, #FFB531); color: var(--hd-accent-ink, #1A1206); cursor: pointer; }',
    ''
  ].join('\n');
  return files;
}

/** The request the crew works from. */
export function jobRequest(spec, folder) {
  const lines = [
    `Finish the hivedesk extension "${spec.name}" in the folder ${folder}/ of the workspace. Goal: ${spec.goal}`,
    `The folder already has a working scaffold (${MANIFEST_FILE} and stubs). Keep every file inside ${folder}/ and keep the manifest format.`
  ];
  if (spec.kind === 'role') {
    lines.push('This extension adds a worker: improve the role, the prompt and the tools list in the manifest (allowed tools: list_files, read_file, check, write_file, edit_file; write tools also need the "workspace.write" permission). Add a short README.md.');
  } else {
    lines.push(
      'The widget is widget.html (it may link widget.js and widget.css from the same folder; nothing else loads). It runs in a sandboxed frame and talks to hivedesk only with `await hivedesk.call("<tool>", args)`.',
      'Tools live in main.js as `export const tools = { name: async (args, api) => result }`. They may only use api.http.get(url) for the domains listed as "http.get:<domain>" permissions, api.storage.get/set, api.notify and api.workspace.read. No fetch, no imports from outside the folder.',
      'Every tool in main.js must also be listed under contributes.tools with a JSON schema for its arguments.'
    );
  }
  return lines.join('\n');
}

/**
 * Starts the flow. Returns at once with the job id; the files follow through the job.
 * @param {{ prompt: string, host: import('./host.js').ExtensionHost, hive: any, toolbox: any, bus: any, createJob: (spec: any) => { jobId: string, done: Promise<any> } }} ctx
 */
export async function createExtension(ctx) {
  const { prompt, host, hive, toolbox, bus } = ctx;
  const spec = { ...guessSpec(prompt), ...(ctx.spec || {}) };
  // A free id: another dev folder with the same name gets a number.
  let id = spec.id;
  for (let n = 2; host.reg[id] || fs.existsSync(path.join(host.dirs.dev, id)); n++) id = `${spec.id}-${n}`.slice(0, 40);
  spec.id = id;
  const folder = `extensions/${id}`;
  const devDir = path.join(host.dirs.dev, id);
  fs.mkdirSync(devDir, { recursive: true });

  // Mirror the crew's writes into the dev folder (and so into hot reload).
  const prefix = `${folder}/`;
  const off = bus.on((ev) => {
    if (ev.type !== 'file.changed' || typeof ev.data?.path !== 'string' || !ev.data.path.startsWith(prefix)) return;
    const abs = inside(devDir, ev.data.path.slice(prefix.length));
    if (!abs) return;
    try {
      if (ev.data.op === 'delete') fs.rmSync(abs, { force: true });
      else {
        const content = ev.data.content ?? toolbox.ws.read(ev.data.path);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
      }
    } catch { /* the next write tries again */ }
  });

  // Mel writes the scaffold with the normal tools, so it shows as diffs in the Files window.
  for (const [rel, content] of Object.entries(scaffold(spec))) {
    const out = await toolbox.execute('write_file', { path: `${folder}/${rel}`, content }, { workerId: 'mel', approval: false });
    if (!out.ok) { off(); throw Object.assign(new Error(`could not write the scaffold: ${out.error}`), { code: 'internal' }); }
  }
  hive.chat('mel', `I set up ${folder}/ for the new extension "${spec.name}" (a ${spec.kind === 'role' ? 'worker' : 'widget'}). The crew finishes it now; every change shows as a diff. When it is done you can install and test it.`);

  // The request is already a precise brief, so the prompt refiner is skipped.
  const { jobId, done } = ctx.createJob({ request: jobRequest(spec, folder), refine: false });
  bus.emit('extension.dev.started', { id, name: spec.name, kind: spec.kind, jobId, folder, path: devDir, prompt: String(prompt).slice(0, 300) }, { jobId });
  const finished = Promise.resolve(done).catch(() => {}).then(() => {
    const job = hive.state.jobs.find((j) => j.id === jobId);
    const m = readManifest(devDir);
    bus.emit('extension.dev.ready', { id, name: m.manifest?.name || spec.name, jobId, status: job?.status || 'unknown', ok: m.ok, errors: m.errors, path: devDir }, { jobId });
  });
  return { id, name: spec.name, kind: spec.kind, jobId, folder, path: devDir, finished, stop: off };
}
