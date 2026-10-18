// How this copy of hivedesk was installed, which decides how it updates itself.
//
//   versioned  the Windows installer and the Linux install script: <root>/current.txt names the folder in
//              <root>/versions/ that the root launcher starts. An update is a new folder plus a new pointer.
//   mac-app    hivedesk.app (from the DMG): the bundle is replaced, the old one kept until the new one is healthy.
//   appimage   the AppImage file is replaced the same way.
//   package    the .deb or .rpm: the system package manager updates it, the app shows the command.
//   portable   a zip or tar.gz unpacked by hand: the app links to the download.
//   npx        npx hivedesk: the app shows npx hivedesk@latest.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DESKTOP_DIR = path.resolve(HERE, '..');

export const POINTER = 'current.txt';
export const VERSIONS = 'versions';

/**
 * @param {{ desktopDir?: string, env?: object, platform?: string, home: string }} o
 * @returns {{ kind: 'versioned' | 'mac-app' | 'appimage' | 'package' | 'portable' | 'npx', asset: string | null,
 *   root?: string, bundle?: string, appimage?: string, stateFile: string, manager?: 'apt' | 'dnf' | null }}
 */
export function detectInstall(o) {
  const env = o.env || process.env;
  const platform = o.platform || process.platform;
  const desktopDir = path.resolve(o.desktopDir || DESKTOP_DIR);
  const appDir = path.dirname(desktopDir);
  const pkgRoot = path.dirname(appDir);
  const homeState = path.join(o.home, 'update', 'state.json');
  const asset = platform === 'win32' ? 'windows-x64' : platform === 'darwin' ? 'macos-universal' : 'linux-x64';
  if (platform === 'linux' && env.APPIMAGE && fs.existsSync(env.APPIMAGE)) {
    return { kind: 'appimage', asset: 'linux-x64-appimage', appimage: path.resolve(env.APPIMAGE), stateFile: homeState };
  }
  const versionsDir = path.dirname(pkgRoot);
  const root = path.dirname(versionsDir);
  if (path.basename(versionsDir) === VERSIONS && fs.existsSync(path.join(root, POINTER)) && path.basename(appDir) === 'app') {
    return { kind: 'versioned', asset: platform === 'darwin' ? null : asset, root, stateFile: path.join(root, 'update-state.json') };
  }
  const mac = /^(.*\.app)[\\/]Contents[\\/]Resources[\\/]app$/.exec(appDir);
  if (mac) return { kind: 'mac-app', asset: 'macos-universal', bundle: mac[1], stateFile: homeState };
  if (platform === 'linux' && ['/opt/hivedesk', '/usr/lib/hivedesk'].includes(pkgRoot.split(path.sep).join('/').replace(/^[A-Za-z]:/, ''))) {
    const manager = fs.existsSync('/usr/bin/dpkg') ? 'apt' : fs.existsSync('/usr/bin/rpm') ? 'dnf' : null;
    return { kind: 'package', asset: null, root: pkgRoot, manager, stateFile: homeState };
  }
  if (env.HIVEDESK_DESKTOP === '1' && path.basename(appDir) === 'app') return { kind: 'portable', asset: null, root: pkgRoot, stateFile: homeState };
  return { kind: 'npx', asset: null, stateFile: homeState };
}

/** True when this install kind can download and apply an update by itself. */
export const canSelfUpdate = (install) => ['versioned', 'mac-app', 'appimage'].includes(install.kind) && !!install.asset;
