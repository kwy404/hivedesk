import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { PairGuest, PairHost, KnownGuest, KnownHost, PhoneHandshakeError } from '../../ui/phone/core/handshake.js';
import { deriveInvite, inviteLink, readInviteHash, homeTopic } from '../../ui/phone/core/invite.js';
import { hostPin, b64u, fromB64u, nonceOf, signWith, verifyWith, newIdentityKey } from '../../ui/phone/core/crypto.js';
import { FrameSession } from '../../ui/phone/core/session.js';
import { phoneIdentity } from './helpers.js';

async function hostKey() {
  const kp = await crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const publicRaw = new Uint8Array(await crypto.webcrypto.subtle.exportKey('raw', kp.publicKey));
  return { publicRaw, pin: await hostPin(publicRaw), sign: (...p) => signWith('p256', kp.privateKey, ...p) };
}

async function pairOnce({ alg = 'ed25519', tamper } = {}) {
  const host = await hostKey();
  const secret = crypto.randomBytes(32);
  const inv = await deriveInvite(secret);
  const phone = await phoneIdentity(alg);
  const g = new PairGuest({ identity: phone.identity, invite: { topicId: inv.topicId, psk: inv.psk, pin: host.pin }, name: 'Pixel 9' });
  const h = new PairHost({ hostKey: host, invite: { topicId: inv.topicId, psk: inv.psk }, hostName: 'Desk' });
  let m1 = await g.start();
  if (tamper === 'm1') m1 = m1.replace('"v":1', '"v":1 ');
  let m2 = await h.onM1(m1);
  if (tamper === 'm2') {
    const o = JSON.parse(m2);
    const box = fromB64u(o.box);
    box[3] ^= 1;
    o.box = b64u(box);
    m2 = JSON.stringify(o);
  }
  const { m3, result: gr } = await g.onM2(m2);
  const hr = await h.onM3(m3);
  return { host, phone, gr, hr, inv };
}

describe('phone invite', () => {
  it('round trips the QR link and keeps the secret in the fragment', async () => {
    const secret = crypto.randomBytes(32);
    const pin = crypto.randomBytes(12);
    const url = inviteLink(secret, pin);
    expect(url.startsWith('https://kwy404.github.io/hivedesk/remote/#p=')).toBe(true);
    expect(new URL(url).search).toBe('');
    const back = readInviteHash(new URL(url).hash);
    expect(Buffer.from(back.secret).equals(secret)).toBe(true);
    expect(Buffer.from(back.pin).equals(pin)).toBe(true);
    expect(readInviteHash('#nothing')).toBeNull();
    expect(() => readInviteHash('#p=abc')).toThrow();
  });

  it('derives the same topic, seal and psk on both sides, and different values per secret', async () => {
    const s = crypto.randomBytes(32);
    const a = await deriveInvite(s);
    const b = await deriveInvite(Uint8Array.from(s));
    expect(a.topic).toBe(b.topic);
    expect(Buffer.from(a.psk).equals(Buffer.from(b.psk))).toBe(true);
    const c = await deriveInvite(crypto.randomBytes(32));
    expect(c.topic).not.toBe(a.topic);
    expect(Buffer.from(a.seal).equals(Buffer.from(a.psk))).toBe(false);
    expect((await homeTopic(crypto.randomBytes(65))).startsWith('hivedesk/p1/h')).toBe(true);
  });
});

