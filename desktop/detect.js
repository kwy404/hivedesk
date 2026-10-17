// Can this machine show the native window? And the decision: native window, browser window or nothing.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const WEBVIEW2_GUID = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
const WEBVIEW2_KEYS = [
  `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_GUID}`,
  `HKLM\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_GUID}`,
  `HKCU\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_GUID}`
];
const LIB_DIRS = ['/usr/lib', '/usr/lib64', '/usr/local/lib', '/lib', '/lib64',
  '/usr/lib/x86_64-linux-gnu', '/usr/lib/aarch64-linux-gnu', '/usr/lib/arm-linux-gnueabihf',
  '/lib/x86_64-linux-gnu', '/lib/aarch64-linux-gnu'];
const WEBKIT_LIBS = ['libwebkit2gtk-4.1.so.0', 'libwebkit2gtk-4.0.so.37'];

function defaultExec(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000, windowsHide: true });
}

/** The install command for WebKitGTK on this Linux distribution. */
export function webkitFix(osRelease = '') {
  const id = (osRelease.match(/^ID=(.*)$/m)?.[1] || '').replace(/"/g, '');
  const like = (osRelease.match(/^ID_LIKE=(.*)$/m)?.[1] || '').replace(/"/g, '');
  const all = `${id} ${like}`;
  if (/\b(debian|ubuntu)\b/.test(all)) return 'sudo apt install libwebkit2gtk-4.1-0';
  if (/\b(fedora|rhel|centos)\b/.test(all)) return 'sudo dnf install webkit2gtk4.1';
  if (/\barch\b/.test(all)) return 'sudo pacman -S webkit2gtk-4.1';
  if (/\b(suse|opensuse)\b/.test(all)) return 'sudo zypper install libwebkit2gtk-4_1-0';
  return 'install the WebKitGTK 4.1 package of your distribution (libwebkit2gtk-4.1)';
}

/**
 * Checks for the OS web view the native window needs.
 * @param {{ platform?: string, env?: object, exec?: (cmd: string, args: string[]) => string,
 *   exists?: (p: string) => boolean, readFile?: (p: string) => string }} [o]
 * @returns {{ ok: boolean, reason?: 'no_webview2' | 'no_webkitgtk' | 'no_display', fix?: string, version?: string }}
 */
export function checkWebview(o = {}) {
  const platform = o.platform || process.platform;
  const env = o.env || process.env;
  const exec = o.exec || defaultExec;
  const exists = o.exists || fs.existsSync;
  if (platform === 'win32') {
    for (const key of WEBVIEW2_KEYS) {
      try {
        const out = exec('reg', ['query', key, '/v', 'pv']);
        const v = out.match(/pv\s+REG_SZ\s+([\d.]+)/)?.[1];
        if (v && v !== '0.0.0.0') return { ok: true, version: v };
      } catch { /* key missing */ }
    }
    return { ok: false, reason: 'no_webview2', fix: 'winget install Microsoft.EdgeWebView2Runtime' };
  }
  if (platform === 'darwin') return { ok: true };
  if (platform === 'linux') {
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return { ok: false, reason: 'no_display' };
    let found = LIB_DIRS.some((d) => WEBKIT_LIBS.some((l) => exists(`${d}/${l}`)));
    if (!found) {
      try { found = WEBKIT_LIBS.some((l) => exec('ldconfig', ['-p']).includes(l)); } catch { /* no ldconfig */ }
    }
    if (found) return { ok: true };
    let rel = '';
    try { rel = (o.readFile || ((p) => fs.readFileSync(p, 'utf8')))('/etc/os-release'); } catch { /* unknown */ }
    return { ok: false, reason: 'no_webkitgtk', fix: webkitFix(rel) };
  }
  return { ok: false, reason: 'unsupported' };
}

/**
 * How to show hivedesk.
 * @param {{ args: { open?: boolean, browser?: boolean }, env?: object, key: string | null, webview?: { ok: boolean, reason?: string, fix?: string } }} o
 * @returns {{ mode: 'native' | 'browser' | 'none', reason?: string, fix?: string }}
 */
export function decideLaunch({ args, env = process.env, key, webview }) {
  if (args.open === false) return { mode: 'none', reason: 'no_open' };
  if (args.browser || env.HIVEDESK_BROWSER === '1') return { mode: 'browser', reason: 'forced' };
  if (!key) return { mode: 'browser', reason: 'unsupported' };
  if (webview && !webview.ok) return { mode: 'browser', reason: webview.reason || 'unsupported', fix: webview.fix };
  return { mode: 'native' };
}
