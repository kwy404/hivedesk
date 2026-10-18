// Identity, encodings, primitives and the session layer: vectors, replays, tampering and rekey.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
// GitHub's hosted Windows runners give new files extra ACL entries, so the owner only check cannot pass there;
// it runs on real Windows PCs and on every other platform.
const HOSTED_WINDOWS = process.platform === 'win32' && !!process.env.GITHUB_ACTIONS;
import { base32, canonical, fromB64u } from '../../src/p2p/encoding.js';
import { open, seal, x25519, x25519Pair, hkdf } from '../../src/p2p/primitives.js';
import { cleanName, fingerprintOf, identityFile, keyFile, loadOrCreateIdentity, peerIdOf, readIdentity, readPeerIdentity, rotateIdentity, verifyRotation, publicIdentity } from '../../src/p2p/identity.js';
import { checkPrivate, writePrivate } from '../../src/p2p/keyfile.js';
import { SecureSession } from '../../src/p2p/session.js';
import { inprocPair } from '../../src/p2p/transport/inproc.js';
import { T, sasWords } from '../../src/p2p/handshake.js';
import { deriveInvite, readWords } from '../../src/p2p/invites.js';
import { cleanHomes, clock, tempHome, until } from './helpers.js';

afterEach(cleanHomes);

describe('encodings', () => {
  it('base32 matches RFC 4648 (lower case, no padding)', () => {
    expect(base32(Buffer.from('foobar'))).toBe('mzxw6ytboi');
    expect(base32(Buffer.from('f'))).toBe('my');
    expect(base32(Buffer.alloc(32))).toHaveLength(52);
  });

  it('canonical JSON sorts keys at every level and refuses NaN', () => {
    expect(canonical({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}');
    expect(() => canonical({ a: NaN })).toThrow();
  });

  it('base64url decoding is strict about alphabet, padding and length', () => {
    expect(fromB64u('AAAA', 3)).toHaveLength(3);
    expect(() => fromB64u('AA==')).toThrow();
    expect(() => fromB64u('AA+A')).toThrow();
    expect(() => fromB64u('AAAA', 4)).toThrow();
  });
});

describe('identity', () => {
  // RFC 8032, test 1 public key.
  const RFC_PK = Buffer.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex');

  it('peerId and fingerprint come from sha256 of the raw key', () => {
    const hash = crypto.createHash('sha256').update(RFC_PK).digest();
    const id = peerIdOf(RFC_PK);
    expect(id).toBe('hd1' + base32(hash).slice(0, 49));
    expect(id).toHaveLength(52);
    expect(id).toMatch(/^hd1[a-z2-7]{49}$/);
    const fp = fingerprintOf(RFC_PK);
    expect(fp.hex).toBe(hash.toString('hex'));
    expect(fp.words).toHaveLength(6);
    expect(fp.short).toBe(`hd1${id.slice(3, 7)}-${id.slice(7, 11)}`);
    // The words carry the first 66 bits of the hash.
    const bits = BigInt('0x' + hash.toString('hex').slice(0, 17)) >> 2n;
    expect(bits.toString(2).padStart(66, '0').length).toBe(66);
  });

  it.skipIf(HOSTED_WINDOWS)('is created once, private on disk, and loaded again unchanged', () => {
    const home = tempHome();
    const { identity, created } = loadOrCreateIdentity(home, { name: 'Rita' });
    expect(created).toBe(true);
    const again = loadOrCreateIdentity(home);
    expect(again.created).toBe(false);
    expect(again.identity.peerId).toBe(identity.peerId);
    expect(JSON.parse(fs.readFileSync(identityFile(home), 'utf8'))).toMatchObject({ v: 1, peerId: identity.peerId, name: 'Rita' });
    expect(fs.readFileSync(keyFile(home), 'utf8')).toMatch(/BEGIN PRIVATE KEY/);
    expect(checkPrivate(keyFile(home)).ok).toBe(true);
    // The private key never lands in JSON.
    expect(JSON.stringify(identity)).not.toMatch(/PRIVATE|"d":/);
    expect(Object.keys(identity)).not.toContain('privateKey');
  });

  it('refuses a key that does not match identity.json, and a lost key, instead of making a new identity', () => {
    const home = tempHome();
    loadOrCreateIdentity(home);
    const meta = JSON.parse(fs.readFileSync(identityFile(home), 'utf8'));
    fs.writeFileSync(identityFile(home), JSON.stringify({ ...meta, peerId: 'hd1' + 'a'.repeat(49) }));
    expect(() => readIdentity(home)).toThrow(expect.objectContaining({ code: 'mismatch' }));
    fs.writeFileSync(identityFile(home), JSON.stringify(meta));
    fs.unlinkSync(keyFile(home));
    expect(() => loadOrCreateIdentity(home)).toThrow(expect.objectContaining({ code: 'key_lost' }));
  });

  it('a peer identity must carry the key its id names', () => {
    const home = tempHome();
    const { identity } = loadOrCreateIdentity(home, { name: 'Ben' });
    const pub = publicIdentity(identity);
    expect(readPeerIdentity(pub).peerId).toBe(identity.peerId);
    expect(() => readPeerIdentity({ ...pub, peerId: 'hd1' + 'b'.repeat(49) })).toThrow(/does not match/);
    expect(() => readPeerIdentity({ ...pub, publicKey: 'AAAA' })).toThrow(/bad public key/);
  });

  it('rotation is signed by the old key and verifies only against it', () => {
    const home = tempHome();
    const { identity: old } = loadOrCreateIdentity(home);
    const { identity, statement } = rotateIdentity(home);
    expect(identity.peerId).not.toBe(old.peerId);
    expect(verifyRotation(statement, old.publicRaw).peerId).toBe(identity.peerId);
    expect(() => verifyRotation({ ...statement, newPeerId: old.peerId }, old.publicRaw)).toThrow();
    expect(() => verifyRotation(statement, identity.publicRaw)).toThrow(/another peer/);
    expect(readIdentity(home).peerId).toBe(identity.peerId);
  });

  it('display names lose control and bidi characters and stay short', () => {
    expect(cleanName(`Rita${String.fromCharCode(0x202e)}${String.fromCharCode(7)}`)).toBe('Rita');
    expect(cleanName('x'.repeat(90))).toHaveLength(40);
    expect(cleanName('   ', 'friend')).toBe('friend');
  });

  it.runIf(process.platform === 'win32')('the doctor check sees a key readable by everyone', () => {
    const home = tempHome();
    loadOrCreateIdentity(home);
    const file = keyFile(home);
    execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe'), [file, '/grant', '*S-1-1-0:R'], { windowsHide: true, stdio: 'ignore' });
    const r = checkPrivate(file);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('Everyone (S-1-1-0)');
  });
});

describe('primitives', () => {
  it('X25519 agrees and refuses a low order point', () => {
    const a = x25519Pair();
    const b = x25519Pair();
    expect(x25519(a.privateKey, b.publicRaw)).toEqual(x25519(b.privateKey, a.publicRaw));
    expect(() => x25519(a.privateKey, Buffer.alloc(32))).toThrow();
  });

  it('ChaCha20-Poly1305 refuses any change of ciphertext, nonce or additional data', () => {
    const key = crypto.randomBytes(32);
    const nonce = crypto.randomBytes(12);
    const box = seal(key, nonce, 'hello', 'aad');
    expect(open(key, nonce, box, 'aad').toString()).toBe('hello');
    const flipped = Buffer.from(box);
    flipped[0] ^= 1;
    expect(() => open(key, nonce, flipped, 'aad')).toThrow();
    expect(() => open(key, crypto.randomBytes(12), box, 'aad')).toThrow();
    expect(() => open(key, nonce, box, 'other')).toThrow();
  });

  it('invite derivation is deterministic and the transcript hash separates its parts', async () => {
    const w = readWords('Abandon ABILITY able, about-above absent');
    expect(w).toEqual(['abandon', 'ability', 'able', 'about', 'above', 'absent']);
    expect(readWords('aban abil able abou abov abse')).toEqual(w);
    const a = await deriveInvite(w, 1000);
    const b = await deriveInvite(w, 1000);
    expect(a.topic).toBe(b.topic);
    expect(a.psk.equals(b.psk)).toBe(true);
    expect(a.psk.equals(a.seal)).toBe(false);
    expect(() => readWords('abandon ability')).toThrow(/six/);
    expect(T('ab', 'c').equals(T('a', 'bc'))).toBe(false);
    expect(sasWords(Buffer.alloc(32), Buffer.alloc(32, 1), Buffer.alloc(32, 2))).toHaveLength(6);
  });
});

/** Two sessions over an inproc pair with mirrored keys. */
function sessionPair({ now = () => Date.now(), rekeyMessages, rekeyMs, tap } = {}) {
  const k1 = crypto.randomBytes(32);
  const k2 = crypto.randomBytes(32);
  const [a, b] = inprocPair({ tap });
  const sa = new SecureSession({ id: 'ss_test', peerId: 'b', role: 'host', conn: a, sendKey: Buffer.from(k1), recvKey: Buffer.from(k2), now, rekeyMessages, rekeyMs });
  const sb = new SecureSession({ id: 'ss_test', peerId: 'a', role: 'guest', conn: b, sendKey: Buffer.from(k2), recvKey: Buffer.from(k1), now, rekeyMessages, rekeyMs });
  return { sa, sb, a, b };
}

describe('sessions', () => {
  it('frames carry stream, counter and ciphertext only; messages arrive in order', async () => {
    const wire = [];
    const { sa, sb } = sessionPair({ tap: (t) => (wire.push(t), t) });
    const got = [];
    sb.on('message', (m, s) => got.push([m.t, s, m.body]));
    sa.send('presence', { x: 1, y: 2 });
    sa.send('ping', {});
    await until(() => got.length === 2);
    expect(got).toEqual([['presence', 1, { x: 1, y: 2 }], ['ping', 1, {}]]);
    const f = JSON.parse(wire[0]);
    expect(Object.keys(f).sort()).toEqual(['ct', 'n', 's']);
    expect(wire.join('')).not.toContain('presence');
  });

  it('refuses replays and tampered frames; three bad frames close the session', async () => {
    let replay = null;
    const { sa, sb, b } = sessionPair({ tap: (t) => (replay ??= t, t) });
    const got = [];
    const refused = [];
    sb.on('message', (m) => got.push(m.t));
    sb.on('refused', (r) => refused.push(r.code));
    sa.send('ping', {});
    await until(() => got.length === 1);
    b._deliver(replay);
    expect(refused).toEqual(['replay']);
    const f = JSON.parse(replay);
    const ct = Buffer.from(f.ct, 'base64url');
    ct[0] ^= 1;
    for (let i = 0; i < 3; i++) b._deliver(JSON.stringify({ s: 1, n: 100 + i, ct: ct.toString('base64url') }));
    expect(refused.filter((c) => c === 'bad_frame')).toHaveLength(3);
    expect(sb.state).toBe('closed');
    expect(got).toEqual(['ping']);
  });

  it('a message on the wrong stream or of an unknown type closes the session with bad_message', async () => {
    const { sa, sb } = sessionPair();
    const closed = new Promise((r) => sb.on('close', r));
    // job.offer belongs to stream 2; force it onto stream 1 by hand.
    sa._sendNow(1, { t: 'job.offer', id: 'x', ts: Date.now(), body: {} });
    expect(await closed).toBe('bad_message');
    const p2 = sessionPair();
    const closed2 = new Promise((r) => p2.sb.on('close', r));
    p2.sa._sendNow(1, { t: 'shell.exec', id: 'x', ts: Date.now(), body: {} });
    expect(await closed2).toBe('bad_message');
  });

  it('rekeys every N messages and after the time limit, both sides in step, old keys gone', async () => {
    const now = clock();
    const { sa, sb } = sessionPair({ now, rekeyMessages: 4, rekeyMs: 60_000 });
    const got = [];
    const rekeys = [];
    sb.on('message', (m) => got.push(m.body.x));
    sb.on('rekey', (r) => rekeys.push(r));
    for (let i = 0; i < 10; i++) sa.send('presence', { x: i, y: 0 });
    await until(() => got.length === 10);
    expect(got).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(rekeys.map((r) => r.epoch)).toEqual([1, 2]);
    const keyBefore = Buffer.from(sa.out.key);
    now.advance(61_000);
    sa.send('presence', { x: 10, y: 0 });
    await until(() => got.length === 11);
    expect(sa.sendN).toBe(13); // jumped to the epoch 3 boundary (12) and sent one
    expect(sa.out.key.equals(keyBefore)).toBe(false);
    expect(sa.out.key.equals(hkdf(keyBefore, Buffer.alloc(0), 'hivedesk v2 rekey', 32))).toBe(true);
    expect(sb.in.epoch).toBe(3);
  });

  it('rate limits per type: presence at most 15 per second', async () => {
    const { sa, sb } = sessionPair();
    const got = [];
    const refused = [];
    sb.on('message', (m) => got.push(m.t));
    sb.on('refused', (r) => refused.push(r.code));
    for (let i = 0; i < 20; i++) sa.send('presence', { x: i, y: 0 });
    await until(() => got.length + refused.length === 20);
    expect(got).toHaveLength(15);
    expect(refused.every((c) => c === 'rate_limited')).toBe(true);
  });

  it('control frames leave before compute frames queued in the same turn', async () => {
    const wire = [];
    const { sa, sb } = sessionPair({ tap: (t) => (wire.push(JSON.parse(t).s), t) });
    sb.on('message', () => {});
    sa.send('job.token', { jobId: 'j', text: 'a' });
    sa.send('job.token', { jobId: 'j', text: 'b' });
    sa.send('job.cancel', { jobId: 'j' });
    await until(() => wire.length === 3);
    expect(wire).toEqual([1, 2, 2]);
  });
});

describe('private files fail closed', () => {
  it('writes nothing and throws when the file cannot be restricted to the user', () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hivedesk-keyfile-'));
    try {
      const file = path.join(dir, 'key.pem');
      expect(() => writePrivate(file, 'secret', () => ({ ok: false, detail: 'icacls failed: not found' }))).toThrow(/not written/);
      expect(fs.readdirSync(dir)).toEqual([]);
      expect(writePrivate(file, 'secret', () => ({ ok: true, detail: 'ok' })).ok).toBe(true);
      expect(fs.readFileSync(file, 'utf8')).toBe('secret');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
