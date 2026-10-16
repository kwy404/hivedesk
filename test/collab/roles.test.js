import { describe, expect, it } from 'vitest';
import { PermissionError, canCommand, canEdit, checkCommand } from '../../ui/lend/collab/roles.js';

const viewer = { id: 'g1', name: 'Ana', role: 'viewer' };
const collab = { id: 'g2', name: 'Bo', role: 'collaborator' };

describe('Code together roles', () => {
  it('a viewer can read and chat, nothing else', () => {
    for (const t of ['files.read', 'files.list', 'events.since', 'chat.send']) expect(canCommand('viewer', t)).toBe(true);
    for (const t of ['job.create', 'approval.resolve', 'files.write', 'task.retry', 'job.cancel']) {
      expect(canCommand('viewer', t)).toBe(false);
      expect(() => checkCommand(viewer, t, {})).toThrow(PermissionError);
    }
    expect(canEdit('viewer')).toBe(false);
  });

  it('a collaborator can ask the crew, approve and edit', () => {
    for (const t of ['job.create', 'approval.resolve', 'files.write', 'task.retry', 'chat.send']) expect(canCommand('collaborator', t)).toBe(true);
    expect(canEdit('collaborator')).toBe(true);
  });

  it('no guest touches the model, settings, crew, lent brains or a shell', () => {
    for (const role of ['viewer', 'collaborator']) {
      for (const t of ['settings.set', 'brain.select', 'brain.download', 'brain.attach', 'brain.chat', 'crew.hire', 'crew.fire', 'crew.update', 'playbook.delete', 'lend.chat', 'lend.stop', 'run', 'shell', 'doctor', 'brain.probe', 'unknown']) {
        expect(canCommand(role, t), `${role} ${t}`).toBe(false);
      }
    }
    expect(canCommand('host', 'settings.set')).toBe(true);
    expect(canCommand('stranger', 'files.read')).toBe(false);
  });

  it('signs what guests say and marks their writes for approval', () => {
    expect(checkCommand(viewer, 'chat.send', { channel: 'general', text: 'hi' }).data).toEqual({ channel: 'general', text: 'Ana: hi' });
    const w = checkCommand(collab, 'files.write', { path: 'index.html', content: '<p>', as: { id: 'host' } });
    expect(w.data).toEqual({ path: 'index.html', content: '<p>', as: { id: 'g2', name: 'Bo' } });
    expect(checkCommand(collab, 'approval.resolve', { approvalId: 'a_1', approved: 1 }).data).toEqual({ approvalId: 'a_1', approved: true, note: 'Bo' });
    expect(checkCommand(collab, 'job.create', { request: 'a page', approval: false }).data).toEqual({ request: 'a page' });
  });
});
