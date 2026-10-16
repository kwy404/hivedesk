import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { PlaybookStore, keywords, similarity } from '../src/playbooks/index.js';
import { tmpDir } from './helpers.js';

const tasks = [{ title: 'Build', detail: 'index.html', assignee: 'dev', dependsOn: [] }, { title: 'Check', detail: '', assignee: 'qa', dependsOn: [0] }];

describe('playbooks', () => {
  it('extracts keywords without stop words', () => {
    expect(keywords('Make a tiny landing page for my bakery, with prices!')).toEqual(['land', 'bakery', 'price']);
    expect(keywords('Crème brûlée recipes')).toEqual(['creme', 'brulee', 'recipe']);
  });

  it('scores similar requests higher', () => {
    const a = similarity('landing page for a bakery', 'a landing page for my bakery shop');
    const b = similarity('landing page for a bakery', 'a todo app with local storage');
    expect(a).toBeGreaterThan(0.5);
    expect(b).toBe(0);
    expect(similarity('', 'x')).toBe(0);
  });

  it('saves, finds the most similar, persists and deletes', () => {
    const dir = path.join(tmpDir(), 'pb');
    const store = new PlaybookStore(dir);
    const bakery = store.save({ request: 'Landing page for a bakery called Crumb', tasks });
    store.save({ request: 'Todo app with filters and local storage', tasks });
    store.save({ request: 'Landing page for a dentist', tasks });
    const hits = store.search('A landing page for my bakery');
    expect(hits[0].playbook.id).toBe(bakery.id);
    expect(hits.every((h, i) => i === 0 || h.score <= hits[i - 1].score)).toBe(true);
    expect(store.search('a rust command line parser')).toEqual([]);
    store.markUsed(bakery.id);
    const again = new PlaybookStore(dir);
    expect(again.list()).toHaveLength(3);
    expect(again.get(bakery.id).uses).toBe(1);
    expect(again.get(bakery.id).tasks[1].dependsOn).toEqual([0]);
    expect(again.delete(bakery.id)).toBe(true);
    expect(new PlaybookStore(dir).list()).toHaveLength(2);
    expect(again.delete('nope')).toBe(false);
  });
});
