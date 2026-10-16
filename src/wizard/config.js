// ~/.hivedesk/config.json: the wizard answers, so later runs only ask "use the same setup?".
// An API key, when given, is kept here only, on this machine (file mode 600 where the OS supports it).
import fs from 'node:fs';
import path from 'node:path';

export function configPath(home) {
  return path.join(home, 'config.json');
}

export function loadConfig(home) {
  try {
    const c = JSON.parse(fs.readFileSync(configPath(home), 'utf8'));
    if (!c || typeof c !== 'object' || !c.brain || typeof c.dir !== 'string') return null;
    return c;
  } catch {
    return null;
  }
}

export function saveConfig(home, answers) {
  fs.mkdirSync(home, { recursive: true });
  const file = configPath(home);
  fs.writeFileSync(file, JSON.stringify({ ...answers, savedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* not supported on this file system */ }
  return file;
}
