// Renders desktop/icons/*.svg into the PNG, ICO and ICNS files the desktop app and the packages use.
// Dev only (needs playwright-core and Edge or Chrome): node desktop/scripts/icons.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { findAppBrowser } from '../browser.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ICONS = path.resolve(HERE, '..', 'icons');
const RES = path.resolve(HERE, '..', 'app', 'resources', 'icons');

const exe = findAppBrowser();
if (!exe) throw new Error('needs Edge or Chrome to render the icons');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hivedesk-icons-'));
const ctx = await chromium.launchPersistentContext(profile, { executablePath: exe, headless: true, args: ['--no-first-run'] });
const page = await ctx.newPage();

async function render(svgFile, size) {
  const svg = fs.readFileSync(path.join(ICONS, svgFile), 'utf8');
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${size}" height="${size}" style="display:block"></body></html>`);
  await page.waitForFunction(() => document.images[0].complete);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

const app = {};
for (const s of [16, 24, 32, 48, 64, 128, 256, 512]) app[s] = await render('icon.svg', s);
const tray = { 16: await render('tray.svg', 16), 32: await render('tray.svg', 32), 64: await render('tray.svg', 64) };
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });

fs.mkdirSync(RES, { recursive: true });
fs.writeFileSync(path.join(RES, 'appIcon.png'), app[256]);
fs.writeFileSync(path.join(RES, 'trayIcon.png'), tray[32]);
fs.writeFileSync(path.join(RES, 'trayIcon@2x.png'), tray[64]);
fs.writeFileSync(path.join(ICONS, 'icon-512.png'), app[512]);

// ICO with PNG entries (Windows Vista and later read them).
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const head = Buffer.alloc(6 + 16 * icoSizes.length);
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(icoSizes.length, 4);
let offset = head.length;
icoSizes.forEach((s, i) => {
  const at = 6 + 16 * i;
  head.writeUInt8(s >= 256 ? 0 : s, at); head.writeUInt8(s >= 256 ? 0 : s, at + 1);
  head.writeUInt16LE(1, at + 4); head.writeUInt16LE(32, at + 6);
  head.writeUInt32LE(app[s].length, at + 8); head.writeUInt32LE(offset, at + 12);
  offset += app[s].length;
});
fs.writeFileSync(path.join(ICONS, 'hivedesk.ico'), Buffer.concat([head, ...icoSizes.map((s) => app[s])]));

// ICNS with PNG entries.
const types = [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512]];
const parts = types.map(([t, s]) => {
  const h = Buffer.alloc(8);
  h.write(t, 0, 'ascii'); h.writeUInt32BE(app[s].length + 8, 4);
  return Buffer.concat([h, app[s]]);
});
const total = 8 + parts.reduce((n, p) => n + p.length, 0);
const ih = Buffer.alloc(8);
ih.write('icns', 0, 'ascii'); ih.writeUInt32BE(total, 4);
fs.writeFileSync(path.join(ICONS, 'hivedesk.icns'), Buffer.concat([ih, ...parts]));
console.log('icons: written to desktop/icons and desktop/app/resources/icons');
