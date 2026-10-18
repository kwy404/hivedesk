// Helpers for the P2P tests: engines with their own temp home in one process.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { P2PNode } from '../../src/p2p/node.js';

const homes = [];

export function tempHome(label = 'p2p') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hivedesk-${label}-`));
  homes.push(dir);
  return dir;
}

export function cleanHomes() {
  for (const d of homes.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch { /* Windows may hold a file a moment longer */ }
  }
}

/** A clock the test moves by hand. */
export function clock(start = Date.parse('2026-10-17T12:00:00Z')) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  return now;
}

export function makeNode(name, opts = {}) {
  return new P2PNode({ home: opts.home || tempHome(name), name, iterations: 1000, handshakeMs: 3000, ...opts }).start();
}

export const waitFor = (emitter, event, ms = 3000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    emitter.once(event, (x) => {
      clearTimeout(t);
      resolve(x);
    });
  });

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Polls until fn() is truthy. */
export async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await tick(5);
  }
  throw new Error('condition not met in time');
}
