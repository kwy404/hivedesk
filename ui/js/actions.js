// User actions shared by the widgets, the command palette and the context menus.
// Every action goes through an engine command (PROTOCOL.md section 4) and reports
// failures honestly in a toast.

import { command } from './net.js';
import { notify } from './notify.js';
import { S, worker, extra } from './store.js';
import { copyText } from './dom.js';
import { t } from './i18n.js';

async function run(type, data, { ok, fail = 'actions.fail.generic', quietOk = true } = {}) {
  try {
    const r = await command(type, data);
    if (ok && !quietOk) notify({ title: t(ok), tone: 'ok' });
    return r;
  } catch (err) {
    notify({
      title: t(fail),
      body: err.code === 'offline' || err.code === 'timeout' ? t('actions.checkRunning', { message: err.message }) : err.message,
      tone: 'bad', sound: 'error',
    });
    return null;
  }
}

export const createJob = (request, { playbookId, approval } = {}) =>
  run('job.create', { request, ...(playbookId ? { playbookId } : {}), ...(approval != null ? { approval } : {}) }, { fail: 'actions.fail.createJob' });
export const cancelJob = (jobId) => run('job.cancel', { jobId }, { fail: 'actions.fail.cancelJob' });
export const sendChat = (channel, text) => run('chat.send', { channel, text }, { fail: 'actions.fail.sendChat' });
export const resolveApproval = (approvalId, approved, note) => run('approval.resolve', { approvalId, approved, ...(note ? { note } : {}) }, { fail: 'actions.fail.resolveApproval' });
export const hire = (data) => run('crew.hire', data, { fail: 'actions.fail.hire' });
export const updateWorker = (workerId, fields) => run('crew.update', { workerId, ...fields }, { fail: 'actions.fail.updateWorker' });
export const fire = (workerId) => run('crew.fire', { workerId }, { fail: 'actions.fail.fire' });
export const setSettings = (data) => run('settings.set', data, { fail: 'actions.fail.setSettings' });
export const selectBrain = (choice) => run('brain.select', choice, { fail: 'actions.fail.selectBrain' });
export const startDownload = (model) => run('brain.download', model ? { model } : {}, { fail: 'actions.fail.startDownload' });
export const deletePlaybook = (playbookId) => run('playbook.delete', { playbookId }, { fail: 'actions.fail.deletePlaybook' });

// Task and worker controls that the context menus offer (PROTOCOL.md: task.retry, task.reassign,
// task.cancel, and crew.update with paused).
export const retryTask = (taskId) => run('task.retry', { taskId }, { fail: 'actions.fail.retryTask' });
export const reassignTask = (taskId, workerId) => run('task.reassign', { taskId, workerId }, { fail: 'actions.fail.reassignTask' });
export const cancelTask = (taskId) => run('task.cancel', { taskId }, { fail: 'actions.fail.cancelTask' });
export const pauseWorker = (workerId, paused) => run('crew.update', { workerId, paused }, { fail: paused ? 'actions.fail.pauseWorker' : 'actions.fail.resumeWorker' });

export async function assignTask(workerId, text) {
  const w = worker(workerId);
  return sendChat(`dm:${workerId}`, text ? t('actions.newTask', { name: w.name, text }) : '');
}

export async function readFile(path) {
  const s = S();
  const f = s.files[path];
  if (f?.content != null) return f.content;
  const r = await command('files.read', { path }).catch((err) => { throw err; });
  return r.content;
}

export function copy(text, label) {
  copyText(text).then(() => notify({ title: label || t('actions.copied'), tone: 'ok', timeout: 1800, quiet: false }), () => notify({ title: t('actions.copyFailed'), tone: 'bad' }));
}

export function pendingApprovals() { return S().approvals || []; }
export const lastDiff = (path) => (extra.diffs[path] || []).slice(-1)[0];
