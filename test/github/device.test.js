import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createGitHub } from '../../src/github/index.js';
import { CredentialStore } from '../../src/github/store.js';
import { EventBus } from '../../src/bus.js';
import { Workspace } from '../../src/tools/index.js';
import { tmpDir, waitFor } from '../helpers.js';
import { startStub } from './stub.js';

const TOKEN = 'gho_DEVICEFLOW_TESTONLY_0123456789abcdef';

describe('device flow (only with a configured client id)', () => {
  let stub;
  afterAll(() => stub?.close());

  it('is off without a client id, and connects through the stub when one is set', async () => {
    const base = tmpDir('hivedesk-device-');
    stub = await startStub({ token: TOKEN, reposDir: path.join(base, 'remotes') });
    const home = path.join(base, 'home');
    const bus = new EventBus();
    const live = [];
    bus.onLive((type, data) => live.push({ type, data }));
    const ws = new Workspace(path.join(base, 'ws'));
    const off = createGitHub({ bus, workspace: ws, config: { home }, github: { apiBase: stub.base, webBase: stub.base, ask: null } });
    await expect(off.deviceStart()).rejects.toMatchObject({ code: 'not_configured' });

    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ github: { clientId: 'Iv1.test-client-id' } }));
    const gh = createGitHub({ bus, workspace: ws, config: { home }, github: { apiBase: stub.base, webBase: stub.base, ask: null, devicePollMs: 20 } });
    const start = await gh.deviceStart();
    expect(start).toMatchObject({ userCode: 'ABCD-1234', verificationUri: 'https://github.example/login/device' });
    expect(JSON.stringify(start)).not.toContain('dev-code');
    await waitFor(() => live.some((f) => f.type === 'github.device' && f.data.state === 'connected'), { timeout: 5000 });
    expect(new CredentialStore(home).read()).toMatchObject({ source: 'device', login: 'octo-tester', token: TOKEN });
    expect(JSON.stringify(live)).not.toContain(TOKEN);
    expect(JSON.stringify(bus.events)).not.toContain(TOKEN);
    expect(new CredentialStore(home).publicView()).not.toHaveProperty('token');
  });
});
