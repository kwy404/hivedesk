// The pure parts of the workbench UI: editor groups, shortcuts, quick open ranking, themes, problems,
// the basic terminal's line editing, project file picking, source control lists and names.
import { describe, it, expect } from 'vitest';
import * as L from '../../ui/workbench/layout.js';
import { Commands, chordOf, normalizeChord, parseQuickQuery, rankFiles, fuzzy } from '../../ui/workbench/commands.js';
import { editorTheme, terminalTheme, editorThemeId, mix } from '../../ui/workbench/theme.js';
import { groupMarkers, lineEdit, pickProjectFiles, groupStatus, nameProblem, validBranchName } from '../../ui/workbench/util.js';
import { validBranch } from '../../src/github/git.js';

describe('editor groups and tabs', () => {
  const a = L.fileKey('ws', 'a.js');
  const b = L.fileKey('ws', 'b.js');
  const c = L.fileKey('r_x', 'c.py');

  it('opens tabs after the active one and parses tab keys', () => {
    let l = L.createLayout();
    l = L.openTab(l, a);
    l = L.openTab(l, b);
    l = L.setActive(l, l.groups[0].id, a);
    l = L.openTab(l, c);
    expect(l.groups[0].tabs).toEqual([a, c, b]);
    expect(L.activeTab(l)).toBe(c);
    expect(L.parseKey(c)).toEqual({ kind: 'file', root: 'r_x', path: 'c.py' });
    expect(L.parseKey(L.diffKey('ws', 'x/y.js', true))).toEqual({ kind: 'diff', root: 'ws', staged: true, path: 'x/y.js' });
    expect(L.parseKey(L.SETTINGS_KEY)).toEqual({ kind: 'settings' });
    expect(L.parseKey('f:ws:dir/with:colon.txt').path).toBe('dir/with:colon.txt');
  });

  it('splits up to three groups, then moves to the next one', () => {
    let l = L.openTab(L.createLayout(), a);
    l = L.split(l);
    expect(l.groups.length).toBe(2);
    expect(l.groups[1].tabs).toEqual([a]);
    expect(l.activeGroup).toBe(l.groups[1].id);
    l = L.openTab(l, b);
    l = L.split(l);
    l = L.split(l, { key: c });
    expect(l.groups.length).toBe(L.MAX_GROUPS);
    expect(l.sizes.reduce((x, y) => x + y, 0)).toBeCloseTo(1);
  });

  it('closes tabs and empty groups, keeping tabs that would be lost', () => {
    let l = L.openTab(L.createLayout(), a);
    l = L.split(l, { key: a });
    l = L.openTab(l, b);
    const second = l.groups[1].id;
    l = L.closeTab(l, a, { group: second });
    expect(l.groups[1].tabs).toEqual([b]);
    l = L.closeTab(l, b, { group: second });
    expect(l.groups.length).toBe(1);
    l = L.split(l, { key: a });
    l = L.openTab(l, c);
    l = L.closeGroup(l, l.groups[1].id);
    expect(l.groups.length).toBe(1);
    expect(l.groups[0].tabs).toEqual([a, c]);
    l = L.closeTab(l, a);
    l = L.closeTab(l, c);
    expect(l.groups.length).toBe(1);
    expect(L.activeTab(l)).toBe(null);
  });

  it('moves tabs between groups, renames and closes everywhere', () => {
    let l = L.openTab(L.createLayout(), a);
    l = L.openTab(l, b);
    l = L.split(l, { key: b });
    const [g1, g2] = l.groups.map((g) => g.id);
    l = L.moveTab(l, a, g2, 0);
    expect(l.groups.find((g) => g.id === g2).tabs).toEqual([a, b]);
    l = L.renameTab(l, b, L.fileKey('ws', 'bb.js'));
    expect(L.openKeys(l)).toEqual(expect.arrayContaining([L.fileKey('ws', 'bb.js')]));
    expect(L.openKeys(l)).not.toContain(b);
    l = L.closeEverywhere(l, L.fileKey('ws', 'bb.js'));
    expect(L.openKeys(l)).toEqual([a]);
    void g1;
  });

  it('cycles tabs, resizes within limits and survives a round trip', () => {
    let l = L.openTab(L.openTab(L.createLayout(), a), b);
    l = L.cycleTab(l, 1);
    expect(L.activeTab(l)).toBe(a);
    l = L.split(l);
    l = L.resize(l, 0, 0.95);
    expect(l.sizes[0]).toBeCloseTo(0.88);
    const back = L.deserialize(L.serialize(l));
    expect(back.groups.map((g) => g.tabs)).toEqual(l.groups.map((g) => g.tabs));
    expect(back.groups.findIndex((g) => g.id === back.activeGroup)).toBe(l.groups.findIndex((g) => g.id === l.activeGroup));
    expect(L.deserialize('{oops').groups.length).toBe(1);
    expect(L.deserialize(JSON.stringify({ v: 1, groups: [{ tabs: ['zz', a], active: 'zz' }] })).groups[0]).toMatchObject({ tabs: [a], active: a });
  });
});

