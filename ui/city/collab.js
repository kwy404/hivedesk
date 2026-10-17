// The browser glue between Code together (ui/lend/collab/) and the city (CITY-PROTOCOL.md 1, 6).
//   guest: after the welcome, reads its own machine and agents from its own engine and joins the
//          host's city with a building; keeps the levels its agents earn there
//   host:  takes a guest's building out of the city when the guest leaves
// The guest's own engine is reached over REST (the socket shows the host while in a session).

import * as net from '/js/net.js';

const OWNER = (guestId) => `peer:${guestId}`;
let mine = null; // guest: { machineId, localIds: Map(cityId -> localId) }

/** A command on this PC's own engine, even while the desktop shows a host's session. */
export async function localCommand(type, data = {}) {
  const r = await fetch('/api/command', {
    method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'content-type': 'application/json', ...(net.token ? { authorization: `Bearer ${net.token}` } : {}) },
    body: JSON.stringify({ type, data }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.ok === false) throw Object.assign(new Error(body.error?.message || `${type}: ${r.status}`), { code: body.error?.code || 'internal' });
  return body.result ?? body;
}

/** The guest side: join the host's city with this machine and its agents. */
export async function joinAsGuest() {
  const local = await localCommand('city.agents.local');
  if (!local?.machine?.id) return null;
  const agents = (local.agents || []).slice(0, 16);
  const res = await net.command('city.machine.join', { machine: local.machine, agents, via: 'words' });
  mine = { machineId: res?.machineId || local.machine.id, localIds: new Map() };
  for (const a of agents) mine.localIds.set(`${mine.machineId}:${a.id}`, a.id);
  for (const id of res?.agents || []) if (!mine.localIds.has(id)) mine.localIds.set(id, String(id).split(':').pop());
  return mine;
}

/** The guest side: a level earned in a friend's city is saved on this PC's engine. */
export function onCityEvent(ev, collab) {
  if (!mine || collab?.mode !== 'guest' || ev?.type !== 'city.agent.leveled') return;
  const d = ev.data || {};
  const localId = mine.localIds.get(d.agentId);
  if (!localId) return;
  localCommand('city.agents.save', { agents: [{ id: localId, xp: d.xp, level: d.level }] }).catch(() => {});
}

/** Wires the collab session events. `getCity` returns the engine CityState the UI holds. */
export function wireCollab(getCity) {
  const collab = globalThis.hivedeskCollab;
  if (!collab || collab._cityWired) return false;
  collab._cityWired = true;
  let was = collab.mode;
  // Only a collaborator brings a building (the host engine refuses a viewer); a promotion joins then.
  const join = () => joinAsGuest().catch((err) => { if (err.code !== 'forbidden') console.warn('[hivedesk] could not join the city', err.message); });
  collab.on('change', (mode) => {
    if (mode === 'guest' && was !== 'guest' && collab.guest?.role !== 'viewer') join();
    if (mode !== 'guest') mine = null;
    was = mode;
  });
  collab.on('role', () => { if (collab.mode === 'guest' && !mine && collab.guest?.role === 'collaborator') join(); });
  // host: a guest left, its building goes dark
  collab.on('left', (g) => {
    const city = getCity();
    for (const m of Object.values(city?.machines || {})) {
      if (m.owner === OWNER(g.id) && m.online !== false) net.command('city.machine.leave', { machineId: m.id, reason: 'left' }).catch(() => {});
    }
  });
  return true;
}
