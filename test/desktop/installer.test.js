// The Windows installer: builds hivedesk-setup.exe from a small test package and runs its non interactive
// self-test (flow state machine, strings in 10 languages, every page, SHA-256 check, download resume, install,
// repair, upgrade and uninstall), all inside a temporary prefix. No window, nothing in the real profile.
// Runs on Windows with the C# compiler of .NET Framework 4; skipped elsewhere.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { makeZip } from './fixtures.js';

const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const can = process.platform === 'win32' && fs.existsSync(csc);

describe.skipIf(!can)('hivedesk-setup.exe', () => {
  it('builds small and passes its self-test in a temporary prefix', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hivedesk-setup-test-'));
    try {
      const zip = path.join(tmp, 'hivedesk-windows-x64.zip');
      fs.writeFileSync(zip, makeZip({
        'hivedesk/hivedesk.exe': Buffer.alloc(4096, 1), 'hivedesk/node/node.exe': Buffer.alloc(20000, 2),
        'hivedesk/app/desktop/main.js': '// test', 'hivedesk/app/package.json': '{}'
      }));
      const exe = path.join(tmp, 'hivedesk-setup.exe');
      execFileSync(process.execPath, ['desktop/scripts/build-setup.mjs', '--zip', zip, '--out', exe], { stdio: 'pipe' });
      expect(fs.statSync(exe).size).toBeLessThan(2e6);
      const prefix = path.join(tmp, 'prefix');
      const r = spawnSync(exe, ['--self-test', '--prefix', prefix, '--payload', zip], { windowsHide: true, timeout: 120000 });
      const log = fs.readFileSync(path.join(prefix, 'self-test.log'), 'utf8');
      expect(log).toMatch(/self-test: \d+ passed, 0 failed/);
      expect(r.status).toBe(0);
      expect(log).not.toMatch(/^FAIL/m);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 180000);
});