describe('shortcuts and the quick picker', () => {
  it('normalizes chords and reads key events by physical key', () => {
    expect(normalizeChord('shift+ctrl+p')).toBe('Ctrl+Shift+P');
    expect(normalizeChord('Cmd+K')).toBe('Ctrl+K');
    expect(chordOf({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true })).toBe('Ctrl+Shift+P');
    expect(chordOf({ key: '~', code: 'Backquote', ctrlKey: true, shiftKey: true })).toBe('Ctrl+Shift+`');
    expect(chordOf({ key: '\\', code: 'Backslash', metaKey: true })).toBe('Ctrl+\\');
    expect(chordOf({ key: 'F8', code: 'F8', altKey: true })).toBe('Alt+F8');
    expect(chordOf({ key: 'Shift', code: 'ShiftLeft', shiftKey: true })).toBe('');
  });

  it('runs the latest enabled command for a chord', () => {
    const c = new Commands();
    const ran = [];
    c.register({ id: 'a', title: () => 'A', keys: ['Ctrl+S'], run: () => ran.push('a') });
    c.register({ id: 'b', title: () => 'B', keys: ['ctrl+s'], run: () => ran.push('b'), when: () => false });
    c.forEvent({ key: 's', code: 'KeyS', ctrlKey: true }).run();
    expect(ran).toEqual(['a']);
    expect(c.entries().map((e) => e.id)).toEqual(['a']);
    expect(c.run('b')).toBe(false);
  });

  it('parses quick open modes and ranks file names above folders', () => {
    expect(parseQuickQuery('>  save')).toEqual({ mode: 'commands', q: 'save' });
    expect(parseQuickQuery('#Widget')).toEqual({ mode: 'symbols', q: 'Widget' });
    expect(parseQuickQuery(':12')).toEqual({ mode: 'line', q: '12' });
    expect(parseQuickQuery('src/app')).toEqual({ mode: 'files', q: 'src/app' });
    const ranked = rankFiles(['main/other.js', 'src/main.js', 'docs/domain.md', 'lib/x.js'], 'main');
    expect(ranked[0].path).toBe('src/main.js');
    expect(ranked.map((r) => r.path)).not.toContain('lib/x.js');
    expect(fuzzy('workbench', 'wbch')).not.toBe(null);
    expect(fuzzy('workbench', 'zz')).toBe(null);
  });
});

describe('one theme for editor and terminal', () => {
  it('maps the desktop tokens to the editor and the terminal', () => {
    const t = { scheme: 'dark', colors: { bg2: '#101010', text: '#EEEEEE', accent: '#FF8800' } };
    const ed = editorTheme(t);
    expect(ed.base).toBe('vs-dark');
    expect(ed.colors['editor.background']).toBe('#101010');
    expect(ed.colors['editorCursor.foreground']).toBe('#FF8800');
    expect(ed.rules.find((r) => r.token === 'keyword').foreground).toBe('FF8800');
    const term = terminalTheme(t);
    expect(term.background).toBe('#101010');
    expect(term.cursor).toBe('#FF8800');
    expect(editorTheme({ scheme: 'light', colors: {} }).base).toBe('vs');
    expect(editorTheme({ colors: { bg2: 'url(x)' } }).colors['editor.background']).toBe('#141210');
    expect(editorThemeId('desk', t)).toBe('hivedesk-desk');
    expect(editorThemeId('hivedesk-light', t)).toBe('hivedesk-light');
    expect(mix('#000000', '#FFFFFF', 0.5)).toBe('#808080');
  });
});

