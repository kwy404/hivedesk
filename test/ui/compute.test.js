// The compute adapter of the City (ui/city/compute.js): jobs, leases, failures and resources
// reduce from the events of the compute plane, and nothing is invented when they are missing.
import { describe, it, expect } from 'vitest';
import { blankCompute, applyComputeEvent, applyComputeLive, jobActions, jobView, countdown, bridgeJobs, cleanResource, isComputeType } from '../../ui/city/compute.js';

const ev = (seq, type, data, ts = new Date(1_800_000_000_000 + seq * 1000).toISOString()) => ({ seq, ts, type, data });
const ME = 'hd1me';
const RITA = 'hd1rita';

function job(c, extra = {}) {
  applyComputeEvent(c, ev(1, 'job.created', { job: { id: 'jb_1', type: 'inference', requester: ME, worker: RITA, taskId: 'ct_1', agentId: 'dev', input: { model: 'qwen-7b', messages: [], maxTokens: 100 }, ...extra } }));
  applyComputeEvent(c, ev(2, 'job.scheduled', { jobId: 'jb_1', decision: { target: { kind: 'peer-gpu', peerId: RITA, model: 'qwen-7b' }, estimateMs: 14000, reason: "Rita's PC, GPU: fits in 9.1 of 12.0 GB free, about 14 s.", candidates: [{ target: 'local-gpu', ok: false, code: 'vram', detail: '3.2 GB free' }, { target: 'peer-gpu:hd1rita', ok: true }] } }));
}

