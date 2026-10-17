import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { MemoryStore, attachMemory, CAPS } from '../src/memory/index.js';
import { EventBus } from '../src/bus.js';
import { startHive } from '../src/index.js';
import { createFakeBrain } from '../src/brain/fake.js';
import { isVague, answerBrief, normalizeBrief, briefText } from '../src/crew/brief.js';
import { tmpDir, waitFor } from './helpers.js';

const DAY = 86_400_000;

function store(now = Date.parse('2026-10-16T12:00:00Z')) {
  const dir = tmpDir();
  let t = now;
  const s = new MemoryStore({ projectFile: path.join(dir, 'p', 'memory.json'), userFile: path.join(dir, 'u', 'memory.json'), sessionsDir: path.join(dir, 'p', 'sessions'), now: () => t });
  return { s, dir, tick: (ms) => { t += ms; } };
}

describe('memory store', () => {
  it('ranks by keywords, then recency, with a bonus for pinned entries', () => {
    const { s, tick } = store();
    const old = s.add({ text: 'The bakery site uses warm orange colors' });
    tick(60 * DAY);
    const recent = s.add({ text: 'The bakery site has a dark footer' });
    s.add({ text: 'The todo app saves to localStorage' });
    const pinned = s.add({ text: 'Always write the copy in Portuguese', pinned: true, scope: 'user', kind: 'preference' });
    const hits = s.search('change the bakery site colors');
    expect(hits[0].entry.id).toBe(old.id); // two shared keywords beat recency
    expect(hits.map((h) => h.entry.id)).toContain(recent.id);
    expect(hits.map((h) => h.entry.id)).toContain(pinned.id);
    expect(hits.map((h) => h.entry.text)).not.toContain('The todo app saves to localStorage');
  });

  it('caps entries and their length, pruning the least used unpinned ones', () => {
    const { s } = store();
    const keep = s.add({ text: 'pinned fact zero', pinned: true });
    for (let i = 0; i < CAPS.project + 20; i++) s.add({ text: `fact number ${i}` });
    expect(s.entries.project).toHaveLength(CAPS.project);
    expect(s.find(keep.id)).toBeTruthy();
    expect(s.add({ text: 'x'.repeat(1000) }).text).toHaveLength(CAPS.text);
    expect(() => s.add({ text: '   ' })).toThrow('empty');
  });

  it('edits, pins, deletes, forgets and persists', () => {
    const { s, dir } = store();
    const a = s.add({ text: 'Use the Inter font for headings' });
    s.update(a.id, { text: 'Use the system font for headings', pinned: true });
    expect(s.find(a.id)).toMatchObject({ text: 'Use the system font for headings', pinned: true });
    const b = s.add({ text: 'The user rejected the blue theme', kind: 'rejected' });
    expect(s.forget('forget the blue theme thing').id).toBe(b.id);
    expect(s.forget('something unrelated entirely')).toBeNull();
    const again = new MemoryStore({ projectFile: path.join(dir, 'p', 'memory.json'), userFile: path.join(dir, 'u', 'memory.json') });
    expect(again.all().map((e) => e.text)).toEqual(['Use the system font for headings']);
    expect(again.remove(a.id)).toBe(true);
    expect(again.remove('nope')).toBe(false);
    expect(() => again.update('nope', {})).toThrow('no memory');
  });

  it('writes a session file per job from the events and turns decisions into memories', () => {
    const { s } = store();
    const bus = new EventBus();
    attachMemory(bus, s);
    bus.emit('job.created', { job: { id: 'j_1', request: 'a coffee page', taskIds: [] } }, { jobId: 'j_1' });
    bus.emit('brief.approved', { text: 'Goal: coffee', source: 'refined' }, { jobId: 'j_1' });
    bus.emit('worker.note', { workerId: 'designer', text: 'colors #2b1d12 on #fff8ef' }, { jobId: 'j_1' });
    bus.emit('file.changed', { path: 'index.html', op: 'create' }, { jobId: 'j_1' });
    bus.emit('job.done', { summary: 'ok', files: ['index.html'] }, { jobId: 'j_1' });
    bus.emit('job.report', { report: { missing: [] }, improvedPrompt: 'Build a coffee page', nextPrompts: ['a', 'b'] }, { jobId: 'j_1' });
    bus.emit('settings.changed', { approvalMode: false });
    const list = s.listSessions();
    expect(list[0]).toMatchObject({ id: 'j_1', request: 'a coffee page', status: 'done', improvedPrompt: 'Build a coffee page', files: ['index.html'] });
    expect(s.readSession('j_1').map((r) => r.type)).toEqual(['request', 'brief', 'decision', 'files', 'outcome', 'report']);
    const texts = s.all().map((e) => e.text);
    expect(texts).toContain('designer: colors #2b1d12 on #fff8ef');
    expect(texts.some((t) => t.startsWith('Session j_1'))).toBe(true);
    expect(s.entries.user[0]).toMatchObject({ kind: 'preference', text: 'Prefers automatic mode: the crew acts without asking.' });
  });
});

