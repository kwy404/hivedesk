// The remote desktop port over two real nodes: dial by address with no words, large clipboard
// items in parts, the address must belong to the key that answers.
import { describe, it, expect, afterEach } from 'vitest';
import { inprocPair } from '../../src/p2p/transport/inproc.js';
import { createRemotePort } from '../../src/p2p/remote-port.js';
import { makeNode, cleanHomes, until } from './helpers.js';

afterEach(cleanHomes);

describe('the remote desktop port', () => {
  it('opens a session by address that grants nothing, with the SAS on both sides', async () => {
    const hana = makeNode('hana');
    const rita = makeNode('rita');
    const hp = createRemotePort(hana);
    hp.listenAddress('', true);
    const [hc, rc] = inprocPair();
    hana.accept(hc);
    const r = await rita.dialAddress(hana.address(), rc);
    await until(() => hp.session(r.sessionId));
    expect(hp.session(r.sessionId)).toMatchObject({ peerId: rita.identity.peerId, role: 'host', sas: r.sas });
    expect(hana.grantsOf(rita.identity.peerId)).toHaveLength(0);
    expect(hana.peers.get(rita.identity.peerId).trust).not.toBe('known');
    expect(hp.peer(rita.identity.peerId).words).toHaveLength(6);
    hp.close();
    await hana.close();
    await rita.close();
  });

  it('refuses a machine that answers for an address that is not its own', async () => {
    const hana = makeNode('hana');
    const rita = makeNode('rita');
    const sam = makeNode('sam');
    createRemotePort(hana).listenAddress('', true);
    // Sam dials Hana's topic but expects the address of Rita: the key does not match it.
    const [hc, sc] = inprocPair();
    hana.accept(hc);
    await expect(sam.dialAddress(rita.address(), sc)).rejects.toBeTruthy();
    for (const n of [hana, rita, sam]) await n.close();
  });

  it('pins the key behind an address on first use and blocks the call when that key changes', async () => {
    const hana = makeNode('hana');
    const rita = makeNode('rita');
    const sam = makeNode('sam');
    const hp = createRemotePort(hana);
    hp.listenAddress('', true);
    const [hc, rc] = inprocPair();
    hana.accept(hc);
    await rita.dialAddress(hana.address(), rc);
    expect(rita.peers.pinnedFor(hana.address()).identity.peerId).toBe(hana.identity.peerId);
    // Pretend Sam's key was the one first seen behind Hana's address: Hana's key there now reads as a forgery.
    const [hc2, sc] = inprocPair();
    hana.accept(hc2);
    await expect(sam.dialAddress(hana.address(), sc)).resolves.toBeTruthy();
    delete rita.peers.get(hana.identity.peerId).addressPin;
    rita.peers.upsert(hana.peers.get(sam.identity.peerId).identity, {});
    rita.peers.pinAddress(sam.identity.peerId, hana.address());
    const [hc3, rc3] = inprocPair();
    hana.accept(hc3);
    await expect(rita.dialAddress(hana.address(), rc3)).rejects.toMatchObject({ code: 'address_key_changed', message: expect.stringContaining('WARNING') });
    // Forgetting the old computer on purpose lets the call through and pins the new key.
    rita.peers.remove(sam.identity.peerId);
    const [hc4, rc4] = inprocPair();
    hana.accept(hc4);
    await expect(rita.dialAddress(hana.address(), rc4)).resolves.toBeTruthy();
    expect(rita.peers.pinnedFor(hana.address()).identity.peerId).toBe(hana.identity.peerId);
    hp.close();
    for (const n of [hana, rita, sam]) await n.close();
  });

  it('carries a clipboard item larger than one frame in parts and joins it on the other side', async () => {
    const hana = makeNode('hana');
    const rita = makeNode('rita');
    const hp = createRemotePort(hana);
    const rp = createRemotePort(rita);
    hp.listenAddress('', true);
    const [hc, rc] = inprocPair();
    hana.accept(hc);
    const { sessionId } = await rita.dialAddress(hana.address(), rc);
    await until(() => hp.session(sessionId));
    const got = [];
    hp.onMessage('clip.', (s, m) => got.push({ s, m }));
    const text = 'x'.repeat(2_500_000);
    expect(rp.send(sessionId, 2, 'clip.text', { text })).toBe(true);
    expect(rp.send(sessionId, 2, 'clip.text', { text: 'small' })).toBe(true);
    await until(() => got.length === 2, 8000);
    expect(got.map((g) => g.m.body.text.length).sort((a, b) => a - b)).toEqual([5, 2_500_000]);
    expect(got[0].s.peerId).toBe(rita.identity.peerId);
    // Too large for its type: refused before it leaves.
    expect(rp.send(sessionId, 2, 'clip.text', { text: 'y'.repeat(4 * 1024 * 1024) })).toBe(false);
    hp.close(); rp.close();
    await hana.close();
    await rita.close();
  });
});
