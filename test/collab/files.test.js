import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolBox } from '../../src/tools/index.js';
import { Approvals } from '../../src/tools/approvals.js';
import registerCollab, { writeFile } from '../../src/collab/index.js';
import { until } from '../lend/helpers.js';

function engine() {
  const dir = mkdtempSync(join(tmpdir(), 'hivedesk-collab-'));
  const events = [];
  const bus = { state: { settings: { approvalMode: true } }, emit: (type, data) => events.push({ type, data }), live: () => {} };
  const approvals = new Approvals(bus);
  const toolbox = new ToolBox({ workspace: dir, bus, approvals });
  return { dir, events, approvals, toolbox };
}

describe('editor saves through the engine tools', () => {
  it('the person at this PC saves at once, with a file.changed event', async () => {
    const e = engine();
    await expect(writeFile(e.toolbox, { path: 'index.html', content: '<h1>Hi</h1>' })).resolves.toEqual({ path: 'index.html', bytes: 11 });
    expect(readFileSync(join(e.dir, 'index.html'), 'utf8')).toBe('<h1>Hi</h1>');
    expect(e.events.find((x) => x.type === 'file.changed').data).toMatchObject({ path: 'index.html', op: 'create', workerId: 'user' });
  });

  it('a guest overwriting a file waits for the host approval', async () => {
    const e = engine();
    writeFileSync(join(e.dir, 'index.html'), 'old');
    const saving = writeFile(e.toolbox, { path: 'index.html', content: 'new', as: { id: 'g1', name: 'Ana', role: 'collaborator' } });
    const req = await until(() => e.events.find((x) => x.type === 'approval.requested'));
    expect(req.data.approval).toMatchObject({ workerId: 'guest:Ana', tool: 'write_file', strict: true, origin: { kind: 'guest', id: 'g1', label: 'Ana' } });
    expect(readFileSync(join(e.dir, 'index.html'), 'utf8')).toBe('old');
    e.approvals.resolve(req.data.approval.id, true);
    await saving;
    expect(readFileSync(join(e.dir, 'index.html'), 'utf8')).toBe('new');
  });

  it('a rejected guest save changes nothing', async () => {
    const e = engine();
    writeFileSync(join(e.dir, 'a.js'), 'keep');
    const saving = writeFile(e.toolbox, { path: 'a.js', content: 'x', as: { id: 'g1', name: 'Ana', role: 'collaborator' } });
    const req = await until(() => e.events.find((x) => x.type === 'approval.requested'));
    e.approvals.resolve(req.data.approval.id, false, 'no');
    await expect(saving).rejects.toMatchObject({ code: 'rejected' });
    expect(readFileSync(join(e.dir, 'a.js'), 'utf8')).toBe('keep');
  });

  it('refuses paths outside the workspace and registers the command', async () => {
    const e = engine();
    for (const path of ['../x.txt', '/etc/passwd', 'C:/x', 'a/../../b']) await expect(writeFile(e.toolbox, { path, content: '' })).rejects.toMatchObject({ code: 'bad_request' });
    const commands = new Map();
    registerCollab({ server: { command: (t, h) => commands.set(t, h) }, toolbox: e.toolbox });
    expect(commands.has('files.write')).toBe(true);
  });
});
