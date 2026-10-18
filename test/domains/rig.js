// A hive with a scripted fake brain for the domain tests (same wiring as test/engine.test.js).
import path from 'node:path';
import { EventBus } from '../../src/bus.js';
import { Scheduler } from '../../src/crew/scheduler.js';
import { Hive } from '../../src/crew/engine.js';
import { ToolBox, Workspace } from '../../src/tools/index.js';
import { Approvals } from '../../src/tools/approvals.js';
import { PlaybookStore } from '../../src/playbooks/index.js';
import { createFakeBrain } from '../../src/brain/fake.js';
import { tmpDir } from '../helpers.js';

export const BRIEF = { goal: 'The app the user asked for', build: ['the files of the skeleton, changed for the request'], constraints: ['no network'], acceptance: ['npm test passes'], questions: [] };

/** A brain that answers each kind of turn by its schema; `seen` keeps the prompts of the brief, the plan and the tasks. */
export function scripted(seen = {}) {
  return (messages, options) => {
    const props = options.schema?.properties || {};
    if (props.goal) { seen.brief = messages.map((m) => m.content).join('\n'); return BRIEF; }
    if (props.improvedPrompt) { seen.report = messages.map((m) => m.content).join('\n'); return { improvedPrompt: 'Build the app with the decisions above and its tests.', nextPrompts: ['Add a settings screen.', 'Add an export button.'] }; }
    if (props.tasks) { seen.plan = messages.map((m) => m.content).join('\n'); return { summary: 'Shape the skeleton, then check it.', tasks: [{ title: 'Change the app', detail: 'Edit the skeleton files.', assignee: 'dev', dependsOn: [] }, { title: 'Check', detail: 'Run the checks.', assignee: 'qa', dependsOn: [1] }] }; }
    if (props.domain) return { domain: 'web', confidence: 'low' };
    if (props.questions) return { questions: [] };
    if (props.intent) return { intent: 'request', confidence: 'high' };
    if (props.order) return { order: [] };
    const system = messages[0]?.content || '';
    (seen.workers ||= []).push(system.slice(0, 200));
    if (/You are QA/.test(system)) return { thought: 'checked', tool: 'report', args: { passed: true, findings: [] } };
    return { thought: 'the skeleton already does it', tool: 'done', args: { summary: 'kept the skeleton' } };
  };
}

export function rig({ refine = true, autoApproveBriefMs = 0, respond, approvalMode = false } = {}) {
  const dir = tmpDir('hivedesk-domains-');
  const bus = new EventBus();
  if (approvalMode === false) bus.emit('settings.changed', { approvalMode: false });
  if (!refine) bus.emit('settings.changed', { refine: false });
  const scheduler = new Scheduler(bus);
  const approvals = new Approvals(bus);
  const ws = new Workspace(path.join(dir, 'ws'));
  const toolbox = new ToolBox({ workspace: ws, bus, approvals });
  const playbooks = new PlaybookStore(path.join(dir, 'pb'));
  const hive = new Hive({ bus, scheduler, toolbox, approvals, playbooks, autoApproveBriefMs });
  hive.init();
  const seen = {};
  scheduler.addBrain(createFakeBrain({ respond: respond || scripted(seen) }));
  return { dir, bus, scheduler, approvals, ws, toolbox, playbooks, hive, seen };
}

export const eventsOf = (bus, type) => bus.events.filter((e) => e.type === type);
