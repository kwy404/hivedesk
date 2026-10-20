// The names a phone and the desktop show for each other: never null, undefined, empty or hidden
// characters, whatever the engine was started with (no --name, an empty profile, a host name that throws).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHive } from '../../src/index.js';
import { PhoneHub, hostLabel } from '../../src/phone/hub.js';
import { createPhonePort } from '../../src/phone/port.js';
import { PhoneClient } from '../../ui/phone/core/client.js';
import { cleanName } from '../../ui/phone/core/handshake.js';
import { readInviteHash, deriveInvite } from '../../ui/phone/core/invite.js';
import { linkPair, phoneIdentity, until } from './helpers.js';

const BAD = /^(null|undefined|)$/;

describe('hostLabel', () => {
  it('takes the first usable name, else "hivedesk"', () => {
    expect(hostLabel(null, undefined, '', '   ', 'Studio PC')).toBe('Studio PC');
    expect(hostLabel(undefined, 'Ana', 'DESKTOP-1')).toBe('Ana');
    expect(hostLabel('​‮', 42, {}, 'DESKTOP-1')).toBe('DESKTOP-1');
    expect(hostLabel(null, undefined)).toBe('hivedesk');
    expect(hostLabel()).toBe('hivedesk');
  });
});

/** A hub on its own (no engine), paired with one phone through the real handshake. */
async function pairWith(hostName, phoneName) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hivedesk-phone-names-'));
  const hub = new PhoneHub({ home, run: async () => ({}), state: () => ({}), hostName });
  await hub.start();
  const inv = await hub.createInvite();
  const { secret, pin } = readInviteHash(new URL(inv.url).hash);
  const d = await deriveInvite(secret);
  const id = await phoneIdentity();
  const { conn, link } = linkPair();
  hub.accept(conn);
  const client = new PhoneClient({ identity: id.identity, deviceId: id.deviceId, name: phoneName });
  const welcome = new Promise((res) => client.on('welcome', res));
  const paired = new Promise((res) => client.on('paired', res));
  const r = await client.pair(link, { topicId: d.topicId, psk: d.psk, pin });
  const req = await until(() => hub.pairRequests()[0]);
  return { hub, client, r, req, id, welcome, paired, answer: () => hub.answerPair(req.requestId, { accept: true, sasMatches: true, grants: { 'phone.status': true } }) };
}

describe('the names over a pairing', () => {
  for (const [label, fn] of [['returns null', () => null], ['returns undefined', () => undefined], ['is empty', () => '  '], ['throws', () => { throw new Error('no name'); }], ['is missing', undefined]]) {
    it(`the phone sees "hivedesk" when the computer name ${label}`, async () => {
      const p = await pairWith(fn, 'Pixel 9');
      expect(p.r.host.name).toBe('hivedesk');
      p.answer();
      expect((await p.r.decision).host.name).toBe('hivedesk');
      expect((await p.paired).host.name).toBe('hivedesk');
      expect((await p.welcome).host.name).toBe('hivedesk');
      p.client.close();
      p.hub.close();
    });
  }

  it('the desktop shows "Phone" for a phone whose name is only hidden characters, everywhere', async () => {
    const p = await pairWith(() => 'Studio PC', '​‮');
    expect(p.req.device.name).toBe('Phone');
    p.answer();
    const w = await p.welcome;
    expect(w.name).toBe('Phone');
    expect(w.host.name).toBe('Studio PC');
    expect(p.hub.phones()[0].name).toBe('Phone');
    expect(createPhonePort(p.hub).peer(p.id.deviceId).name).toBe('Phone');
    p.client.close();
    p.hub.close();
  });

  it('the phone cleans what the desktop sends after the handshake too', async () => {
    const p = await pairWith(() => 'Studio PC', 'Pixel 9');
    // A desktop that skips the hub's own cleaning: the client still never shows null.
    p.hub.hostName = () => null;
    p.answer();
    expect((await p.r.decision).host.name).toBe('hivedesk');
    expect((await p.welcome).host.name).toBe('hivedesk');
    p.client.close();
    p.hub.close();
  });
});

describe('the computer name of a real engine', () => {
  let app;
  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivedesk-phone-names-app-'));
    app = await startHive({ dir, demo: true, demoDelayMs: 0, demoApproveMs: 0, autoStartDemo: false, city: false, name: null });
  });
  afterAll(async () => {
    await app?.close();
  });

  it('is the profile name, then the OS host name, never null', async () => {
    const hub = app.phone.hub;
    await app.server.runCommand('profile.set', { name: '' }, null, { kind: 'user' });
    expect(hub.hostName()).toBe(hostLabel(os.hostname()));
    expect(hub.hostName()).not.toMatch(BAD);
    await app.server.runCommand('profile.set', { name: 'Ana' }, null, { kind: 'user' });
    expect(hub.hostName()).toBe('Ana');
    expect(cleanName(hub.hostName())).toBe('Ana');
  });
});
