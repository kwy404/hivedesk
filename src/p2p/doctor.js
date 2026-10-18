// hivedesk doctor --p2p (PLAN 9): identity present and private, peers and audit readable, the
// rendezvous brokers reachable over WSS, the NAT type from STUN binding requests sent with
// node:dgram to two servers from one socket, and the ports. Every network check has a short
// deadline, and nothing here writes to the home folder.

import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { readIdentity, keyFile } from './identity.js';
import { checkPrivate } from './keyfile.js';
import { PeerStore } from './peers.js';
import { AuditLog } from './audit.js';
import { LAN_PORT } from './transport/ws-lan.js';
import { DEFAULT_BROKERS } from '../../ui/lend/core/relay.js';

export const STUN_SERVERS = Object.freeze(['stun.cloudflare.com:3478', 'stun.l.google.com:19302']);
const MAGIC = 0x2112a442;

// ---------------------------------------------------------------- STUN (RFC 5389)

export function stunRequest() {
  const id = crypto.randomBytes(12);
  const b = Buffer.alloc(20);
  b.writeUInt16BE(0x0001, 0);
  b.writeUInt16BE(0, 2);
  b.writeUInt32BE(MAGIC, 4);
  id.copy(b, 8);
  return { id, bytes: b };
}

/** Reads a Binding success response. Returns { address, port } or null. */
export function parseStunResponse(buf, id) {
  if (!Buffer.isBuffer(buf) || buf.length < 20 || buf.readUInt16BE(0) !== 0x0101 || buf.readUInt32BE(4) !== MAGIC) return null;
  if (id && !buf.subarray(8, 20).equals(id)) return null;
  const len = buf.readUInt16BE(2);
  let off = 20;
  let mapped = null;
  while (off + 4 <= 20 + len && off + 4 <= buf.length) {
    const type = buf.readUInt16BE(off);
    const alen = buf.readUInt16BE(off + 2);
    const v = buf.subarray(off + 4, off + 4 + alen);
    if ((type === 0x0020 || type === 0x0001) && v.length >= 8 && v[1] === 0x01) {
      let port = v.readUInt16BE(2);
      let addr = v.readUInt32BE(4);
      if (type === 0x0020) {
        port ^= MAGIC >>> 16;
        addr = (addr ^ MAGIC) >>> 0;
      }
      const address = [addr >>> 24, (addr >>> 16) & 255, (addr >>> 8) & 255, addr & 255].join('.');
      if (type === 0x0020 || !mapped) mapped = { address, port };
    }
    off += 4 + alen + ((4 - (alen % 4)) % 4);
  }
  return mapped;
}

/**
 * Sends a Binding request to each server from one UDP socket and classifies the NAT:
 *   open       the mapped address is one of this machine's addresses
 *   cone       both servers saw the same public port (peers can usually connect)
 *   symmetric  each server saw another port (two strict NATs need a TURN relay)
 *   blocked    no answer at all (UDP is blocked or there is no network)
 *   unknown    only one server answered
 */
export async function classifyNat({ servers = STUN_SERVERS, timeoutMs = 2500, lookup } = {}) {
  const sock = dgram.createSocket('udp4');
  await new Promise((resolve, reject) => {
    sock.once('error', reject);
    sock.bind(0, () => resolve());
  });
  const results = [];
  try {
    const waits = servers.map((s) => new Promise((resolve) => {
      const [host, portText] = s.split(':');
      const port = Number(portText) || 3478;
      const req = stunRequest();
      const timer = setTimeout(() => done(null), timeoutMs);
      const onMsg = (msg) => {
        const m = parseStunResponse(msg, req.id);
        if (m) done(m);
      };
      function done(m) {
        clearTimeout(timer);
        sock.off('message', onMsg);
        resolve({ server: s, mapped: m });
      }
      sock.on('message', onMsg);
      const send = (address) => sock.send(req.bytes, port, address, () => {});
      if (lookup) lookup(host).then(send, () => done(null));
      else send(host);
    }));
    results.push(...(await Promise.all(waits)));
  } finally {
    sock.close();
  }
  const ok = results.filter((r) => r.mapped);
  const local = new Set(Object.values(os.networkInterfaces()).flat().filter(Boolean).map((i) => i.address));
  let type;
  if (!ok.length) type = 'blocked';
  else if (ok.some((r) => local.has(r.mapped.address))) type = 'open';
  else if (ok.length < 2) type = 'unknown';
  else type = ok.every((r) => r.mapped.port === ok[0].mapped.port && r.mapped.address === ok[0].mapped.address) ? 'cone' : 'symmetric';
  return { type, results, publicAddress: ok[0]?.mapped.address ?? null };
}

// ---------------------------------------------------------------- brokers and ports

/** A WebSocket upgrade over TLS to one MQTT broker. Resolves { ok, ms, detail }. */
export function probeBroker(url, { timeoutMs = 4000, tlsOptions = {} } = {}) {
  const u = new URL(url);
  const started = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ url, ok, ms: Date.now() - started, detail });
    };
    const socket = tls.connect({ host: u.hostname, port: Number(u.port) || 443, servername: u.hostname, ...tlsOptions }, () => {
      const key = crypto.randomBytes(16).toString('base64');
      socket.write(`GET ${u.pathname || '/'} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: mqtt\r\n\r\n`);
    });
    let head = '';
    socket.on('data', (c) => {
      head += c.toString('latin1');
      const line = head.split('\r\n')[0];
      if (head.includes('\r\n')) finish(/^HTTP\/1\.1 101/.test(line), line.slice(0, 80));
    });
    socket.on('error', (err) => finish(false, err.code || err.message));
    const timer = setTimeout(() => finish(false, 'timeout'), timeoutMs);
  });
}

