// The per stream string parts are merged into the locale files and translated (scripts/merge-i18n.mjs).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('i18n parts', () => {
  it('every part with translations for every locale is merged into en.json with the same text', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'merge-i18n.mjs'), '--check'], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/0 keys not merged yet/);
    const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n', 'en.json'), 'utf8'));
    const parts = fs.readdirSync(path.join(ROOT, 'i18n', 'parts'));
    for (const f of parts.filter((x) => x.endsWith('.en.json') && parts.includes(x.replace('.en.json', '.ja.json')))) {
      const part = JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n', 'parts', f), 'utf8'));
      for (const [k, v] of Object.entries(part)) expect(en[k], k).toBe(v);
    }
  });
});
