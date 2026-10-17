import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateTheme, fixContrast, checkContrast, contrast, themeVars, serializeTheme, patternUrl, BASE, THEME_SCHEMA, COLOR_KEYS
} from '../ui/themes/core.js';
import { ThemeStore, generateTheme } from '../src/extensions/themes.js';
import { validate } from '../src/brain/schema.js';
import { createFakeBrain } from '../src/brain/fake.js';
import { EventBus } from '../src/bus.js';
import { Scheduler } from '../src/crew/scheduler.js';
import { tmpDir } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const THEMES = path.join(ROOT, 'themes');

describe('theme schema', () => {
  it('accepts every built-in theme and they all pass their contrast targets', () => {
    const files = fs.readdirSync(THEMES).filter((f) => f.endsWith('.hivedesk-theme.json'));
    expect(files.length).toBeGreaterThanOrEqual(8);
    const names = [];
    for (const f of files) {
      const raw = JSON.parse(fs.readFileSync(path.join(THEMES, f), 'utf8'));
      const v = validateTheme(raw);
      expect(v.errors, f).toEqual([]);
      expect(checkContrast(v.theme).filter((r) => !r.ok), f).toEqual([]);
      expect(`${v.theme.id}.hivedesk-theme.json`).toBe(f);
      names.push(v.theme.name);
    }
    for (const n of ['Mel', 'Colmeia Clara', 'Meia-noite', 'Floresta', 'Neon', 'Papel', 'Alto contraste', 'Pixel']) expect(names).toContain(n);
  });

  it('holds the high contrast theme to AAA for text', () => {
    const t = validateTheme(JSON.parse(fs.readFileSync(path.join(THEMES, 'alto-contraste.hivedesk-theme.json'), 'utf8'))).theme;
    expect(t.contrast).toBe('high');
    expect(contrast(t.colors.text, t.colors.panel)).toBeGreaterThanOrEqual(7);
    expect(contrast(t.colors.muted, t.colors.panel2)).toBeGreaterThanOrEqual(7);
  });

  it('rejects bad colors, unknown enums and missing fields', () => {
    const bad = JSON.parse(JSON.stringify(BASE));
    bad.colors.text = 'red';
    delete bad.colors.panel;
    bad.pattern.kind = 'stars';
    bad.sound = 'trumpet';
    bad.scheme = 'blue';
    const v = validateTheme(bad);
    expect(v.ok).toBe(false);
    expect(v.theme).toBeNull();
    expect(v.errors).toEqual(expect.arrayContaining([
      'colors.text must be a #RRGGBB color', 'colors.panel is required', 'scheme must be "dark" or "light"'
    ]));
    expect(v.errors.some((e) => e.startsWith('pattern.kind'))).toBe(true);
    expect(v.errors.some((e) => e.startsWith('sound'))).toBe(true);
    expect(validateTheme(null).ok).toBe(false);
    expect(validateTheme({ ...BASE, format: 'other' }).errors[0]).toMatch(/format/);
  });

  it('refuses font lists that could load anything and clamps numbers', () => {
    const v = validateTheme({ ...BASE, fonts: { sans: 'x; } body { background: url(https://evil.example/a.png)', mono: 'system' } });
    expect(v.ok).toBe(false);
    const ok = validateTheme({ ...BASE, fonts: { sans: '"Inter", Arial, sans-serif', mono: 'pixel' }, radius: { window: 400, control: -3, small: 6 }, motion: 9, lines: 0 });
    expect(ok.ok).toBe(true);
    expect(ok.theme.radius).toEqual({ window: 28, control: 0, small: 6 });
    expect(ok.theme.motion).toBe(1.5);
    expect(ok.theme.lines).toBe(0.5);
  });

  it('maps tokens to the custom properties hive.css reads', () => {
    const vars = themeVars(validateTheme(BASE).theme);
    for (const k of ['--bg', '--panel', '--text', '--muted-t', '--honey', '--honey-ink', '--r-win', '--t', '--shadow-win', '--font-sans', '--hd-pattern', '--primary', '--hd-topbar']) expect(vars[k], k).toBeTruthy();
    expect(vars['--r-win']).toBe('14px');
    expect(patternUrl({ kind: 'none', color: '#FFFFFF', opacity: 0.1, size: 56 }).url).toBe('none');
    expect(patternUrl(BASE.pattern).url).toMatch(/^url\("data:image\/svg\+xml,/);
    // No quote or parenthesis from the pattern can end the url() early.
    expect(patternUrl(BASE.pattern).url.slice(5, -2)).not.toMatch(/["()']/);
  });

  it('round trips through the export format', () => {
    const t = validateTheme(BASE).theme;
    const again = validateTheme(JSON.parse(serializeTheme(t)));
    expect(again.ok).toBe(true);
    expect(again.theme).toEqual(t);
  });

  it('works as a schema for the brain', () => {
    const { format, version, id, author, ...answer } = BASE;
    expect(validate(THEME_SCHEMA, answer)).toEqual([]);
    expect(validate(THEME_SCHEMA, { ...answer, colors: { ...answer.colors, text: undefined } }).length).toBeGreaterThan(0);
    expect(Object.keys(THEME_SCHEMA.properties.colors.properties)).toEqual(COLOR_KEYS);
  });
});

describe('contrast auto fix', () => {
  it('moves only text colors until every pair passes AA', () => {
    const t = validateTheme({
      ...BASE, name: 'Muddy',
      colors: { ...BASE.colors, text: '#3A3530', text2: '#2E2A26', muted: '#302B26', faint: '#24201C', accent2: '#40301A', ok: '#204030', bad: '#401C18', accentInk: '#E0A030' }
    }).theme;
    const before = checkContrast(t).filter((r) => !r.ok);
    expect(before.length).toBeGreaterThan(5);
    const r = fixContrast(t);
    expect(r.failing).toEqual([]);
    expect(checkContrast(r.theme).every((x) => x.ok)).toBe(true);
    // Surfaces never change.
    for (const k of ['bg', 'bg2', 'panel', 'panel2', 'panel3', 'panel4', 'accent']) expect(r.theme.colors[k]).toBe(t.colors[k]);
    expect(r.fixes.map((f) => f.key)).toEqual(expect.arrayContaining(['text', 'text2', 'muted', 'faint', 'ok', 'bad', 'accentInk']));
    for (const f of r.fixes) expect(f.ratio).toBeGreaterThanOrEqual(f.min);
    expect(contrast(r.theme.colors.text, t.colors.panel3)).toBeGreaterThanOrEqual(4.5);
  });

  it('darkens text on light themes and keeps a passing theme as it is', () => {
    const light = validateTheme({ ...BASE, name: 'Pale', scheme: 'light', colors: { ...BASE.colors, bg: '#FAFAFA', bg2: '#F2F2F2', panel: '#FFFFFF', panel2: '#F5F5F5', panel3: '#EEEEEE', panel4: '#E5E5E5', text: '#AAAAAA', text2: '#BBBBBB', muted: '#CCCCCC', faint: '#DDDDDD', accent: '#FFD84D', accent2: '#FFE58A', accentInk: '#FFFFFF', ok: '#9FE0B0', warn: '#FFE08A', bad: '#FFAAAA', info: '#AACCFF' } }).theme;
    const r = fixContrast(light);
    expect(r.failing).toEqual([]);
    const lum = (hex) => parseInt(hex.slice(1, 3), 16);
    expect(lum(r.theme.colors.text)).toBeLessThan(lum(light.colors.text));
    const mel = fixContrast(validateTheme(BASE).theme);
    expect(mel.fixes).toEqual([]);
  });
});

describe('theme store and "create a theme with the crew"', () => {
  const dirs = [];
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  it('lists built-in themes first, saves, renames on conflicts and deletes user themes', () => {
    const home = tmpDir();
    dirs.push(home);
    const store = new ThemeStore({ builtinDir: THEMES, home });
    const list = store.list();
    expect(list.slice(0, 8).map((t) => t.id)).toEqual(['mel', 'colmeia-clara', 'meia-noite', 'floresta', 'neon', 'papel', 'alto-contraste', 'pixel']);
    const saved = store.save({ ...BASE, id: 'mel', name: 'Mel' });
    expect(saved.id).toBe('mel-2');
    expect(fs.existsSync(path.join(home, 'themes', 'mel-2.hivedesk-theme.json'))).toBe(true);
    expect(() => store.save({ name: 'broken' })).toThrow(/problems/);
    expect(() => store.delete('mel')).toThrow(/only your own/);
    store.delete('mel-2');
    expect(store.list().some((t) => t.id === 'mel-2')).toBe(false);
  });

  it('turns a prompt into a validated theme and fixes the contrast with the fake brain', async () => {
    const bus = new EventBus();
    const scheduler = new Scheduler(bus);
    const answer = {
      ...BASE, name: 'Pôr do sol na praia', description: 'Warm sunset over the sea', scheme: 'dark',
      colors: { ...BASE.colors, bg: '#1B0F14', bg2: '#22121A', panel: '#2A1620', panel2: '#331A26', panel3: '#3D1F2D', panel4: '#472435', text: '#5A3A40', text2: '#6A4040', muted: '#553035', accent: '#FF7A45', accent2: '#FF9E6E', accentInk: '#2A0E05' },
      pattern: { kind: 'dots', color: '#FFB07A', opacity: 0.08, size: 40 }
    };
    const brain = createFakeBrain({ respond: (messages, options) => { expect(options.schema).toBe(THEME_SCHEMA); expect(messages[1].content).toContain('pôr do sol'); return answer; } });
    scheduler.addBrain(brain);
    const r = await generateTheme({ scheduler, prompt: 'crie um tema inspirado em pôr do sol na praia' });
    expect(r.theme.name).toBe('Pôr do sol na praia');
    expect(r.theme.id).toBe('por-do-sol-na-praia');
    expect(r.problemsBefore).toBeGreaterThan(0);
    expect(r.fixes.map((f) => f.key)).toEqual(expect.arrayContaining(['text', 'text2', 'muted']));
    expect(r.failing).toEqual([]);
    expect(r.theme.colors.bg).toBe('#1B0F14');
    expect(validateTheme(r.theme).ok).toBe(true);
    await scheduler.close();
  });

  it('asks again after an unusable answer and falls back to an editable draft', async () => {
    const bus = new EventBus();
    const scheduler = new Scheduler(bus);
    const brain = createFakeBrain({ respond: () => ({ nope: true }) });
    scheduler.addBrain(brain);
    const r = await generateTheme({ scheduler, prompt: 'ocean' });
    expect(brain.calls.length).toBe(2);
    expect(brain.calls[1].messages.at(-1).content).toMatch(/problems/);
    expect(r.fallback).toBe(true);
    expect(validateTheme(r.theme).ok).toBe(true);
    await scheduler.close();
    const empty = new Scheduler(new EventBus());
    await expect(generateTheme({ scheduler: empty, prompt: 'x' })).rejects.toThrow(/no model/);
  });
});
