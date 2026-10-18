import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeSettings, patchSettings, SettingsFile, DEFAULTS } from '../../src/workbench/settings.js';
import { POLICY } from '../../src/workbench/origin.js';
import { tmpDir } from '../helpers.js';

describe('workbench settings', () => {
  it('clamps and drops what is not a setting', () => {
    const s = normalizeSettings({ fontSize: 400, tabSize: 0, wordWrap: 'sideways', minimap: 'yes', evil: 1, terminal: { shell: 'bash\nrm -rf /', scrollback: 9 }, searchExcludes: ['dist/**', '', 7, 'x\ny'] });
    expect(s.fontSize).toBe(32);
    expect(s.tabSize).toBe(1);
    expect(s.wordWrap).toBe('off');
    expect(s.minimap).toBe(true);
    expect(s.evil).toBeUndefined();
    expect(s.terminal.shell).toBe('');
    expect(s.terminal.scrollback).toBe(500);
    expect(s.searchExcludes).toEqual(['dist/**']);
    expect(normalizeSettings({})).toEqual(normalizeSettings(DEFAULTS));
  });

  it('patches without touching the roots', () => {
    const cur = normalizeSettings({ roots: [{ id: 'r_abcd1234', path: path.resolve('/tmp/x'), name: 'x' }] });
    const next = patchSettings(cur, { fontSize: 15, roots: [], terminal: { fontSize: 11 } });
    expect(next.fontSize).toBe(15);
    expect(next.terminal.fontSize).toBe(11);
    expect(next.terminal.scrollback).toBe(cur.terminal.scrollback);
    expect(next.roots).toEqual(cur.roots);
  });

  it('writes only its own section of settings.json and keeps the rest', () => {
    const file = path.join(tmpDir('hivedesk-wb-set-'), 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ v: 1, share: { enabled: false }, remote: { x: 1 } }));
    const sf = new SettingsFile(file);
    sf.patch({ fontSize: 16 });
    const all = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(all.share).toEqual({ enabled: false });
    expect(all.remote).toEqual({ x: 1 });
    expect(all.workbench.fontSize).toBe(16);
    expect(new SettingsFile(file).get().fontSize).toBe(16);
    fs.writeFileSync(file, '{ not json');
    expect(new SettingsFile(file).get()).toEqual(normalizeSettings({}));
  });

  it('has a policy for every command, and no terminal or git command is ever open to peers', () => {
    for (const [type, p] of Object.entries(POLICY)) {
      expect(p.local).toBe(true);
      if (/^wb\.(term|scm|settings|roots|peers)\./.test(type) || type === 'wb.peers') expect(p.peer).toBeUndefined();
      if (p.peer) expect(['workspace.read', 'workspace.propose']).toContain(p.peer);
    }
  });
});