describe('phone pairing handshake', () => {
  for (const alg of ['ed25519', 'p256']) {
    it(`agrees on keys, SAS words and the reconnect secret with ${alg}`, async () => {
      const { gr, hr, phone } = await pairOnce({ alg });
      expect(gr.sessionId).toBe(hr.sessionId);
      expect(gr.sas).toEqual(hr.sas);
      expect(gr.sas).toHaveLength(6);
      expect(Buffer.from(gr.sendKey).equals(Buffer.from(hr.recvKey))).toBe(true);
      expect(Buffer.from(gr.recvKey).equals(Buffer.from(hr.sendKey))).toBe(true);
      expect(Buffer.from(gr.reconnect).equals(Buffer.from(hr.reconnect))).toBe(true);
      expect(hr.device.deviceId).toBe(phone.deviceId);
      expect(hr.device.alg).toBe(alg);
      expect(hr.device.name).toBe('Pixel 9');
      expect(gr.host.name).toBe('Desk');
    });
  }

  it('fails without the secret from the QR code', async () => {
    const host = await hostKey();
    const inv = await deriveInvite(crypto.randomBytes(32));
    const wrong = await deriveInvite(crypto.randomBytes(32));
    const phone = await phoneIdentity();
    const g = new PairGuest({ identity: phone.identity, invite: { topicId: inv.topicId, psk: wrong.psk, pin: host.pin } });
    const h = new PairHost({ hostKey: host, invite: { topicId: inv.topicId, psk: inv.psk } });
    const m2 = await h.onM1(await g.start());
    await expect(g.onM2(m2)).rejects.toMatchObject({ code: 'bad_secret' });
  });

  it('refuses a computer whose key does not match the pin in the QR code', async () => {
    const host = await hostKey();
    const other = await hostKey();
    const inv = await deriveInvite(crypto.randomBytes(32));
    const phone = await phoneIdentity();
    const g = new PairGuest({ identity: phone.identity, invite: { topicId: inv.topicId, psk: inv.psk, pin: other.pin } });
    const h = new PairHost({ hostKey: host, invite: { topicId: inv.topicId, psk: inv.psk } });
    await expect(g.onM2(await h.onM1(await g.start()))).rejects.toMatchObject({ code: 'pin' });
  });

  it('refuses a tampered ph.2', async () => {
    await expect(pairOnce({ tamper: 'm2' })).rejects.toBeInstanceOf(PhoneHandshakeError);
  });

  it('gives different SAS words to an attacker in the middle', async () => {
    const host = await hostKey();
    const inv = await deriveInvite(crypto.randomBytes(32));
    const real = await phoneIdentity();
    const evil = await phoneIdentity();
    const h = new PairHost({ hostKey: host, invite: { topicId: inv.topicId, psk: inv.psk } });
    const gEvil = new PairGuest({ identity: evil.identity, invite: { topicId: inv.topicId, psk: inv.psk, pin: host.pin } });
    const { m3, result: evilSide } = await gEvil.onM2(await h.onM1(await gEvil.start()));
    const hostSide = await h.onM3(m3);
    // The real phone would run its own handshake: its words cannot be the ones the host shows for the attacker.
    const h2 = new PairHost({ hostKey: host, invite: { topicId: inv.topicId, psk: inv.psk } });
    const gReal = new PairGuest({ identity: real.identity, invite: { topicId: inv.topicId, psk: inv.psk, pin: host.pin } });
    const { result: realSide } = await gReal.onM2(await h2.onM1(await gReal.start()));
    expect(hostSide.sas).toEqual(evilSide.sas);
    expect(realSide.sas).not.toEqual(hostSide.sas);
  });
});

