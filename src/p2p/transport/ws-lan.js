// ws-lan: a WebSocket listener on a LAN address, off by default (PLAN 3.4). It serves one path,
// /hivedesk/p2p, needs no token (the handshake authenticates both sides) and carries only the
// handshake and encrypted frames; the engine closes any connection that does not finish a
// handshake in time. Every other request gets a bare 404.

import http from 'node:http';
import { acceptUpgrade, connect as wsConnect, rejectUpgrade } from '../../ws.js';
import { Connection, MAX_TEXT } from './base.js';

export const LAN_PATH = '/hivedesk/p2p';
export const LAN_PORT = 4175;
const MAX_CONNECTIONS = 32;

class WsLanConnection extends Connection {
  constructor(ws, address) {
    super('ws-lan', { address });
    this.ws = ws;
    ws.on('message', (text) => this._deliver(text));
    ws.on('binary', () => this.close('binary frames are not used'));
    ws.on('close', () => this._closed('transport closed'));
    ws.on('error', () => {});
  }

  _write(text) {
    return this.ws.send(text);
  }

  _end(reason) {
    this.ws.close(1000, String(reason).slice(0, 100));
  }
}

/**
 * Starts listening. onConnection(conn) gets every accepted connection.
 * Returns { port, host, close() }.
 */
export async function listenLan({ host, port = LAN_PORT, onConnection, maxConnections = MAX_CONNECTIONS }) {
  if (!host) throw new Error('ws-lan needs an explicit address to listen on');
  const open = new Set();
  const server = http.createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'text/plain', connection: 'close' });
    res.end('not found');
  });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://lan');
    if (url.pathname !== LAN_PATH) return rejectUpgrade(socket, 403, 'unknown path');
    if (open.size >= maxConnections) return rejectUpgrade(socket, 403, 'too many connections');
    const ws = acceptUpgrade(req, socket, head);
    if (!ws) return;
    ws.maxPayload = MAX_TEXT;
    ws.parser.maxPayload = MAX_TEXT;
    const conn = new WsLanConnection(ws, `${socket.remoteAddress}:${socket.remotePort}`);
    open.add(conn);
    conn.on('close', () => open.delete(conn));
    onConnection(conn);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const addr = server.address();
  return {
    host: addr.address,
    port: addr.port,
    connections: open,
    close: () => new Promise((resolve) => {
      for (const c of open) c.close('listener closed');
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}

/** Connects to a peer's ws-lan listener: address is "host:port" (or a full ws:// URL). */
export async function connectLan(address, { timeoutMs = 8000 } = {}) {
  const url = /^wss?:\/\//.test(address) ? address : `ws://${address.includes(':') ? address : `${address}:${LAN_PORT}`}${LAN_PATH}`;
  let timer;
  const ws = await Promise.race([
    wsConnect(url),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`no answer from ${address}`), { code: 'unreachable' })), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
  return new WsLanConnection(ws, address);
}
