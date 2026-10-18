// The tasks.* commands (docs/1.0/protocol/core.md). Peers reach only list, get, create, retry and cancel
// (with city.view or city.member, src/core/router.js), and change only the tasks they created.
import { obj, str, id, arr, int } from '../core/schema.js';

const taskRef = obj({ taskId: id(120) }, ['taskId']);

/**
 * @param {{ command: (type: string, fn: Function, spec?: object) => void }} server
 * @param {import('./engine.js').TaskEngine} tasks
 */
export function registerTaskCommands(server, tasks) {
  const local = (schema) => ({ local: true, schema });
  // Copies: a reply is what the task was when the command ended, not a live object.
  const view = (t, full) => JSON.parse(JSON.stringify(full ? t : { ...t, logs: t.logs.slice(-20), history: t.history.slice(-20) }));

  server.command('tasks.list', (d) => {
    const states = Array.isArray(d.state) ? d.state : typeof d.state === 'string' ? [d.state] : undefined;
    return { tasks: tasks.list({ state: states, assignee: typeof d.assignee === 'string' ? d.assignee : undefined }).map((t) => view(t, false)), counts: tasks.counts() };
  }, { schema: obj({ state: { type: ['string', 'array'] }, assignee: str(120) }) });
  server.command('tasks.get', (d) => {
    const t = tasks.get(d.taskId);
    if (!t) throw Object.assign(new Error(`no task ${d.taskId}`), { code: 'not_found' });
    return { task: view(t, true) };
  }, { schema: taskRef });
  server.command('tasks.history', (d) => ({ history: tasks.history(d.taskId) }), local(taskRef));

  server.command('tasks.create', (d, _client, ctx) => ({ task: view(tasks.create({ ...d, run: ctx.origin.kind === 'peer' ? null : d.run }, ctx), true) }), {
    schema: obj({ title: str(300, { minLength: 1 }), detail: str(16000), criteria: arr(str(500), 50), dependsOn: arr(id(120), 100), assignee: str(120), pipeline: arr(str(40), 20), maxLoops: int(0, 20), maxAttempts: int(1, 10), run: { enum: ['crew', null] } }, ['title'])
  });
  server.command('tasks.update', (d, _c, ctx) => ({ task: view(tasks.update(d.taskId, d, ctx), true) }), local(obj({ taskId: id(120) }, ['taskId'])));
  server.command('tasks.assign', (d, _c, ctx) => ({ task: view(tasks.assign(d.taskId, d.agentId, ctx), true) }), local(obj({ taskId: id(120), agentId: id(120) }, ['taskId', 'agentId'])));
  server.command('tasks.start', (d, _c, ctx) => ({ task: view(tasks.start(d.taskId, ctx), true) }), local(taskRef));
  server.command('tasks.review', (d, _c, ctx) => ({ task: view(tasks.review(d.taskId, { ...ctx, reason: d.reason }), true) }), local(taskRef));
  server.command('tasks.test', (d, _c, ctx) => ({ task: view(tasks.test(d.taskId, { ...ctx, reason: d.reason }), true) }), local(taskRef));
  server.command('tasks.loop', (d, _c, ctx) => ({ task: view(tasks.loopBack(d.taskId, { ...ctx, reason: d.reason }), true) }), local(taskRef));
  server.command('tasks.wait', (d, _c, ctx) => ({ task: view(tasks.wait(d.taskId, { kind: d.kind, ref: d.ref, deadlineMs: d.deadlineMs }, ctx), true) }),
    local(obj({ taskId: id(120), kind: { enum: ['approval', 'resource', 'peer', 'user'] }, ref: str(400), deadlineMs: int(0, 86_400_000) }, ['taskId', 'kind'])));
  server.command('tasks.resume', (d, _c, ctx) => ({ task: view(tasks.resume(d.taskId, ctx), true) }), local(taskRef));
  server.command('tasks.complete', (d, _c, ctx) => ({ task: view(tasks.complete(d.taskId, { ...ctx, reason: d.reason }), true) }), local(taskRef));
  server.command('tasks.fail', (d, _c, ctx) => ({ task: view(tasks.failTask(d.taskId, { code: d.code, message: d.message }, ctx), true) }), local(taskRef));
  server.command('tasks.retry', async (d, _c, ctx) => ({ task: view(await tasks.retry(d.taskId, ctx), true) }), { schema: taskRef });
  server.command('tasks.reassign', async (d, _c, ctx) => ({ task: view(await tasks.reassign(d.taskId, d.agentId, ctx), true) }), local(obj({ taskId: id(120), agentId: id(120) }, ['taskId', 'agentId'])));
  server.command('tasks.cancel', async (d, _c, ctx) => ({ task: view(await tasks.cancel(d.taskId, ctx), true) }), { schema: taskRef });
  server.command('tasks.log', (d, _c, ctx) => ({ task: view(tasks.log(d.taskId, d.text, d.level, ctx), true) }), local(obj({ taskId: id(120), text: str(4000, { minLength: 1 }) }, ['taskId', 'text'])));
  server.command('tasks.artifact', (d, _c, ctx) => ({ task: view(tasks.artifact(d.taskId, d, ctx), true) }), local(obj({ taskId: id(120), kind: str(20) }, ['taskId', 'kind'])));
}
