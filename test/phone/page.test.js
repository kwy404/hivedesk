// The public phone page (docs/remote/): its copies of the shared code are current, its CSP is strict,
// its JavaScript stays under 100 KB gzipped without the lazy viewer, the offline shell caches every
// file, it holds no secrets, and its strings (and the desktop's) exist in all 10 languages.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { SHARED, expected, target } from '../../scripts/phone-page.mjs';
import { DEFAULT_BROKERS } from '../../ui/lend/core/relay.js';
import { CODES, placeholders as ph } from '../../i18n/index.js';
import { EN as DESK_EN } from '../../ui/phone/strings.js';
import { GRANT_NAMES } from '../../ui/phone/core/grants.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PAGE = path.join(ROOT, 'docs', 'remote');
const read = (p) => fs.readFileSync(path.join(PAGE, p), 'utf8');
const walk = (d, out = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(path.relative(PAGE, p).replaceAll('\\', '/'));
  }
  return out;
};
const FILES = walk(PAGE);
const DASH = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);
const EMOJI = /\p{Extended_Pictographic}/u;
const placeholders = (s) => [...ph(s)].sort();

describe('phone page files', () => {
  it('the vendored copies match their sources (run node scripts/phone-page.mjs)', () => {
    for (const rel of SHARED) expect(fs.readFileSync(target(rel), 'utf8'), rel).toBe(expected(rel));
  });

  it('has a strict CSP: own scripts and styles only, the relays and nothing else to connect to', () => {
    const html = read('index.html');
    const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1];
    expect(csp).toBeTruthy();
    const dir = Object.fromEntries(csp.split(';').map((x) => x.trim()).filter(Boolean).map((x) => { const [k, ...v] = x.split(/\s+/); return [k, v]; }));
    expect(dir['default-src']).toEqual(["'none'"]);
    expect(dir['script-src']).toEqual(["'self'"]);
    expect(dir['style-src']).toEqual(["'self'"]);
    expect(dir['object-src']).toEqual(["'none'"]);
    expect(dir['base-uri']).toEqual(["'none'"]);
    expect(dir['form-action']).toEqual(["'none'"]);
    const brokers = DEFAULT_BROKERS.map((u) => u.replace(/\/mqtt$/, ''));
    expect(dir['connect-src'].sort()).toEqual(["'self'", ...brokers].sort());
    expect(csp).not.toMatch(/unsafe-(inline|eval)|\*/);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/\sstyle=|\son[a-z]+=/i);
    expect(html).toMatch(/name="referrer" content="no-referrer"/);
  });

  it('keeps the JavaScript under 100 KB gzipped, without the lazy remote screen viewer', () => {
    const lazy = new Set(['js/viewer.js', 'js/vendor/remote/media.js', 'js/vendor/remote/abr.js', 'js/vendor/remote/pointer.js']);
    const js = FILES.filter((f) => f.endsWith('.js') && f !== 'sw.js' && !lazy.has(f));
    const size = js.reduce((n, f) => n + zlib.gzipSync(fs.readFileSync(path.join(PAGE, f)), { level: 9 }).length, 0);
    expect(size).toBeLessThan(100 * 1024);
    // the viewer is only reached through a dynamic import
    expect(read('js/app.js')).toMatch(/import\('\.\/viewer\.js'\)/);
    expect(read('js/app.js')).not.toMatch(/from '\.\/viewer\.js'/);
  });

  it('the offline shell caches every file of the page, and the manifest makes it installable', () => {
    const sw = read('sw.js');
    const listed = new Set([...sw.matchAll(/'([^']+\.(?:js|css|json|svg|png|html|webmanifest))'/g)].map((m) => m[1]));
    for (const f of FILES) if (f !== 'sw.js') expect(listed.has(f), f).toBe(true);
    for (const f of listed) expect(FILES.includes(f), f).toBe(true);
    const m = JSON.parse(read('manifest.webmanifest'));
    expect(m.display).toBe('standalone');
    expect(m.icons.some((i) => i.sizes === '192x192')).toBe(true);
    expect(m.icons.some((i) => i.sizes === '512x512')).toBe(true);
    expect(m.icons.some((i) => i.purpose === 'maskable')).toBe(true);
  });

  it('holds no secrets, no forbidden characters, and never puts data into HTML strings', () => {
    for (const f of FILES.filter((x) => /\.(js|html|css|json)$/.test(x) && !x.includes('vendor/'))) {
      const text = read(f);
      expect(text, f).not.toMatch(/-----BEGIN|sk-[A-Za-z0-9]{20}|AKIA[0-9A-Z]{16}/);
      expect(text.match(/[A-Za-z0-9+/_]{2}[A-Za-z0-9+/_-]{46,}/g) || [], f).toEqual([]);
      expect(DASH.test(text), `${f} has a long dash`).toBe(false);
      expect(EMOJI.test(text), `${f} has an emoji`).toBe(false);
    }
    // innerHTML only for the static icon paths in dom.js
    for (const f of FILES.filter((x) => x.startsWith('js/') && !x.includes('vendor/'))) {
      const uses = [...read(f).matchAll(/innerHTML/g)].length;
      expect(uses, f).toBe(f === 'js/dom.js' ? 2 : 0);
    }
  });
});

