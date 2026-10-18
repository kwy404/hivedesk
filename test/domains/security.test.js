import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { auditProject, scanSecrets, scanCode, checkDependencies, listDependencies, mask, entropy, loadAdvisories } from '../../src/crew/domains/security/scan.js';
import { proposeFixes, fixFor, redact, envName } from '../../src/crew/domains/security/fixes.js';
import { runChecks } from '../../src/crew/library/checks.js';
import { waitFor } from '../helpers.js';
import { SECRETS, vulnerableFiles, writeProject, snapshot } from './fixtures.js';
import { rig, eventsOf } from './rig.js';

const at = (r, id, file) => r.findings.filter((f) => f.id === id && (!file || f.file === file)).map((f) => `${f.file}:${f.line}`);

describe('the security scanner', () => {
  const root = writeProject();
  const r = auditProject({ root });

  it('finds the secrets with severity, file and line, and never shows them in full', () => {
    expect(at(r, 'secret.aws-key')).toEqual(['config.js:2']);
    expect(at(r, 'secret.assignment')).toEqual(['config.js:3']);
    expect(at(r, 'secret.github-token')).toEqual(['.env:1']);
    expect(at(r, 'secret.stripe-key')).toEqual(['.env:2']);
    expect(at(r, 'secret.private-key')).toEqual(['deploy/key.pem:1']);
    expect(r.findings.find((f) => f.id === 'secret.aws-key').severity).toBe('critical');
    const all = JSON.stringify(r.findings);
    for (const s of Object.values(SECRETS)) expect(all.includes(s), s.slice(0, 6)).toBe(false);
    // Placeholders, example files and dependencies are not findings.
    expect(r.findings.some((f) => f.file === '.env.example' && f.severity !== 'low')).toBe(false);
    expect(r.findings.some((f) => f.file.startsWith('node_modules/'))).toBe(false);
    expect(r.findings.some((f) => /changeme/.test(f.snippet || ''))).toBe(false);
  });

  it('finds the risky patterns', () => {
    expect(at(r, 'code.shell-input')).toEqual(['server.js:4', 'tools/load.py:5']);
    expect(at(r, 'code.sql-concat')).toEqual(['server.js:7']);
    expect(at(r, 'code.weak-hash')).toEqual(['server.js:9']);
    expect(at(r, 'code.insecure-random')).toEqual(['server.js:10']);
    expect(at(r, 'code.tls-off')).toEqual(['server.js:11']);
    expect(at(r, 'code.eval')).toEqual(['server.js:12']);
    expect(at(r, 'code.inner-html')).toEqual(['public/app.js:3']);
    expect(at(r, 'code.unsafe-deserialize')).toEqual(['tools/load.py:3', 'tools/load.py:4']);
    expect(at(r, 'config.no-csp')).toEqual(['public/index.html:3']);
    expect(at(r, 'config.env-not-ignored')).toEqual(['.gitignore:0']);
    for (const f of r.findings) expect(f.fix.length, f.id).toBeGreaterThan(10);
  });

  it('checks the dependencies against the offline advisory list, locked versions first', () => {
    const deps = r.findings.filter((f) => f.category === 'dependency').map((f) => f.dependency).sort();
    expect(deps).toEqual(['lodash', 'node-fetch', 'pyyaml']);
    expect(r.dependencies).toBe(6);
    expect(loadAdvisories().updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const locked = checkDependencies([{ ecosystem: 'npm', name: 'lodash', range: '^4.17.15', locked: '4.17.21', file: 'package.json' }]);
    expect(locked).toEqual([]);
    const lock = listDependencies((p) => ({ 'package.json': '{"dependencies":{"minimist":"^1.2.0"}}', 'package-lock.json': '{"packages":{"node_modules/minimist":{"version":"1.2.5"}}}' })[p] ?? null);
    expect(lock[0].locked).toBe('1.2.5');
    expect(checkDependencies(lock)[0].basis).toBe('locked version');
  });

  it('orders by severity and counts', () => {
    const rank = { critical: 0, high: 1, medium: 2, low: 3 };
    for (let i = 1; i < r.findings.length; i++) expect(rank[r.findings[i].severity]).toBeGreaterThanOrEqual(rank[r.findings[i - 1].severity]);
    expect(r.counts.critical).toBeGreaterThanOrEqual(5);
    expect(r.scanned).toBe(Object.keys(vulnerableFiles()).length - 1);
  });

  it('a clean project has no findings', () => {
    const clean = auditProject({ files: [
      { path: 'index.html', text: '<!doctype html><html lang="en"><head><meta http-equiv="Content-Security-Policy" content="default-src \'self\'"><title>x</title></head><body><script src="a.js"></script></body></html>' },
      { path: 'a.js', text: "document.querySelector('p').textContent = new URLSearchParams(location.search).get('q');\nconst key = process.env.API_KEY;\n" }
    ] });
    expect(clean.findings).toEqual([]);
  });

  it('small helpers: masking, entropy, scans of one file', () => {
    expect(mask('abcdefghijklmnop')).toBe('abcd************');
    expect(entropy('aaaaaaaa')).toBe(0);
    expect(scanSecrets('a.js', "const password = 'x'").length).toBe(0);
    expect(scanSecrets('test/fixtures/a.js', `const k = '${SECRETS.aws}'`)[0].severity).toBe('low');
    expect(scanCode('a.js', '// eval(x) in a comment').length).toBe(0);
    expect(scanCode('a.py', 'requests.get(url, verify=False)')[0].id).toBe('code.tls-off');
    expect(runChecks(['sec.no-secrets'], { files: [{ path: 'a.js', text: `const k = '${SECRETS.aws}';` }] }).issues[0]).toMatch(/a\.js:1: AWS access key id/);
    expect(runChecks(['sec.sql-params', 'sec.no-shell-input', 'sec.weak-crypto'], { files: [{ path: 's.js', text: vulnerableFiles()['server.js'] }] }).issues.length).toBe(4);
  });
});

describe('suggested fixes', () => {
  const root = writeProject();
  const read = (p) => { try { return fs.readFileSync(path.join(root, p), 'utf8'); } catch { return null; } };
  const r = auditProject({ root });
  const fixes = proposeFixes(r.findings, read);

  it('are small exact patches for what has a safe mechanical fix', () => {
    const by = Object.fromEntries(fixes.map((f) => [f.findingId, f]));
    expect(by['code.inner-html']).toMatchObject({ path: 'public/app.js', search: 'out.innerHTML = name;', replace: 'out.textContent = name;' });
    expect(by['code.weak-hash'].replace).toMatch(/createHash\('sha256'\)/);
    expect(by['code.tls-off'].replace).toMatch(/rejectUnauthorized: true/);
    expect(by['code.unsafe-deserialize'].replace).toMatch(/yaml\.safe_load/);
    expect(by['config.no-csp'].replace).toMatch(/Content-Security-Policy/);
    expect(by['config.env-not-ignored']).toMatchObject({ path: '.gitignore', replace: 'node_modules\n.env' });
    expect(by['secret.assignment']).toMatchObject({ path: 'config.js', secret: true });
    expect(by['secret.assignment'].replace).toMatch(/process\.env\.API_TOKEN/);
    expect(by['secret.assignment'].summary).not.toMatch(new RegExp(SECRETS.token));
    // No fix for what needs a person: SQL, shell, eval, keys in .env.
    for (const id of ['code.sql-concat', 'code.shell-input', 'code.eval', 'secret.github-token']) expect(by[id], id).toBeUndefined();
    expect(fixFor({ id: 'code.inner-html', file: 'public/app.js', line: 4 }, read)).toBe(null);
  });

  it('helpers', () => {
    expect(envName('apiToken')).toBe('API_TOKEN');
    expect(envName('client-secret')).toBe('CLIENT_SECRET');
    expect(redact(`key '${SECRETS.aws}' and ${SECRETS.github}`)).not.toMatch(/Q3EXAMPLE|k3J9xQ2m/);
  });
});

describe('security mode in a job', () => {
  it('audits read only, reports, and writes only the fixes the user approves (strict, even with approval mode off)', async () => {
    const t = rig({ refine: false, approvalMode: false });
    for (const [p, text] of Object.entries(vulnerableFiles())) t.ws.write(p, text);
    const before = snapshot(t.ws.root);
    const { done } = t.hive.createJob({ request: 'audit my project for leaked keys and vulnerabilities' });
    const first = await waitFor(() => eventsOf(t.bus, 'approval.requested')[0]);
    // Nothing is written before an answer.
    expect(snapshot(t.ws.root)).toEqual(before);
    const report = eventsOf(t.bus, 'security.report')[0];
    expect(report.data.counts.critical).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(report.data)).not.toMatch(/Q3EXAMPLE7KEY|k3J9xQ2mZ7|9f8Kq2Lm4Z/);
    const chat = t.bus.events.filter((e) => e.type === 'chat.message' && e.data.from === 'security').map((e) => e.data.text).join('\n');
    expect(chat).toMatch(/Security audit \(read only\)/);
    expect(chat).toMatch(/\[critical\] config\.js:2 AWS access key id/);
    expect(eventsOf(t.bus, 'job.domain')[0].data).toMatchObject({ domain: 'security', specialist: 'security' });
    expect(first.data.approval.strict).toBe(true);
    // Approve the first fix, decline every other one.
    t.approvals.resolve(first.data.approval.id, true);
    const answered = new Set([first.data.approval.id]);
    for (;;) {
      await waitFor(() => eventsOf(t.bus, 'approval.requested').some((e) => !answered.has(e.data.approval.id)) || eventsOf(t.bus, 'job.done').length);
      const next = eventsOf(t.bus, 'approval.requested').find((e) => !answered.has(e.data.approval.id));
      if (!next) break;
      answered.add(next.data.approval.id);
      expect(JSON.stringify(next.data)).not.toMatch(/9f8Kq2Lm4Z/);
      t.approvals.resolve(next.data.approval.id, false);
    }
    await done;
    const after = snapshot(t.ws.root);
    const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
    expect(changed).toHaveLength(1);
    expect(eventsOf(t.bus, 'job.planned')).toEqual([]);
    expect(eventsOf(t.bus, 'job.done')[0].data.summary).toMatch(/1 fixes applied, \d+ declined/);
  }, 30000);

  it('the security.audit command is read only too', async () => {
    const t = rig({ refine: false });
    for (const [p, text] of Object.entries(vulnerableFiles())) t.ws.write(p, text);
    const before = snapshot(t.ws.root);
    const commands = new Map();
    const { attachDomains } = await import('../../src/crew/domains/attach.js');
    attachDomains({ hive: t.hive, server: { command: (type, fn) => commands.set(type, fn) } });
    const r = commands.get('security.audit')({});
    expect(r.findings.length).toBeGreaterThan(10);
    expect(JSON.stringify(r)).not.toMatch(/Q3EXAMPLE7KEY|k3J9xQ2mZ7/);
    expect(snapshot(t.ws.root)).toEqual(before);
    expect(() => commands.get('crew.answer')({})).toThrow(/questionId/);
    expect(commands.get('crew.questions')({})).toEqual({ questions: [] });
  });
});