/** Whether a TCP port on an address is free to listen on. */
export function portFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (err) => resolve({ free: false, code: err.code }));
    srv.listen(port, host, () => srv.close(() => resolve({ free: true })));
  });
}

/** Asks whatever listens on the stable port whether it is a hivedesk engine (its 401 says so). */
async function isHivedesk(port, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(1500) });
    const body = await res.json().catch(() => null);
    return res.status === 401 && body?.error?.code === 'unauthorized';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- the checks

/**
 * @param {{ home: string, network?: boolean, brokers?: string[], stunServers?: string[], stablePort?: number,
 *   lanPort?: number, fetchImpl?: typeof fetch, timeoutMs?: number, lookup?: (host: string) => Promise<string> }} o
 * Returns checks in the shape of src/doctor.js: { id, label, ok, detail, hint? }.
 */
export async function runP2PChecks(o) {
  const checks = [];
  const add = (id, label, ok, detail, hint) => checks.push(hint ? { id, label, ok, detail, hint } : { id, label, ok, detail });

  // identity
  try {
    const id = readIdentity(o.home);
    add('p2p.identity', 'P2P identity', true, `${id.fingerprint.short}, words: ${id.fingerprint.words.join(' ')}`);
    const priv = checkPrivate(keyFile(o.home));
    add('p2p.key', 'Identity key is private', priv.ok, priv.detail, priv.ok ? undefined : 'Only your user should read identity/key.pem.');
  } catch (err) {
    if (err.code === 'missing') add('p2p.identity', 'P2P identity', true, 'not created yet; it is made on the first invite or join');
    else add('p2p.identity', 'P2P identity', false, err.message, err.code === 'mismatch' ? 'identity.json and key.pem disagree; restore the backup of identity/ or rotate.' : 'The key file is damaged.');
  }

  // peers
  try {
    const store = new PeerStore({ dir: path.join(o.home, 'peers'), readOnly: true });
    const known = store.list().filter((p) => p.trust === 'known').length;
    add('p2p.peers', 'Peer store', store.errors.length === 0, `${store.list().length} peers, ${known} known${store.errors.length ? `; unreadable: ${store.errors.map((e) => e.file).join(', ')}` : ''}`, store.errors.length ? 'Unreadable peer files are skipped; remove them or restore them.' : undefined);
  } catch (err) {
    add('p2p.peers', 'Peer store', false, err.message);
  }

  // audit chain
  try {
    const v = new AuditLog({ dir: path.join(o.home, 'audit'), readOnly: true }).verify();
    add('p2p.audit', 'Audit log chain', v.ok, v.ok ? `${v.count} entries, chain intact` : `broken at ${v.at}: ${v.reason}`, v.ok ? undefined : 'Someone or something edited the audit log. Keep a copy before changing anything.');
  } catch (err) {
    add('p2p.audit', 'Audit log chain', false, err.message);
  }

  // ports
  const stable = o.stablePort ?? 4174;
  const sp = await portFree(stable);
  if (sp.free) add('port.stable', `Port ${stable}`, true, 'free');
  else {
    const ours = await isHivedesk(stable, o.fetchImpl);
    add('port.stable', `Port ${stable}`, ours, ours ? 'in use by a running hivedesk' : `in use by another program (${sp.code})`, ours ? undefined : 'hivedesk falls back to a random port; the installed app then needs the terminal link.');
  }
  const lanPort = o.lanPort ?? LAN_PORT;
  const lp = await portFree(lanPort, '0.0.0.0');
  add('port.lan', `LAN port ${lanPort} (optional)`, true, lp.free ? 'free; LAN listening is off unless you turn it on' : `in use (${lp.code}); choose another port for LAN listening`);

  if (o.network === false) return checks;

  // brokers
  const brokers = await Promise.all((o.brokers || DEFAULT_BROKERS).map((b) => probeBroker(b, { timeoutMs: o.timeoutMs })));
  const up = brokers.filter((b) => b.ok);
  add('p2p.brokers', 'Rendezvous relays (WSS)', up.length > 0, `${up.length} of ${brokers.length} reachable${up.length ? `: ${up.map((b) => `${new URL(b.url).hostname} ${b.ms} ms`).join(', ')}` : ''}`,
    up.length ? undefined : 'Invites by words need one public relay. A firewall or proxy may block WSS; LAN invites still work.');

  // NAT
  try {
    const nat = await classifyNat({ servers: o.stunServers, timeoutMs: o.timeoutMs ?? 2500, lookup: o.lookup });
    const text = {
      open: 'open: this machine has a public address',
      cone: `cone NAT, public address ${nat.publicAddress}: direct connections usually work`,
      symmetric: 'symmetric NAT: a friend behind another strict NAT cannot connect without a TURN relay',
      blocked: 'no STUN answer: UDP looks blocked, so direct connections will fail',
      unknown: 'only one STUN server answered; the NAT type is unknown',
    }[nat.type];
    add('p2p.nat', 'NAT type (STUN)', nat.type !== 'blocked', text, nat.type === 'symmetric' ? 'If both sides show symmetric, use the LAN or add your own TURN URL in settings.' : nat.type === 'blocked' ? 'Allow outgoing UDP, or pair over the LAN.' : undefined);
  } catch (err) {
    add('p2p.nat', 'NAT type (STUN)', false, err.message);
  }
  return checks;
}
