// Replay: rebuild any moment from events.jsonl.
import { readEventsFile } from '../bus.js';
import { replay, reduce, initialState } from './reduce.js';

export { replay, reduce, initialState, readEventsFile };

/** State after event `seq` from a log file. */
export function stateAtFile(file, seq = Infinity, meta = {}) {
  return replay(readEventsFile(file), seq, meta);
}

/**
 * Marks for a scrubber: one per job start and end, so the UI can jump between them.
 * @param {any[]} events
 */
export function marks(events) {
  const out = [];
  for (const e of events) {
    if (e.type === 'job.created') out.push({ seq: e.seq, ts: e.ts, kind: 'job', jobId: e.jobId, label: e.data?.job?.request || '' });
    else if (e.type === 'job.done' || e.type === 'job.failed' || e.type === 'job.cancelled') out.push({ seq: e.seq, ts: e.ts, kind: e.type.slice(4), jobId: e.jobId });
    else if (e.type === 'approval.requested') out.push({ seq: e.seq, ts: e.ts, kind: 'approval', jobId: e.jobId });
  }
  return out;
}

/** Files of the workspace as they were at `seq`, from file.changed events only. */
export function filesAt(events, seq = Infinity) {
  const files = {};
  for (const e of events) {
    if (e.seq > seq) break;
    if (e.type !== 'file.changed') continue;
    if (e.data.op === 'delete') delete files[e.data.path];
    else files[e.data.path] = e.data.content;
  }
  return files;
}