describe('memory in jobs', () => {
  const respond = (seen) => (messages, options) => {
    if (options.schema?.properties?.goal) return { goal: 'A small app', build: ['index.html'], constraints: [], acceptance: ['it opens'], questions: [{ question: 'Type of app?', options: ['to-do list', 'notes'], answer: 'to-do list' }, { question: 'Style?', options: ['light', 'dark'], answer: 'light' }, { question: 'Where is data saved?', options: ['localStorage', 'nowhere'], answer: 'localStorage' }] };
    if (options.schema?.properties?.tasks) { seen.plan = messages[1].content; return { summary: 's', tasks: [{ title: 'App', detail: '', assignee: 'dev', dependsOn: [] }] }; }
    if (options.schema?.properties?.improvedPrompt) return { improvedPrompt: 'Build a dark notes app in index.html.', nextPrompts: ['a', 'b'] };
    const first = messages.find((m) => m.role === 'user')?.content || '';
    if (first.includes('Your task: App')) {
      seen.worker = first;
      return messages.filter((m) => m.role === 'assistant').length === 0 ? { tool: 'write_file', args: { path: 'notes.txt', content: 'n' } } : { tool: 'done', args: { summary: 'ok' } };
    }
    return { tool: 'report', args: { passed: true, findings: [] } };
  };

  it('expands a vague request with multiple choice questions, applies the answers, uses memories, and continues a session', async () => {
    const seen = {};
    const dir = tmpDir();
    const app = await startHive({ dir, home: tmpDir(), brain: createFakeBrain({ respond: respond(seen) }) });
    app.memory.add({ text: 'The notes app should feel calm and minimal' });
    app.hive.setSettings({ approvalMode: false });
    const { jobId, done } = app.hive.createJob({ request: 'crie um app de notas' });
    const proposed = await waitFor(() => app.bus.events.find((e) => e.type === 'brief.proposed'));
    expect(proposed.data.vague).toBe(true);
    expect(proposed.data.brief.questions[0]).toMatchObject({ options: ['to-do list', 'notes'], answer: 'to-do list' });
    app.hive.approveBrief(jobId, { use: 'refined', answers: ['notes', 'dark'] });
    await done;
    const approved = app.bus.events.find((e) => e.type === 'brief.approved').data;
    expect(approved.text).toContain('Type of app? Answer: notes');
    expect(approved.text).toContain('Style? Answer: dark');
    expect(approved.text).toContain('Where is data saved? Answer: localStorage');
    const used = app.bus.events.find((e) => e.type === 'memory.used');
    expect(used.data.items[0].text).toBe('The notes app should feel calm and minimal');
    expect(seen.plan).toContain('memory: The notes app should feel calm and minimal');
    expect(seen.worker).toContain('What we know (memory):');
    expect(fs.existsSync(path.join(dir, '.hivedesk', 'sessions', 'j_1.jsonl'))).toBe(true);

    // Continue from it.
    const sessions = await app.server.runCommand('session.list', {}, null);
    expect(sessions.sessions[0]).toMatchObject({ id: 'j_1', status: 'done' });
    const cont = app.hive.continueSession('j_1', 'add a search box');
    const proposed2 = await waitFor(() => app.bus.events.filter((e) => e.type === 'brief.proposed')[1]);
    expect(proposed2.data.original).toContain('Last time the goal was:\nBuild a dark notes app in index.html.');
    expect(proposed2.data.original).toContain('Now: add a search box');
    app.hive.approveBrief(cont.jobId, { use: 'original' });
    await cont.done;
    // Memory off: nothing is used.
    app.hive.setSettings({ memory: false });
    const third = app.hive.createJob({ request: 'notes app with tags and colors and a search', refine: false });
    await third.done;
    expect(app.bus.events.filter((e) => e.type === 'memory.used' && e.jobId === third.jobId)).toHaveLength(0);
    // The memory API through commands.
    const added = await app.server.runCommand('memory.add', { text: 'Prefers short copy', scope: 'user', kind: 'preference' }, null);
    expect((await app.server.runCommand('memory.list', { q: 'copy' }, null)).entries[0].id).toBe(added.entry.id);
    await app.server.runCommand('memory.delete', { id: added.entry.id }, null);
    await expect(app.server.runCommand('memory.delete', { id: added.entry.id }, null)).rejects.toMatchObject({ code: 'not_found' });
    await app.close();
  });

  it('knows a vague request and answers a brief', () => {
    expect(isVague('crie um app')).toBe(true);
    expect(isVague('a landing page for a bakery with three breads and hours')).toBe(false);
    const b = normalizeBrief({ goal: 'g', build: [], constraints: [], acceptance: [], questions: [{ question: 'Q?', options: ['a', 'b'], answer: 'a' }] }, 'r');
    expect(briefText(b)).toContain('Q? Answer: a (options: a, b)');
    expect(answerBrief(b, ['b']).text).toContain('Q? Answer: b');
  });
});
