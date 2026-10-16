import { describe, expect, it } from 'vitest';
import { ReplayGuard, deriveRendezvous, openMessage, sealMessage } from '../../ui/lend/core/rendezvous.js';
import { connectPacket, PacketReader, parsePublish, publishPacket } from '../../ui/lend/core/mqtt.js';
import { encodeQR, qrSvg } from '../../ui/lend/core/qr.js';
import { lendLink } from '../../ui/lend/core/link.js';

const WORDS = ['abandon', 'ability', 'able', 'about', 'above', 'absent'];

describe('lend rendezvous', () => {
  it('derives the same topic and key from the same words, sealed against other words', async () => {
    const a = await deriveRendezvous(WORDS, 1000);
    const b = await deriveRendezvous(WORDS.map((w) => w.toUpperCase()), 1000);
    expect(a.topic).toBe(b.topic);
    expect(a.topic).toMatch(/^hivedesk\/v1\/[A-Za-z0-9_-]{22}$/);
    const sealed = await sealMessage(a, { k: 'join', f: 'x' });
    expect(await openMessage(b, sealed)).toMatchObject({ k: 'join', f: 'x' });
    const other = await deriveRendezvous([...WORDS.slice(0, 5), 'zoo'], 1000);
    expect(other.topic).not.toBe(a.topic);
    await expect(openMessage(other, sealed)).rejects.toThrow();
  });

  it('drops replays and stale messages', () => {
    let t = 1_000_000;
    const g = new ReplayGuard({ now: () => t });
    expect(g.accept({ ts: t, n: 'a' })).toBe(true);
    expect(g.accept({ ts: t, n: 'a' })).toBe(false);
    expect(g.accept({ ts: t - 12 * 60 * 1000, n: 'b' })).toBe(false);
    expect(g.accept({ ts: t + 5 * 60 * 1000, n: 'c' })).toBe(false);
  });

  it('frames MQTT packets', () => {
    const reader = new PacketReader();
    const pub = publishPacket('hivedesk/v1/x', new Uint8Array([1, 2, 3]));
    const both = new Uint8Array([...connectPacket({ clientId: 'hd1' }), ...pub]);
    const packets = [...reader.push(both.subarray(0, 7)), ...reader.push(both.subarray(7))];
    expect(packets.map((p) => p.type)).toEqual([1, 3]);
    expect(parsePublish(packets[1])).toMatchObject({ topic: 'hivedesk/v1/x', qos: 0 });
  });

  it('draws the share link as a QR code', () => {
    const qr = encodeQR(lendLink(WORDS), { ecl: 'M' });
    expect(qr.size).toBeGreaterThan(20);
    expect(qrSvg(qr, { title: 'Lend your PC' })).toMatch(/^<svg[\s\S]*<title>Lend your PC<\/title>/);
  });
});
