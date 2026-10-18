// One place where the City, the Machines window and the Activity window read the compute plane,
// the peers and the recent events. It listens to the engine socket once and batches every change
// into one notification per animation frame, so 50 token frames a second cost one repaint.

import * as net from '/js/net.js';
import { blankCompute, applyComputeEvent, applyComputeLive, isComputeType } from './compute.js';
import { blankPeers, applyPeerEvent, isPeerType } from './peers.js';
import { entryOf } from './activity.js';

const RECENT = 800;

export const hub = {
  compute: blankCompute(),
  peers: blankPeers(),
  /** recent events that make an Activity line, oldest first */
  recent: [],
  /** this engine's PeerId, when the p2p identity exists (hello.peerId or hello.state.identity) */
  selfPeerId: null,
  /** set by the City: () => the City view */
  view: null,
  /** set by the City: the context that names agents, tasks, machines, peers and rooms */
  names: null,
};

const listeners = new Set();
let queued = false;
let started = false;

/** Subscribe to hub changes (at most once per frame). Returns an unsubscribe function. */
export function onHub(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function changed() {
  if (queued) return;
  queued = true;
  const run = () => { queued = false; for (const fn of listeners) { try { fn(hub); } catch (err) { console.error(err); } } };
  if (typeof requestAnimationFrame === 'function' && !document.hidden) requestAnimationFrame(run);
  else setTimeout(run, 50);
}

/** Feeds one engine event (also used for the history loaded by the Activity window). */
export function feedEvent(ev, { notify = true } = {}) {
  if (!ev?.type) return false;
  let hit = false;
  if (isComputeType(ev.type)) hit = applyComputeEvent(hub.compute, ev) || hit;
  if (isPeerType(ev.type)) hit = applyPeerEvent(hub.peers, ev) || hit;
  if (entryOf(ev)) {
    if (!hub.recent.length || ev.seq > hub.recent[hub.recent.length - 1].seq) hub.recent.push(ev);
    if (hub.recent.length > RECENT) hub.recent.splice(0, hub.recent.length - RECENT);
    hit = true;
  }
  if (hit && notify) changed();
  return hit;
}

export function startHub() {
  if (started) return;
  started = true;
  net.on('hello', (f) => {
    hub.compute = blankCompute();
    hub.peers = blankPeers();
    hub.recent = [];
    hub.selfPeerId = f.peerId || f.state?.identity?.peerId || null;
    // the share settings and resources of this engine, when hello carries them (Stream 3)
    if (f.state?.share) applyComputeEvent(hub.compute, { type: 'share.changed', data: { share: f.state.share } });
    if (f.state?.resources) applyComputeLive(hub.compute, { type: 'resources.sample', data: f.state.resources });
    if (Array.isArray(f.state?.peers)) applyPeerEvent(hub.peers, { type: 'p2p.peers', data: { peers: f.state.peers } });
    changed();
  });
  net.on('event', (f) => { if (f.event) feedEvent(f.event); });
  net.on('live', (f) => {
    const type = String(f.type || '');
    // The p2p live frames: the peer list after any change, and join requests (src/p2p/engine.js).
    if (type === 'p2p.peers' || type === 'p2p.join.request') { if (applyPeerEvent(hub.peers, { type, data: f.data || {} })) changed(); return; }
    if (!isComputeType(type)) return;
    if (applyComputeLive(hub.compute, f, { selfPeerId: hub.selfPeerId })) changed();
  });
}

/** Loads past events for the Activity window, oldest first, in pages of 5,000 (events.since). */
export async function loadHistory({ max = 20000 } = {}) {
  const out = [];
  let seq = 0;
  for (let i = 0; i < Math.ceil(max / 5000); i++) {
    const r = await net.command('events.since', { seq, limit: 5000 });
    const list = r?.events || [];
    out.push(...list);
    if (list.length < 5000) break;
    seq = list[list.length - 1].seq;
  }
  return out;
}
