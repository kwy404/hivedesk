// The local profile (docs/1.0/PROFILE.md): who you are on this machine and what your crew did.
//   <home>/profile.json        { name, avatar, bio, createdAt, shareAchievements }  (the installer may write { name, avatar })
//   <home>/profile-stats.json  { stats, unlocked, seen }                            (local only, never sent)
// The counters are fed by the event bus of each project (src/core/bus.js) and persisted with the
// last sequence seen per project, so a restart never counts an event twice. Peers only ever see
// { name, avatar } (and the achievement count when the user turns that switch on).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { cleanName, cleanAvatar, cleanBio, shortPeer, publicProfile } from './sanitize.js';
import { blankStats, normalizeStats, applyEvent, summary } from '../../ui/profile/stats.js';
import { ACHIEVEMENTS, ACHIEVEMENT_IDS, unlock } from '../../ui/profile/achievements.js';
import { fileURLToPath } from 'node:url';

const STRINGS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'i18n', 'parts', 'design.en.json');

export const PROFILE_FILE = 'profile.json';
export const STATS_FILE = 'profile-stats.json';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** The profile file as stored, repaired: unknown keys dropped, every field sanitized. */
export function readProfile(home, now = () => Date.now()) {
  const raw = readJson(path.join(home, PROFILE_FILE)) || {};
  const created = typeof raw.createdAt === 'string' && !Number.isNaN(Date.parse(raw.createdAt)) ? raw.createdAt : null;
  return {
    name: cleanName(raw.name), avatar: cleanAvatar(raw.avatar), bio: cleanBio(raw.bio),
    createdAt: created || new Date(now()).toISOString(), shareAchievements: raw.shareAchievements === true,
    imported: !created && !!(raw.name || raw.avatar), // written by the installer, read for the first time
  };
}

export class ProfileStore {
  /** @param {{ home: string, now?: () => number, project?: string }} o */
  constructor({ home, now = () => Date.now(), project = 'default' }) {
    this.home = home;
    this.now = now;
    this.project = crypto.createHash('sha256').update(String(project)).digest('hex').slice(0, 16);
    const p = readProfile(home, now);
    this.imported = p.imported;
    delete p.imported;
    this.profile = p;
    const raw = readJson(path.join(home, STATS_FILE)) || {};
    this.stats = normalizeStats(raw.stats);
    this.unlocked = {};
    for (const [id, at] of Object.entries(raw.unlocked || {})) if (ACHIEVEMENT_IDS.has(id) && typeof at === 'string') this.unlocked[id] = at;
    this.seen = raw.seen && typeof raw.seen === 'object' ? { ...raw.seen } : {};
    this.listeners = new Set();
    this._dirty = false;
    this._timer = null;
    // The first read of an installer file (or a first run) writes the repaired profile back.
    if (this.imported || !fs.existsSync(path.join(home, PROFILE_FILE))) this.saveProfile();
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit(kind, extra) { for (const fn of this.listeners) { try { fn(kind, extra); } catch { /* a listener must not break the store */ } } }

  saveProfile() { writeJson(path.join(this.home, PROFILE_FILE), this.profile); }
  _saveStats() {
    this._dirty = false;
    writeJson(path.join(this.home, STATS_FILE), { v: 1, stats: this.stats, unlocked: this.unlocked, seen: this.seen });
  }
  _later() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; if (this._dirty) this._saveStats(); }, 1500);
    this._timer.unref?.();
  }
  flush() { if (this._timer) { clearTimeout(this._timer); this._timer = null; } if (this._dirty) this._saveStats(); }

  /** Changes what the user may change. Everything is sanitized; an unknown avatar id is refused. */
  set(patch = {}) {
    const p = { ...this.profile };
    if ('name' in patch) p.name = cleanName(patch.name);
    if ('avatar' in patch) {
      if (patch.avatar != null && !cleanAvatar(patch.avatar)) throw Object.assign(new Error('unknown avatar'), { code: 'bad_request' });
      p.avatar = cleanAvatar(patch.avatar);
    }
    if ('bio' in patch) p.bio = cleanBio(patch.bio);
    if ('shareAchievements' in patch) p.shareAchievements = patch.shareAchievements === true;
    this.profile = p;
    this.saveProfile();
    this._emit('profile');
    return this.view();
  }

  /** Counts one event of this project (once: the sequence is remembered per project). */
  count(ev, ctx = {}) {
    const seq = Number(ev?.seq);
    const last = Number(this.seen[this.project] || 0);
    if (Number.isFinite(seq) && seq > 0) {
      if (seq <= last) return false;
      this.seen[this.project] = seq;
    }
    const changed = applyEvent(this.stats, ev, { project: this.project, ...ctx });
    if (Number.isFinite(seq)) this._later();
    if (!changed) return false;
    this._unlock();
    this._emit('stats');
    return true;
  }

  /** A milestone the engine verified itself (a clean doctor) or a local fact (a voice conversation). */
  milestone(kind) {
    if (kind === 'voice') this.stats.voice++;
    else if (kind === 'audit_clean') this.stats.auditClean++;
    else return false;
    this._later();
    this._unlock();
    this._emit('stats');
    return true;
  }

  _unlock() {
    const fresh = unlock(this.stats, this.unlocked, this.now());
    if (fresh.length) { this._later(); for (const id of fresh) this._emit('unlocked', { id, at: this.unlocked[id] }); }
    return fresh;
  }

  /** What the Profile page shows (local window only). */
  view(extra = {}) {
    return {
      profile: { ...this.profile },
      stats: summary(this.stats, this.now()),
      achievements: ACHIEVEMENTS.map((a) => ({ id: a.id, glyph: a.glyph, group: a.group, unlockedAt: this.unlocked[a.id] || null })),
      ...extra,
    };
  }

  /** What peers see. */
  wire(peerId) {
    const pub = publicProfile(this.profile, peerId);
    return this.profile.shareAchievements ? { ...pub, achievements: Object.keys(this.unlocked).length } : pub;
  }
}

