// Code together frames on the data channel between the host and one guest.
//
//   hello     both   { t, v, role: 'host' | 'guest', name, color }
//   confirm   both   { t }                         the confirmation words match on this side
//   welcome   host   { t, you: { id, role }, hello }  hello is the host engine's hello frame
//   engine    host   { t, frame }                  an engine event or live frame, relayed
//   peers     host   { t, peers: [{ id, name, color, role, file? }] }
//   role      host   { t, role }
//   cmd       guest  { t, id, type, data }         a command for the host's engine
//   reply     host   { t, id, ok, result? , error? }
//   presence  both   { t, from?, file, sel: [{ a, h }] }  a and h are CRDT anchors
//   doc.open  guest  { t, path }
//   doc.state host   { t, path, snap }             the whole document for a guest who opens it
//   doc.op    both   { t, path, ops, from? }
//   lend      both   { t, f }                      a lend frame (a guest lends its brain)
//   stop      both   { t, reason }
//
// The host checks every frame a guest sends: shape, sizes, and then the guest's role
// (roles.js). Frames longer than one data channel message travel in parts (session.js).

import { FrameError } from '../core/frames.js';
import { readOps } from './crdt.js';

export const COLLAB_PROTOCOL = 1;

export const COLLAB_LIMITS = Object.freeze({
  frameBytes: 12 * 1024 * 1024, // a whole frame after joining its parts (the hello carries the state)
  commandBytes: 600 * 1024, // one guest command (a saved file is at most 512 KB)
  pathChars: 300,
  nameChars: 40,
});

const TYPES = new Set(['hello', 'confirm', 'welcome', 'engine', 'peers', 'role', 'cmd', 'reply', 'presence', 'doc.open', 'doc.state', 'doc.op', 'lend', 'stop']);
const fail = (code, message) => {
  throw new FrameError(code, message);
};
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const COLOR = /^#[0-9a-fA-F]{6}$/;
const anchor = (a) => (a === null || (Array.isArray(a) && a.length === 2 && typeof a[0] === 'string' && a[0].length <= 24 && Number.isInteger(a[1]) && a[1] >= 0) ? a : undefined);

/** A shared path: relative, forward slashes, no parent steps. */
export function readPath(p, limits = COLLAB_LIMITS) {
  const s = String(p ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!s || s.length > limits.pathChars || s.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(s) || /^[a-zA-Z]:/.test(s) || /[\0]/.test(s)) fail('bad_frame', 'A file path is missing or not allowed');
  return s;
}

