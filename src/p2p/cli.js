// The invite, join and peers subcommands (PLAN 9). Stream 1's CLI shell registers them:
//   import { P2P_SUBCOMMANDS } from './p2p/cli.js'
//   const code = await P2P_SUBCOMMANDS[name](argv, { home, stdin, stdout, stderr })
// Each talks to the running engine on 127.0.0.1 (the token in <home>/token) when there is one,
// and otherwise runs a headless control plane in this process. From a terminal, pairing works
// over the LAN (ws-lan); pairing through the public relays needs a hivedesk window
// (browser-pipe) until a Node WebRTC transport exists, and the commands say so.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { P2PNode } from './node.js';
import { listenLan, connectLan, LAN_PORT } from './transport/ws-lan.js';
import { CAPABILITIES, normalizeCapList } from './caps.js';

export const STABLE_PORT = 4174;

export function parseP2PArgs(argv, takes) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      o._.push(a);
      continue;
    }
    const [key, inline] = a.slice(2).split(/=(.*)/s);
    if (takes.includes(key)) {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new Error(`--${key} needs a value`);
      o[key] = v;
    } else o[key] = true;
  }
  return o;
}

/** The running engine on the stable port, or null. */
export async function engineClient({ home, port = STABLE_PORT, fetchImpl = fetch }) {
  let token;
  try {
    token = fs.readFileSync(path.join(home, 'token'), 'utf8').trim();
  } catch {
    return null;
  }
  const call = async (type, data = {}) => {
    const res = await fetchImpl(`http://127.0.0.1:${port}/api/command`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ type, data }) });
    const body = await res.json();
    if (!body.ok) throw Object.assign(new Error(body.error?.message || 'command failed'), { code: body.error?.code });
    return body.result;
  };
  try {
    await call('p2p.identity');
    return { call };
  } catch {
    return null;
  }
}

