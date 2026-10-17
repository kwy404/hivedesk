// Who may do what in Code together. The host's browser checks every guest command here before
// it reaches the host's engine. Every forwarded command carries `as: { id, name, role }`, and the
// engine checks the role again on its side (src/collab/policy.js) before its own approval rules.
//
//   viewer        sees everything, can chat
//   collaborator  can also send requests to the crew, approve steps, edit files (the host
//                 approves every write) and bring a building and its agents into the city
//   host          everything (the person whose hivedesk and disk it is)
//
// There is no command that runs a shell. Commands that change the model, settings, crew, lent
// brains or anything not listed here stay with the host.

export const ROLES = Object.freeze(['viewer', 'collaborator', 'host']);
export const GUEST_ROLES = Object.freeze(['viewer', 'collaborator']);

const READ = ['ping', 'events.since', 'replay.at', 'replay.marks', 'files.list', 'files.read', 'playbook.list'];
// Hive City (CITY-PROTOCOL.md): everyone can see the city; collaborators can also bring a building and
// its agents, lend or borrow a GPU and put tasks on the board. The host engine checks roles and ownership again.
const CITY_VIEWER = ['city.state', 'city.sync', 'city.presence'];
const CITY_COLLABORATOR = ['city.machine.join', 'city.machine.update', 'city.machine.leave', 'city.agent.update', 'city.borrow.request', 'city.borrow.answer', 'city.borrow.stop', 'city.task.create', 'city.task.assign', 'city.task.move', 'city.task.approve', 'city.task.reject', 'city.task.retry', 'city.task.cancel', 'city.agent.move', 'city.agent.retire', 'city.agent.wake'];
const VIEWER = new Set([...READ, 'chat.send', ...CITY_VIEWER]);
const COLLABORATOR = new Set([...VIEWER, 'job.create', 'job.cancel', 'approval.resolve', 'task.retry', 'task.reassign', 'task.cancel', 'files.write', ...CITY_COLLABORATOR]);

export class PermissionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PermissionError';
    this.code = 'forbidden';
  }
}

export const isRole = (r) => ROLES.includes(r);

/** True when this role may send this command type. */
export function canCommand(role, type) {
  if (role === 'host') return true;
  if (role === 'collaborator') return COLLABORATOR.has(type);
  if (role === 'viewer') return VIEWER.has(type);
  return false;
}

/** True when this role may change shared files in the editor. */
export const canEdit = (role) => role === 'host' || role === 'collaborator';

const short = (v, n) => String(v ?? '').slice(0, n);

/**
 * Checks one guest command and returns what the host forwards to its engine, or throws a
 * PermissionError. guest is { id, name, role }. Every command carries `as`, which replaces any
 * `as` the guest sent, so the engine knows who sent it and with which role.
 *   chat.send    the text is signed with the guest's name
 *   files.write  the engine asks the host for approval, new files included
 *   job.create   the job runs with approval mode on and its writes wait for the host
 */
export function checkCommand(guest, type, data = {}) {
  if (typeof type !== 'string' || !canCommand(guest.role, type)) {
    throw new PermissionError(guest.role === 'viewer' ? `A viewer cannot use ${type}. Ask the host to make you a collaborator.` : `Guests cannot use ${type}.`);
  }
  const d = data && typeof data === 'object' && !Array.isArray(data) ? { ...data } : {};
  const as = { id: guest.id, name: guest.name, role: guest.role };
  switch (type) {
    case 'chat.send':
      return { type, data: { channel: short(d.channel, 60) || 'general', text: `${guest.name}: ${short(d.text, 4000)}`, as } };
    case 'files.write':
      return { type, data: { path: short(d.path, 300), content: String(d.content ?? ''), as } };
    case 'job.create':
      return { type, data: { request: short(d.request, 4000), ...(d.playbookId ? { playbookId: short(d.playbookId, 80) } : {}), as } };
    case 'approval.resolve':
      return { type, data: { approvalId: short(d.approvalId, 80), approved: !!d.approved, note: `${guest.name}${d.note ? `: ${short(d.note, 300)}` : ''}`, as } };
    default:
      // Commands carry who sent them, so the host engine can apply roles and "the owner wins".
      return { type, data: { ...d, as } };
  }
}
