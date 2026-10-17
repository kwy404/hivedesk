// A small Hive City test rig: the real bus, scheduler, crew engine and tools, a scripted fake brain, no server.
import path from 'node:path';
import { EventBus } from '../../src/bus.js';
import { Scheduler } from '../../src/crew/scheduler.js';
import { Hive } from '../../src/crew/engine.js';
import { ToolBox, Workspace } from '../../src/tools/index.js';
import { Approvals } from '../../src/tools/approvals.js';
import { PlaybookStore } from '../../src/playbooks/index.js';
import { createFakeBrain } from '../../src/brain/fake.js';
import { City } from '../../src/city/index.js';
import { tmpDir } from '../helpers.js';

export const page = (body = '<p>Hello</p>') => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Hello</title>
</head>
<body>
  ${body}
</body>
</html>
`;

export const userTask = (messages) => (messages.find((m) => m.role === 'user')?.content.match(/Your task: ([^\n]+)/) || [])[1];
export const step = (messages) => messages.filter((m) => m.role === 'assistant').length;

/**
 * respond by schema: spec (Design), approved (Review), tasks (planner), improvedPrompt (report),
 * otherwise the worker script for the task title.
 */
export function scripted({ scripts = {}, review, plan, design } = {}) {
  const seen = [];
  const fn = (messages, options) => {
    const p = options.schema?.properties || {};
    seen.push({ messages, options });
    if (p.spec) return design ? design(messages) : { spec: 'A hello page in hello.html.', criteria: ['hello.html says hello'] };
    if (p.approved) return review ? review(messages) : { approved: true, issues: [] };
    if (p.tasks) return plan || { summary: 'One page.', tasks: [{ title: 'Write hello', detail: 'Write hello.html.', assignee: 'dev', dependsOn: [] }] };
    if (p.improvedPrompt) return { improvedPrompt: 'Build a hello page in hello.html with a title and a footer.', nextPrompts: ['Add a dark mode.', 'Add a footer link.'] };
    const title = userTask(messages);
    const s = scripts[title];
    const isQa = !!options.schema?.oneOf?.some((o) => o.properties?.tool?.const === 'report');
    if (!s) return isQa ? { tool: 'report', args: { passed: true, issues: [] } } : { tool: 'done', args: { summary: 'Done.' } };
    return s[Math.min(step(messages), s.length - 1)];
  };
  fn.seen = seen;
  return fn;
}

export function rig({ respond = scripted(), dir = tmpDir('hivedesk-city-'), home = tmpDir('hivedesk-cityhome-'), approvalMode = false, brain } = {}) {
  const bus = new EventBus({ file: path.join(dir, 'events.jsonl') });
  if (bus.state.settings.approvalMode !== approvalMode) bus.emit('settings.changed', { approvalMode });
  if (bus.state.settings.refine !== false) bus.emit('settings.changed', { refine: false });
  const scheduler = new Scheduler(bus);
  const approvals = new Approvals(bus, { autoApproveMs: approvalMode ? 20 : 0 });
  const ws = new Workspace(path.join(dir, 'ws'));
  const toolbox = new ToolBox({ workspace: ws, bus, approvals });
  const playbooks = new PlaybookStore(path.join(dir, 'pb'));
  const hive = new Hive({ bus, scheduler, toolbox, approvals, playbooks, maxTurns: 6 });
  hive.init();
  const local = brain || createFakeBrain({ id: 'local', respond });
  scheduler.addBrain(local);
  const city = new City({ bus, hive, scheduler, toolbox, home, projectDir: path.join(dir, 'city'), version: 'test' });
  city.start();
  const commands = new Map();
  city.register({ command: (type, fn) => commands.set(type, fn) });
  const run = async (type, data = {}) => commands.get(type)(data, null);
  const types = (prefix) => bus.events.filter((e) => e.type.startsWith(prefix)).map((e) => e.type);
  const of = (type) => bus.events.filter((e) => e.type === type);
  return { dir, home, bus, scheduler, approvals, ws, toolbox, hive, city, run, commands, types, of, brain: local, get s() { return bus.state.city; } };
}

/** A friend's brain, lent by owner (brain.attach with that guest's id). */
export function friendBrain(id = 'b_friend', respond = scripted(), owner = 'peer:g1') {
  const b = createFakeBrain({ id, label: 'Friend', respond });
  b.kind = 'remote';
  b.owner = owner;
  return b;
}

export const RITA = { id: 'g1', name: 'Rita', role: 'collaborator' };
export const joinRita = (r, extra = {}) => r.run('city.machine.join', {
  as: RITA,
  machine: { id: 'm_rita0001', name: "Rita's PC", gpu: { name: 'RTX 3060', vramBytes: 12e9 }, model: 'Qwen 7B' },
  agents: [{ id: 'pip', name: 'Pip', role: 'Reviewer', specialization: ['review', 'test'], tools: ['list_files', 'read_file', 'check', 'run'], xp: 30 }],
  brainId: 'b_friend', via: 'words', ...extra
});
