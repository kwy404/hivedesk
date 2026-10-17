import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parse, merge, render, proposeEntry, suggestBump, bumpVersion, entryFromMarkdown, latestVersion, renderSections } from '../../src/changelog/keepachangelog.js';
import { jobReport, templateCommitMessage, prBody, commitSubject } from '../../src/changelog/report.js';
import { activityFrom, filterActivity, exportActivity, people } from '../../src/changelog/activity.js';
import registerChangelog from '../../src/changelog/index.js';
import { EventBus } from '../../src/bus.js';
import { Workspace } from '../../src/tools/index.js';
import { tmpDir } from '../helpers.js';

const EXISTING = `# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Fixed

- The footer link on phones

## [0.2.0] - 2026-09-01

### Added

- A pricing page

## [0.1.0] - 2026-08-01

### Added

- First version

[0.2.0]: https://github.com/a/b/compare/v0.1.0...v0.2.0
`;

function jobEvents() {
  const crew = [{ id: 'dev', name: 'Dev' }, { id: 'qa', name: 'QA' }, { id: 'designer', name: 'Designer' }];
  let seq = 0;
  const ev = (type, data, jobId = 'j_7') => ({ seq: ++seq, ts: new Date(Date.UTC(2026, 9, 16, 10, 0, seq)).toISOString(), type, jobId, data });
  const events = [
    ev('job.created', { job: { id: 'j_7', request: 'a pricing page with three plans', createdAt: '2026-10-16T10:00:00Z' } }),
    ev('job.planned', { tasks: [
      { id: 't1', title: 'Build the pricing page', kind: 'build', assignee: 'dev', status: 'pending' },
      { id: 't2', title: 'Style the plan cards', kind: 'build', assignee: 'designer', status: 'pending' },
      { id: 't3', title: 'Check the page', kind: 'qa', assignee: 'qa', status: 'pending' }
    ] }),
    ev('file.changed', { path: 'pricing.html', op: 'create', diff: '+<h1>Pricing</h1>', added: 1, removed: 0, workerId: 'dev', taskId: 't1' }),
    ev('file.changed', { path: 'style.css', op: 'modify', diff: '-a\n+b', added: 4, removed: 1, workerId: 'designer', taskId: 't2' }),
    ev('file.changed', { path: 'style.css', op: 'modify', diff: '+c', added: 1, removed: 0, workerId: 'guest:Ana' }),
    ev('task.status', { taskId: 't1', status: 'done' }),
    ev('task.status', { taskId: 't2', status: 'done' }),
    ev('task.added', { task: { id: 't4', title: 'Fix the broken button on phones', kind: 'fix', assignee: 'dev', status: 'pending' } }),
    ev('task.status', { taskId: 't4', status: 'done' }),
    ev('qa.report', { taskId: 't3', passed: true, issues: [] }),
    ev('task.status', { taskId: 't3', status: 'done' }),
    ev('chat.message', { id: 'm1', channel: 'general', from: 'guest:Ana', text: 'I tweaked the colors' }, undefined),
    ev('chat.message', { id: 'm2', channel: 'general', from: 'user', text: 'Looks great' }, undefined),
    ev('job.done', { summary: 'Finished, and QA passed.', files: ['pricing.html', 'style.css'] })
  ];
  return { events, state: { crew, tasks: { t1: { title: 'Build the pricing page', assignee: 'dev' }, t2: { title: 'Style the plan cards', assignee: 'designer' }, t3: { title: 'Check the page', assignee: 'qa' }, t4: { title: 'Fix the broken button on phones', assignee: 'dev' } } } };
}