describe('compute adapter', () => {
  it('follows a job from queued to completed with its decision, lease and tokens', () => {
    const c = blankCompute();
    job(c);
    expect(c.jobs.jb_1).toMatchObject({ state: 'queued', model: 'qwen-7b', taskId: 'ct_1', agentId: 'dev' });
    const now = 1_800_000_010_000;
    applyComputeEvent(c, ev(3, 'job.accepted', { jobId: 'jb_1', lease: { id: 'ls_1', jobId: 'jb_1', expiresAt: now + 15000, hardDeadline: now + 120000, limits: { maxTokens: 100, vramBytes: 6e9, model: 'qwen-7b' }, state: 'active' } }));
    expect(c.jobs.jb_1.state).toBe('leased');
    expect(applyComputeLive(c, { type: 'job.token', data: { jobId: 'jb_1', text: 'he' } }, { now })).toBe(true);
    applyComputeLive(c, { type: 'job.token', data: { jobId: 'jb_1', text: 'llo' } }, { now });
    expect(c.jobs.jb_1).toMatchObject({ state: 'running', tokens: 2 });
    applyComputeLive(c, { type: 'job.heartbeat', data: { jobId: 'jb_1', leaseId: 'ls_1', tokens: 7, vramBytes: 5e9 } }, { now });
    expect(c.jobs.jb_1).toMatchObject({ tokens: 7, vramBytes: 5e9 });
    expect(countdown(c.jobs.jb_1, now)).toEqual({ lease: 15, deadline: 120 });
    const v = jobView(c.jobs.jb_1, { now, selfPeerId: ME, peerName: () => 'Rita' });
    expect(v).toMatchObject({ state: 'running', where: { kind: 'peerGpu', name: 'Rita' }, estimateMs: 14000, actions: ['cancel'], live: true, remote: true });
    expect(v.rejected).toEqual([{ target: 'local-gpu', ok: false, code: 'vram', detail: '3.2 GB free' }]);
    expect(v.reason).toContain('fits in 9.1');
    applyComputeEvent(c, ev(4, 'job.completed', { jobId: 'jb_1', result: { text: 'hello', promptTokens: 9, completionTokens: 7, ms: 900, model: 'qwen-7b' } }));
    expect(c.jobs.jb_1).toMatchObject({ state: 'completed', lease: { state: 'released' } });
    expect(jobActions(c.jobs.jb_1, { selfPeerId: ME })).toEqual([]);
    expect(countdown(c.jobs.jb_1, now)).toBe(null);
  });

  it('offers the PLAN failure choices: retry locally, retry another peer, cancel, use the partial', () => {
    const c = blankCompute();
    job(c);
    applyComputeEvent(c, ev(3, 'job.failed', { jobId: 'jb_1', error: { code: 'disconnected', message: 'no pong for 10 s' } }));
    expect(c.jobs.jb_1.error).toEqual({ code: 'disconnected', message: 'no pong for 10 s' });
    expect(jobActions(c.jobs.jb_1, { selfPeerId: ME })).toEqual(['retryLocal', 'retryPeer', 'cancel']);
    const p = blankCompute();
    job(p);
    applyComputeEvent(p, ev(3, 'job.partial', { jobId: 'jb_1', partial: { text: 'half an answ', completionTokens: 4 }, error: { code: 'lease_expired' } }));
    expect(jobActions(p.jobs.jb_1)).toEqual(['usePartial', 'retryLocal', 'retryPeer', 'cancel']);
    expect(jobView(p.jobs.jb_1).partial).toEqual({ chars: 12, tokens: 4 });
    const r = blankCompute();
    job(r);
    applyComputeEvent(r, ev(3, 'job.revoked', { jobId: 'jb_1', reason: 'Rita pressed Stop' }));
    expect(r.jobs.jb_1.error.code).toBe('revoked');
    expect(jobActions(r.jobs.jb_1)).toEqual(['retryLocal', 'cancel']);
  });

  it('lets the worker stop a job it serves, and lights or breaks the bridge from real job events', () => {
    const c = blankCompute();
    job(c, { requester: RITA, worker: ME });
    expect(jobActions(c.jobs.jb_1, { selfPeerId: ME })).toEqual(['stop']);
    const d = blankCompute();
    job(d);
    const now = Date.now();
    expect(bridgeJobs(d, RITA, now)).toEqual({ live: false, running: 1, failed: null });
    applyComputeLive(d, { type: 'job.token', data: { jobId: 'jb_1' } }, { now });
    expect(bridgeJobs(d, RITA, now).live).toBe(true);
    expect(bridgeJobs(d, RITA, now + 5000).live).toBe(false);
    applyComputeEvent(d, ev(5, 'job.failed', { jobId: 'jb_1', code: 'oom', message: 'CUDA out of memory' }, new Date(now).toISOString()));
    expect(bridgeJobs(d, RITA, now)).toMatchObject({ running: 0, failed: { id: 'jb_1', code: 'oom' } });
    expect(bridgeJobs(d, 'hd1other', now)).toEqual({ live: false, running: 0, failed: null });
  });

  it('keeps every resource number measured or null, and knows a peer advert from its own probe', () => {
    const r = cleanResource({ machineId: 'm_1', sampledAt: 5, cpu: { model: 'Ryzen', cores: 8, loadPct: 31 }, ram: { totalBytes: 32e9, freeBytes: 'lots' }, gpus: [{ index: 0, name: 'RTX 3060', vendor: 'nvidia', vramTotalBytes: 12e9, vramFreeBytes: 9e9, utilPct: null, source: 'nvidia-smi' }] });
    expect(r.ram).toEqual({ totalBytes: 32e9, freeBytes: null });
    expect(r.gpus[0]).toMatchObject({ utilPct: null, source: 'nvidia-smi' });
    const c = blankCompute();
    applyComputeLive(c, { type: 'resources.sample', data: { machineId: 'm_self', cpu: { loadPct: 12 } } });
    applyComputeLive(c, { type: 'resource.advert', data: { peerId: RITA, resource: { machineId: 'm_rita', cpu: { loadPct: 50 } } } }, { selfPeerId: ME });
    expect(c.resources.m_self.reportedBy).toBe(null);
    expect(c.resources.m_rita.reportedBy).toBe(RITA);
    expect(applyComputeLive(c, { type: 'resource.advert', data: { peerId: ME, resource: {} } }, { selfPeerId: ME })).toBe(false);
    expect(isComputeType('job.token')).toBe(true);
    expect(isComputeType('city.task.done')).toBe(false);
  });

  it('keeps at most 40 ended jobs', () => {
    const c = blankCompute();
    for (let i = 0; i < 60; i++) {
      applyComputeEvent(c, ev(i * 2, 'job.created', { job: { id: `jb_${i}` } }));
      applyComputeEvent(c, ev(i * 2 + 1, 'job.completed', { jobId: `jb_${i}` }));
    }
    expect(c.order).toHaveLength(40);
    expect(c.jobs.jb_0).toBeUndefined();
    expect(c.jobs.jb_59).toBeTruthy();
  });
});
