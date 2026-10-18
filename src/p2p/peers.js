// The peer store (PLAN 1.4): <home>/peers/<peerId>.json, one file per peer, written with a temp
// file plus rename. Standing grants live here; session grants live only in memory and end with
// their session (they never survive a restart).

import fs from 'node:fs';
import path from 'node:path';
import { isPeerId, readPeerIdentity } from './identity.js';
import { isActive } from './caps.js';
import { writeJsonAtomic } from './keyfile.js';
import { publicProfile } from '../profile/sanitize.js';

export const PEER_VERSION = 1;
const TRUST = new Set(['unknown', 'known', 'blocked']);

export class PeerStore {
  /** @param {{ dir: string, now?: () => number, readOnly?: boolean }} opts */
  constructor({ dir, now = () => Date.now(), readOnly = false }) {
    this.dir = dir;
    this.now = now;
    this.peers = new Map();
    this.errors = [];
    if (readOnly && !fs.existsSync(dir)) return;
    if (!readOnly) fs.mkdirSync(dir, { recursive: true });
    this._load();
  }

  _load() {
    let names = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch (err) {
      this.errors.push({ file: this.dir, reason: err.message });
      return;
    }
    for (const f of names) {
      if (!f.endsWith('.json') || f.startsWith('.')) continue;
      const id = f.slice(0, -5);
      if (!isPeerId(id)) {
        this.errors.push({ file: f, reason: 'not a peer file name' });
        continue;
      }
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
        const identity = readPeerIdentity({ peerId: raw.peerId, publicKey: raw.publicKey, name: raw.name, createdAt: raw.createdAt });
        if (identity.peerId !== id) throw new Error('file name and key do not match');
        this.peers.set(id, {
          identity,
          trust: TRUST.has(raw.trust) ? raw.trust : 'unknown',
          firstSeen: raw.firstSeen || new Date(this.now()).toISOString(),
          lastSeen: raw.lastSeen || raw.firstSeen || new Date(this.now()).toISOString(),
          relation: raw.relation === 'host' || raw.relation === 'guest' ? raw.relation : 'guest',
          machineId: typeof raw.machineId === 'string' ? raw.machineId.slice(0, 40) : undefined,
          ...(typeof raw.addressPin === 'string' && /^\d{10}$/.test(raw.addressPin) ? { addressPin: raw.addressPin } : {}),
          grants: Array.isArray(raw.grants) ? raw.grants.filter((g) => g && g.scope === 'standing' && g.peerId === id && typeof g.id === 'string') : [],
          held: Array.isArray(raw.held) ? raw.held.filter((g) => g && typeof g.id === 'string') : [],
          ...(raw.profile && typeof raw.profile === 'object' ? { profile: publicProfile(raw.profile, id) } : {}),
        });
      } catch (err) {
        this.errors.push({ file: f, reason: err.message });
      }
    }
  }

  _save(rec) {
    const id = rec.identity.peerId;
    writeJsonAtomic(path.join(this.dir, `${id}.json`), {
      v: PEER_VERSION,
      peerId: id,
      publicKey: rec.identity.publicKey,
      name: rec.identity.name,
      createdAt: rec.identity.createdAt,
      firstSeen: rec.firstSeen,
      lastSeen: rec.lastSeen,
      trust: rec.trust,
      relation: rec.relation,
      ...(rec.machineId ? { machineId: rec.machineId } : {}),
      ...(rec.addressPin ? { addressPin: rec.addressPin } : {}),
      ...(rec.profile ? { profile: { name: rec.profile.name, avatar: rec.profile.avatar } } : {}),
      grants: rec.grants.filter((g) => g.scope === 'standing'),
      held: rec.held,
    });
  }

  get(peerId) {
    return this.peers.get(peerId) || null;
  }

  list() {
    return [...this.peers.values()];
  }

  /**
   * Adds or updates a peer after a verified handshake. relation: what the peer is to us
   * ('guest' joined our invite, 'host' invited us). A known key never changes here: a peer
   * with the same id always has the same key (the id is its hash).
   */
  upsert(identity, { trust, relation, name } = {}) {
    const ts = new Date(this.now()).toISOString();
    let rec = this.peers.get(identity.peerId);
    if (!rec) {
      rec = { identity, trust: 'unknown', firstSeen: ts, lastSeen: ts, relation: relation || 'guest', grants: [], held: [] };
      this.peers.set(identity.peerId, rec);
    }
    if (name) rec.identity = { ...rec.identity, name };
    if (trust && rec.trust !== 'blocked') rec.trust = trust;
    if (relation) rec.relation = relation;
    rec.lastSeen = ts;
    this._save(rec);
    return rec;
  }

  touch(peerId) {
    const rec = this.peers.get(peerId);
    if (!rec) return;
    rec.lastSeen = new Date(this.now()).toISOString();
    this._save(rec);
  }

  setTrust(peerId, trust) {
    if (!TRUST.has(trust)) throw new TypeError('bad trust');
    const rec = this.peers.get(peerId);
    if (!rec) return null;
    rec.trust = trust;
    this._save(rec);
    return rec;
  }

  /** The name and avatar the peer showed us (already sanitized by the node). */
  setProfile(peerId, profile) {
    const rec = this.peers.get(peerId);
    if (!rec) return;
    const next = publicProfile(profile, peerId);
    if (rec.profile && rec.profile.name === next.name && rec.profile.avatar === next.avatar) return;
    rec.profile = next;
    this._save(rec);
  }

  /** The peer pinned for a remote address on first use (trust on first use), or null. */
  pinnedFor(address) {
    for (const rec of this.peers.values()) if (rec.addressPin === address) return rec;
    return null;
  }

  /** Pins the key behind an address: later dials of that address must reach this same key. */
  pinAddress(peerId, address) {
    const rec = this.peers.get(peerId);
    if (!rec || !/^\d{10}$/.test(String(address)) || rec.addressPin === address) return;
    rec.addressPin = String(address);
    this._save(rec);
  }

  setMachine(peerId, machineId) {
    const rec = this.peers.get(peerId);
    if (!rec) return;
    rec.machineId = String(machineId).slice(0, 40);
    this._save(rec);
  }

  /** Stores a standing grant this engine gave the peer. */
  addGrant(grant) {
    const rec = this.peers.get(grant.peerId);
    if (!rec || grant.scope !== 'standing') return;
    rec.grants.push(grant);
    this._save(rec);
  }

  /** Marks a grant revoked (kept for the record, inactive). Returns the grant or null. */
  revokeGrant(grantId, ts) {
    for (const rec of this.peers.values()) {
      const g = rec.grants.find((x) => x.id === grantId);
      if (g) {
        g.revokedAt = ts;
        this._save(rec);
        return g;
      }
    }
    return null;
  }

  /** Grants the peer holds on us that are still active (standing ones from disk). */
  activeGrants(peerId, now = this.now()) {
    return (this.peers.get(peerId)?.grants || []).filter((g) => isActive(g, now));
  }

  /** What the peer told us we hold on it (cap.grant and join.accept), for display and requests. */
  setHeld(peerId, held) {
    const rec = this.peers.get(peerId);
    if (!rec) return;
    rec.held = held.filter((g) => g.scope === 'standing');
    this._save(rec);
  }

  /** Drops revoked and expired grants older than a day from the files. */
  prune(now = this.now()) {
    for (const rec of this.peers.values()) {
      const before = rec.grants.length;
      rec.grants = rec.grants.filter((g) => isActive(g, now) || now - Date.parse(g.revokedAt || g.expiresAt || 0) < 86_400_000);
      if (rec.grants.length !== before) this._save(rec);
    }
  }

  remove(peerId) {
    if (!this.peers.delete(peerId)) return false;
    try {
      fs.unlinkSync(path.join(this.dir, `${peerId}.json`));
    } catch { /* already gone */ }
    return true;
  }
}
