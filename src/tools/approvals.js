// Pending approvals. A tool call waits here until the user answers in the UI.

let n = 0;

export class Approvals {
  /** @param {import('../bus.js').EventBus} bus */
  constructor(bus, opts = {}) {
    this.bus = bus;
    /** @type {Map<string, { resolve: Function, approval: any }>} */
    this.pending = new Map();
    // Demo mode answers by itself after a pause so the scripted job never hangs.
    this.autoApproveMs = opts.autoApproveMs || 0;
  }

  /**
   * @param {{ jobId?: string, taskId?: string, workerId?: string, tool: string, args: any, summary: string, diff?: string, origin?: any, strict?: boolean }} req
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ approved: boolean, note?: string, by: string }>}
   */
  request(req, signal) {
    const id = `a_${Date.now().toString(36)}_${++n}`;
    const approval = { id, ...req, createdAt: new Date().toISOString() };
    if (approval.diff === undefined) delete approval.diff;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, approval });
      this.bus.emit('approval.requested', { approval }, { jobId: req.jobId });
      if (req.workerId) this.bus.emit('worker.status', { workerId: req.workerId, status: 'waiting_approval', detail: approval.summary, taskId: req.taskId }, { jobId: req.jobId });
      // Demo mode answers by itself; a strict approval outside the demo never does.
      if (this.autoApproveMs) {
        const t = setTimeout(() => this.resolve(id, true, 'approved automatically in the demo', 'auto'), this.autoApproveMs);
        t.unref?.();
      }
      if (signal) {
        const onAbort = () => {
          if (this.pending.has(id)) {
            this.pending.delete(id);
            this.bus.emit('approval.resolved', { approvalId: id, approved: false, by: 'auto', note: 'job cancelled' }, { jobId: req.jobId });
            reject(new Error('cancelled'));
          }
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  /** The pending approval with this id, or null. */
  get(approvalId) {
    return this.pending.get(approvalId)?.approval || null;
  }

  /** @returns {boolean} false when the id is unknown */
  resolve(approvalId, approved, note, by = 'user') {
    const p = this.pending.get(approvalId);
    if (!p) return false;
    this.pending.delete(approvalId);
    const data = { approvalId, approved: !!approved, by };
    if (note) data.note = String(note);
    this.bus.emit('approval.resolved', data, { jobId: p.approval.jobId });
    p.resolve({ approved: !!approved, note, by });
    return true;
  }

  /**
   * Approves everything that is pending (used when approval mode is switched off), except strict
   * approvals: actions from a guest or a friend's model always wait for the host's own answer.
   */
  approveAll(by = 'auto') {
    for (const [id, p] of [...this.pending]) if (!p.approval.strict) this.resolve(id, true, 'approval mode turned off', by);
  }
}