export function normalizeCollab(f, limits = COLLAB_LIMITS) {
  if (!f || typeof f !== 'object' || Array.isArray(f) || !TYPES.has(f.t)) fail('bad_frame', 'Unknown frame');
  switch (f.t) {
    case 'hello':
      if (f.role !== 'host' && f.role !== 'guest') fail('bad_frame', 'hello needs a role');
      return { t: 'hello', v: Number.isInteger(f.v) ? f.v : 0, role: f.role, name: str(f.name, limits.nameChars).trim() || (f.role === 'host' ? 'Host' : 'Guest'), color: COLOR.test(f.color) ? f.color : '#f2a93b' };
    case 'confirm':
      return { t: 'confirm' };
    case 'cmd': {
      if (typeof f.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,40}$/.test(f.id)) fail('bad_frame', 'A command needs an id');
      if (typeof f.type !== 'string' || !/^[a-z][a-z.]{1,40}$/.test(f.type)) fail('bad_frame', 'A command needs a type');
      const data = f.data && typeof f.data === 'object' && !Array.isArray(f.data) ? f.data : {};
      if (JSON.stringify(data).length > limits.commandBytes) fail('too_big', 'This command is too large');
      return { t: 'cmd', id: f.id, type: f.type, data };
    }
    case 'presence': {
      const sel = Array.isArray(f.sel) ? f.sel.slice(0, 16).map((s) => ({ a: anchor(s?.a), h: anchor(s?.h) })).filter((s) => s.a !== undefined && s.h !== undefined) : [];
      const out = { t: 'presence', file: f.file ? readPath(f.file, limits) : null, sel };
      if (typeof f.from === 'string') out.from = f.from.slice(0, 24);
      if (f.follow === null || typeof f.follow === 'string') out.follow = f.follow;
      return out;
    }
    case 'doc.open':
      return { t: 'doc.open', path: readPath(f.path, limits) };
    case 'doc.op': {
      let ops;
      try {
        ops = readOps(f.ops);
      } catch (err) {
        fail('bad_frame', `Edit ops: ${err.message}`);
      }
      const out = { t: 'doc.op', path: readPath(f.path, limits), ops };
      if (typeof f.from === 'string') out.from = f.from.slice(0, 24);
      return out;
    }
    case 'doc.state':
      if (!f.snap || !Array.isArray(f.snap.runs)) fail('bad_frame', 'A document state needs runs');
      return { t: 'doc.state', path: readPath(f.path, limits), snap: f.snap, ...(typeof f.error === 'string' ? { error: f.error.slice(0, 300) } : {}) };
    case 'role':
      if (f.role !== 'viewer' && f.role !== 'collaborator') fail('bad_frame', 'Unknown role');
      return { t: 'role', role: f.role };
    case 'stop':
      return { t: 'stop', reason: str(f.reason, 200) || 'stopped' };
    // Frames only the host sends. The guest trusts its host, so they pass with a light check.
    case 'welcome':
      if (!f.you || typeof f.you.id !== 'string' || !f.hello || typeof f.hello !== 'object') fail('bad_frame', 'welcome needs you and hello');
      return { t: 'welcome', you: { id: f.you.id.slice(0, 24), role: f.you.role === 'collaborator' ? 'collaborator' : 'viewer' }, hello: f.hello };
    case 'engine':
      if (!f.frame || (f.frame.kind !== 'event' && f.frame.kind !== 'live')) fail('bad_frame', 'Only engine events travel');
      return { t: 'engine', frame: f.frame };
    case 'peers':
      return { t: 'peers', peers: (Array.isArray(f.peers) ? f.peers : []).slice(0, 32).map((p) => ({ id: str(p.id, 24), name: str(p.name, limits.nameChars), color: COLOR.test(p.color) ? p.color : '#f2a93b', role: ['host', 'viewer', 'collaborator'].includes(p.role) ? p.role : 'viewer', file: typeof p.file === 'string' ? p.file.slice(0, limits.pathChars) : null })) };
    case 'reply':
      return { t: 'reply', id: str(f.id, 40), ok: !!f.ok, ...(f.ok ? { result: f.result ?? {} } : { error: { code: str(f.error?.code, 40) || 'failed', message: str(f.error?.message, 500) || 'The host could not run this command' } }) };
    case 'lend':
      if (!f.f || typeof f.f !== 'object') fail('bad_frame', 'lend needs a frame');
      return { t: 'lend', f: f.f };
  }
  return fail('bad_frame', 'Unknown frame');
}

export function decodeCollab(text, limits = COLLAB_LIMITS) {
  if (typeof text !== 'string') fail('bad_frame', 'Frames are text');
  if (text.length > limits.frameBytes) fail('too_big', 'This frame is too large');
  let f;
  try {
    f = JSON.parse(text);
  } catch {
    fail('bad_json', 'A frame is not valid JSON');
  }
  return normalizeCollab(f, limits);
}

export function encodeCollab(frame, limits = COLLAB_LIMITS) {
  const text = JSON.stringify(normalizeCollab(frame, limits));
  if (text.length > limits.frameBytes) fail('too_big', 'This frame is too large');
  return text;
}

export const COLLAB_CODEC = { decode: decodeCollab, encode: encodeCollab };
