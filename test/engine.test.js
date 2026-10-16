import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { EventBus } from '../src/bus.js';
import { Scheduler } from '../src/crew/scheduler.js';
import { Hive } from '../src/crew/engine.js';
import { ToolBox, Workspace } from '../src/tools/index.js';
import { Approvals } from '../src/tools/approvals.js';
import { PlaybookStore } from '../src/playbooks/index.js';
import { createFakeBrain } from '../src/brain/fake.js';
import { createDemoBrain, demoRespond } from '../src/demo.js';
import { normalizePlan, makePlan } from '../src/crew/planner.js';
import { compactAction, workerSchema } from '../src/crew/worker.js';
import { BUILTIN } from '../src/crew/workers.js';
import { validate } from '../src/brain/schema.js';
import { tmpDir, waitFor } from './helpers.js';

function setup(respond, opts = {}) {
  const dir = tmpDir();
  const bus = new EventBus();
  if (opts.approvalMode === false) bus.emit('settings.changed', { approvalMode: false });
  const scheduler = new Scheduler(bus);
  const approvals = new Approvals(bus);
  const ws = new Workspace(path.join(dir, 'ws'));
  const toolbox = new ToolBox({ workspace: ws, bus, approvals });
  const playbooks = new PlaybookStore(path.join(dir, 'pb'));
  const hive = new Hive({ bus, scheduler, toolbox, approvals, playbooks, maxTurns: opts.maxTurns });
  hive.init();
  const brain = typeof respond === 'function' ? createFakeBrain({ respond }) : respond;
  scheduler.addBrain(brain);
  return { bus, scheduler, approvals, ws, toolbox, playbooks, hive, brain };
}

const userTask = (messages) => (messages.find((m) => m.role === 'user')?.content.match(/Your task: ([^\n]+)/) || [])[1];
const step = (messages) => messages.filter((m) => m.role === 'assistant').length;