function io(o) {
  const out = (s = '') => o.stdout.write(s + '\n');
  const err = (s) => (o.stderr || o.stdout).write(s + '\n');
  const rl = readline.createInterface({ input: o.stdin, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (q) => {
    o.stdout.write(q + ' ');
    const { value, done } = await lines.next();
    return done ? '' : String(value).trim().toLowerCase();
  };
  return { out, err, ask, close: () => rl.close() };
}

const yes = (a) => a === 'y' || a === 'yes';

function capsArg(text) {
  if (!text) return [];
  const names = String(text).split(',').map((s) => s.trim()).filter(Boolean);
  const bad = names.filter((n) => !CAPABILITIES[n]);
  if (bad.length) throw new Error(`unknown capability: ${bad.join(', ')} (known: ${Object.keys(CAPABILITIES).join(', ')})`);
  return normalizeCapList(names);
}

const lanAddress = (v) => {
  const s = String(v);
  return s.includes(':') ? { host: s.slice(0, s.lastIndexOf(':')), port: Number(s.slice(s.lastIndexOf(':') + 1)) } : { host: s, port: LAN_PORT };
};

/** The person decides: the SAS words, then each capability (city.view on by default). */
async function decide(t, request) {
  t.out('');
  t.out(`Join request from "${request.peer.name}"`);
  t.out(`  their fingerprint: ${request.peer.fingerprint.words.join(' ')} (${request.peer.fingerprint.short})`);
  t.out(`  check words:       ${request.sas.join(' ')}`);
  const match = await t.ask('Do these check words match on their screen? Type yes or no:');
  if (!yes(match)) return { accept: false, sasMatches: false };
  const caps = [];
  for (const tog of request.toggles) {
    const def = tog.on ? 'Y/n' : 'y/N';
    const a = await t.ask(`  allow ${tog.capability.name}${tog.capability.limits ? ' ' + JSON.stringify(tog.capability.limits) : ''} for ${tog.minutes} minutes? [${def}]`);
    if (a ? yes(a) : tog.on) caps.push({ capability: tog.capability, minutes: tog.minutes });
  }
  const ok = await t.ask(`Accept "${request.peer.name}" with ${caps.length ? caps.map((c) => c.capability.name).join(', ') : 'nothing'}? [y/N]`);
  return yes(ok) ? { accept: true, sasMatches: true, caps } : { accept: false, sasMatches: true, reason: 'refused' };
}

const NEEDS_WINDOW = 'Pairing through the public relays runs in the hivedesk window for now (the Lend screen, or "hivedesk --join <words>"). From a terminal, pair on the same network with --lan.';

/** hivedesk invite [--caps a,b] [--minutes 10] --lan <address>[:port] */
export async function runInvite(argv, o) {
  const t = io(o);
  try {
    const a = parseP2PArgs(argv, ['caps', 'minutes', 'lan', 'name']);
    if (!a.lan) {
      t.err(NEEDS_WINDOW);
      t.err('Example: hivedesk invite --lan 192.168.1.20 --caps compute.inference,compute.gpu');
      return 2;
    }
    const caps = capsArg(a.caps);
    const minutes = a.minutes ? Number(a.minutes) : 10;
    const { host, port } = lanAddress(a.lan);
    const engine = o.engine === undefined ? await engineClient(o) : o.engine;
    if (engine) {
      const l = await engine.call('p2p.lan.listen', { host, port });
      const inv = await engine.call('p2p.invite.create', { caps, minutes });
      t.out(`Invite words: ${inv.words.join(' ')}`);
      t.out(`On the other machine: hivedesk join "${inv.words.join(' ')}" --lan ${host === '0.0.0.0' ? '<this address>' : host}:${l.port}`);
      t.out(`The words work once and expire at ${inv.expiresAt}. Waiting...`);
      const end = Date.parse(inv.expiresAt);
      while (Date.now() < end) {
        const { requests } = await engine.call('p2p.join.requests');
        if (requests.length) {
          const answer = await decide(t, requests[0]);
          const r = await engine.call('p2p.join.answer', { requestId: requests[0].requestId, ...answer });
          t.out(r.accepted ? 'Accepted. They are a known peer now.' : 'Refused.');
          return r.accepted ? 0 : 1;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      t.out('The invite expired.');
      return 1;
    }
    const node = new P2PNode({ home: o.home, name: a.name, ...(o.nodeOptions || {}) }).start();
    const lan = await listenLan({ host, port, onConnection: (c) => node.accept(c) });
    try {
      const inv = await node.createInvite({ caps, minutes });
      t.out(`Invite words: ${inv.words.join(' ')}`);
      t.out(`On the other machine: hivedesk join "${inv.words.join(' ')}" --lan ${host === '0.0.0.0' ? '<this address>' : host}:${lan.port}`);
      t.out(`Your fingerprint: ${node.identity.fingerprint.words.join(' ')}`);
      t.out(`The words work once and expire at ${inv.expiresAt}. Waiting...`);
      const outcome = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve('expired'), Date.parse(inv.expiresAt) - Date.now());
        node.once('invite.burned', () => {
          clearTimeout(timer);
          resolve('burned');
        });
        node.once('join.request', (req) => {
          clearTimeout(timer);
          resolve(req);
        });
      });
      if (outcome === 'expired' || outcome === 'burned') {
        t.out(outcome === 'expired' ? 'The invite expired.' : 'Someone tried with the wrong words; the invite is burned. Make a new one.');
        return 1;
      }
      const answer = await decide(t, outcome);
      const r = node.answerJoin(outcome.requestId, answer);
      t.out(r.accepted ? 'Accepted. They are a known peer now; standing grants apply when you both run hivedesk.' : 'Refused.');
      await new Promise((res) => setTimeout(res, 300));
      return r.accepted ? 0 : 1;
    } finally {
      await lan.close();
      await node.close();
    }
  } catch (err) {
    t.err(`hivedesk invite: ${err.message}`);
    return 2;
  } finally {
    t.close();
  }
}

/** hivedesk join "<words>" --lan <address:port> [--caps a,b] [--name me] */
export async function runJoin(argv, o) {
  const t = io(o);
  try {
    const a = parseP2PArgs(argv, ['caps', 'lan', 'name']);
    const words = a._.join(' ');
    if (!words) {
      t.err('Usage: hivedesk join "<six words>" --lan <address:port>');
      return 2;
    }
    if (!a.lan) {
      t.err(NEEDS_WINDOW);
      t.err(`Example: hivedesk --join "${words}"   (opens the window with the words filled in)`);
      return 2;
    }
    const requestedCaps = capsArg(a.caps);
    const engine = o.engine === undefined ? await engineClient(o) : o.engine;
    const show = (sas, host) => {
      t.out(`Host: "${host.name}", fingerprint ${host.fingerprint.words.join(' ')}`);
      t.out(`Check words: ${sas.join(' ')}`);
      t.out('Read them to the host. They accept only if their screen shows the same words.');
    };
    if (engine) {
      let s = await engine.call('p2p.join', { words, via: 'lan', address: a.lan, requestedCaps, name: a.name });
      if (s.phase === 'failed') {
        t.out(s.reason === 'words' ? 'The words did not work (wrong, used or expired).' : `Join failed: ${s.reason}`);
        return 1;
      }
      show(s.sas, s.host);
      while (s.phase === 'sas') {
        await new Promise((r) => setTimeout(r, 1000));
        s = await engine.call('p2p.join.status', { joinId: s.joinId });
      }
      t.out(s.phase === 'accepted' ? `Accepted with ${s.grants.map((g) => g.capability.name).join(', ') || 'nothing'}.` : `Not accepted: ${s.reason || s.phase}.`);
      return s.phase === 'accepted' ? 0 : 1;
    }
    const node = new P2PNode({ home: o.home, name: a.name, ...(o.nodeOptions || {}) }).start();
    try {
      let handle;
      try {
        handle = await node.join(words, await connectLan(a.lan), { requestedCaps, name: a.name });
      } catch (err) {
        t.out(err.code === 'words' ? 'The words did not work (wrong, used or expired).' : `Join failed: ${err.message}`);
        return 1;
      }
      show(handle.sas, handle.host);
      const d = await handle.decision;
      t.out(d.accepted ? `Accepted with ${d.grants.map((g) => g.capability.name).join(', ') || 'nothing'}.` : `Not accepted: ${d.reason}.`);
      return d.accepted ? 0 : 1;
    } finally {
      await node.close();
    }
  } catch (err) {
    t.err(`hivedesk join: ${err.message}`);
    return 2;
  } finally {
    t.close();
  }
}

/** Finds a peer by full id, short fingerprint, id prefix or exact name. */
export function findPeer(peers, ref) {
  const r = String(ref || '').toLowerCase();
  const hits = peers.filter((p) => p.identity.peerId === r || p.identity.fingerprint.short === r || (r.length >= 7 && p.identity.peerId.startsWith(r)) || p.identity.name.toLowerCase() === r);
  if (hits.length !== 1) throw new Error(hits.length ? `"${ref}" matches ${hits.length} peers; use the full id` : `no peer "${ref}"`);
  return hits[0];
}

export function formatPeers(peers) {
  if (!peers.length) return 'No peers yet. Make an invite: hivedesk invite --lan <address>';
  const lines = [];
  for (const p of peers) {
    lines.push(`${p.identity.name}  ${p.identity.fingerprint.short}  ${p.trust}${p.online ? ', online' : ''}  last seen ${p.lastSeen}`);
    lines.push(`  fingerprint: ${p.identity.fingerprint.words.join(' ')}`);
    for (const g of p.grants) lines.push(`  may here:  ${g.capability.name}${g.capability.limits ? ' ' + JSON.stringify(g.capability.limits) : ''}  until ${g.expiresAt || 'revoked'}  (${g.id})`);
    for (const g of p.held || []) lines.push(`  we may there: ${g.capability.name}  until ${g.expiresAt || 'revoked'}`);
  }
  return lines.join('\n');
}

/** hivedesk peers [--revoke <peer|grantId>] [--block <peer>] [--json] */
export async function runPeers(argv, o) {
  const t = io(o);
  let node = null;
  try {
    const a = parseP2PArgs(argv, ['revoke', 'block']);
    const engine = o.engine === undefined ? await engineClient(o) : o.engine;
    if (!engine) node = new P2PNode({ home: o.home, ...(o.nodeOptions || {}) }).start();
    const call = engine ? engine.call : async (type, d) => {
      if (type === 'p2p.peers') return { peers: node.listPeers() };
      if (type === 'p2p.revoke') return { grant: node.revoke(d.grantId, 'revoked from the terminal') };
      if (type === 'p2p.block') return { blocked: node.block(d.peerId) };
      throw new Error(type);
    };
    let { peers } = await call('p2p.peers');
    if (a.revoke) {
      let ids;
      if (/^gr_/.test(a.revoke)) ids = [a.revoke];
      else ids = findPeer(peers, a.revoke).grants.map((g) => g.id);
      for (const id of ids) await call('p2p.revoke', { grantId: id });
      t.out(`Revoked ${ids.length} grant${ids.length === 1 ? '' : 's'}.`);
      ({ peers } = await call('p2p.peers'));
    }
    if (a.block) {
      const p = findPeer(peers, a.block);
      await call('p2p.block', { peerId: p.identity.peerId });
      t.out(`Blocked ${p.identity.name}: every grant revoked, no reconnect, no invite.`);
      ({ peers } = await call('p2p.peers'));
    }
    t.out(a.json ? JSON.stringify(peers, null, 2) : formatPeers(peers));
    return 0;
  } catch (err) {
    t.err(`hivedesk peers: ${err.message}`);
    return 2;
  } finally {
    await node?.close();
    t.close();
  }
}

export const P2P_SUBCOMMANDS = Object.freeze({ invite: runInvite, join: runJoin, peers: runPeers });
