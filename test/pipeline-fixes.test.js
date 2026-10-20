// Fixes found by the real model project runs (test/e2e-projects.mjs).
import { describe, it, expect } from 'vitest';
import { TaskGraph } from '../src/crew/taskgraph.js';
import { fitHistory } from '../src/crew/worker.js';
import { estimateTokens } from '../src/crew/prompts/index.js';
import { contextFor } from '../src/brain/catalog/router.js';

const graph = (statuses) => {
  const g = new TaskGraph();
  statuses.forEach((s, i) => g.add({ id: `t${i}`, title: `t${i}`, assignee: 'dev', dependsOn: [], status: s, kind: 'build' }));
  g.add({ id: 'qa', title: 'check', assignee: 'qa', dependsOn: statuses.map((_, i) => `t${i}`), status: 'pending', kind: 'qa' });
  return g;
};

describe('QA after a failed build task', () => {
  it('runs QA (and so the fix rounds) when one build task failed and another is done', () => {
    const g = graph(['done', 'failed']);
    expect(g.propagateBlocked()).toEqual([]);
    expect(g.ready().map((t) => t.id)).toEqual(['qa']);
  });
  it('waits while a build task is still running', () => {
    const g = graph(['failed', 'running']);
    expect(g.propagateBlocked()).toEqual([]);
    expect(g.ready()).toEqual([]);
  });
  it('blocks QA when nothing was built', () => {
    const g = graph(['failed', 'failed']);
    expect(g.propagateBlocked().map((t) => t.id)).toEqual(['qa']);
  });
  it('still blocks build tasks behind a failed one', () => {
    const g = new TaskGraph();
    g.add({ id: 'a', title: 'a', assignee: 'dev', dependsOn: [], status: 'failed', kind: 'build' });
    g.add({ id: 'b', title: 'b', assignee: 'dev', dependsOn: ['a'], status: 'pending', kind: 'build' });
    expect(g.propagateBlocked().map((t) => t.id)).toEqual(['b']);
  });
});

describe('worker history fits the context', () => {
  const page = '<p>pao</p>\n'.repeat(500); // about 5500 chars
  const msgs = () => [
    { role: 'system', content: 'S'.repeat(3000) },
    { role: 'user', content: 'U'.repeat(4000) },
    { role: 'assistant', content: JSON.stringify({ tool: 'read_file', args: { path: 'index.html' } }) },
    { role: 'user', content: `Result: ${page}` },
    { role: 'assistant', content: JSON.stringify({ tool: 'edit_file', args: { path: 'index.html', search: 'x', replace: 'y' } }) },
    { role: 'user', content: 'Error: search text not found in index.html' },
    { role: 'assistant', content: JSON.stringify({ tool: 'read_file', args: { path: 'index.html' } }) },
    { role: 'user', content: `Result: ${page}` }
  ];
  it('keeps a 4096 token model on its context with a 1500 token reply', () => {
    const limit = 4096 - 1500 - 100;
    const out = fitHistory(msgs(), limit);
    expect(out.reduce((n, m) => n + estimateTokens(m.content) + 4, 0)).toBeLessThanOrEqual(limit);
    expect(contextFor(out, 1500)).toBe(4096);
    // The oldest steps went first; the newest read is cut, not dropped.
    expect(out).toHaveLength(6);
    expect(out[out.length - 1].content).toMatch(/^Result: <p>pao<\/p>[\s\S]*cut to fit the context\]$/);
    expect(out[0].content).toBe('S'.repeat(3000));
    expect(out[1].content).toBe('U'.repeat(4000));
  });
  it('shortens an older read of the same file even when everything fits', () => {
    const out = fitHistory(msgs(), 100000);
    expect(out[3].content).toMatch(/shown again further down/);
    expect(out[7].content).toBe(`Result: ${page}`);
  });
  it('leaves a short history alone', () => {
    const m = msgs().slice(0, 4);
    expect(fitHistory(m, 100000)).toEqual(m);
  });
});