describe('Keep a Changelog', () => {
  it('parses and renders an existing file without losing anything', () => {
    const doc = parse(EXISTING);
    expect(doc.releases.map((r) => r.version)).toEqual([null, '0.2.0', '0.1.0']);
    expect(doc.releases[0].sections.Fixed).toEqual(['The footer link on phones']);
    const again = parse(render(doc));
    expect(again.releases).toEqual(doc.releases);
    expect(render(doc)).toContain('[0.2.0]: https://github.com/a/b/compare/v0.1.0...v0.2.0');
    expect(latestVersion(EXISTING)).toBe('0.2.0');
  });

  it('merges an entry into [Unreleased] without duplicates', () => {
    const out = merge(EXISTING, { Added: ['A pricing page with three plans'], Fixed: ['the footer link on phones', 'The menu on tablets'] });
    const doc = parse(out);
    expect(doc.releases[0].sections.Added).toEqual(['A pricing page with three plans']);
    expect(doc.releases[0].sections.Fixed).toEqual(['The footer link on phones', 'The menu on tablets']);
    expect(doc.releases[1].sections.Added).toEqual(['A pricing page']);
  });

  it('releases [Unreleased] plus the entry under a new version, newest first', () => {
    const out = merge(EXISTING, { Added: ['Plans'] }, { version: '0.3.0', date: '2026-10-16', repoUrl: 'https://github.com/a/b' });
    const doc = parse(out);
    expect(doc.releases.map((r) => r.title)).toEqual(['[Unreleased]', '[0.3.0] - 2026-10-16', '[0.2.0] - 2026-09-01', '[0.1.0] - 2026-08-01']);
    expect(doc.releases[1].sections).toEqual({ Added: ['Plans'], Fixed: ['The footer link on phones'] });
    expect(doc.releases[0].sections).toEqual({});
    expect(out).toContain('[0.3.0]: https://github.com/a/b/compare/v0.2.0...v0.3.0');
    expect(out).toContain('[unreleased]: https://github.com/a/b/compare/v0.3.0...HEAD');
  });

  it('creates a new file with the standard header', () => {
    const out = merge(null, { Added: ['First page'] });
    expect(out).toMatch(/^# Changelog\n/);
    expect(out).toContain('keepachangelog.com');
    expect(out).toContain('## [Unreleased]\n\n### Added\n\n- First page\n');
  });

  it('reads an edited entry back from markdown', () => {
    expect(entryFromMarkdown('### Added\n\n- One\n- Two\n\n### Fixed\n\n- Three\n')).toEqual({ Added: ['One', 'Two'], Fixed: ['Three'] });
  });

  it('suggests a version bump with a reason', () => {
    expect(suggestBump({ Added: ['x'] }, '1.2.3')).toMatchObject({ bump: 'minor', version: '1.3.0' });
    expect(suggestBump({ Fixed: ['x'] }, '1.2.3')).toMatchObject({ bump: 'patch', version: '1.2.4' });
    expect(suggestBump({ Changed: ['Removed the old API'] }, '1.2.3')).toMatchObject({ bump: 'major', version: '2.0.0' });
    const pre = suggestBump({ Removed: ['the beta page'] }, '0.4.1');
    expect(pre).toMatchObject({ bump: 'major', version: '0.5.0' });
    expect(pre.reason).toMatch(/Before 1\.0\.0/);
    expect(suggestBump({ Added: ['x'] }, null).version).toBe('0.1.0');
    expect(bumpVersion('0.1.9', 'patch')).toBe('0.1.10');
  });
});

describe('the job report', () => {
  it('proposes Added, Changed and Fixed from the tasks', () => {
    const { events, state } = jobEvents();
    const r = jobReport(events, undefined, state);
    expect(r.jobId).toBe('j_7');
    const e = proposeEntry(r);
    expect(e.Added).toEqual(['Build the pricing page', 'Style the plan cards']);
    expect(e.Fixed).toEqual(['Fix the broken button on phones']);
    expect(renderSections(e)).toContain('### Fixed\n\n- Fix the broken button on phones');
  });

  it('writes a commit message and a pull request body from the report', () => {
    const { events, state } = jobEvents();
    const r = jobReport(events, 'j_7', state);
    expect(commitSubject(r)).toBe('A pricing page with three plans');
    const msg = templateCommitMessage(r);
    expect(msg.split('\n')[0].length).toBeLessThanOrEqual(72);
    expect(msg).toContain('- Build the pricing page (Dev)');
    expect(msg).toContain('QA passed.');
    const body = prBody(r, { changelog: '### Added\n\n- A pricing page' });
    expect(body).toContain('## Request\n\n> a pricing page with three plans');
    expect(body).toContain('- [x] Build the pricing page (Dev)');
    expect(body).toContain('| `style.css` | modify | +5 -1 | Designer, guest:Ana |');
    expect(body).toContain('QA passed.');
    expect(body).toContain('## Changelog\n\n### Added\n\n- A pricing page');
    expect(body).not.toMatch(/[–—]/);
  });
});

describe('the activity log', () => {
  it('names workers, humans and guests, and filters', () => {
    const { events, state } = jobEvents();
    const a = activityFrom(events, state);
    const guest = a.filter((e) => e.who.kind === 'guest');
    expect(guest.map((e) => e.action)).toEqual(['edited', 'said']);
    expect(guest[0].who.name).toBe('Ana');
    expect(a.find((e) => e.kind === 'job' && e.action === 'asked').who.name).toBe('You');
    expect(filterActivity(a, { who: 'designer' }).map((e) => e.action)).toEqual(['edited', 'finished task']);
    expect(filterActivity(a, { kind: 'file', q: 'pricing' })).toHaveLength(1);
    expect(filterActivity(a, { who: 'humans' }).every((e) => ['human', 'guest'].includes(e.who.kind))).toBe(true);
    expect(people(a).map((p) => p.id)).toEqual(expect.arrayContaining(['dev', 'designer', 'guest:Ana', 'user']));
  });

  it('exports CSV that a spreadsheet cannot turn into a formula', () => {
    const a = [{ seq: 1, ts: '2026-10-16T10:00:00Z', kind: 'chat', action: 'said', text: '=HYPERLINK("x")', who: { id: 'guest:Bo', name: 'Bo, the "guest"', kind: 'guest' } }];
    const csv = exportActivity(a, 'csv').body;
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain('"Bo, the ""guest"""');
    expect(exportActivity(a, 'md').body).toContain('| Bo, the "guest" (guest) | said |');
    expect(JSON.parse(exportActivity(a, 'json').body).entries).toHaveLength(1);
  });
});

describe('the changelog plug-in', () => {
  it('proposes an entry when a job ends and writes it only when asked', async () => {
    const base = tmpDir('hivedesk-cl-');
    const ws = new Workspace(path.join(base, 'ws'));
    fs.writeFileSync(path.join(ws.root, 'CHANGELOG.md'), EXISTING);
    fs.writeFileSync(path.join(ws.root, 'package.json'), JSON.stringify({ version: '0.2.0' }));
    const bus = new EventBus();
    const commands = new Map();
    const chats = [];
    registerChangelog({ bus, workspace: ws, server: { command: (t, fn) => commands.set(t, fn), route: () => {} }, hive: { chat: (...a) => chats.push(a) } });
    const { events } = jobEvents();
    for (const e of events) bus.emit(e.type, e.data, e.jobId ? { jobId: e.jobId } : {});
    await new Promise((r) => setTimeout(r, 20));
    const proposed = bus.events.find((e) => e.type === 'changelog.proposed');
    expect(proposed.data.suggestion).toMatchObject({ bump: 'minor', version: '0.3.0', current: '0.2.0' });
    expect(chats[0][1]).toMatch(/Nothing is written until you do/);
    expect(fs.readFileSync(path.join(ws.root, 'CHANGELOG.md'), 'utf8')).toBe(EXISTING);

    const r = commands.get('changelog.write')({ proposalId: proposed.data.proposalId, release: true });
    expect(r.version).toBe('0.3.0');
    const text = fs.readFileSync(path.join(ws.root, 'CHANGELOG.md'), 'utf8');
    expect(parse(text).releases[1]).toMatchObject({ version: '0.3.0', sections: { Added: ['Build the pricing page', 'Style the plan cards'], Fixed: ['The footer link on phones', 'Fix the broken button on phones'] } });
    const changed = bus.events.filter((e) => e.type === 'file.changed' && e.data.path === 'CHANGELOG.md');
    expect(changed).toHaveLength(1);
    expect(changed[0].data.diff).toContain('+## [0.3.0]');
    expect(bus.events.some((e) => e.type === 'changelog.written' && e.jobId === 'j_7')).toBe(true);
    expect(() => commands.get('changelog.write')({ proposalId: proposed.data.proposalId })).toThrow(/gone/);
    expect(() => commands.get('changelog.write')({ markdown: '### Added\n' })).toThrow(/empty/);
    expect(() => commands.get('changelog.write')({ markdown: '### Added\n\n- x', release: true, version: 'v1' })).toThrow(/not a version/);
  });
});
