// End to end check with a real local model (not part of the unit tests).
// Usage: node test/e2e-local.mjs --model <file.gguf> [--request "..."] [--dir <folder>] [--cpu]
// Set HIVEDESK_RUNTIME to a node_modules folder that has node-llama-cpp to skip the runtime install.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHive } from '../src/index.js';
import { checkWorkspace } from '../src/tools/check.js';

const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
const model = arg('model');
if (!model) {
  console.error('usage: node test/e2e-local.mjs --model <file.gguf>');
  process.exit(2);
}
const request = arg('request', 'A tiny static page for a coffee stand called Bean There: a heading, a short menu with three drinks and prices, and opening hours. Use index.html and style.css.');
const dir = arg('dir') || fs.mkdtempSync(path.join(os.tmpdir(), 'hivedesk-e2e-'));
// Never start a model on a machine that is short of memory (the engine checks too, this stops earlier).
if (os.freemem() < 4e9) {
  console.error(`only ${(os.freemem() / 1e9).toFixed(1)} GB of RAM free; need 4 GB. Skipping.`);
  process.exit(3);
}
const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(1);

const app = await startHive({
  dir,
  log: (l) => console.log(`[${secs()}s] ${l}`),
  flags: { model, gpu: argv.includes('--cpu') ? false : undefined }
});
console.log(`[${secs()}s] server ${app.url}`);

app.bus.on((e) => {
  const d = e.data;
  if (e.type === 'turn.ended') console.log(`[${secs()}s] turn ${d.workerId} ${d.promptTokens}+${d.completionTokens} tok, ${(d.ms / 1000).toFixed(1)}s, ${d.tps} tok/s${d.error ? ' ERROR ' + d.error : ''}`);
  else if (e.type === 'tool.called') console.log(`[${secs()}s]   ${d.workerId} -> ${d.tool} ${d.args?.path || d.args?.command || ''}`);
  else if (e.type === 'tool.result' && !d.ok) console.log(`[${secs()}s]   tool error: ${d.error}`);
  else if (e.type === 'task.status') console.log(`[${secs()}s] task ${d.taskId} ${d.status}${d.note ? ': ' + d.note : ''}`);
  else if (e.type === 'chat.message') console.log(`[${secs()}s] chat ${d.from}: ${d.text.replace(/\n/g, ' / ').slice(0, 300)}`);
  else if (e.type === 'approval.requested') {
    console.log(`[${secs()}s] approval asked: ${d.approval.summary} (approving)`);
    setTimeout(() => app.approvals.resolve(d.approval.id, true, 'e2e'), 100);
  } else if (e.type === 'brief.proposed') {
    const text = d.brief.text.split('\n').map((l) => `    ${l}`).join('\n');
    console.log(`[${secs()}s] brief proposed (using it):\n${text}`);
    setTimeout(() => app.hive.approveBrief(e.jobId, { use: 'refined' }), 100);
  } else if (e.type === 'job.report') {
    console.log(`[${secs()}s] improved prompt: ${d.improvedPrompt}\n[${secs()}s] next prompts: ${d.nextPrompts.join(' | ')}`);
  } else if (e.type === 'brain.status') console.log(`[${secs()}s] brain ${d.state} ${d.model || ''} ${d.detail || ''}`);
  else if (e.type === 'qa.report') console.log(`[${secs()}s] QA ${d.passed ? 'passed' : 'failed'}: ${d.issues.join(' | ')}`);
});

// Wait for the model.
while (!['ready', 'error', 'needs_download'].includes(app.bus.state.brain.state)) await new Promise((r) => setTimeout(r, 500));
if (app.bus.state.brain.state !== 'ready') {
  console.log('brain not ready:', app.bus.state.brain);
  await app.close();
  process.exit(1);
}
const loadedAt = secs();
const { jobId, done } = app.hive.createJob({ request });
await done;
const job = app.bus.state.jobs.find((j) => j.id === jobId);
const files = app.toolbox.ws.list();
const checks = checkWorkspace(app.toolbox.ws);
console.log('\n==== result ====');
console.log(`model ready after ${loadedAt}s, job ${job.status} after ${secs()}s: ${job.summary || job.error || ''}`);
console.log(`tokens: prompt ${app.bus.state.tokens.prompt}, completion ${app.bus.state.tokens.completion}`);
console.log(`files: ${files.map((f) => `${f.path} (${f.bytes} B)`).join(', ') || 'none'}`);
console.log(`static checks: ${checks.passed ? 'passed' : checks.issues.join(' | ')}`);
console.log(`workspace: ${app.toolbox.ws.root}`);
const summary = { status: job.status, seconds: Number(secs()), loadSeconds: Number(loadedAt), tokens: app.bus.state.tokens, files, checks, tasks: job.taskIds.map((id) => app.bus.state.tasks[id]) };
fs.writeFileSync(path.join(dir, 'e2e-summary.json'), JSON.stringify(summary, null, 2));
await app.close();
process.exit(0);
