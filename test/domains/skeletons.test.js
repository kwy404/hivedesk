import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { templateFiles, templateIds, wantsSkeleton, seedSkeleton, TEMPLATES_DIR } from '../../src/crew/domains/skeletons.js';
import { DOMAINS } from '../../src/crew/domains/index.js';
import { runChecks, CHECKS } from '../../src/crew/library/checks.js';
import { ToolBox, Workspace } from '../../src/tools/index.js';
import { Approvals } from '../../src/tools/approvals.js';
import { EventBus } from '../../src/bus.js';
import { tmpDir } from '../helpers.js';

const BASE_CHECKS = ['js.syntax', 'json.valid', 'pkg.scripts', 'file.readme', 'file.test', 'file.nonempty', 'text.no-placeholder', 'sec.no-secrets', 'node.test-runner'];

describe('the offline skeletons', () => {
  it('there is one per buildable domain that needs one', () => {
    expect(templateIds().sort()).toEqual(['backend', 'cli', 'data', 'desktop', 'extension', 'game', 'mobile']);
  });

  for (const id of ['mobile', 'desktop', 'backend', 'cli', 'extension', 'game', 'data']) {
    describe(id, () => {
      const files = templateFiles(id);

      it('passes its domain checks and the base checks', () => {
        const ids = [...new Set([...DOMAINS[id].checks, ...BASE_CHECKS])];
        for (const c of ids) expect(CHECKS[c], c).toBeTruthy();
        const r = runChecks(ids, { files });
        expect(r.issues).toEqual([]);
        expect(r.results.filter((x) => DOMAINS[id].checks.includes(x.id)).every((x) => x.status === 'pass')).toBe(true);
      });

      it('its tests pass in a fresh copy (node --test, no install)', () => {
        const dir = tmpDir(`skeleton-${id}-`);
        for (const f of files) {
          fs.mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true });
          fs.writeFileSync(path.join(dir, f.path), f.text);
        }
        const r = spawnSync(process.execPath, ['--test'], { cwd: dir, encoding: 'utf8', timeout: 60000 });
        expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
        expect(r.stdout).toMatch(/fail 0/);
        fs.rmSync(dir, { recursive: true, force: true });
      }, 70000);

      it('has a README that is honest about what needs other tools', () => {
        const readme = files.find((f) => f.path === 'README.md').text;
        expect(readme).toMatch(/npm test/);
        if (id === 'mobile') expect(readme).toMatch(/Android Studio[\s\S]*Xcode/);
        if (id === 'desktop') expect(readme).toMatch(/neu update|setup/);
        if (id === 'extension') expect(readme).toMatch(/Load unpacked/);
      });
    });
  }

  it('the checks catch a broken skeleton', () => {
    const files = templateFiles('mobile').map((f) => (f.path === 'capacitor.config.json' ? { ...f, text: '{"appName": "x", "webDir": "www", "appId": "not an id"}' } : f.path === 'www/manifest.webmanifest' ? { ...f, text: '{"name": "x"}' } : f));
    const r = runChecks(['capacitor.config', 'pwa.manifest'], { files });
    expect(r.issues.join('\n')).toMatch(/appId "not an id"/);
    expect(r.issues.join('\n')).toMatch(/no "start_url"/);
    const ext = templateFiles('extension').map((f) => (f.path === 'manifest.json' ? { ...f, text: JSON.stringify({ manifest_version: 2, name: 'x', version: '1', background: { scripts: ['b.js'] }, permissions: ['<all_urls>'] }) } : f));
    expect(runChecks(['ext.manifest-v3'], { files: ext }).issues.length).toBe(3);
    const neu = templateFiles('desktop').map((f) => (f.path === 'neutralino.config.json' ? { ...f, text: JSON.stringify({ applicationId: 'a', modes: { window: {} }, nativeAllowList: ['os.*'] }) } : f));
    expect(runChecks(['neu.config'], { files: neu }).issues.join('\n')).toMatch(/allows running commands/);
    const game = [{ path: 'main.js', text: 'const c = document.querySelector("canvas").getContext("2d"); setInterval(draw, 16);' }];
    expect(runChecks(['game.loop'], { files: game }).issues.join('\n')).toMatch(/requestAnimationFrame/);
    const docker = [{ path: 'Dockerfile', text: 'FROM node:latest\nCOPY . .\nCMD ["node", "server.js"]\n' }];
    const d = runChecks(['container.nonroot', 'container.pinned'], { files: docker });
    expect(d.issues.join('\n')).toMatch(/runs as root[\s\S]*not pinned/);
    expect(runChecks(['container.nonroot', 'container.pinned'], { files: [{ path: 'Dockerfile', text: 'FROM node:22.11-slim\nUSER node\n' }] }).issues).toEqual([]);
  });

  it('starts only in a workspace without a project of that kind, and never overwrites a file', () => {
    expect(wantsSkeleton('mobile', [])).toBe(true);
    expect(wantsSkeleton('mobile', ['README.md'])).toBe(true);
    expect(wantsSkeleton('mobile', ['capacitor.config.json'])).toBe(false);
    expect(wantsSkeleton('web', [])).toBe(false);
    expect(wantsSkeleton('backend', ['a.js', 'b.js', 'c.js', 'd.js'])).toBe(false);
    const bus = new EventBus();
    const ws = new Workspace(path.join(tmpDir(), 'ws'));
    ws.write('README.md', '# Mine\n');
    const toolbox = new ToolBox({ workspace: ws, bus, approvals: new Approvals(bus) });
    const written = seedSkeleton(toolbox, 'backend', { jobId: 'j_1' });
    expect(written).toContain('src/server.js');
    expect(written).not.toContain('README.md');
    expect(ws.read('README.md')).toBe('# Mine\n');
    const changed = bus.events.filter((e) => e.type === 'file.changed');
    expect(changed.map((e) => e.data.path).sort()).toEqual([...written].sort());
    expect(changed[0].jobId).toBe('j_1');
    expect(changed[0].data.workerId).toBe('backend');
    expect(seedSkeleton(toolbox, 'backend')).toEqual([]);
  });

  it('templates live inside the package and hold no binary files', () => {
    expect(TEMPLATES_DIR.replace(/\\/g, '/')).toMatch(/src\/crew\/domains\/templates$/);
    for (const id of templateIds()) for (const f of templateFiles(id)) expect(f.text.includes('\u0000'), f.path).toBe(false);
  });
});