/**
 * Engine plug-in: the store, the bus feed, the commands, and the profile on the p2p node.
 * @param {{ bus: any, home: string, server: { command: Function }, p2p?: any, dir?: string, hive?: any, doctor?: () => Promise<{ ok: boolean }>, address?: () => string | null }} o
 */
export default function startProfile({ bus, home, server, p2p = null, dir = 'default', doctor = null, address = null }) {
  const store = new ProfileStore({ home, project: dir });
  const roleOf = (taskId) => {
    const t = bus.state?.tasks?.[taskId];
    const w = t && (bus.state?.crew || []).find((x) => x.id === t.assignee);
    return w?.role || w?.id || '';
  };
  // Backfill what this project's log holds since the last count, then follow it live.
  try {
    let seq = Number(store.seen[store.project] || 0);
    for (let guard = 0; guard < 200; guard++) {
      const batch = bus.since(seq, 1000);
      if (!batch.length) break;
      for (const ev of batch) store.count(ev, { roleOf });
      seq = batch[batch.length - 1].seq;
    }
  } catch { /* an unreadable log only means fewer counts */ }
  const off = bus.on((ev) => store.count(ev, { roleOf }));

  const node = () => { try { return p2p?.started ? p2p.node() : null; } catch { return null; } };
  const peerId = () => node()?.identity?.peerId || null;
  const pushToNode = () => { try { node()?.setProfile?.(store.wire(peerId())); } catch { /* the node may not support profiles */ } };
  pushToNode();

  const view = () => store.view({ peerId: peerId(), peerShort: peerId() ? shortPeer(peerId()) : null, address: (() => { try { return address?.() || null; } catch { return null; } })() });
  store.onChange((kind, extra) => {
    if (kind === 'profile') pushToNode();
    if (kind === 'unlocked') { bus.live('profile.unlocked', extra); if (store.profile.shareAchievements) pushToNode(); }
    bus.live('profile.changed', view());
  });

  // The profile strings (i18n/parts/design.en.json) until Stream 1 merges the part into i18n/en.json.
  server.route?.('GET', '/api/profile/strings', (req, res) => {
    let body = '{}';
    try { body = fs.readFileSync(STRINGS_FILE, 'utf8'); } catch { /* not shipped */ }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(body);
  });
  server.command('profile.get', () => view(), { local: true });
  server.command('profile.set', (d) => { store.set(d || {}); return view(); }, { local: true });
  server.command('profile.milestone', (d) => {
    // only a local fact the window saw (a voice conversation); the security check runs here, never on trust
    if (d?.kind === 'voice') store.milestone('voice');
    return view();
  }, { local: true });
  server.command('profile.check', async () => {
    if (!doctor) return { ok: false, reason: 'no doctor' };
    const r = await doctor();
    if (r?.ok) store.milestone('audit_clean');
    return { ok: !!r?.ok, failed: (r?.checks || []).filter((c) => !c.ok).map((c) => c.label).slice(0, 20) };
  }, { local: true });

  return { store, view, wire: (id) => store.wire(id), close() { off(); store.flush(); } };
}