describe('phone page strings', () => {
  const en = JSON.parse(read('i18n/en.json'));
  const app = read('js/app.js') + read('js/viewer.js');

  it('every key the page uses exists in English', () => {
    const used = new Set([...app.matchAll(/\bt\('([\w.-]+)'/g)].map((m) => m[1]));
    const families = [
      ...['on', 'off', 'wait'].map((x) => `conn.${x}`),
      ...['status', 'crew', 'approvals', 'remote'].map((x) => `nav.${x}`),
      ...GRANT_NAMES.map((g) => `grant.${g}`),
      ...['planning', 'refining', 'awaiting_brief', 'running', 'done', 'failed', 'cancelled'].map((x) => `job.${x}`),
      ...['job.done', 'job.failed', 'approval', 'brief'].map((x) => `notice.${x}`),
      ...['expired', 'used', 'nodesk', 'relays', 'pin', 'bad', 'busy', 'removed', 'browser'].flatMap((x) => [`fail.${x}.title`, `fail.${x}.body`]),
      ...['touch', 'touchpad'].flatMap((x) => [`rd.mode.${x}`, `rd.mode.${x}Help`]),
      ...['auto', 'balanced', 'quality', 'speed'].map((x) => `rd.q.${x}`),
      ...['request', 'message'].map((x) => `crew.mode.${x}`),
      ...['idle', 'thinking', 'working', 'waiting', 'waiting_approval', 'waiting_model', 'paused', 'reviewing', 'testing', 'sleeping', 'offline', 'queued', 'tool', 'error'].map((x) => `worker.${x}`),
      ...['job.created', 'job.done', 'job.failed', 'job.cancelled', 'job.planned', 'task.running', 'task.done', 'task.failed', 'approval.requested', 'approval.approved', 'approval.rejected', 'file.changed', 'brief.proposed', 'worker.paused', 'worker.resumed'].map((x) => `feed.${x}`),
      'crew.requestLabel', 'crew.messageLabel', 'crew.requestHint', 'crew.messageHint', 'crew.pause', 'crew.resume', 'crew.paused', 'crew.resumed', 'ap.approved', 'ap.rejected',
      'pair.refused.body', 'pair.refused.mismatch', 'sas.waiting', 'rd.grantedControl', 'rd.grantedView', 'rd.refused.timeout', 'rd.refused.busy', 'rd.refused.stopped'
    ];
    expect([...used, ...families].filter((k) => !(k in en))).toEqual([]);
  });

  for (const code of CODES) {
    it(`${code} has every page key, the same placeholders and plural forms that exist in its language`, () => {
      const m = JSON.parse(read(`i18n/${code}.json`));
      expect(Object.keys(m).sort()).toEqual(Object.keys(en).sort());
      const cats = new Set(new Intl.PluralRules(code).resolvedOptions().pluralCategories);
      for (const [k, v] of Object.entries(m)) {
        expect(v.trim(), `${code} ${k}`).toBeTruthy();
        expect(placeholders(v), `${code} ${k}`).toEqual(placeholders(en[k]));
        for (const pm of v.matchAll(/plural,((?:\s*\w+\s*\{[^}]*\})+)\}/g)) {
          const used = [...pm[1].matchAll(/(\w+)\s*\{/g)].map((x) => x[1]);
          expect(used.includes('other'), `${code} ${k}`).toBe(true);
          for (const c of used) expect(cats.has(c) || /^=\d+$/.test(c), `${code} ${k}: ${c}`).toBe(true);
        }
        expect(DASH.test(v) || EMOJI.test(v), `${code} ${k}`).toBe(false);
      }
    });
  }

  it('the desktop strings: the English part equals ui/phone/strings.js and every locale has every key', () => {
    const dir = path.join(ROOT, 'i18n', 'parts');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 's7-phone.en.json'), 'utf8'))).toEqual(DESK_EN);
    for (const code of CODES) {
      const m = JSON.parse(fs.readFileSync(path.join(dir, `s7-phone.${code}.json`), 'utf8'));
      expect(Object.keys(m).sort(), code).toEqual(Object.keys(DESK_EN).sort());
      for (const [k, v] of Object.entries(m)) {
        expect(placeholders(v), `${code} ${k}`).toEqual(placeholders(DESK_EN[k]));
        expect(DASH.test(v) || EMOJI.test(v), `${code} ${k}`).toBe(false);
      }
    }
    for (const g of GRANT_NAMES) expect(DESK_EN[`phone.grant.${g}`], g).toBeTruthy();
  });
});

describe('phone viewer keyboard', () => {
  it('maps typed characters to the physical keys the computer accepts (US layout)', async () => {
    const { keysForChar } = await import('../../docs/remote/js/viewer.js');
    const { KEYS } = await import('../../src/remote/keys.js');
    expect(keysForChar('a')).toEqual([{ code: 'KeyA' }]);
    expect(keysForChar('Q')).toEqual([{ code: 'KeyQ', shift: true }]);
    expect(keysForChar('7')).toEqual([{ code: 'Digit7' }]);
    expect(keysForChar('?')).toEqual([{ code: 'Slash', shift: true }]);
    expect(keysForChar('\u00e9')).toBeNull();
    const all = ' abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=[]{}\|;:\'",.<>/?`~\n\t';
    for (const ch of all) expect(Object.hasOwn(KEYS, keysForChar(ch)[0].code), ch).toBe(true);
  });
});
