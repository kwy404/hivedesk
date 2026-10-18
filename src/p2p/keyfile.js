// Private files of the control plane (the identity key): written with a temp file plus rename,
// mode 600 on POSIX, and on Windows an ACL that grants only the current user (no inherited
// entries, so "Users" or "Everyone" from a parent folder do not apply).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const WIN = process.platform === 'win32';
// The system tools by full path: a POSIX whoami from Git or MSYS may come first on PATH.
const sys32 = (exe) => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', exe);
let sidCache;

/** The current Windows user as an icacls principal: "*S-1-5-..." when whoami answers, else the name. */
function windowsPrincipal() {
  if (sidCache !== undefined) return sidCache;
  try {
    const out = execFileSync(sys32('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const sid = /"(S-1-[0-9-]+)"/.exec(out)?.[1];
    sidCache = sid ? `*${sid}` : os.userInfo().username;
  } catch {
    sidCache = os.userInfo().username;
  }
  return sidCache;
}

/** Restricts a file or folder to the current user. Returns { ok, detail }. */
export function restrictToUser(target) {
  if (!WIN) {
    try {
      fs.chmodSync(target, fs.statSync(target).isDirectory() ? 0o700 : 0o600);
      return { ok: true, detail: 'mode set' };
    } catch (err) {
      return { ok: false, detail: err.message };
    }
  }
  try {
    execFileSync(sys32('icacls.exe'), [target, '/inheritance:r', '/grant:r', `${windowsPrincipal()}:F`], { windowsHide: true, timeout: 10000, stdio: 'ignore' });
    return { ok: true, detail: 'ACL set to the current user only' };
  } catch (err) {
    return { ok: false, detail: `icacls failed: ${err.message}` };
  }
}

// Who may hold an ACE on a private file: the user, SYSTEM (S-1-5-18) and Administrators (S-1-5-32-544),
// the same rule OpenSSH for Windows applies to private keys. SIDs, because names are localized.
const ALLOWED_SIDS = new Set(['S-1-5-18', 'S-1-5-32-544', 'SY', 'BA']);

const ALIASES = { WD: 'Everyone (S-1-1-0)', AU: 'Authenticated Users (S-1-5-11)', BU: 'Users (S-1-5-32-545)', BG: 'Guests (S-1-5-32-546)', AN: 'Anonymous (S-1-5-7)' };

/** The allow ACEs of a file as SIDs, from the SDDL that "icacls /save" writes (UTF-16). */
function aclSids(file) {
  const out = path.join(os.tmpdir(), `hivedesk-acl-${crypto.randomBytes(6).toString('hex')}.txt`);
  try {
    execFileSync(sys32('icacls.exe'), [file, '/save', out], { windowsHide: true, timeout: 30000, stdio: 'ignore' });
    const sddl = fs.readFileSync(out).toString('utf16le');
    const dacl = /D:[A-Z]*((?:\([^)]*\))*)/.exec(sddl)?.[1] || '';
    return [...dacl.matchAll(/\(([^)]*)\)/g)].map((m) => {
      const f = m[1].split(';');
      return { allow: f[0] === 'A', inherited: (f[1] || '').includes('ID'), sid: f[5] };
    });
  } finally {
    try {
      fs.unlinkSync(out);
    } catch { /* not written */ }
  }
}

/** Checks that only the owner can read a private file. Returns { ok, detail }. */
export function checkPrivate(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch (err) {
    return { ok: false, detail: err.code === 'ENOENT' ? 'missing' : err.message };
  }
  if (!WIN) {
    const loose = st.mode & 0o077;
    return loose ? { ok: false, detail: `mode ${(st.mode & 0o777).toString(8)}, others can read it` } : { ok: true, detail: `mode ${(st.mode & 0o777).toString(8)}` };
  }
  try {
    const me = windowsPrincipal().replace(/^\*/, '');
    const aces = aclSids(file).filter((a) => a.allow);
    const others = aces.filter((a) => a.sid !== me && !ALLOWED_SIDS.has(a.sid));
    if (others.length) return { ok: false, detail: `readable by ${others.map((a) => ALIASES[a.sid] || a.sid).join(', ')}` };
    return { ok: true, detail: 'ACL: the user, SYSTEM and Administrators only' };
  } catch (err) {
    return { ok: false, detail: `could not read the ACL: ${err.message.split('\n')[0]}` };
  }
}

/**
 * Writes a private file atomically: temp file in the same folder, restrict, rename. Fails closed: when the
 * file cannot be restricted to the user (icacls or chmod failed), nothing is written and it throws.
 */
export function writePrivate(file, data, restrict = restrictToUser) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' });
  const acl = restrict(tmp);
  if (!acl?.ok) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw Object.assign(new Error(`could not make ${path.basename(file)} private, so it was not written: ${acl?.detail || 'unknown error'}`), { code: 'acl_failed' });
  }
  fs.renameSync(tmp, file);
  return acl;
}

/** Writes a non secret JSON file atomically (temp file plus rename, the pattern of src/city/store.js). */
export function writeJsonAtomic(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
