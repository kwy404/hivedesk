import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { startHive } from '../src/index.js';
import { connect } from '../src/ws.js';
import { createFakeBrain } from '../src/brain/fake.js';
import { tmpDir, waitFor, frames } from './helpers.js';

function request(port, p, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch { /* text */ }
        resolve({ status: res.statusCode, headers: res.headers, text: data, json });
      });
    });
    req.on('error', reject);
    if (body) req.end(typeof body === 'string' ? body : JSON.stringify(body));
    else req.end();
  });
}

describe('server', () => {
  let app;
  let port;
  let token;
  let uiDir;
  const respond = (messages, options) => {
    if (options.schema?.properties?.tasks) return { summary: 'ok', tasks: [{ title: 'Write', detail: '', assignee: 'dev', dependsOn: [] }] };
    const content = messages.find((m) => m.role === 'user')?.content || '';
    if (content.includes('Your task: Write')) {
      return messages.filter((m) => m.role === 'assistant').length === 0
        ? { tool: 'write_file', args: { path: 'index.html', content: '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>T</title></head><body><p>hi</p></body></html>' } }
        : { tool: 'done', args: { summary: 'wrote it' } };
    }
    return { tool: 'report', args: { passed: true, issues: [] } };
  };

  beforeAll(async () => {
    const dir = tmpDir();
    uiDir = path.join(dir, 'ui');
    fs.mkdirSync(uiDir);
    fs.writeFileSync(path.join(uiDir, 'index.html'), '<!doctype html><title>Hive</title>');
    fs.writeFileSync(path.join(dir, 'secret.txt'), 'secret');
    app = await startHive({ dir, uiDir, brain: createFakeBrain({ id: 'fake', respond }), home: tmpDir() });
    port = app.server.port;
    token = app.server.token;
  });
  afterAll(async () => { await app.close(); });

  it('needs the token on every request and sets a cookie', async () => {
    expect((await request(port, '/')).status).toBe(401);
    expect((await request(port, '/api/state')).status).toBe(401);
    expect((await request(port, '/?t=wrong')).status).toBe(401);
    const ok = await request(port, `/?t=${token}`);
    expect(ok.status).toBe(200);
    expect(ok.text).toContain('Hive');
    const cookie = ok.headers['set-cookie'][0];
    expect(cookie).toMatch(/hivedesk_token=.*HttpOnly; SameSite=Strict/);
    expect((await request(port, '/api/health', { headers: { cookie: cookie.split(';')[0] } })).json).toMatchObject({ ok: true, protocol: 1 });
    expect((await request(port, '/api/health', { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  });

  it('refuses a foreign Host header and path traversal in static files', async () => {
    expect((await request(port, `/?t=${token}`, { headers: { host: 'evil.example' } })).status).toBe(403);
    expect((await request(port, `/..%2f..%2fsecret.txt?t=${token}`)).status).toBe(404);
    expect((await request(port, `/%2e%2e/secret.txt?t=${token}`)).status).toBe(404);
  });

  it('serves the reducer module for the UI', async () => {
    const r = await request(port, `/lib/reduce.js?t=${token}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/javascript/);
    expect(r.text).toContain('export function reduce');
  });

  it('runs a job over the WebSocket and broadcasts events', async () => {
    expect(connect(`ws://127.0.0.1:${port}/ws`)).rejects.toMatchObject({ status: 401 });
    await expect(connect(`ws://127.0.0.1:${port}/ws?t=${token}`, { headers: { Origin: 'http://evil.example' } })).rejects.toMatchObject({ status: 403 });
    const c = await connect(`ws://127.0.0.1:${port}/ws?t=${token}`, { headers: { Origin: `http://127.0.0.1:${port}` } });
    const got = frames(c);
    await waitFor(() => got[0]);
    expect(got[0]).toMatchObject({ kind: 'hello', protocol: 1, demo: false });
    expect(got[0].state.crew).toHaveLength(5);
    c.send(JSON.stringify({ kind: 'command', id: 'c1', type: 'job.create', data: { request: 'a page', approval: false, refine: false } }));
    const reply = await waitFor(() => got.find((f) => f.kind === 'reply' && f.id === 'c1'));
    expect(reply).toMatchObject({ ok: true, result: { jobId: 'j_1' } });
    await waitFor(() => got.some((f) => f.kind === 'event' && f.event.type === 'job.done'));
    const types = got.filter((f) => f.kind === 'event').map((f) => f.event.type);
    expect(types).toContain('file.changed');
    expect(types).toContain('turn.started');
    expect(got.some((f) => f.kind === 'live' && f.type === 'turn.token')).toBe(true);
    c.send(JSON.stringify({ kind: 'command', id: 'c2', type: 'nope', data: {} }));
    c.send('not json');
    const bad = await waitFor(() => got.find((f) => f.kind === 'reply' && f.id === 'c2'));
    expect(bad).toMatchObject({ ok: false, error: { code: 'bad_request' } });
    c.close();
  });

  it('answers the REST endpoints', async () => {
    const auth = { headers: { authorization: `Bearer ${token}` } };
    const files = await request(port, '/api/files', auth);
    expect(files.json.files.map((f) => f.path)).toContain('index.html');
    expect((await request(port, '/api/file?path=index.html', auth)).json.content).toContain('<p>hi</p>');
    expect((await request(port, '/api/file?path=../secret.txt', auth)).status).toBe(400);
    const ev = await request(port, '/api/events?since=0&limit=3', auth);
    expect(ev.json.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    const replay = await request(port, '/api/replay?seq=1', auth);
    expect(replay.json.lastSeq).toBe(1);
    expect((await request(port, '/api/playbooks', auth)).json.playbooks).toHaveLength(1);
    const cmd = await request(port, '/api/command', { method: 'POST', headers: auth.headers, body: { type: 'settings.set', data: { sound: false } } });
    expect(cmd.json).toMatchObject({ ok: true, result: { settings: { sound: false } } });
    const fail = await request(port, '/api/command', { method: 'POST', headers: auth.headers, body: { type: 'crew.fire', data: { workerId: 'dev' } } });
    expect(fail.status).toBe(400);
    expect(fail.json.error.code).toBe('bad_request');
    const lend = await request(port, '/api/command', { method: 'POST', headers: auth.headers, body: { type: 'brain.chat', data: { messages: [{ role: 'user', content: 'x' }] } } });
    expect(lend.json.error.code).toBe('not_lending');
  });

  it('serves the preview sandboxed, without the token, inside the workspace only', async () => {
    const r = await request(port, '/preview/');
    expect(r.status).toBe(200);
    expect(r.text).toContain('<p>hi</p>');
    expect(r.headers['content-security-policy']).toMatch(/sandbox/);
    expect((await request(port, '/preview/..%2f..%2fsecret.txt')).status).toBe(403);
    expect((await request(port, '/preview/missing.css')).status).toBe(404);
    expect((await request(port, '/preview/', { headers: { host: 'evil.example' } })).status).toBe(403);
  });

  it('plugs a remote brain in over the WebSocket', async () => {
    const c = await connect(`ws://127.0.0.1:${port}/ws?t=${token}`);
    const got = frames(c);
    await waitFor(() => got[0]);
    // Take the local brain away so the remote one gets the turn.
    app.scheduler.removeBrain('fake', 'test');
    c.send(JSON.stringify({ kind: 'command', id: 'a', type: 'brain.attach', data: { label: 'Friend', model: 'qwen' } }));
    const attached = await waitFor(() => got.find((f) => f.kind === 'reply' && f.id === 'a'));
    const brainId = attached.result.brainId;
    expect(app.bus.state.brains.map((b) => b.brainId)).toContain(brainId);
    const turn = app.scheduler.turn({ workerId: 'dev', messages: [{ role: 'user', content: 'hello friend' }], options: { maxTokens: 10 } });
    const req = await waitFor(() => got.find((f) => f.kind === 'brain.request'));
    expect(req).toMatchObject({ brainId, messages: [{ role: 'user', content: 'hello friend' }], options: { maxTokens: 10 } });
    c.send(JSON.stringify({ kind: 'command', id: 'r', type: 'brain.respond', data: { requestId: req.requestId, ok: true, result: { text: 'hi back', completionTokens: 2 } } }));
    expect((await turn).text).toBe('hi back');
    c.close();
    await waitFor(() => !app.bus.state.brains.some((b) => b.brainId === brainId));
  });
});

describe('demo and lend modes', () => {
  it('demo labels every event and finishes the scripted job', async () => {
    const app = await startHive({ dir: tmpDir(), demo: true, demoDelayMs: 0, demoApproveMs: 10, autoStartDemo: true, home: tmpDir() });
    const c = await connect(`ws://127.0.0.1:${app.server.port}/ws?t=${app.server.token}`);
    const got = frames(c);
    await waitFor(() => got[0]);
    expect(got[0].demo).toBe(true);
    await waitFor(() => app.bus.state.jobs[0]?.status === 'done', { timeout: 20000 });
    expect(app.bus.events.every((e) => e.demo === true)).toBe(true);
    expect(app.bus.state.chat.general[0].text).toMatch(/This is a demo/);
    expect(app.bus.state.brain).toMatchObject({ backend: 'fake', state: 'ready' });
    c.close();
    await app.close();
  });

  it('lend mode serves brain.chat through the scheduler', async () => {
    const app = await startHive({ dir: tmpDir(), lend: true, brain: createFakeBrain({ respond: () => 'pong' }), home: tmpDir() });
    const r = await app.server.runCommand('brain.chat', { messages: [{ role: 'user', content: 'ping' }, { role: 'evil', content: 'x' }], options: { maxTokens: 99999 } }, null);
    expect(r.text).toBe('pong');
    expect(app.bus.events.find((e) => e.type === 'brain.served').data.promptChars).toBe(4);
    await app.close();
  });
});
