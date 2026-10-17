// The --demo city scenario (CITY-PROTOCOL.md section 9). No model runs: the demo brain answers
// for both machines. Every event is labeled demo by the bus; each step has a city.demo.step caption.
//   1. Rita joins with the six words, her building rises, she contributes Pip, a reviewer.
//   2. Dev's machine is busy, so Dev borrows Rita's GPU for three turns, then the borrow ends.
//   3. A task dropped in the Design room flows Design, Code, Review (Pip), Test and done.
import { createDemoBrain, DEMO_CITY_TASK } from '../demo.js';

export const DEMO_FRIEND = Object.freeze({
  owner: 'peer:demo-rita',
  brainId: 'b_demo_rita',
  machine: { id: 'm_demo_rita', name: "Rita's PC", gpu: { name: 'NVIDIA GeForce RTX 3060', vramBytes: 12 * 1024 ** 3 }, ramBytes: 32 * 1024 ** 3, cpus: 12, model: 'Qwen2.5-Coder 7B (demo)', color: '#7fc98f' },
  agents: [{ id: 'pip', name: 'Pip', role: 'Reviewer', avatar: 'P', color: '#9FD3C7', specialization: ['review', 'test'], tools: ['list_files', 'read_file', 'check'], xp: 30 }]
});

/** Resolves when no crew job is running (the demo task edits the page the bakery job builds). */
function jobsIdle(bus, signal) {
  const busy = () => bus.state.jobs.some((j) => ['refining', 'awaiting_brief', 'planning', 'running'].includes(j.status));
  if (!busy()) return Promise.resolve();
  return new Promise((resolve) => {
    const off = bus.on(() => { if (!busy()) { off(); resolve(); } });
    signal?.addEventListener('abort', () => { off(); resolve(); }, { once: true });
  });
}

const sleep = (ms, signal) => new Promise((resolve) => {
  if (!ms) return resolve();
  const t = setTimeout(resolve, ms);
  t.unref?.();
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

/**
 * @param {{ city: import('./index.js').City, scheduler: any, bus: any, stepMs?: number, signal?: AbortSignal }} opts
 * @returns {Promise<{ taskId: string }>}
 */
export async function runCityDemo({ city, scheduler, bus, stepMs = 1800, signal }) {
  const step = (name, text) => bus.emit('city.demo.step', { step: name, text });
  const rita = { guest: true, id: 'demo-rita', name: 'Rita', owner: DEMO_FRIEND.owner };
  const host = { guest: false, id: 'h', name: 'You', owner: 'host' };

  // 1. A friend joins: her brain is attached first (as the lend relay would), then her building.
  const brain = createDemoBrain({ id: DEMO_FRIEND.brainId, label: "Rita's PC (demo)", delayMs: stepMs ? 300 : 0, tokenDelayMs: stepMs ? 15 : 0 });
  brain.kind = 'remote';
  brain.only = new Set();
  scheduler.addBrain(brain);
  step('friend', 'Rita joined with the six words. Her building rises across the bridge, and she brings Pip, a reviewer.');
  city.joinMachine({ machine: DEMO_FRIEND.machine, agents: DEMO_FRIEND.agents, brainId: DEMO_FRIEND.brainId, via: 'words' }, DEMO_FRIEND.owner);
  await sleep(stepMs, signal);
  if (signal?.aborted || city.closed) return null;

  // 2. Borrow a GPU across the bridge.
  step('borrow', "Dev's machine is busy with the bakery job, so Dev asks to borrow Rita's GPU for three turns.");
  let borrow = null;
  try { borrow = city.requestBorrow({ agentId: 'dev', machineId: DEMO_FRIEND.machine.id, turns: 3, minutes: 5 }, host); } catch { /* Dev is missing in a custom crew */ }
  await sleep(Math.round(stepMs * 0.8), signal);
  if (signal?.aborted || city.closed) return null;
  if (borrow) {
    city.answerBorrow({ borrowId: borrow.id, accept: true, turns: 3 }, rita);
    step('lent', 'Rita said yes. Dev walks across the bridge: his next three model turns run on her GPU.');
  }
  await sleep(stepMs, signal);
  if (signal?.aborted || city.closed) return null;

  // 3. A task through every room, once the bakery page it changes is built.
  await jobsIdle(bus, signal);
  if (signal?.aborted || city.closed) return null;
  step('task', 'A task note lands in the Design room. It goes Design, Code, Review, Test, then done.');
  const task = city.createTask({ title: DEMO_CITY_TASK.title, detail: DEMO_CITY_TASK.detail, room: 'design' }, host);
  city.onTaskDone = (id) => {
    if (id !== task.id) return;
    city.onTaskDone = null;
    step('done', 'Done: the task went through Design, Code, Review and Test. Every hop was an event.');
  };
  return { taskId: task.id };
}
