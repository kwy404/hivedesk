// User actions shared by the widgets, the command palette and the context menus.
// Every action goes through an engine command (PROTOCOL.md section 4) and reports
// failures honestly in a toast.

import { command } from './net.js';
import { notify } from './notify.js';
import { S, worker, extra } from './store.js';
import { copyText } from './dom.js';

const UNSUPPORTED = new Set(['bad_request', 'not_found']);

async function run(type, data, { ok, fail = 'That did not work', quietOk = true } = {}) {
  try {
    const r = await command(type, data);
    if (ok && !quietOk) notify({ title: ok, tone: 'ok' });
    return r;
  } catch (err) {
    const unknown = err.code === 'bad_request' && /unknown|not supported|unsupported/i.test(err.message);
    notify({
      title: fail,
      body: unknown ? 'This engine version does not support it yet.' : err.code === 'offline' || err.code === 'timeout' ? `${err.message} Check that hivedesk is still running.` : err.message,
      tone: 'bad', sound: 'error',
    });
    void UNSUPPORTED;
    return null;
  }
}

export const createJob = (request, { playbookId, approval } = {}) =>
  run('job.create', { request, ...(playbookId ? { playbookId } : {}), ...(approval != null ? { approval } : {}) }, { fail: 'Could not start the job' });
export const cancelJob = (jobId) => run('job.cancel', { jobId }, { fail: 'Could not cancel the job' });
export const sendChat = (channel, text) => run('chat.send', { channel, text }, { fail: 'Message not sent' });
export const resolveApproval = (approvalId, approved, note) => run('approval.resolve', { approvalId, approved, ...(note ? { note } : {}) }, { fail: 'Could not answer the approval' });
export const hire = (data) => run('crew.hire', data, { fail: 'Could not hire this worker' });
export const updateWorker = (workerId, fields) => run('crew.update', { workerId, ...fields }, { fail: 'Could not update the worker' });
export const fire = (workerId) => run('crew.fire', { workerId }, { fail: 'Could not fire the worker' });
export const setSettings = (data) => run('settings.set', data, { fail: 'Could not save the setting' });
export const selectBrain = (choice) => run('brain.select', choice, { fail: 'Could not switch the model' });
export const startDownload = (model) => run('brain.download', model ? { model } : {}, { fail: 'Could not start the download' });
export const deletePlaybook = (playbookId) => run('playbook.delete', { playbookId }, { fail: 'Could not delete the playbook' });

// Task and worker controls that the context menus offer. They are sent as engine
// commands; an engine that does not know them answers bad_request and the toast says so.
export const retryTask = (taskId) => run('task.retry', { taskId }, { fail: 'Could not retry the task' });
export const reassignTask = (taskId, workerId) => run('task.reassign', { taskId, workerId }, { fail: 'Could not reassign the task' });
export const cancelTask = (taskId) => run('task.cancel', { taskId }, { fail: 'Could not cancel the task' });
export const pauseWorker = (workerId, paused) => run('crew.update', { workerId, paused }, { fail: paused ? 'Could not pause the worker' : 'Could not resume the worker' });

export async function assignTask(workerId, text) {
  const w = worker(workerId);
  return sendChat(`dm:${workerId}`, text ? `New task for ${w.name}: ${text}` : '');
}

export async function readFile(path) {
  const s = S();
  const f = s.files[path];
  if (f?.content != null) return f.content;
  const r = await command('files.read', { path }).catch((err) => { throw err; });
  return r.content;
}

export function copy(text, label = 'Copied') {
  copyText(text).then(() => notify({ title: label, tone: 'ok', timeout: 1800, quiet: false }), () => notify({ title: 'Could not copy', tone: 'bad' }));
}

export function pendingApprovals() { return S().approvals || []; }
export const lastDiff = (path) => (extra.diffs[path] || []).slice(-1)[0];
