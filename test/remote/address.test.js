import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { deriveAddress, dammDigit, dammValid, parseAddress, formatAddress, addressTopic, findCollision, avatarFor } from '../../src/remote/address.js';
import { Unattended, weakPassword } from '../../src/remote/unattended.js';

const key = (seed) => crypto.createHash('sha256').update(String(seed)).digest().toString('base64url');

describe('remote address', () => {
  it('Damm check digits: the textbook vector and every single digit and neighbour swap error', () => {
    expect(dammDigit('572')).toBe(4);
    expect(dammValid('5724')).toBe(true);
    const a = deriveAddress(key('x'));
    for (let i = 0; i < 10; i++) {
      for (let d = 0; d < 10; d++) {
        if (String(d) === a[i]) continue;
        expect(dammValid(a.slice(0, i) + d + a.slice(i + 1))).toBe(false);
      }
      if (i < 9 && a[i] !== a[i + 1]) expect(dammValid(a.slice(0, i) + a[i + 1] + a[i] + a.slice(i + 2))).toBe(false);
    }
  });

  it('is deterministic, 10 digits, never starting with 0, and differs between keys', () => {
    const k = key('hana');
    const a = deriveAddress(k);
    expect(a).toMatch(/^[1-9]\d{9}$/);
    expect(deriveAddress(k)).toBe(a);
    expect(deriveAddress(Buffer.from(k, 'base64url'))).toBe(a);
    expect(deriveAddress(key('rita'))).not.toBe(a);
    expect(dammValid(a)).toBe(true);
    expect(() => deriveAddress('short')).toThrow();
  });

  it('spreads over the space: no collision among 2,000 keys', () => {
    const seen = new Set();
    for (let i = 0; i < 2000; i++) seen.add(deriveAddress(key(`k${i}`)));
    expect(seen.size).toBe(2000);
  });

  it('parses typed and pasted forms, and catches typos', () => {
    const a = deriveAddress(key('hana'));
    expect(parseAddress(formatAddress(a))).toEqual({ ok: true, address: a });
    expect(parseAddress(formatAddress(a, '334'))).toEqual({ ok: true, address: a });
    expect(parseAddress(` ${a.slice(0, 3)}-${a.slice(3, 6)}-${a.slice(6)} `)).toEqual({ ok: true, address: a });
    const typo = a.slice(0, 4) + String((Number(a[4]) + 1) % 10) + a.slice(5);
    expect(parseAddress(typo)).toEqual({ ok: false, code: 'check_digit' });
    expect(parseAddress('12345')).toEqual({ ok: false, code: 'length' });
    expect(parseAddress('abc')).toEqual({ ok: false, code: 'format' });
    expect(formatAddress('1234567890')).toBe('123 456 789 0');
    expect(formatAddress('1234567890', '334')).toBe('123 456 7890');
  });

  it('names a relay topic that does not reveal the key, and finds collisions among known peers', () => {
    const a = deriveAddress(key('hana'));
    expect(addressTopic(a)).toMatch(/^hivedesk\/r1\/[A-Za-z0-9_-]{22}$/);
    expect(addressTopic(a)).not.toContain(a);
    const peers = [{ peerId: 'p1', publicKey: key('rita') }, { peerId: 'p2', publicKey: key('hana') }];
    expect(findCollision(a, peers, key('hana'))).toBe(null);
    expect(findCollision(a, peers, key('other'))).toMatchObject({ peerId: 'p2' });
    expect(avatarFor(a, 'Rita Lima')).toMatchObject({ initials: 'RL' });
    expect(avatarFor(a, 'Rita').hue).toBeGreaterThanOrEqual(0);
  });
});

describe('unattended access', () => {
  it('is off by default and refuses weak passwords', () => {
    const u = new Unattended();
    expect(u.info()).toMatchObject({ enabled: false, hasPassword: false });
    expect(u.check('anything').code).toBe('off');
    expect(weakPassword('short1A!')).toBe('too_short');
    expect(weakPassword('alllowercaseletters')).toBe('too_simple');
    expect(weakPassword('Password1234!')).toBe('too_simple');
    expect(() => u.configure({ enabled: true, password: 'weakweakweak' })).toThrow(/too simple/);
  });

  it('accepts the right password from a known peer only, never shows the hash, and locks out after 5 failures', () => {
    let t = 1_000_000;
    const u = new Unattended({ now: () => t });
    const info = u.configure({ enabled: true, password: 'Correct-Horse-9', allow: { control: true }, minutes: 60 });
    expect(JSON.stringify(info)).not.toMatch(/hash|salt/);
    expect(u.check('Correct-Horse-9', { trust: 'unknown' }).code).toBe('unknown_peer');
    expect(u.check('Correct-Horse-9', { trust: 'known' })).toMatchObject({ ok: true, minutes: 60, allow: { control: true, clipboard: false, files: false } });
    for (let i = 0; i < 5; i++) expect(u.check('wrong', { trust: 'known' }).code).toBe('wrong');
    expect(u.check('Correct-Horse-9', { trust: 'known' }).code).toBe('locked_out');
    t += 15 * 60_000;
    expect(u.check('Correct-Horse-9', { trust: 'known' }).ok).toBe(true);
    u.configure({ enabled: false });
    expect(u.check('Correct-Horse-9', { trust: 'known' }).code).toBe('off');
  });
});
