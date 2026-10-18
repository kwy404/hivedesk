// Renders the shell's update panel and About card headlessly to PNG files, for review. Dev only (needs
// playwright-core and Edge or Chrome; nothing is shown on screen):
//   node desktop/scripts/shell-screens.mjs <out dir> [locale]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { findAppBrowser } from '../browser.js';
import { desktopStrings } from '../strings.js';
import { GALLERY } from '../profile/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.argv[2] || 'screens');
const locale = process.argv[3] || 'pt-BR';
fs.mkdirSync(out, { recursive: true });
const S = await desktopStrings(locale);
const L = (k) => S.t(`cli.desktop.${k}`);
const strings = {
  menu: L('shell.menu'), chooseFolder: L('shell.chooseFolder'), openFolder: L('tray.folder'), closeToTray: L('shell.closeToTray'),
  systemFrame: L('shell.systemFrame'), minimize: L('shell.minimize'), maximize: L('shell.maximize'), restore: L('shell.restore'),
  close: L('shell.close'), pause: L('tray.pause'), resume: L('tray.resume'), paused: L('shell.paused'),
  checkUpdates: L('shell.checkUpdates'), autoUpdate: L('shell.autoUpdate'), beta: L('shell.beta'), about: L('shell.about'),
  profile: Object.fromEntries(Object.entries(S.table).filter(([k]) => k.startsWith('cli.desktop.profile.')).map(([k, v]) => [k.slice(20), v])),
  update: Object.fromEntries(Object.entries(S.table).filter(([k]) => /^cli\.desktop\.(update|about)\./.test(k)).map(([k, v]) => [k.slice(12), v]))
};
const notes = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'release-notes', '1.0.0.json'), 'utf8'))[locale];
const base = { kind: 'versioned', autoUpdate: true, channel: 'stable', current: '1.0.0', version: '1.1.0', notes, when: null, snoozed: false, rolledBack: null };
const shots = {
  'update-available': { ...base, status: 'available', size: 44e6, got: 0 },
  'update-downloading': { ...base, status: 'downloading', size: 44e6, got: 17.6e6, speed: 6.2e6, eta: 5 },
  'update-ready': { ...base, status: 'ready', size: 44e6, got: 44e6 },
  'update-notice-npx': { ...base, kind: 'npx', status: 'notice', command: 'npx hivedesk@latest' },
  'update-rolled-back': { ...base, status: 'current', version: undefined, notes: undefined, rolledBack: '1.1.0' }
};
const html = fs.readFileSync(path.join(HERE, '..', 'shell.html'), 'utf8');
const exe = findAppBrowser();
if (!exe) throw new Error('needs Edge or Chrome');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hivedesk-shell-'));
const ctx = await chromium.launchPersistentContext(profile, { executablePath: exe, headless: true, args: ['--no-first-run'], viewport: { width: 1180, height: 720 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const backdrop = 'data:text/html,' + encodeURIComponent('<body style="margin:0;background:#0E0D0B;font:14px system-ui;color:#8C8172;display:grid;place-items:center;height:100vh">hivedesk</body>');
async function shot(name, update, after, profile = { needed: false }) {
  const cfg = { start: backdrop, platform: 'windows', native: true, strings, min: { width: 760, height: 520 }, state: { mode: 'native', platform: 'windows', native: true, closeToTray: true, frame: 'custom', paused: false, dir: 'C:/Users/me/hivedesk', dirName: 'hivedesk' }, version: '1.0.0', locale, update, profile };
  const body = html.replace('{{LANG}}', locale).replace('{{PLATFORM}}', 'windows').replace('{{CONFIG}}', JSON.stringify(cfg).replace(/</g, '\\u003c'));
  await page.route('**/*', (r) => (r.request().url().startsWith('http://shell.test/') ? r.fulfill({ contentType: 'text/html', body }) : r.fulfill({ status: 404, body: '{}' })));
  await page.goto('http://shell.test/');
  await page.waitForTimeout(400);
  if (after) await after();
  await page.waitForTimeout(300);
  const file = path.join(out, `${name}.png`);
  await page.screenshot({ path: file });
  await page.unroute('**/*');
  console.log(file);
}
for (const [name, u] of Object.entries(shots)) await shot(name, u);
await shot('first-run-profile', null, () => page.fill('#profName', 'Alexandre Kohler').then(() => page.click('#profGrid button:nth-child(3)')), { needed: true, gallery: GALLERY.avatars, nameMax: 32 });
await shot('about', { ...base, status: 'current', version: undefined, notes: undefined }, () => page.evaluate(() => document.getElementById('mAbout').click()));
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