describe('the full loop', () => {
  it('runs request, plan, workers, tools, QA, fix round and done with the demo script', async () => {
    const t = setup(createDemoBrain({ delayMs: 0, tokenDelayMs: 0 }), { approvalMode: false });
    const { jobId, done } = t.hive.createJob({ request: 'A tiny landing page for Crumb, a bakery' });
    await done;
    const s = t.bus.state;
    const job = s.jobs.find((j) => j.id === jobId);
    expect(job.status).toBe('done');
    expect(job.summary).toBe('Finished, and QA passed.');
    const tasks = job.taskIds.map((id) => s.tasks[id]);
    expect(tasks.map((x) => [x.assignee, x.status])).toEqual([
      ['designer', 'done'], ['dev', 'done'], ['writer', 'done'], ['qa', 'done'], ['dev', 'done'], ['qa', 'done']
    ]);
    expect(t.ws.list().map((f) => f.path).sort()).toEqual(['README.md', 'app.js', 'bread.svg', 'index.html', 'style.css']);
    expect(t.ws.read('index.html')).toContain('alt="A fresh loaf of bread"');
    const reports = t.bus.events.filter((e) => e.type === 'qa.report').map((e) => e.data.passed);
    expect(reports).toEqual([false, true]);
    expect(t.bus.events.filter((e) => e.type === 'playbook.saved')).toHaveLength(1);
    expect(t.playbooks.list()[0].tasks.map((x) => x.assignee)).toEqual(['designer', 'dev', 'writer', 'qa']);
    // Workers took turns on one brain.
    const started = t.bus.events.filter((e) => e.type === 'turn.started');
    const ended = t.bus.events.filter((e) => e.type === 'turn.ended');
    expect(started.length).toBe(ended.length);
    let open = 0;
    for (const e of t.bus.events) {
      if (e.type === 'turn.started') open++;
      if (e.type === 'turn.ended') open--;
      expect(open).toBeLessThanOrEqual(1);
    }
    // Every write produced a diff event.
    expect(t.bus.events.filter((e) => e.type === 'file.changed').length).toBeGreaterThanOrEqual(6);
    expect(Object.values(s.workers).every((w) => w.status === 'idle')).toBe(true);
  });

  it('waits for approval before running a command and continues after it', async () => {
    const respond = (messages, options) => {
      if (options.schema?.properties?.tasks) return { summary: 's', tasks: [{ title: 'Run it', detail: 'run', assignee: 'dev', dependsOn: [] }] };
      if (userTask(messages) === 'Run it') {
        return [
          { tool: 'write_file', args: { path: 'a.js', content: 'console.log(40 + 2)' } },
          { tool: 'run', args: { command: 'node a.js' } },
          { tool: 'done', args: { summary: 'ran' } }
        ][step(messages)];
      }
      return { tool: 'report', args: { passed: true, issues: [] } };
    };
    const t = setup(respond);
    const { done } = t.hive.createJob({ request: 'run a script' });
    const approval = await waitFor(() => t.bus.state.approvals[0]);
    expect(approval).toMatchObject({ tool: 'run', summary: 'Run: node a.js', workerId: 'dev' });
    expect(t.bus.state.workers.dev.status).toBe('waiting_approval');
    expect(t.bus.events.some((e) => e.type === 'run.finished')).toBe(false);
    t.approvals.resolve(approval.id, true);
    await done;
    const run = t.bus.events.find((e) => e.type === 'run.finished');
    expect(run.data.stdout.trim()).toBe('42');
    expect(t.bus.state.jobs[0].status).toBe('done');
  });

  it('a job created with approval off does not ask', async () => {
    const respond = (messages, options) => {
      if (options.schema?.properties?.tasks) return { summary: 's', tasks: [{ title: 'Run it', detail: '', assignee: 'dev', dependsOn: [] }] };
      if (userTask(messages) === 'Run it') return [{ tool: 'write_file', args: { path: 'a.js', content: '1' } }, { tool: 'run', args: { command: 'node a.js' } }, { tool: 'done', args: { summary: 'x' } }][step(messages)];
      return { tool: 'report', args: { passed: true, issues: [] } };
    };
    const t = setup(respond);
    await t.hive.createJob({ request: 'x', approval: false }).done;
    expect(t.bus.events.some((e) => e.type === 'approval.requested')).toBe(false);
  });

  it('reuses a playbook for a similar request', async () => {
    const t = setup(createDemoBrain({ delayMs: 0, tokenDelayMs: 0 }), { approvalMode: false });
    await t.hive.createJob({ request: 'A tiny landing page for Crumb, a bakery' }).done;
    t.brain.calls.length = 0;
    await t.hive.createJob({ request: 'landing page for a bakery called Crumb' }).done;
    const used = t.bus.events.find((e) => e.type === 'playbook.used');
    expect(used.data.score).toBeGreaterThan(0.5);
    const planCall = t.brain.calls.find((c) => c.options.schema?.properties?.tasks);
    expect(planCall.messages[1].content).toContain('A similar job went well before');
    expect(t.bus.state.jobs[1].playbookId).toBe(used.data.playbookId);
    expect(t.playbooks.list()).toHaveLength(1);
  });

  it('falls back to a default plan when the planner answer is unusable', async () => {
    const respond = (messages, options) => {
      if (options.schema?.properties?.tasks) return 'not json at all';
      if (userTask(messages) === 'Build it') return step(messages) === 0 ? { tool: 'write_file', args: { path: 'x.txt', content: 'x' } } : { tool: 'done', args: { summary: 'ok' } };
      return { tool: 'report', args: { passed: true, issues: [] } };
    };
    const t = setup(respond);
    await t.hive.createJob({ request: 'something' }).done;
    const planned = t.bus.events.find((e) => e.type === 'job.planned');
    expect(planned.data.tasks.map((x) => x.assignee)).toEqual(['dev', 'qa']);
    expect(t.bus.state.jobs[0].status).toBe('done');
  });

  it('cancels a running job', async () => {
    const t = setup((messages, options) => {
      if (options.schema?.properties?.tasks) return { summary: 's', tasks: [{ title: 'Slow', detail: '', assignee: 'dev', dependsOn: [] }] };
      return { tool: 'list_files', args: {} };
    });
    t.brain.chat = ((orig) => async (m, o) => { await new Promise((r) => setTimeout(r, 20)); return orig(m, o); })(t.brain.chat);
    const { jobId, done } = t.hive.createJob({ request: 'slow job' });
    await waitFor(() => t.bus.state.tasks[`t_1_1`]?.status === 'running');
    t.hive.cancelJob(jobId);
    await done;
    expect(t.bus.state.jobs[0].status).toBe('cancelled');
    expect(t.bus.state.tasks.t_1_1.status).toBe('skipped');
  });

  it('stops a worker that never finishes and keeps what it wrote', async () => {
    const t = setup((messages, options) => {
      if (options.schema?.properties?.tasks) return { summary: 's', tasks: [{ title: 'Loop', detail: '', assignee: 'dev', dependsOn: [] }] };
      if (userTask(messages) === 'Loop') return step(messages) === 0 ? { tool: 'write_file', args: { path: 'a.txt', content: 'a' } } : { tool: 'say', args: { text: 'still here' } };
      return { tool: 'report', args: { passed: true, issues: [] } };
    }, { maxTurns: 4 });
    await t.hive.createJob({ request: 'loop' }).done;
    expect(t.bus.state.tasks.t_1_1.status).toBe('done');
    expect(t.bus.state.tasks.t_1_1.note).toMatch(/stopped after 4 turns/);
  });

  it('routes user chat into the running job', async () => {
    let seen = '';
    const t = setup((messages, options) => {
      if (options.schema?.properties?.tasks) return { summary: 's', tasks: [{ title: 'Listen', detail: '', assignee: 'dev', dependsOn: [] }] };
      if (userTask(messages) === 'Listen') {
        seen = messages[1].content;
        return step(messages) < 2 ? { tool: 'list_files', args: {} } : { tool: 'done', args: { summary: 'ok' } };
      }
      return { tool: 'report', args: { passed: true, issues: [] } };
    });
    t.brain.chat = ((orig) => async (m, o) => { await new Promise((r) => setTimeout(r, 15)); return orig(m, o); })(t.brain.chat);
    const { done } = t.hive.createJob({ request: 'listen' });
    await waitFor(() => t.bus.state.tasks.t_1_1?.status === 'running');
    t.hive.userChat('dm:dev', 'please use blue');
    await done;
    expect(seen).toContain('please use blue');
    expect(t.bus.state.chat['dm:dev'][0]).toMatchObject({ from: 'user', text: 'please use blue' });
  });
});

