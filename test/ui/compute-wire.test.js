// The City compute view reads the events and frames that src/compute/ really sends (docs/1.0/protocol/compute.md).
import { describe, it, expect } from 'vitest';
import { blankCompute, applyComputeEvent, applyComputeLive, jobActions, jobCommand, STOP_SHARING } from '../../ui/city/compute.js';
import { machineCard } from '../../ui/city/machines.js';
import { defaultShare, patchShare } from '../../src/compute/share.js';

const ev = (seq, type, data) => ({ seq, ts: new Date(1_800_000_000_000 + seq * 1000).toISOString(), type, data });
const RITA = 'hd1' + 'r'.repeat(49);

describe('the City compute view on the real compute events', () => {
  it('follows a requester job through job.state with the choices it offers, and ends with job.ended', () => {
    const c = blankCompute();
    applyComputeEvent(c, ev(1, 'job.created', { jobId: 'jb_a', model: 'any-allowed', priority: 'normal', taskId: 't1', agentId: 'dev' }));
    applyComputeEvent(c, ev(2, 'job.scheduled', { jobId: 'jb_a', decision: { target: { kind: 'peer-gpu', peerId: RITA, model: 'qwen' }, reason: 'fits', candidates: [] } }));
    expect(c.jobs.jb_a).toMatchObject({ state: 'queued', worker: RITA, taskId: 't1' });
    applyComputeEvent(c, ev(3, 'job.state', { jobId: 'jb_a', state: 'running' }));
    applyComputeLive(c, { type: 'job.token', data: { jobId: 'jb_a', peerId: RITA, n: 12 } });
    expect(c.jobs.jb_a).toMatchObject({ state: 'running', tokens: 12 });
    expect(jobActions(c.jobs.jb_a)).toEqual(['cancel']);
    applyComputeEvent(c, ev(4, 'job.state', { jobId: 'jb_a', state: 'failed', error: { code: 'disconnected', message: 'gone' }, choices: ['retry-local', 'cancel'], choiceDeadline: '2027-01-01T00:00:00Z' }));
    expect(c.jobs.jb_a.error.code).toBe('disconnected');
    expect(jobActions(c.jobs.jb_a)).toEqual(['retryLocal', 'cancel']);
    expect(jobCommand('retryLocal', 'jb_a')).toEqual(['compute.job.choose', { jobId: 'jb_a', choice: 'retry-local' }]);
    expect(jobCommand('cancel', 'jb_a')).toEqual(['compute.job.choose', { jobId: 'jb_a', choice: 'cancel' }]);
    applyComputeEvent(c, ev(5, 'job.state', { jobId: 'jb_a', state: 'failed', error: { code: 'disconnected', message: 'gone' } }));
    applyComputeEvent(c, ev(6, 'job.ended', { role: 'requester', jobId: 'jb_a', worker: RITA, state: 'failed', error: 'disconnected' }));
    expect(c.jobs.jb_a.state).toBe('failed');
    expect(jobActions(c.jobs.jb_a)).toEqual([]);
  });

  it('shows a job this engine serves for a peer, with its lease and the owner Stop', () => {
    const c = blankCompute();
    applyComputeEvent(c, ev(1, 'job.leased', { jobId: 'jb_s', peerId: RITA, leaseId: 'ls_1', model: 'qwen', device: 'gpu', hardDeadline: 1_900_000_000_000 }));
    applyComputeEvent(c, ev(2, 'job.running', { jobId: 'jb_s', peerId: RITA }));
    expect(c.jobs.jb_s).toMatchObject({ state: 'running', requester: RITA, worker: 'local', served: true, lease: { id: 'ls_1' } });
    expect(jobActions(c.jobs.jb_s)).toEqual(['stop']);
    expect(jobCommand('stop', 'jb_s')).toEqual(['compute.job.stop', { jobId: 'jb_s' }]);
    const card = machineCard({ id: 'm_me', name: 'Me', self: true }, { machines: {}, agents: {} }, c, { selfPeerId: 'hd1me' });
    expect(card.jobs[0]).toMatchObject({ id: 'jb_s', forPeer: true, leaseId: 'ls_1' });
    applyComputeEvent(c, ev(3, 'job.served', { jobId: 'jb_s', requester: RITA, model: 'qwen', outcome: 'revoked' }));
    expect(c.jobs.jb_s).toMatchObject({ state: 'revoked', error: { code: 'revoked' } });
  });

  it('reads a peer advert from resources.peer as reported by its name, and the real share blocks', () => {
    const c = blankCompute();
    applyComputeLive(c, { type: 'resources.peer', data: { peerId: RITA, name: "Rita's PC", reportedBy: "Rita's PC", sampledAt: Date.now(), cpu: { loadPct: 20 }, ram: { totalBytes: 16e9, freeBytes: 8e9 }, gpus: [{ index: 0, name: 'GTX 1060', vendor: 'nvidia', vramTotalBytes: 6e9, vramFreeBytes: 5e9, utilPct: 3, source: 'nvidia-smi' }], share: { gpu: { enabled: true, maxConcurrentJobs: 1, maxJobSeconds: 60, maxVramBytes: 4e9 }, cpu: { enabled: false }, maxTokensPerJob: 512, modelAllowlist: ['qwen'] } } });
    expect(c.resources[RITA].reportedBy).toBe("Rita's PC");
    const card = machineCard({ id: 'm_r', name: 'Rita', peerId: RITA }, { machines: {}, agents: {} }, c, { now: Date.now() });
    expect(card.state).toBe('reported');
    expect(card.share).toMatchObject({ enabled: true, maxConcurrentJobs: 1, maxJobSeconds: 60, maxVramBytes: 4e9, maxTokensPerJob: 512 });
    // Stop sharing turns both blocks off in the real settings.
    const on = patchShare(defaultShare(4), { gpu: { enabled: true }, cpu: { enabled: true } });
    expect(patchShare(on, STOP_SHARING[1].change)).toMatchObject({ enabled: false, gpu: { enabled: false }, cpu: { enabled: false } });
    expect(STOP_SHARING[0]).toBe('compute.share.set');
  });
});
