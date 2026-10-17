// Every locale has every key of i18n/en.json, with no empty values, the same placeholders, valid
// ICU plurals for its language, and nothing the project rules forbid.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { LOCALES, CODES, match, format, placeholders, translator } from '../i18n/index.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'i18n');
const read = (code) => JSON.parse(fs.readFileSync(path.join(DIR, `${code}.json`), 'utf8'));
const en = read('en');
const keys = Object.keys(en);
const DASH = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);
const EMOJI = /\p{Extended_Pictographic}/u;

const sample = (msg) => {
  const p = {};
  for (const n of placeholders(msg)) p[n] = 2;
  return p;
};

describe('i18n formatter', () => {
  it('formats parameters, plurals and selects', () => {
    expect(format('en', 'Hi {name}', { name: 'Mel' })).toBe('Hi Mel');
    expect(format('en', '{n, plural, =0 {none} one {# file} other {# files}}', { n: 0 })).toBe('none');
    expect(format('en', '{n, plural, one {# file} other {# files}}', { n: 1 })).toBe('1 file');
    expect(format('en', '{n, plural, one {# file} other {# files}}', { n: 1200 })).toBe('1,200 files');
    expect(format('de', '{n, plural, one {# Datei} other {# Dateien}}', { n: 1200 })).toBe('1.200 Dateien');
    expect(format('ru', '{n, plural, one {# файл} few {# файла} many {# файлов} other {# файла}}', { n: 5 })).toBe('5 файлов');
    expect(format('en', '{s, select, done {Done} other {Other}}', { s: 'done' })).toBe('Done');
  });
  it('falls back to English, then to the key', () => {
    const t = translator('pt-BR', {}, { a: 'A' });
    expect(t('a')).toBe('A');
    expect(t('missing.key')).toBe('missing.key');
  });
  it('matches browser and OS tags', () => {
    expect(match(['pt-PT'])).toBe('pt-BR');
    expect(match('pt_BR.UTF-8')).toBe('pt-BR');
    expect(match(['zh-TW'])).toBe('zh-CN');
    expect(match(['nl-NL', 'de-AT'])).toBe('de');
    expect(match(['C'])).toBe(null);
  });
});

describe('locale files', () => {
  it('there are ten locales and English is complete', () => {
    expect(CODES).toHaveLength(10);
    for (const k of keys) expect(en[k], k).toBeTruthy();
  });

  for (const { code } of LOCALES) {
    it(`${code} has every key, no empty value, the same placeholders and valid messages`, () => {
      const file = path.join(DIR, `${code}.json`);
      expect(fs.existsSync(file), `${code}.json exists`).toBe(true);
      const m = read(code);
      const missing = keys.filter((k) => !(k in m));
      expect(missing, `${code} misses keys`).toEqual([]);
      const extra = Object.keys(m).filter((k) => !(k in en));
      expect(extra, `${code} has keys English does not have`).toEqual([]);
      const problems = [];
      for (const k of keys) {
        const v = m[k];
        if (typeof v !== 'string' || !v.trim()) { problems.push(`${k}: empty`); continue; }
        const want = placeholders(en[k]).join(',');
        const got = placeholders(v).join(',');
        if (want !== got) problems.push(`${k}: placeholders ${got} instead of ${want}`);
        try { format(code, v, sample(en[k])); } catch (err) { problems.push(`${k}: ${err.message}`); }
        if (/[{}]/.test(format(code, v, sample(en[k])))) problems.push(`${k}: unbalanced braces`);
        if (DASH.test(v)) problems.push(`${k}: en or em dash`);
        if (EMOJI.test(v)) problems.push(`${k}: emoji`);
        if (/hivedesk/.test(en[k]) && !/hivedesk/.test(v)) problems.push(`${k}: the product name changed`);
      }
      expect(problems).toEqual([]);
    });
  }
});