describe('known phone reconnect', () => {
  it('reconnects with the stored secret and refuses an unknown or changed phone', async () => {
    const { host, phone, gr, hr } = await pairOnce();
    const stored = { alg: hr.device.alg, publicKey: hr.device.publicKey, reconnect: hr.reconnect };
    const kh = new KnownHost({ hostKey: host, pin: host.pin, lookup: (id) => (id === phone.deviceId ? stored : null) });
    const kg = new KnownGuest({ identity: phone.identity, deviceId: phone.deviceId, host: { key: host.publicRaw, pin: host.pin }, reconnect: gr.reconnect });
    const { m2, result } = await kh.onM1(await kg.start());
    const back = await kg.onM2(m2);
    expect(back.sessionId).toBe(result.sessionId);
    expect(Buffer.from(back.sendKey).equals(Buffer.from(result.recvKey))).toBe(true);

    const gone = new KnownHost({ hostKey: host, pin: host.pin, lookup: () => null });
    await expect(gone.onM1(await new KnownGuest({ identity: phone.identity, deviceId: phone.deviceId, host: { key: host.publicRaw, pin: host.pin }, reconnect: gr.reconnect }).start())).rejects.toMatchObject({ code: 'unknown_phone' });

    const thief = await phoneIdentity();
    const kt = new KnownGuest({ identity: thief.identity, deviceId: phone.deviceId, host: { key: host.publicRaw, pin: host.pin }, reconnect: gr.reconnect });
    await expect(kh.onM1(await kt.start())).rejects.toMatchObject({ code: 'bad_identity' });
  });

  it('a phone without the reconnect secret cannot read the answer', async () => {
    const { host, phone, hr } = await pairOnce();
    const stored = { alg: hr.device.alg, publicKey: hr.device.publicKey, reconnect: hr.reconnect };
    const kh = new KnownHost({ hostKey: host, pin: host.pin, lookup: () => stored });
    const kg = new KnownGuest({ identity: phone.identity, deviceId: phone.deviceId, host: { key: host.publicRaw, pin: host.pin }, reconnect: crypto.randomBytes(32) });
    const { m2 } = await kh.onM1(await kg.start());
    await expect(kg.onM2(m2)).rejects.toMatchObject({ code: 'bad_box' });
  });
});

describe('phone session frames', () => {
  async function pairSessions() {
    const { gr, hr } = await pairOnce();
    const toPhone = [];
    const toDesk = [];
    const desk = new FrameSession({ id: hr.sessionId, side: 'desktop', sendKey: hr.sendKey, recvKey: hr.recvKey, write: (t) => toPhone.push(t) });
    const phone = new FrameSession({ id: gr.sessionId, side: 'phone', sendKey: gr.sendKey, recvKey: gr.recvKey, write: (t) => toDesk.push(t) });
    return { desk, phone, toPhone, toDesk };
  }

  it('carries messages both ways and refuses replays and wrong directions', async () => {
    const { desk, phone, toPhone, toDesk } = await pairSessions();
    const got = [];
    const refused = [];
    desk.on('message', (m) => got.push(m));
    desk.on('refused', (r) => refused.push(r.code));
    phone.send('cmd', { op: 'state.get', a: {} });
    await phone._out;
    await desk.receive(toDesk[0]);
    expect(got[0]).toMatchObject({ t: 'cmd', body: { op: 'state.get' } });
    await desk.receive(toDesk[0]);
    expect(refused).toContain('replay');
    // the desktop may not receive a type that only travels down
    phone.send('state', {});
    await phone._out;
    await desk.receive(toDesk[1]);
    expect(desk.state).not.toBe('open');
    expect(toPhone.length).toBeGreaterThanOrEqual(0);
  });

  it('refuses a frame sealed for another session', async () => {
    const a = await pairSessions();
    const b = await pairSessions();
    const refused = [];
    a.desk.on('refused', (r) => refused.push(r.code));
    b.phone.send('ping', {});
    await b.phone._out;
    await a.desk.receive(b.toDesk[0]);
    expect(refused).toContain('bad_frame');
  });

  it('builds 96 bit nonces from the stream and a 64 bit counter', () => {
    expect([...nonceOf(3, 2 ** 33 + 5)]).toEqual([0, 0, 0, 3, 0, 0, 0, 2, 0, 0, 0, 5]);
  });

  it('signs and verifies with both schemes', async () => {
    for (const prefer of ['ed25519', 'p256']) {
      const k = await newIdentityKey({ prefer });
      const sig = await signWith(k.alg, k.privateKey, 'a', 'b');
      expect(await verifyWith(k.alg, k.publicRaw, sig, 'ab')).toBe(true);
      expect(await verifyWith(k.alg, k.publicRaw, sig, 'ba')).toBe(false);
    }
  });
});
