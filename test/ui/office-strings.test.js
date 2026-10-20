// Every string the Office and the mini widget show comes from i18n/parts/office.<locale>.json
// (merged into i18n/<locale>.json by scripts/merge-i18n.mjs). The parts follow the rules of the
// locale files, and no hard coded English is left in the drawing and HUD code.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, placeholders, CODES } from '../../i18n/index.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const part = (code) => JSON.parse(read(`i18n/parts/office.${code}.json`));
const en = part('en');
const FILES = ['ui/office/office.js', 'ui/office/scene.js', 'ui/office/popout.js', 'ui/widget.js'];
const SCANNED = ['ui/office/office.js', 'ui/office/scene.js', 'ui/widget.js'];
const DASH = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);

describe('Office strings', () => {
  it('has every literal key the Office code and the widget ask for', () => {
    const missing = [];
    for (const f of FILES) {
      const src = read(f);
      for (const m of src.matchAll(/\bt\(\s*'(office\.[A-Za-z0-9_.]+)'/g)) if (!(m[1] in en)) missing.push(`${f}: ${m[1]}`);
      for (const m of src.matchAll(/\btc\(\s*'(office\.[A-Za-z0-9_.]+)'/g)) if (!(m[1] in en)) missing.push(`${f}: ${m[1]}`);
      for (const m of src.matchAll(/\b(?:tx|ta|tp): '(office\.[A-Za-z0-9_.]+)'/g)) if (!(m[1] in en)) missing.push(`${f}: ${m[1]}`);
      for (const m of src.matchAll(/'(office\.[A-Za-z0-9_.]+\.[A-Za-z0-9_]+)'/g)) if (!(m[1] in en)) missing.push(`${f}: ${m[1]}`);
    }
    const html = read('ui/widget.html');
    for (const m of html.matchAll(/data-t[xap]="(office\.[A-Za-z0-9_.]+)"/g)) if (!(m[1] in en)) missing.push(`widget.html: ${m[1]}`);
    expect(missing).toEqual([]);
  });

  it('has every key of the families built at run time', () => {
    const fam = {
      'office.mode': ['idle', 'sleep', 'type', 'plan', 'wait', 'stuck', 'test', 'read', 'error', 'celebrate', 'paused', 'fly'],
      'office.state': ['refining', 'awaiting_brief', 'planning', 'running', 'done', 'failed', 'cancelled', 'idle'],
      'office.hud.line': ['refining', 'awaiting_brief', 'planning'],
      'office.now': ['thinking', 'tool', 'queued', 'waiting_approval', 'review', 'works'],
      'office.shift': ['morning', 'day', 'afternoon', 'evening', 'night'],
      'office.board': ['todo', 'doing', 'done'],
      'office.bubble': ['nod1', 'nod2', 'nod3', 'curious1', 'curious2', 'idleDone1', 'idleDone2', 'idleDone3', 'idleNew1', 'idleNew2', 'idleNew3'],
      'office.widget.conn': ['open', 'unauthorized', 'offline', 'connecting'],
      'office.widget.sub': ['refining', 'awaiting_brief', 'planning', 'done', 'failed'],
    };
    const missing = [];
    for (const [prefix, list] of Object.entries(fam)) for (const k of list) if (!(`${prefix}.${k}` in en)) missing.push(`${prefix}.${k}`);
    expect(missing).toEqual([]);
  });

  it('gives every locale the same keys and placeholders, valid messages, no dashes, no emoji', () => {
    const problems = [];
    const keys = Object.keys(en).sort();
    for (const code of CODES) {
      const m = part(code);
      const got = Object.keys(m).sort();
      for (const k of keys) if (!(k in m)) problems.push(`${code}: missing ${k}`);
      for (const k of got) if (!(k in en)) problems.push(`${code}: extra ${k}`);
      for (const [k, v] of Object.entries(m)) {
        if (typeof v !== 'string' || !v.trim()) { problems.push(`${code} ${k}: empty`); continue; }
        if (k in en && placeholders(v).join() !== placeholders(en[k]).join()) problems.push(`${code} ${k}: placeholders ${placeholders(v)} vs ${placeholders(en[k])}`);
        const p = {};
        for (const n of placeholders(v)) p[n] = 2;
        try { if (/[{}]/.test(format(code, v, p))) problems.push(`${code} ${k}: braces`); } catch (err) { problems.push(`${code} ${k}: ${err.message}`); }
        if (DASH.test(v)) problems.push(`${code} ${k}: dash`);
        if (/\p{Extended_Pictographic}/u.test(v)) problems.push(`${code} ${k}: emoji`);
      }
    }
    expect(CODES.length).toBe(10);
    expect(problems).toEqual([]);
  });

  it('leaves no hard coded English on screen in the Office, its scene and the widget', () => {
    const left = [];
    const words = /[A-Za-z]{2,}[^'`]*\s[A-Za-z]|^[A-Z][a-z]{2,}/;
    const rules = [
      /\b(?:text|title|label|header|sub)\s*:\s*(['`])((?:(?!\1).)*)\1/g,
      /'aria-label'\s*:\s*(['`])((?:(?!\1).)*)\1/g,
      /fillText\(\s*(['`])((?:(?!\1).)*)\1/g,
      /\.textContent\s*=\s*(['`])((?:(?!\1).)*)\1/g,
      /\bpick\(\[/g,
    ];
    for (const f of SCANNED) {
      const src = read(f).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      for (const re of rules) {
        for (const m of src.matchAll(re)) {
          if (m[0].startsWith('pick(')) { left.push(`${f}: ${m[0]}`); continue; }
          const s = m[2].replace(/\$\{[^}]*\}/g, '');
          if (words.test(s)) left.push(`${f}: ${m[0]}`);
        }
      }
    }
    expect(left).toEqual([]);
  });
});
