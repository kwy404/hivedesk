// The borrower side of a pooled model: llama-server on 127.0.0.1 with --rpc pointing at the local ends
// of the tunnels (one per lender), used through the OpenAI compatible brain. Experimental and off by
// default: it runs only when the pooled model flag is on, the file is downloaded, and every lender
// granted a lease.
//
// Honest limits: the first load sends each lender its share of the weights through the tunnel (slow over
// the internet), and every token waits for each lender in turn (fine on the same network, slow far away).
// A friend's machine computes part of every token, so the output is untrusted like any remote output:
// the brain is marked kind 'remote' and its tool calls wait for the host (0.2.1).
import { spawn } from 'node:child_process';
import { createOpenAIBrain } from '../http.js';
import { freePort } from './lender.js';

/** llama-server arguments for a pooled run. `split` follows the meter plan: a fraction per RPC worker. */
export function serverArgs({ model, rpcPorts, ctx, port, threads, split, localFirst = false, ngl = 999 }) {
  // -ngl: the layers offloaded to the RPC workers; the others stay on this PC.
  const args = ['-m', model, '--rpc', rpcPorts.map((p) => `127.0.0.1:${p}`).join(','), '-ngl', String(ngl), '-c', String(ctx || 4096), '-np', '1', '--host', '127.0.0.1', '--port', String(port)];
  if (threads) args.push('-t', String(threads));
  if (split?.length && split.length === rpcPorts.length + (localFirst ? 1 : 0)) args.push('-ts', split.map((x) => Math.max(0, Math.round(x * 100) / 100)).join(','));
  return args;
}

export class PooledSession {
  /**
   * @param {{ server: string, model: string, name: string, rpcPorts: number[], ctx?: number, split?: number[], threads?: number,
   *   spawnImpl?: typeof spawn, fetchImpl?: typeof fetch, loadTimeoutMs?: number, bus?: any, log?: (s: string) => void }} o
   */
  constructor(o) {
    this.o = o;
    this.proc = null;
    this.brain = null;
    this.state = 'idle';
    this.tail = '';
  }

  async start() {
    const o = this.o;
    const port = await freePort();
    const args = serverArgs({ model: o.model, rpcPorts: o.rpcPorts, ctx: o.ctx, port, threads: o.threads, split: o.split, ngl: o.ngl });
    this.state = 'loading';
    const proc = (o.spawnImpl || spawn)(o.server, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    this.proc = proc;
    proc.stderr?.on('data', (c) => { this.tail = (this.tail + c).slice(-4000); });
    const exited = new Promise((resolve) => proc.on('exit', (code) => { this.state = 'stopped'; resolve(code); }));
    const f = o.fetchImpl || fetch;
    const until = Date.now() + (o.loadTimeoutMs ?? 30 * 60_000);
    let ready = false;
    while (!ready && Date.now() < until && this.state === 'loading') {
      const r = await Promise.race([f(`http://127.0.0.1:${port}/health`).then((x) => x.ok).catch(() => false), exited.then(() => 'exit')]);
      if (r === 'exit') break;
      if (r === true) ready = true;
      else await new Promise((res) => setTimeout(res, 1000));
    }
    if (!ready) {
      const why = this.state === 'stopped' ? 'llama-server stopped' : 'the pooled model did not load in time';
      this.stop();
      throw Object.assign(new Error(`${why}: ${this.tail.slice(-300)}`), { code: 'load' });
    }
    this.state = 'ready';
    const brain = createOpenAIBrain({ url: `http://127.0.0.1:${port}/v1`, model: o.name, id: 'pooled', backend: 'pooled', fetchImpl: o.fetchImpl });
    brain.kind = 'remote';
    brain.label = `Pooled: ${o.name} (experimental)`;
    brain.pooled = true;
    const close = brain.close?.bind(brain);
    brain.close = async () => { try { await close?.(); } catch { /* ignore */ } this.stop(); };
    this.brain = brain;
    o.bus?.emit?.('pool.session.ready', { model: o.name, workers: o.rpcPorts.length });
    return brain;
  }

  /** Real cancel of the whole session: llama-server is killed (a turn is cancelled by its own signal). */
  stop() {
    if (this.proc && this.state !== 'stopped') { try { this.proc.kill(); } catch { /* gone */ } }
    this.state = 'stopped';
  }
}
