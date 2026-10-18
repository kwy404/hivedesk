// The local profile: a display name and an avatar from the built in gallery, in <hivedesk home>/profile.json
// as { "name": string up to 32 characters, "avatar": id from the gallery }. Written by the Windows installer
// or the first run card of the desktop app; the app imports it on first run. The gallery ids live in one
// file, desktop/profile/avatars.json (the ids of the 1.0 gallery in ui/profile/avatars.js, with monogram colors).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const GALLERY = Object.freeze(JSON.parse(fs.readFileSync(path.join(HERE, 'avatars.json'), 'utf8')));
export const AVATAR_IDS = Object.freeze(GALLERY.avatars.map((a) => a.id));
export const NAME_MAX = 32;

function fail(message) {
  return Object.assign(new Error(message), { code: 'bad_profile' });
}

/** A clean { name, avatar }, or throws code 'bad_profile'. The name is trimmed, inner spaces collapsed. */
export function validateProfile(p) {
  if (!p || typeof p !== 'object') throw fail('the profile must be an object');
  const name = String(p.name ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!name) throw fail('the name is empty');
  if ([...name].length > NAME_MAX) throw fail(`the name is longer than ${NAME_MAX} characters`);
  if (/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/.test(name)) throw fail('the name has control characters');
  if (!AVATAR_IDS.includes(p.avatar)) throw fail('the avatar is not in the gallery');
  return { name, avatar: p.avatar };
}

export const profileFile = (home) => path.join(home, 'profile.json');

export function readProfile(home) {
  try { return validateProfile(JSON.parse(fs.readFileSync(profileFile(home), 'utf8'))); } catch { return null; }
}

/** Writes the profile atomically (temporary file and rename). */
export function writeProfile(home, p) {
  const clean = validateProfile(p);
  fs.mkdirSync(home, { recursive: true });
  const file = profileFile(home);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return clean;
}

/** Up to two initials for the monogram. */
export function initials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  const first = [...words[0]][0] || '';
  const last = words.length > 1 ? [...words[words.length - 1]][0] || '' : '';
  return (first + last).toUpperCase();
}