describe('panel helpers', () => {
  it('groups problems by file, errors first', () => {
    const fromUri = (u) => ({ root: 'ws', path: u.path });
    const g = groupMarkers([
      { resource: { path: 'b.ts' }, severity: 4, message: 'unused', startLineNumber: 2, startColumn: 1 },
      { resource: { path: 'a.ts' }, severity: 4, message: 'w', startLineNumber: 9, startColumn: 1 },
      { resource: { path: 'b.ts' }, severity: 8, message: 'boom', startLineNumber: 5, startColumn: 3, code: 2322, source: 'ts' },
    ], { fromUri });
    expect(g).toMatchObject({ errors: 1, warnings: 2 });
    expect(g.files[0].path).toBe('b.ts');
    expect(g.files[0].items[0]).toMatchObject({ sev: 'error', message: 'boom', line: 5, code: 2322 });
  });

  it('edits a line for the basic terminal, without passing escape sequences', () => {
    let r = lineEdit('', 'ls -l\x7f\x7fa');
    expect(r).toMatchObject({ line: 'ls a', lines: [] });
    r = lineEdit(r.line, '\x1b[A\r');
    expect(r.lines).toEqual(['ls a']);
    expect(r.echo).toBe('\r\n');
    expect(lineEdit('x', '\x03').lines).toEqual([null]);
    expect(lineEdit('', 'a\r\nb\r').lines).toEqual(['a', 'b']);
  });

  it('picks project files for the language service within the caps', () => {
    const files = [{ path: 'src/a.ts', bytes: 10 }, { path: 'src/b.js', bytes: 10 }, { path: 'dist/x.js', bytes: 1 }, { path: 'big.js', bytes: 300 * 1024 }, { path: 'a.min.js', bytes: 1 }, { path: 'README.md', bytes: 1 }];
    expect(pickProjectFiles(files).files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.js']);
    expect(pickProjectFiles(files, { maxFiles: 1 })).toMatchObject({ capped: true, files: [{ path: 'src/a.ts' }] });
  });

  it('splits git status into staged and changes', () => {
    const g = groupStatus([
      { path: 'a', x: 'M', y: 'M', staged: true, unstaged: true },
      { path: 'b', x: '?', y: '?', untracked: true },
      { path: 'c', x: 'D', y: ' ', staged: true },
      { path: 'd', x: 'U', y: 'U', conflict: true },
    ]);
    expect(g.staged.map((f) => `${f.path}${f.letter}`)).toEqual(['aM', 'cD']);
    expect(g.changes.map((f) => `${f.path}${f.letter}`)).toEqual(['aM', 'bU']);
    expect(g.conflicts.map((f) => f.path)).toEqual(['d']);
  });

  it('checks names like the engine does, and branch names like git.js', () => {
    expect(nameProblem('')).toEqual({ code: 'empty' });
    expect(nameProblem('../x')).toEqual({ code: 'dots' });
    expect(nameProblem('C:/x')).toEqual({ code: 'absolute' });
    expect(nameProblem('.git/hooks')).toEqual({ code: 'git' });
    expect(nameProblem('a/con.txt')).toEqual({ code: 'bad', name: 'con.txt' });
    expect(nameProblem('a?.txt').code).toBe('bad');
    expect(nameProblem('src/new file.js')).toBe(null);
    expect(nameProblem('a/b', { allowSlash: false })).toEqual({ code: 'slash' });
    for (const n of ['main', 'feature/x', '-x', 'a..b', 'x.lock', 'a//b', 'ok-1.2']) expect(validBranchName(n)).toBe(validBranch(n));
  });
});
