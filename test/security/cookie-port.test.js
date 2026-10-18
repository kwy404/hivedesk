// Two engines on one PC share the 127.0.0.1 cookie jar of a browser: each engine names its cookie by its port,
// so opening the second window never logs the first one out (found by the 1.0 end to end test).
import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { startHive } from '../../src/index.js';
import { createFakeBrain } from '../../src/brain/fake.js';
import { tmpDir } from '../helpers.js';

const get = (port, p, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode, cookie: String(res.headers['set-cookie'] || '') })); });
  req.on('error', reject);
  req.end();
});

describe('one session cookie per engine', () => {
  it('names the cookie by the port, and both windows keep working with both cookies in one jar', async () => {
    const brain = () => createFakeBrain({ respond: () => 'x' });
    const a = await startHive({ dir: tmpDir(), home: tmpDir(), brain: brain() });
    const b = await startHive({ dir: tmpDir(), home: tmpDir(), brain: brain() });
    try {
      const ca = (await get(a.server.port, `/?t=${a.server.token}`)).cookie.split(';')[0];
      const cb = (await get(b.server.port, `/?t=${b.server.token}`)).cookie.split(';')[0];
      expect(ca.startsWith(`hivedesk_token_${a.server.port}=`)).toBe(true);
      expect(cb.startsWith(`hivedesk_token_${b.server.port}=`)).toBe(true);
      const jar = `${ca}; ${cb}`;
      expect((await get(a.server.port, '/api/health', { cookie: jar })).status).toBe(200);
      expect((await get(b.server.port, '/api/health', { cookie: jar })).status).toBe(200);
      // The 0.x name still works for a window opened before the update.
      expect((await get(a.server.port, '/api/health', { cookie: `hivedesk_token=${a.server.token}` })).status).toBe(200);
    } finally {
      await b.close();
      await a.close();
    }
  });
});
