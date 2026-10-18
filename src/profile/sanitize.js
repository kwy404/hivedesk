// What a profile may contain, here and on the wire: a display name of at most 32 characters with no
// control or bidi override characters, an avatar id from the built-in gallery only (never an image),
// a short bio, and a fallback to the PeerId short form. Shared by the profile store and src/p2p/.

import { isAvatarId } from '../../ui/profile/avatars.js';

export const NAME_MAX = 32;
export const BIO_MAX = 160;
// C0 and C1 controls, bidi overrides and isolates, zero width joiners and the BOM
const BAD = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;

/** A display name or '' when nothing usable is left. */
export function cleanName(v) {
  if (typeof v !== 'string') return '';
  const s = v.normalize('NFC').replace(BAD, '').replace(/\s+/g, ' ').trim();
  return [...s].slice(0, NAME_MAX).join('').trim();
}

/** An avatar id from the allowlist, or null. */
export function cleanAvatar(v) { return isAvatarId(v) ? v : null; }

export function cleanBio(v) {
  if (typeof v !== 'string') return '';
  return [...v.normalize('NFC').replace(BAD, ' ').replace(/[ \t]+/g, ' ').trim()].slice(0, BIO_MAX).join('');
}

/** The PeerId short form shown when a peer has no name: the first 8 characters after the prefix. */
export function shortPeer(peerId) {
  const s = String(peerId || '');
  if (!s) return 'peer';
  const body = s.replace(/^hd1/, '');
  return `${s.startsWith('hd1') ? 'hd1' : ''}${body.slice(0, 8)}`;
}

/** What a peer sees: { name, avatar }, bounded and sanitized, with the PeerId fallback. */
export function publicProfile(input, peerId) {
  const p = input && typeof input === 'object' ? input : {};
  return { name: cleanName(p.name) || shortPeer(peerId), avatar: cleanAvatar(p.avatar) };
}