describe('crew', () => {
  it('hires, updates and fires workers; the default crew stays', () => {
    const t = setup(() => ({}));
    expect(t.bus.state.crew.map((w) => w.id)).toEqual(['mel', 'dev', 'designer', 'qa', 'writer']);
    const w = t.hive.hire({ name: 'Ana', role: 'SEO', prompt: 'You write meta tags.', color: '#123456', tools: ['read_file', 'edit_file', 'rm'] });
    expect(w).toMatchObject({ name: 'Ana', color: '#123456', tools: ['read_file', 'edit_file'], builtin: false });
    expect(t.hive.updateWorker(w.id, { role: 'Search' }).role).toBe('Search');
    expect(() => t.hive.fire('dev')).toThrow('cannot be fired');
    t.hive.fire(w.id);
    expect(t.bus.state.crew.some((x) => x.id === w.id)).toBe(false);
    expect(() => t.hive.hire({ name: '', role: 'x' })).toThrow('name');
  });

  it('closes jobs left running by a crash on the next start', () => {
    const bus = new EventBus();
    bus.emit('job.created', { job: { id: 'j_1', request: 'x', status: 'planning', taskIds: [] } }, { jobId: 'j_1' });
    const dir = tmpDir();
    const ws = new Workspace(path.join(dir, 'ws'));
    const approvals = new Approvals(bus);
    const hive = new Hive({ bus, scheduler: new Scheduler(bus), toolbox: new ToolBox({ workspace: ws, bus, approvals }), approvals, playbooks: new PlaybookStore(null) });
    hive.init();
    expect(bus.state.jobs[0].status).toBe('failed');
  });
});

describe('planner and worker helpers', () => {
  it('normalizes plans: no cycles, valid workers, one QA task at the end', () => {
    const ids = BUILTIN.map((w) => w.id);
    const plan = normalizePlan({
      tasks: [
        { title: 'A', detail: '', assignee: 'qa', dependsOn: [] },
        { title: 'B', detail: '', assignee: 'mel', dependsOn: [5, 2, 1] },
        { title: 'C', detail: '', assignee: 'ghost', dependsOn: [2, 3] },
        { title: 'D', detail: '', assignee: 'writer', dependsOn: [3] }
      ]
    }, ids, 'req');
    expect(plan.map((t) => [t.title, t.assignee, t.dependsOn])).toEqual([
      ['B', 'dev', []], ['C', 'dev', [0]], ['D', 'writer', [1]], ['A', 'qa', [0, 1, 2]]
    ]);
    expect(normalizePlan({ tasks: [] }, ids, 'req').map((t) => t.assignee)).toEqual(['dev', 'qa']);
  });

  it('keeps whole files out of the history and gives QA a report action', () => {
    const c = compactAction({ tool: 'write_file', args: { path: 'a', content: 'x'.repeat(1000) } });
    expect(c.args.content).toBe('[1000 chars written]');
    const qa = BUILTIN.find((w) => w.id === 'qa');
    const s = workerSchema(qa, { kind: 'qa' });
    expect(validate(s, { tool: 'report', args: { passed: true, issues: [] } })).toEqual([]);
    expect(validate(s, { tool: 'done', args: { summary: 'x' } }).length).toBeGreaterThan(0);
    expect(validate(s, { tool: 'write_file', args: { path: 'a', content: 'b' } }).length).toBeGreaterThan(0);
  });

  it('the demo responder follows its script', () => {
    const plan = demoRespond([], { schema: { properties: { tasks: {} } } });
    expect(plan.tasks).toHaveLength(4);
    const first = demoRespond([{ role: 'system', content: '' }, { role: 'user', content: 'Your task: Set the look\n' }], {});
    expect(first.tool).toBe('say');
  });

  it('makePlan passes the plan schema to the scheduler', async () => {
    const bus = new EventBus();
    const s = new Scheduler(bus);
    const b = createFakeBrain({ respond: () => ({ summary: 'ok', tasks: [{ title: 'T', detail: 'd', assignee: 'designer', dependsOn: [] }] }) });
    s.addBrain(b);
    const r = await makePlan({ scheduler: s, request: 'x', crew: BUILTIN, jobId: 'j_1' });
    expect(r.source).toBe('model');
    expect(r.tasks.map((t) => t.assignee)).toEqual(['designer', 'qa']);
    expect(b.calls[0].options.schema.properties.tasks.items.properties.assignee.enum).toEqual(['dev', 'designer', 'qa', 'writer']);
  });
});
