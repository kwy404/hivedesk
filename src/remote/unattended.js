// Unattended access: a host may let a peer in without clicking Accept, with a strong password.
// OFF by default, a separate setting from everything else, and never more than what the host chose:
//   * the password is at least 12 characters with three kinds of characters, kept only as scrypt
//     (N 2^15, r 8, p 1, 16 byte salt), compared in constant time;
//   * 5 wrong passwords lock it for 15 minutes for everybody (an online guesser gets 480 tries a day);
//   * a grant made this way is time limited (at most 60 minutes) and audited like any other;
//   * control still stops while the screen is locked, so on a locked machine it is view only;
//   * the red session bar, the indicator and the kill switch work exactly as for an accepted session.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MIN_PASSWORD = 12;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const MAX_FAILS = 5;
const LOCKOUT_MS = 15 * 60_000;

/** Why a password is too weak, or null. */
export function weakPassword(pw) {
  const s = String(pw || '');
  if (s.length < MIN_PASSWORD) return 'too_short';
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(s)).length;
  if (kinds < 3) return 'too_simple';
  if (/^(.)\1+$/.test(s) || /(0123|1234|2345|3456|4567|5678|6789|abcd|qwer|asdf|pass)/i.test(s)) return 'too_simple';
  return null;
}

const hash = (pw, salt) => crypto.scryptSync(String(pw).normalize('NFKC'), salt, 32, SCRYPT);

export class Unattended {
  /** @param {{ file?: string | null, now?: () => number }} o  file: settings path, null keeps it in memory (tests) */
  constructor({ file = null, now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
    this.cfg = { v: 1, enabled: false, salt: null, hash: null, allow: { control: false, clipboard: false, files: false }, minutes: 15, peers: 'known' };
    this.fails = 0;
    this.lockedUntil = 0;
    if (file) {
      try { Object.assign(this.cfg, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { /* first run */ }
    }
  }

  _save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.cfg, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** What the settings screen shows. Never the hash. */
  info() {
    const { enabled, allow, minutes, peers } = this.cfg;
    return { enabled, hasPassword: !!this.cfg.hash, allow: { ...allow }, minutes, peers, lockedFor: Math.max(0, this.lockedUntil - this.now()) };
  }

  /** Turns it on with a password and the most a peer may get, or off. Only the local person calls this. */
  configure({ enabled, password, allow = {}, minutes = 15, peers = 'known' } = {}) {
    if (enabled !== true) {
      this.cfg.enabled = false;
      this._save();
      return this.info();
    }
    if (password != null) {
      const weak = weakPassword(password);
      if (weak) throw Object.assign(new Error(`the password is ${weak.replace('_', ' ')}`), { code: 'bad_request' });
      const salt = crypto.randomBytes(16);
      this.cfg.salt = salt.toString('base64');
      this.cfg.hash = hash(password, salt).toString('base64');
    }
    if (!this.cfg.hash) throw Object.assign(new Error('set a password first'), { code: 'bad_request' });
    this.cfg.enabled = true;
    this.cfg.allow = { control: allow.control === true, clipboard: allow.clipboard === true, files: allow.files === true };
    this.cfg.minutes = [5, 15, 60].includes(Number(minutes)) ? Number(minutes) : 15;
    this.cfg.peers = peers === 'any' ? 'any' : 'known';
    this.fails = 0;
    this._save();
    return this.info();
  }

  /**
   * Checks a password a peer sent inside its authenticated session.
   * @returns {{ ok: true, allow: object, minutes: number } | { ok: false, code: 'off' | 'locked_out' | 'unknown_peer' | 'wrong' }}
   */
  check(password, { trust = 'unknown' } = {}) {
    if (!this.cfg.enabled || !this.cfg.hash) return { ok: false, code: 'off' };
    if (this.now() < this.lockedUntil) return { ok: false, code: 'locked_out' };
    if (this.cfg.peers === 'known' && trust !== 'known') return { ok: false, code: 'unknown_peer' };
    const want = Buffer.from(this.cfg.hash, 'base64');
    const got = hash(typeof password === 'string' ? password.slice(0, 256) : '', Buffer.from(this.cfg.salt, 'base64'));
    if (!crypto.timingSafeEqual(want, got)) {
      if (++this.fails >= MAX_FAILS) { this.lockedUntil = this.now() + LOCKOUT_MS; this.fails = 0; }
      return { ok: false, code: 'wrong' };
    }
    this.fails = 0;
    return { ok: true, allow: { ...this.cfg.allow }, minutes: this.cfg.minutes };
  }
}
