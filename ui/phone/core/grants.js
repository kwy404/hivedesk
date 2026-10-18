// What a phone may do on the desktop, one grant per power (docs/1.0/protocol/phone.md section 5).
// The desktop engine enforces this table on every command (src/phone/hub.js); the page and the accept
// dialog only read it to show the right controls. Everything is off by default except phone.status.

export const GRANTS = Object.freeze([
  { name: 'phone.status', on: true },    // the City status, jobs, tasks and the activity feed, live
  { name: 'phone.crew', on: false },     // send requests (the normal refiner flow), chat with a worker, voice input
  { name: 'phone.approve', on: false },  // the full approval cards, approve and reject
  { name: 'phone.control', on: false },  // pause and resume workers, cancel jobs
  { name: 'phone.notify', on: false },   // notifications while the page is open: job done, approval needed
  { name: 'phone.remote', on: false }    // ask for remote desktop; viewing and control are then granted per session (remote.view, remote.control)
]);

export const GRANT_NAMES = Object.freeze(GRANTS.map((g) => g.name));
export const isGrant = (n) => GRANT_NAMES.includes(n);

/** The grants an accept dialog starts with. */
export const defaultGrants = () => Object.fromEntries(GRANTS.map((g) => [g.name, g.on]));

/** Every command a phone can send, the grant it needs, and its own rate limit [count, windowMs]. */
export const OPS = Object.freeze({
  'state.get': { grant: 'phone.status', rate: [20, 10_000] },
  'job.create': { grant: 'phone.crew', rate: [6, 60_000] },
  'brief.approve': { grant: 'phone.crew', rate: [12, 60_000] },
  'chat.send': { grant: 'phone.crew', rate: [20, 60_000] },
  'chat.log': { grant: 'phone.crew', rate: [20, 10_000] },
  'approval.get': { grant: 'phone.approve', rate: [30, 10_000] },
  'approval.resolve': { grant: 'phone.approve', rate: [30, 60_000] },
  'worker.pause': { grant: 'phone.control', rate: [20, 60_000] },
  'worker.resume': { grant: 'phone.control', rate: [20, 60_000] },
  'job.cancel': { grant: 'phone.control', rate: [10, 60_000] },
  'notify.set': { grant: 'phone.notify', rate: [10, 60_000] }
});

export const OP_NAMES = Object.freeze(Object.keys(OPS));

/** Normalizes a grant map from an answer or a file: known names only, booleans only. */
export function cleanGrants(g) {
  const out = defaultGrants();
  for (const n of GRANT_NAMES) out[n] = g && typeof g === 'object' && n in g ? g[n] === true : false;
  return out;
}

/** The grant names that are on. */
export const grantList = (g) => GRANT_NAMES.filter((n) => g?.[n] === true);
