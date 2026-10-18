import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODES, placeholders } from '../../i18n/index.js';
import { tr } from '../../src/crew/domains/text.js';
import { buildQuestions, validateCard, QUESTION_SETS } from '../../src/crew/domains/questions.js';
import { classifyDomain } from '../../src/crew/domains/classify.js';
import { DOMAINS } from '../../src/crew/domains/index.js';

const PARTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'i18n', 'parts');
const read = (code) => JSON.parse(fs.readFileSync(path.join(PARTS, `domains.${code}.json`), 'utf8'));
const en = read('en');

describe('the domain strings', () => {
  it('cover every key the code uses', () => {
    const dir = path.join(PARTS, '..', '..', 'src', 'crew', 'domains');
    const src = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    const used = [...new Set([...src.matchAll(/'(domains\.[a-zA-Z.]+)'/g)].map((m) => m[1]))];
    expect(used.filter((k) => !(k in en))).toEqual([]);
    for (const d of Object.values(DOMAINS)) expect(en[`domains.label.${d.id}`]).toBe(d.label);
    for (const q of Object.values(QUESTION_SETS).flat()) expect(en[`domains.q.${q.id}.text`]).toBe(q.text);
  });

  for (const code of CODES) {
    it(`${code}: every key, the same placeholders, no dashes, questions end with a question mark`, () => {
      const t = read(code);
      expect(Object.keys(t)).toEqual(Object.keys(en));
      for (const [k, v] of Object.entries(en)) {
        expect([...placeholders(t[k])].sort(), k).toEqual([...placeholders(v)].sort());
        expect(/[–—]/.test(t[k]), k).toBe(false);
        if (k.endsWith('.text')) expect(t[k], k).toMatch(/[?？]$/);
      }
    });
  }

  it('the crew asks in the user language, and the card still follows the rules', () => {
    const text = 'crie um app de receitas para celular';
    const card = buildQuestions({ text, cls: classifyDomain(text), lang: 'pt-BR' });
    expect(card.questions[0].text).toBe(tr('pt-BR', 'domains.q.mobile.data.text', { subject: 'app de receitas' }));
    expect(card.questions[0].text).toMatch(/app de receitas/);
    expect(card.questions[0].text).not.toBe(QUESTION_SETS.mobile[0].text.replace('{subject}', 'app de receitas'));
    expect(validateCard(card, text)).toEqual([]);
    expect(tr('ja', 'domains.ask.decide')).not.toBe('Decide for me');
    expect(tr('xx', 'domains.ask.decide')).toBe('Decide for me');
    expect(tr('en', 'domains.nothing', {}, 'fallback')).toBe('fallback');
  });
});
