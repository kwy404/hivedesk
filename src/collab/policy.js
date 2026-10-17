// Engine side guest policy (0.2.1). A guest command reaches this engine through the host's
// browser with `as: { id, name, role }`. The browser checks the role first (ui/lend/collab/roles.js),
// and the engine checks it again here, so a bug in the browser cannot widen what a guest may do.
// A missing or unknown role counts as a viewer.
//
//   viewer        reads and chats
//   collaborator  also creates tasks and jobs, edits files (through the host's approval) and
//                 brings its own building and agents into the city
//   host          everything; never a guest
//
// Hiring agents, changing an agent's tools, rooms, settings, models, providers and brains stay
// with the host.

export const GUEST_ROLES = Object.freeze(['viewer', 'collaborator']);

const READ = ['ping', 'events.since', 'replay.at', 'replay.marks', 'files.list', 'files.read', 'playbook.list', 'city.state', 'city.sync', 'city.presence'];
const VIEWER = new Set([...READ, 'chat.send']);
const COLLABORATOR = new Set([
  ...VIEWER,
  'job.create', 'job.cancel', 'approval.resolve', 'task.retry', 'task.reassign', 'task.cancel', 'files.write',
  'city.task.create', 'city.task.assign', 'city.task.move', 'city.task.approve', 'city.task.reject', 'city.task.retry', 'city.task.cancel',
  'city.machine.join', 'city.machine.update', 'city.machine.leave', 'city.agent.update', 'city.agent.move', 'city.agent.retire', 'city.agent.wake',
  'city.borrow.request', 'city.borrow.answer', 'city.borrow.stop'
]);

const clip = (v, n) => String(v ?? '').trim().slice(0, n);

/** The guest behind a command, or null when the person at this PC sent it. */
export function guestOf(data) {
  const as = data && typeof data === 'object' ? data.as : null;
  if (!as || typeof as !== 'object') return null;
  const id = clip(as.id, 24) || 'guest';
  const role = GUEST_ROLES.includes(as.role) ? as.role : 'viewer';
  return { id, name: clip(as.name, 40) || 'Guest', role, owner: `peer:${id}` };
}

/** True when a guest with this role may send this command type. */
export function guestMay(role, type) {
  if (role === 'collaborator') return COLLABORATOR.has(type);
  return VIEWER.has(type);
}

/** Throws a forbidden error when this guest may not send this command. */
export function checkGuest(guest, type, makeError) {
  if (!guest || guestMay(guest.role, type)) return;
  const message = guest.role === 'viewer' ? `a viewer cannot use ${type}; the host can make you a collaborator` : `guests cannot use ${type}`;
  throw makeError ? makeError('forbidden', message) : Object.assign(new Error(message), { code: 'forbidden' });
}
