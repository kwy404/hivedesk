// Invites by six words (PLAN 3.3). The words feed PBKDF2 once; HKDF then gives three values:
//   topic  the rendezvous name on the relays (or the LAN), 16 bytes
//   psk    a pre shared key mixed into the handshake's first key, never sent anywhere
//   seal   the key that seals rendezvous messages on the public relays
// The words are the meeting point and one secret; the Ed25519 identities, the short
// authentication string and the host's explicit Accept are the others. An invite is single
// use, lives 10 minutes, and is burned by the first handshake that starts on it, whatever
// its outcome, so an online attacker gets one guess.

import crypto from 'node:crypto';
import { wordsFromBytes, phraseOf, resolvePhrase, splitPhrase } from '../../ui/lend/core/words.js';
import { b64u, base32 } from './encoding.js';
import { hkdf, pbkdf2, wipe } from './primitives.js';
import { normalizeCapList } from './caps.js';

export const INVITE_ITERATIONS = 100_000;
export const INVITE_MINUTES = 10;
const SALT = 'hivedesk invite v2';

export class InviteError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'InviteError';
    this.code = code;
  }
}

/** Six random words: 66 bits from node:crypto. */
export const newWords = () => wordsFromBytes(crypto.randomBytes(9), 6);

/** Turns typed words into the canonical six, forgiving case, accents, prefixes and one typo. */
export function readWords(input) {
  const parts = Array.isArray(input) ? input : splitPhrase(String(input ?? ''));
  if (parts.length !== 6) throw new InviteError('bad_words', `an invite has six words, not ${parts.length}`);
  const r = resolvePhrase(parts);
  if (!r.ok) throw new InviteError('bad_words', `word ${r.missing[0] + 1} is not one of the invite words`);
  return r.words;
}

/** { topic, psk, seal } for six words. Both sides get the same values. */
export async function deriveInvite(words, iterations = INVITE_ITERATIONS) {
  const master = await pbkdf2(phraseOf(words), SALT, iterations, 32);
  const out = {
    topic: b64u(hkdf(master, Buffer.alloc(0), 'hivedesk v2 topic', 16)),
    psk: hkdf(master, Buffer.alloc(0), 'hivedesk v2 psk', 32),
    seal: hkdf(master, Buffer.alloc(0), 'hivedesk v2 seal', 32),
  };
  wipe(master);
  return out;
}

/**
 * The meeting point of a 10 digit remote desktop address (src/remote/address.js): { topic, psk, seal }.
 * The address is public, so this psk is NOT a secret: an address handshake is authenticated by the
 * two Ed25519 identities (the dialer also checks that the address comes from the host's key), the
 * SAS words, and the host's Accept of each capability. Nothing is granted by the handshake itself.
 */
export function deriveAddressInvite(address) {
  if (!/^\d{10}$/.test(String(address))) throw new InviteError('bad_address', 'an address has 10 digits');
  const master = crypto.createHash('sha256').update(`hivedesk remote address meeting v1|${address}`).digest();
  const out = {
    topic: b64u(hkdf(master, Buffer.alloc(0), 'hivedesk v2 address topic', 16)),
    psk: hkdf(master, Buffer.alloc(0), 'hivedesk v2 address psk', 32),
    seal: hkdf(master, Buffer.alloc(0), 'hivedesk v2 address seal', 32),
  };
  wipe(master);
  return out;
}

export class InviteBook {
  constructor({ now = () => Date.now(), iterations = INVITE_ITERATIONS } = {}) {
    this.now = now;
    this.iterations = iterations;
    this.invites = new Map();
  }

  /** Creates an invite. Returns the record, words included (they are shown once, never logged). */
  async create({ minutes = INVITE_MINUTES, offeredCaps = [], words } = {}) {
    const w = words ? readWords(words) : newWords();
    const d = await deriveInvite(w, this.iterations);
    const m = Math.min(60, Math.max(1, Number.isFinite(minutes) ? minutes : INVITE_MINUTES));
    const inv = {
      id: 'iv_' + base32(crypto.randomBytes(8)).slice(0, 12),
      words: w,
      topic: d.topic,
      psk: d.psk,
      seal: d.seal,
      createdAt: this.now(),
      expiresAt: this.now() + m * 60_000,
      attemptsLeft: 1,
      offeredCaps: normalizeCapList(offeredCaps),
      state: 'open',
    };
    this.invites.set(inv.id, inv);
    return inv;
  }

  get(id) {
    return this.invites.get(id) || null;
  }

  _live(inv) {
    if (inv.state === 'open' && this.now() >= inv.expiresAt) this._end(inv, 'expired');
    return inv.state === 'open';
  }

  _end(inv, state) {
    if (inv.state !== 'open' && inv.state !== 'in_use') return;
    inv.state = state;
    wipe(inv.psk, inv.seal);
    inv.words = null;
  }

  /**
   * Takes the one attempt of an invite for a handshake that starts now. Returns the invite or
   * throws InviteError('expired' | 'used' | 'unknown').
   */
  take({ id, topic }) {
    const inv = id ? this.invites.get(id) : [...this.invites.values()].find((x) => x.topic === topic && x.state === 'open');
    if (!inv) throw new InviteError('unknown', 'no invite with these words');
    if (!this._live(inv)) throw new InviteError(inv.state === 'expired' ? 'expired' : 'used', `the invite is ${inv.state}`);
    if (inv.attemptsLeft < 1) throw new InviteError('used', 'the invite was already tried');
    inv.attemptsLeft = 0;
    inv.state = 'in_use';
    return inv;
  }

  /** The handshake on this invite failed: it can never be used again. */
  burn(id, reason = 'failed') {
    const inv = this.invites.get(id);
    if (inv) {
      this._end(inv, 'burned');
      inv.reason = reason;
    }
    return inv;
  }

  /** The handshake succeeded: the invite is used up. */
  consume(id) {
    const inv = this.invites.get(id);
    if (inv) this._end(inv, 'used');
    return inv;
  }

  cancel(id) {
    const inv = this.invites.get(id);
    if (inv) this._end(inv, 'cancelled');
    return inv;
  }

  /** Expires what is due; returns the invites that just expired. */
  sweep() {
    const out = [];
    for (const inv of this.invites.values()) if (inv.state === 'open' && this.now() >= inv.expiresAt) {
      this._end(inv, 'expired');
      out.push(inv);
    }
    return out;
  }

  /** What may be shown (no psk, no seal; the words only to the local user while open). */
  view(inv, { withWords = false } = {}) {
    return { id: inv.id, state: inv.state, expiresAt: new Date(inv.expiresAt).toISOString(), offeredCaps: inv.offeredCaps, ...(withWords && inv.words ? { words: inv.words } : {}) };
  }

  list() {
    this.sweep();
    return [...this.invites.values()].map((i) => this.view(i));
  }
}
