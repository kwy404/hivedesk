// Runs the 0.2.0 engine (git archive 10d9f2d) with a scripted brain and writes real 0.2 logs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHive } from './src/index.js';
import { createFakeBrain } from './src/brain/fake.js';

const out = process.argv[2];
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const page = '<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>Hello</title>\n</head>\n<body>\n  <p>Hello</p>\n</body>\n</html>\n';
const userTask = (messages) => (messages.find((m) => m.role === 'user')?.content.match(/Your task: ([^\n]+)/) || [])[1];
const step = (messages) => messages.filter((m) => m.role === 'assistant').length;
const scripts = {
  'Write the page': [{ tool: 'write_file', args: { path: 'index.html', content: page } }, { tool: 'done', args: { summary: 'Wrote index.html.' } }],
  'Write the styles': [{ tool: 'write_file', args: { path: 'style.css', content: 'body { color: #222; }\n' } }, { tool: 'done', args: { summary: 'Wrote style.css.' } }],
  'Write the notes': [{ tool: 'fail', args: { reason: 'no' } }]
};
const respond = (messages, options) => {
  const p = options.schema?.properties || {};
  if (p.spec) return { spec: 'A hello page.', criteria: ['index.html says hello'] };
  if (p.approved) return { approved: true, issues: [] };
  if (p.tasks) return { summary: 'Two files.', tasks: [
    { title: 'Write the page', detail: 'Write index.html.', assignee: 'dev', dependsOn: [] },
    { title: 'Write the styles', detail: 'Write style.css.', assignee: 'designer', dependsOn: [0] },
    { title: 'Write the notes', detail: 'Write notes.md.', assignee: 'writer', dependsOn: [] }
  ] };
  if (p.improvedPrompt) return { improvedPrompt: 'Build a hello page in index.html with a stylesheet.', nextPrompts: ['Add a dark mode.', 'Add a footer.'] };
  const isQa = !!options.schema?.oneOf?.some((o) => o.properties?.tool?.const === 'report');
  const s = scripts[userTask(messages)];
  if (!s) return isQa ? { tool: 'report', args: { passed: true, issues: [] } } : { tool: 'done', args: { summary: 'Done.' } };
  return s[Math.min(step(messages), s.length - 1)];
};
const wait = async (fn, ms = 20000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); } };

// 1. A real project: a crew job (three planner tasks, one depends on another, one fails), then a city task.
const dir = tmp('hd02-real-');
const home = tmp('hd02-home-');
let app = await startHive({ dir, home, brain: createFakeBrain({ respond }), maxTurns: 6 });
app.hive.setSettings({ approvalMode: false, refine: false });
const { jobId } = app.hive.createJob({ request: 'A hello page with styles and notes' });
await wait(() => ['done', 'failed'].includes(app.bus.state.jobs.find((j) => j.id === jobId)?.status) && app.bus.state.jobs.find((j) => j.id === jobId)?.report);
const created = await app.server.runCommand('city.task.create', { title: 'Review the page', room: 'review' });
const cityTaskId = created.task.id;
await wait(() => ['done', 'blocked'].includes(app.bus.state.city.tasks[cityTaskId]?.status));
await app.server.runCommand('city.task.create', { title: 'Later idea', room: 'lobby' }).then((r) => app.server.runCommand('city.task.cancel', { taskId: r.task.id }));
await new Promise((r) => setTimeout(r, 300));
await app.close();
fs.copyFileSync(path.join(dir, '.hivedesk', 'events.jsonl'), path.join(out, 'real-0.2.jsonl'));

// 2. The same project after one "--demo --dir" run of 0.2 and one more real start: demo events in a real log.
app = await startHive({ dir, home, demo: true, demoDelayMs: 0, demoApproveMs: 10, autoStartDemo: true, log: (l) => console.log('LOG', l) });
setTimeout(() => console.log('STEPS', app.bus.events.filter((e) => e.type === 'city.demo.step').map((e) => e.data.step), app.bus.state.jobs.map((j) => j.status)), 30000).unref();
await wait(() => app.bus.events.some((e) => e.type === 'city.demo.step' && e.data.step === 'task'), 40000);
await new Promise((r) => setTimeout(r, 4000));
await app.close();
app = await startHive({ dir, home, brain: createFakeBrain({ respond }) });
await app.close();
fs.copyFileSync(path.join(dir, '.hivedesk', 'events.jsonl'), path.join(out, 'demo-in-real-0.2.jsonl'));
console.log('ok', fs.statSync(path.join(out, 'real-0.2.jsonl')).size, fs.statSync(path.join(out, 'demo-in-real-0.2.jsonl')).size);
process.exit(0);
