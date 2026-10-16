import { describe, it, expect } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { encodeFrame, FrameParser, OP, acceptKey, acceptUpgrade, connect, WsError } from '../src/ws.js';
import { waitFor } from './helpers.js';

function parseAll(buf) {
  const out = [];
  new FrameParser((f) => out.push(f)).push(buf);
  return out;
}

describe('WebSocket framing', () => {
  it('computes the accept key from the RFC example', () => {
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });

  it.each([0, 5, 125, 126, 65535, 65536, 200000])('round trips a %i byte payload, masked and not', (n) => {
    const payload = Buffer.alloc(n, 0x61);
    for (const mask of [false, true]) {
      const [f] = parseAll(encodeFrame(OP.TEXT, payload, { mask }));
      expect(f.opcode).toBe(OP.TEXT);
      expect(f.fin).toBe(true);
      expect(f.masked).toBe(mask);
      expect(f.payload.equals(payload)).toBe(true);
    }
  });

  it('decodes frames split at any byte and several frames in one chunk', () => {
    const a = encodeFrame(OP.TEXT, 'hello', { mask: true });
    const b = encodeFrame(OP.PING, 'p', { mask: true });
    const all = Buffer.concat([a, b]);
    for (let cut = 1; cut < all.length; cut++) {
      const out = [];
      const p = new FrameParser((f) => out.push(f));
      p.push(all.subarray(0, cut));
      p.push(all.subarray(cut));
      expect(out.map((f) => [f.opcode, f.payload.toString()])).toEqual([[OP.TEXT, 'hello'], [OP.PING, 'p']]);
    }
  });

  it('rejects reserved bits, big control frames and oversized frames', () => {
    const bad = encodeFrame(OP.TEXT, 'x');
    bad[0] |= 0x40;
    expect(() => parseAll(bad)).toThrow(WsError);
    expect(() => parseAll(encodeFrame(OP.PING, Buffer.alloc(200)))).toThrow(/control/);
    const p = new FrameParser(() => {}, { maxPayload: 10 });
    expect(() => p.push(encodeFrame(OP.TEXT, Buffer.alloc(11)))).toThrow(/too large/);
  });
});

describe('WebSocket connection', () => {
  async function server(onConn) {
    const s = http.createServer();
    s.on('upgrade', (req, socket, head) => {
      const c = acceptUpgrade(req, socket, head);
      if (c) onConn(c);
    });
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    return s;
  }

  it('echoes text, handles fragments, ping and close', async () => {
    const s = await server((c) => c.on('message', (t) => c.send(`echo:${t}`)));
    const port = s.address().port;
    const c = await connect(`ws://127.0.0.1:${port}/`);
    const got = [];
    c.on('message', (t) => got.push(t));
    c.send('hi');
    c.send('ü'.repeat(70000));
    // A fragmented message written by hand.
    c.socket.write(encodeFrame(OP.TEXT, 'frag', { mask: true, fin: false }));
    c.socket.write(encodeFrame(OP.CONT, 'ment', { mask: true }));
    let pong = false;
    c.on('pong', () => { pong = true; });
    c.ping('x');
    await waitFor(() => got.length === 3 && pong);
    expect(got[0]).toBe('echo:hi');
    expect(got[1]).toBe('echo:' + 'ü'.repeat(70000));
    expect(got[2]).toBe('echo:fragment');
    const closed = new Promise((r) => c.on('close', (code) => r(code)));
    c.close(1000, 'bye');
    expect(await closed).toBe(1000);
    s.close();
  });

  it('closes the connection on an unmasked client frame and invalid UTF-8', async () => {
    const codes = [];
    const s = await server((c) => c.on('close', (code) => codes.push(code)));
    const port = s.address().port;
    for (const frame of [encodeFrame(OP.TEXT, 'plain'), encodeFrame(OP.TEXT, Buffer.from([0xff, 0xfe]), { mask: true })]) {
      const c = await connect(`ws://127.0.0.1:${port}/`);
      c.socket.write(frame);
      await new Promise((r) => c.on('close', r));
    }
    await waitFor(() => codes.length === 2);
    expect(codes).toEqual([1002, 1007]);
    s.close();
  });

  it('answers 400 to a bad upgrade', async () => {
    const s = await server(() => {});
    const port = s.address().port;
    const res = await new Promise((resolve) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      });
      let data = '';
      sock.on('data', (d) => (data += d));
      sock.on('close', () => resolve(data));
    });
    expect(res).toMatch(/^HTTP\/1.1 400/);
    s.close();
  });
});
