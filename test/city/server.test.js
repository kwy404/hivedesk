import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { startHive } from '../../src/index.js';
import { connect } from '../../src/ws.js';
import { createFakeBrain } from '../../src/brain/fake.js';
import { checkCommand, canCommand } from '../../ui/lend/collab/roles.js';
import { DEMO_FRIEND } from '../../src/city/demo.js';
import { tmpDir, waitFor, frames } from '../helpers.js';

function request(port, p, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json' } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text, json: () => JSON.parse(text) }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('the city on the engine server', () => {
  it('serves the reducer, puts the city in hello and state, and answers city commands over REST and WebSocket', async () => {
    const app = await startHive({ dir: tmpDir(), home: tmpDir(), brain: createFakeBrain({ respond: () => ({ tool: 'done', args: { summary: 'ok' } }) }) });
    const { port, token } = app.server;
    const lib = await request(port, `/lib/city.js?t=${token}`);
    expect(lib.status).toBe(200);
    expect(lib.text).toContain('export function reduceCity');
    expect(lib.text).not.toMatch(/from 'node:/);
    const c = await connect(`ws://127.0.0.1:${port}/ws?t=${token}`);
    const got = frames(c);
    await waitFor(() => got[0]);
    expect(got[0]).toMatchObject({ kind: 'hello', city: 1 });
    expect(Object.keys(got[0].state.city.rooms)).toContain('lobby');
    expect(got[0].state.city.agents.dev.room).toBe('code');
    c.send(JSON.stringify({ kind: 'command', id: 'p1', type: 'city.presence', data: { x: 1, y: 2 } }));
    await waitFor(() => got.find((f) => f.kind === 'live' && f.type === 'city.presence'));
    const health = (await request(port, `/api/health?t=${token}`)).json();
    expect(health.city).toBe(1);
    const created = await request(port, `/api/command?t=${token}`, { method: 'POST', body: { type: 'city.task.create', data: { title: 'A task', room: 'review' } } });
    expect(created.json()).toMatchObject({ ok: true, result: { task: { pipeline: ['review', 'test'] } } });
    await waitFor(() => got.some((f) => f.kind === 'event' && f.event.type === 'city.task.created'));
    const denied = await request(port, `/api/command?t=${token}`, { method: 'POST', body: { type: 'city.room.add', data: { id: 'lab', as: { id: 'g1', name: 'Eve' } } } });
    expect(denied.status).toBe(403);
    expect(denied.json().error.code).toBe('forbidden');
    expect((await request(port, `/api/state?t=${token}`)).json().city.v).toBe(1);
    c.close();
    await app.close();
  });

  it('can run without the city, and the 0.1 job API works with it', async () => {
    const app = await startHive({ dir: tmpDir(), home: tmpDir(), city: false, brain: createFakeBrain({ respond: () => 'x' }) });
    expect(app.city).toBe(null);
    await expect(app.server.runCommand('city.state', {})).rejects.toMatchObject({ code: 'bad_request' });
    await app.close();
  });
});

describe('the --demo city scenario', () => {
  it('has a friend join, a borrow across the bridge and a task through every room, all labeled demo', async () => {
    const app = await startHive({ dir: tmpDir(), demo: true, demoDelayMs: 0, demoApproveMs: 10, autoStartDemo: true, home: tmpDir() });
    const steps = () => app.bus.events.filter((e) => e.type === 'city.demo.step').map((e) => e.data.step);
    await waitFor(() => steps().includes('done') && app.bus.state.jobs[0]?.status === 'done', { timeout: 30000 });
    expect(steps()).toEqual(['friend', 'borrow', 'lent', 'task', 'done']);
    const city = app.bus.state.city;
    expect(city.machines[DEMO_FRIEND.machine.id]).toMatchObject({ via: 'words', online: true, name: "Rita's PC" });
    const borrow = Object.values(city.borrows)[0];
    expect(borrow).toMatchObject({ agentId: 'dev', to: DEMO_FRIEND.machine.id, status: 'ended', reason: 'limit', used: { turns: 3 } });
    const task = Object.values(city.tasks).find((t) => t.title === 'Add a weekly specials section');
    expect(task).toMatchObject({ status: 'done', pipeline: ['design', 'code', 'review', 'test'], files: ['index.html'] });
    const hops = app.bus.events.filter((e) => e.type === 'city.task.hop' && e.data.hop.taskId === task.id).map((e) => e.data.hop.to);
    expect(hops).toEqual(['code', 'review', 'test']);
    expect(task.verdicts.find((v) => v.room === 'review').agentId).toBe(`${DEMO_FRIEND.machine.id}:pip`);
    expect(app.toolbox.ws.read('index.html')).toContain('<section class="specials">');
    expect(app.bus.events.every((e) => e.demo === true)).toBe(true);
    await app.close();
  });
});

describe('Code together roles for the city', () => {
  it('lets every guest see the city and bring a building, and collaborators use the task board', () => {
    for (const t of ['city.sync', 'city.presence', 'city.machine.join', 'city.borrow.answer']) expect(canCommand('viewer', t)).toBe(true);
    for (const t of ['city.task.create', 'city.task.approve', 'city.agent.move']) {
      expect(canCommand('viewer', t)).toBe(false);
      expect(canCommand('collaborator', t)).toBe(true);
    }
    for (const t of ['city.agent.hire', 'city.room.add', 'city.agents.local', 'city.agents.save']) expect(canCommand('collaborator', t)).toBe(false);
    const out = checkCommand({ id: 'g2', name: 'Kim', role: 'collaborator' }, 'city.task.create', { title: 'x', as: { id: 'h', name: 'Host' } });
    expect(out.data).toEqual({ title: 'x', as: { id: 'g2', name: 'Kim' } });
  });
});
