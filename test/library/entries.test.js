import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { loadBuiltin, validateEntry, estimateTokens, CATEGORIES, SIZE_MIN, SIZE_MAX, BUILTIN_DIR } from '../../src/crew/library/index.js';
import { CHECKS } from '../../src/crew/library/checks.js';
import { textProblems, similarPairs, THRESHOLDS } from './rules.js';

const all = loadBuiltin();
const per = {};
for (const e of all) per[e.category] = (per[e.category] || 0) + 1;
const BUILTIN_CATEGORIES = CATEGORIES.filter((x) => x !== 'custom');

describe('the library entries', () => {
  it('every category that exists has at least 25 entries', () => {
    expect(Object.keys(per).length).toBeGreaterThan(0);
    for (const c of Object.keys(per)) expect(per[c], c).toBeGreaterThanOrEqual(25);
  });

  it.runIf(BUILTIN_CATEGORIES.every((c) => per[c]))('the complete library has about seven hundred entries (the 1.0 domains added mobile, desktop, backend, security, devops, tools and games)', () => {
    expect(all.length).toBeGreaterThanOrEqual(650);
    expect(all.length).toBeLessThanOrEqual(760);
  });

  it('every entry is schema valid, one file per entry named after its id in its category folder', () => {
    const problems = [];
    for (const e of all) {
      for (const p of validateEntry(e)) problems.push(`${e.id}: ${p}`);
      if (e.file !== `${e.category}/${e.id}.json`) problems.push(`${e.id}: lives in ${e.file}`);
    }
    expect(problems).toEqual([]);
    expect(new Set(all.map((e) => e.id)).size).toBe(all.length);
    expect(fs.readdirSync(BUILTIN_DIR).every((d) => CATEGORIES.includes(d))).toBe(true);
  });

  it('every prompt is within the size limits and its size field is right', () => {
    const out = all.filter((e) => e.size !== estimateTokens(e.prompt) || e.size < SIZE_MIN || e.size > SIZE_MAX).map((e) => `${e.id}: ${e.size}`);
    expect(out).toEqual([]);
  });

  it('has no emoji, no en or em dashes, no product or brand names and no comparison phrases', () => {
    const out = all.flatMap((e) => textProblems(e).map((p) => `${e.id}: ${p}`));
    expect(out).toEqual([]);
  });

  it('every prompt has steps, a quality bar, pitfalls, a verification checklist and the output', () => {
    for (const e of all) {
      // Each section starts a line, in this order.
      const sections = ['Goal:', 'Steps:', 'Quality bar:', 'Pitfalls:', 'Verify:', 'Output:'].map((s) => e.prompt.search(new RegExp(`^${s}`, 'm')));
      expect(sections.every((i, k) => i >= 0 && (k === 0 || i > sections[k - 1])), e.id).toBe(true);
      expect(e.prompt, e.id).toMatch(/Steps:\n1\. /);
      expect(e.prompt, e.id).toMatch(/Verify:\n- \[ \] /);
    }
  });

  it('every check named by an entry exists in the runner', () => {
    const unknown = all.flatMap((e) => e.checks.filter((c) => !CHECKS[c]).map((c) => `${e.id}: ${c}`));
    expect(unknown).toEqual([]);
    expect(all.filter((e) => e.category !== 'planning' && !e.checks.length).map((e) => e.id)).toEqual([]);
  });

  it('the files are plain JSON with a trailing newline', () => {
    for (const e of all.slice(0, 50)) {
      const raw = fs.readFileSync(path.join(BUILTIN_DIR, e.file), 'utf8');
      expect(raw.endsWith('}\n')).toBe(true);
    }
  });
});

describe('dedupe', () => {
  it(`no two entries are near duplicates (title ${THRESHOLDS.title}, combined ${THRESHOLDS.combined}, body shingles ${THRESHOLDS.shingles})`, () => {
    const pairs = similarPairs(all).map((p) => `${p.a} ~ ${p.b} (combined ${p.combined.toFixed(2)}, shingles ${p.shingles.toFixed(2)})`);
    expect(pairs).toEqual([]);
  });

  it('the threshold catches a lightly edited copy', () => {
    const base = all.find((e) => e.id === 'bakery-site') || all[0];
    const copy = { ...base, id: 'bakery-copy', title: `${base.title} for shops`, tags: [...base.tags.slice(0, -1), 'shop'], prompt: base.prompt.replace('Steps:', 'Steps to follow:').replace(/\n- [^\n]+$/m, '\n- Keep it short.') };
    const hits = similarPairs([base, copy]);
    expect(hits).toHaveLength(1);
  });

  it('two unrelated entries stay far apart', () => {
    const a = all.find((e) => e.category === 'web-pages');
    const b = all.find((e) => e.category === 'planning');
    expect(similarPairs([a, b])).toEqual([]);
  });
});
