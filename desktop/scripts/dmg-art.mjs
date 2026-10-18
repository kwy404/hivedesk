// Renders desktop/installer/macos/background.html into background.png (660x440) and background@2x.png for
// the DMG window. Dev only (needs playwright-core and Edge or Chrome, headless): node desktop/scripts/dmg-art.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { findAppBrowser } from '../browser.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(HERE, '..', 'installer', 'macos');
const exe = findAppBrowser();
if (!exe) throw new Error('needs Edge or Chrome to render the DMG background');
const browser = await chromium.launch({ executablePath: exe, headless: true });
try {
  const html = fs.readFileSync(path.join(DIR, 'background.html'), 'utf8');
  for (const [scale, name] of [[1, 'background.png'], [2, 'background@2x.png']]) {
    const ctx = await browser.newContext({ viewport: { width: 660, height: 440 }, deviceScaleFactor: scale });
    const page = await ctx.newPage();
    await page.setContent(html);
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(DIR, name) });
    console.log(path.join(DIR, name));
    await ctx.close();
  }
} finally {
  await browser.close();
}
