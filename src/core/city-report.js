// `hivedesk city`: the City of a project as text, from the live engine or read only from its log.
import { TASK_STATES, listTasks, countByState, TERMINAL } from '../tasks/state.js';

const MB = 1024 * 1024;
const size = (n) => (n >= MB ? `${(n / MB).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

/**
 * @param {any} state bus.state (crew root with city and board mounted)
 * @param {{ dir: string, source: 'engine' | 'log', info?: any }} meta
 * @returns {object} a plain summary (also what --json prints)
 */
export function citySummary(state, meta) {
  const city = state.city || { machines: {}, agents: {}, rooms: {} };
  const board = state.board || { order: [], tasks: {} };
  const machines = Object.values(city.machines || {}).map((m) => ({
    id: m.id, name: m.name, host: !!m.host, online: m.online !== false, agents: (m.agents || []).length,
    gpu: m.gpu?.name || null, model: m.model || null
  }));
  const agents = Object.values(city.agents || {}).filter((a) => !a.retired).map((a) => ({
    id: a.id, name: a.name, role: a.role, room: a.room, status: a.status, level: a.level || 1, home: a.home, taskId: a.taskId || null
  }));
  const open = listTasks(board).filter((t) => !TERMINAL.has(t.state)).map((t) => ({
    id: t.id, title: t.title, state: t.state, assignee: t.assignee, ...(t.waitingFor ? { waitingFor: t.waitingFor } : {})
  }));
  return {
    dir: meta.dir,
    source: meta.source,
    demo: !!state.demo,
    lastSeq: state.lastSeq || 0,
    machines,
    agents,
    tasks: { counts: countByState(board), open },
    peersOnline: machines.filter((m) => !m.host && m.online).map((m) => m.name),
    log: meta.info ? { bytes: meta.info.bytes, segments: meta.info.segments.length, snapshots: meta.info.snapshots, restore: meta.info.restore } : null
  };
}

export function formatCity(s) {
  const lines = [`hivedesk city: ${s.dir}`, `  ${s.source === 'engine' ? 'live from the running engine' : 'read from the log (no engine is running for this folder)'}${s.demo ? ', DEMO' : ''}`];
  if (s.log) lines.push(`  log: ${s.lastSeq} events, ${s.log.segments} segment${s.log.segments === 1 ? '' : 's'}, ${size(s.log.bytes)}${s.log.snapshots.length ? `, snapshot at ${s.log.snapshots[0]}` : ''}`);
  lines.push('', `Buildings (${s.machines.length})`);
  if (!s.machines.length) lines.push('  none yet: the City starts with the first run of the engine');
  for (const m of s.machines) lines.push(`  ${m.host ? '*' : '-'} ${m.name}${m.host ? ' (this machine)' : ''}: ${m.online ? 'online' : 'offline'}, ${m.agents} agents${m.gpu ? `, ${m.gpu}` : ''}${m.model ? `, ${m.model}` : ''}`);
  lines.push('', `Agents (${s.agents.length})`);
  for (const a of s.agents) lines.push(`  - ${a.name} (${a.role || a.id}), level ${a.level}, ${a.status || 'idle'} in ${a.room || 'no room'}${a.taskId ? `, on ${a.taskId}` : ''}`);
  const counts = TASK_STATES.map((k) => `${k} ${s.tasks.counts[k] || 0}`).join(', ');
  lines.push('', `Tasks: ${counts}`);
  for (const t of s.tasks.open.slice(0, 20)) lines.push(`  - [${t.state}${t.waitingFor ? `: ${t.waitingFor.kind}` : ''}] ${t.title}${t.assignee ? ` (${t.assignee})` : ''}  ${t.id}`);
  if (s.tasks.open.length > 20) lines.push(`  and ${s.tasks.open.length - 20} more`);
  lines.push('', `Peers online: ${s.peersOnline.length ? s.peersOnline.join(', ') : 'none'}`);
  return lines.join('\n');
}
