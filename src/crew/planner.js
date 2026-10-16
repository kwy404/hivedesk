// Mel's planner: request (plus a similar playbook, when there is one) to a small task graph.

const MAX_TASKS = 6;

export function planSchema(assignees) {
  return {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'one friendly sentence for the crew chat' },
      tasks: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_TASKS,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            detail: { type: 'string' },
            assignee: { enum: assignees },
            dependsOn: { type: 'array', items: { type: 'integer' } }
          },
          required: ['title', 'detail', 'assignee', 'dependsOn'],
          additionalProperties: false
        }
      }
    },
    required: ['summary', 'tasks'],
    additionalProperties: false
  };
}

export function planMessages({ request, crew, playbook, files, notes }) {
  const workers = crew.filter((w) => w.id !== 'mel');
  const roster = workers.map((w) => `- ${w.id}: ${w.role}`).join('\n');
  const system = [
    crew.find((w) => w.id === 'mel')?.prompt || 'You are Mel, the foreman.',
    '',
    'Make a plan for the request. Rules:',
    `- As few tasks as possible: 2 to ${MAX_TASKS}. A small job needs only 2 or 3.`,
    '- One task per file (or per few files): never split one file across several tasks.',
    '- Each task says which files to create or change and what goes in them.',
    '- Use relative file names like index.html, style.css, app.js.',
    '- dependsOn lists the numbers of earlier tasks that must finish first (tasks are numbered from 1).',
    '- End with one qa task that checks the work.',
    '- Only use these workers:',
    roster,
    '',
    'Answer with one JSON object: {"summary": "...", "tasks": [{"title": "...", "detail": "...", "assignee": "...", "dependsOn": []}]}'
  ].join('\n');
  const parts = [`Request: ${request}`];
  if (files && files.length) parts.push(`Files already in the workspace: ${files.slice(0, 40).join(', ')}`);
  if (notes && notes.length) parts.push(`Notes from earlier jobs:\n${notes.join('\n')}`);
  if (playbook) {
    parts.push(`A similar job went well before ("${playbook.request}"). Its plan, reuse and adapt it:\n${playbookText(playbook)}`);
  }
  parts.push('Write the plan.');
  return [{ role: 'system', content: system }, { role: 'user', content: parts.join('\n\n') }];
}

export function playbookText(playbook) {
  return playbook.tasks.map((t, i) => `${i + 1}. [${t.assignee}] ${t.title}: ${t.detail}${t.dependsOn?.length ? ` (after ${t.dependsOn.map((d) => d + 1).join(', ')})` : ''}`).join('\n');
}

export function kindFor(assignee) {
  if (assignee === 'qa') return 'qa';
  if (assignee === 'writer') return 'docs';
  return 'build';
}

/**
 * Cleans a plan from the model: valid assignees, dependencies only on earlier tasks (so no cycles),
 * zero based indices, and exactly one final QA task that depends on everything else.
 * @returns {Array<{ title: string, detail: string, assignee: string, dependsOn: number[], kind: string }>}
 */
export function normalizePlan(raw, crewIds, request) {
  const fallbackAssignee = crewIds.includes('dev') ? 'dev' : crewIds.find((id) => id !== 'mel' && id !== 'qa') || crewIds[0];
  let tasks = (raw?.tasks || []).slice(0, MAX_TASKS).map((t, i) => {
    const assignee = crewIds.includes(t.assignee) && t.assignee !== 'mel' ? t.assignee : fallbackAssignee;
    const deps = [...new Set((t.dependsOn || []).map((d) => Number(d) - 1).filter((d) => Number.isInteger(d) && d >= 0 && d < i))];
    return {
      title: String(t.title || `Task ${i + 1}`).trim().slice(0, 120),
      detail: String(t.detail || '').trim().slice(0, 1200),
      assignee,
      dependsOn: deps,
      kind: kindFor(assignee)
    };
  });
  if (!tasks.length) tasks = defaultPlan(request, crewIds);
  // Keep QA tasks only at the end, as a single check.
  const qaTasks = tasks.filter((t) => t.assignee === 'qa');
  const build = tasks.filter((t) => t.assignee !== 'qa');
  if (!build.length) return defaultPlan(request, crewIds);
  const remap = new Map();
  tasks.forEach((t, i) => { if (t.assignee !== 'qa') remap.set(i, build.indexOf(t)); });
  for (const t of build) t.dependsOn = t.dependsOn.map((d) => remap.get(d)).filter((d) => d !== undefined);
  if (crewIds.includes('qa')) {
    const qa = qaTasks[qaTasks.length - 1];
    build.push({
      title: qa?.title || 'Check the work',
      detail: qa?.detail || 'Run the checks, read the files and report real problems with a concrete fix.',
      assignee: 'qa',
      dependsOn: build.map((_, i) => i),
      kind: 'qa'
    });
  }
  return build;
}

export function defaultPlan(request, crewIds) {
  const dev = crewIds.includes('dev') ? 'dev' : crewIds.find((id) => id !== 'mel') || 'dev';
  const tasks = [{ title: 'Build it', detail: `Create the files for: ${request}`, assignee: dev, dependsOn: [], kind: 'build' }];
  if (crewIds.includes('qa')) tasks.push({ title: 'Check the work', detail: 'Run the checks and report problems.', assignee: 'qa', dependsOn: [0], kind: 'qa' });
  return tasks;
}

/**
 * Runs the planner turn.
 * @returns {Promise<{ tasks: any[], summary: string, source: 'model' | 'playbook' | 'fallback', error?: string }>}
 */
export async function makePlan({ scheduler, request, crew, playbook, files, notes, jobId, signal }) {
  const ids = crew.map((w) => w.id);
  const assignees = ids.filter((id) => id !== 'mel');
  try {
    const result = await scheduler.turn({
      workerId: 'mel', jobId, signal,
      messages: planMessages({ request, crew, playbook, files, notes }),
      options: { schema: planSchema(assignees), maxTokens: 1200, temperature: 0.2 }
    });
    const tasks = normalizePlan(result.json, ids, request);
    return { tasks, summary: String(result.json?.summary || '').slice(0, 400), source: 'model' };
  } catch (err) {
    if (signal?.aborted) throw err;
    if (playbook) {
      return { tasks: normalizePlan({ tasks: playbook.tasks.map((t) => ({ ...t, dependsOn: (t.dependsOn || []).map((d) => d + 1) })) }, ids, request), summary: `Using the playbook "${playbook.title}".`, source: 'playbook', error: String(err.message) };
    }
    return { tasks: defaultPlan(request, ids), summary: 'I could not plan this in detail, so Dev builds it and QA checks it.', source: 'fallback', error: String(err.message) };
  }
}
