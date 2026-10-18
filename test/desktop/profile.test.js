// The local profile: { name, avatar } in <home>/profile.json, written in a temporary home only.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GALLERY, AVATAR_IDS, NAME_MAX, validateProfile, writeProfile, readProfile, profileFile, initials } from '../../desktop/profile/index.js';
import { BUILTIN_STRINGS } from '../../desktop/strings.js';
import { WindowStore } from '../../desktop/state.js';

let home;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'hivedesk-profile-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

describe('profile', () => {
  it('has one gallery file with unique ids and colors', () => {
    expect(AVATAR_IDS.length).toBeGreaterThanOrEqual(6);
    expect(new Set(AVATAR_IDS).size).toBe(AVATAR_IDS.length);
    for (const a of GALLERY.avatars) expect(a.bg).toMatch(/^#[0-9A-F]{6}$/i);
    expect(AVATAR_IDS).toContain(GALLERY.default);
    expect(NAME_MAX).toBe(32);
  });
  it('writes exactly { name, avatar } to profile.json in the hivedesk home', () => {
    const p = writeProfile(home, { name: '  Alexandre   Kohler ', avatar: AVATAR_IDS[1], extra: 'dropped' });
    expect(p).toEqual({ name: 'Alexandre Kohler', avatar: AVATAR_IDS[1] });
    expect(JSON.parse(fs.readFileSync(profileFile(home), 'utf8'))).toEqual(p);
    expect(fs.readdirSync(home)).toEqual(['profile.json']);
    expect(readProfile(home)).toEqual(p);
  });
  it('refuses empty, long or control character names and avatars outside the gallery, keeping the old file', () => {
    writeProfile(home, { name: 'Ana', avatar: AVATAR_IDS[0] });
    const before = fs.readFileSync(profileFile(home), 'utf8');
    expect(() => writeProfile(home, { name: '   ', avatar: AVATAR_IDS[0] })).toThrow(/empty/);
    expect(() => writeProfile(home, { name: 'x'.repeat(33), avatar: AVATAR_IDS[0] })).toThrow(/32/);
    expect(() => writeProfile(home, { name: 'a\u202eb', avatar: AVATAR_IDS[0] })).toThrow(/control/);
    expect(() => writeProfile(home, { name: 'Ana', avatar: '../../etc' })).toThrow(/gallery/);
    expect(fs.readFileSync(profileFile(home), 'utf8')).toBe(before);
    expect(validateProfile({ name: '\u{1D538}'.repeat(32), avatar: AVATAR_IDS[0] }).name).toHaveLength(64);
  });
  it('reads nothing from a missing or broken file, and makes monogram initials', () => {
    expect(readProfile(home)).toBe(null);
    fs.writeFileSync(profileFile(home), '{"name": 5}');
    expect(readProfile(home)).toBe(null);
    expect(initials('Alexandre Silva Kohler')).toBe('AK');
    expect(initials('ana')).toBe('A');
    expect(initials('')).toBe('');
  });
  it('remembers that the first run asked, and has the card strings in 10 languages', () => {
    const store = new WindowStore(path.join(home, 'desktop'));
    expect(store.settings().profileAsked).toBe(false);
    expect(store.setSettings({ profileAsked: true }).profileAsked).toBe(true);
    for (const table of Object.values(BUILTIN_STRINGS)) {
      for (const k of ['title', 'body', 'name', 'placeholder', 'avatar', 'save', 'skip', 'tooLong']) expect(table[`cli.desktop.profile.${k}`]).toBeTruthy();
    }
  });
});

describe('the installer gallery and the profile module', () => {
  it('uses the avatar ids the profile module accepts, so an installer choice survives the first start', async () => {
    const { GALLERY } = await import('../../desktop/profile/index.js');
    const { AVATAR_IDS } = await import('../../ui/profile/avatars.js');
    expect(GALLERY.avatars.length).toBe(AVATAR_IDS.size);
    for (const a of GALLERY.avatars) expect(AVATAR_IDS.has(a.id)).toBe(true);
    expect(AVATAR_IDS.has(GALLERY.default)).toBe(true);
  });
});
