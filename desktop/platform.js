import path from 'node:path';

// Which desktop runtime binary fits this OS and CPU, and where it comes from.
// The runtime is Neutralinojs (MIT), a small native shell around the OS web view. See desktop/README.md.

export const RUNTIME = Object.freeze({
  name: 'neutralinojs',
  version: '5.6.0',
  // The upstream release zip (all platforms), used only when the project release asset is missing.
  zip: {
    url: 'https://github.com/neutralinojs/neutralinojs/releases/download/v5.6.0/neutralinojs-v5.6.0.zip',
    sha256: 'fec85fc330a678c4c31e31ad3296104eda58a8e425393a5dd478234a661895af',
    bytes: 5101931
  },
  license: 'https://raw.githubusercontent.com/neutralinojs/neutralinojs/v5.6.0/LICENSE'
});

const BIN = {
  win_x64: { file: 'neutralino-win_x64.exe', sha256: 'aea3c3208a7e3f9623bfc380bf4c82124b4195e9b15adb2a429ce5917caa04c4', bytes: 2671616 },
  mac_x64: { file: 'neutralino-mac_x64', sha256: '317ac4326b49cad381736fc610adc3c0dd06b7a8ec39866ae8c0f1941db42c2f', bytes: 2249752 },
  mac_arm64: { file: 'neutralino-mac_arm64', sha256: '7f4b3a1510a1173b51b2e2190bb27e00354aecf527e6f279b1b4198a611fbd42', bytes: 2230312 },
  mac_universal: { file: 'neutralino-mac_universal', sha256: 'a351016221370e68a7263546ff59681fa2d744eac3765f147b9eef5e3d6880d5', bytes: 4507688 },
  linux_x64: { file: 'neutralino-linux_x64', sha256: '5d6776a03654eda86f1539af5468abafde7a38407c451acfa91268ee0334ca9e', bytes: 1728800 },
  linux_arm64: { file: 'neutralino-linux_arm64', sha256: 'e9181b8797f83e6389d0046cfce761f2a3e715a992b06b95ab3d42dc59820a56', bytes: 1798472 },
  linux_armhf: { file: 'neutralino-linux_armhf', sha256: '3d32c8eaa4ed97b3a4ed13e68c34e48cf4c21dc9bd4c6e358374f51a7efe2df5', bytes: 1423944 }
};
export const BINARIES = Object.freeze(BIN);

/**
 * Platform keys hivedesk knows. Windows on ARM runs the x64 build through the OS x64 emulation.
 * @type {Record<string, { os: 'windows' | 'macos' | 'linux', arch: string, bin: keyof typeof BIN, emulated?: boolean }>}
 */
export const TARGETS = Object.freeze({
  'win-x64': { os: 'windows', arch: 'x64', bin: 'win_x64' },
  'win-arm64': { os: 'windows', arch: 'arm64', bin: 'win_x64', emulated: true },
  'mac-x64': { os: 'macos', arch: 'x64', bin: 'mac_x64' },
  'mac-arm64': { os: 'macos', arch: 'arm64', bin: 'mac_arm64' },
  'linux-x64': { os: 'linux', arch: 'x64', bin: 'linux_x64' },
  'linux-arm64': { os: 'linux', arch: 'arm64', bin: 'linux_arm64' },
  'linux-arm': { os: 'linux', arch: 'arm', bin: 'linux_armhf' }
});

/** "win-x64", "mac-arm64", "linux-x64"... or null when no runtime build exists for it. */
export function platformKey(platform = process.platform, arch = process.arch) {
  const os = { win32: 'win', darwin: 'mac', linux: 'linux' }[platform];
  if (!os) return null;
  const key = `${os}-${arch}`;
  return TARGETS[key] ? key : null;
}

/** Everything about one platform key: the binary, its checksum, its size and its download sources. */
export function target(key, { appVersion = '0.0.0' } = {}) {
  const t = TARGETS[key];
  if (!t) return null;
  const bin = BIN[t.bin];
  const ext = t.os === 'windows' ? '.exe' : '';
  const asset = `hivedesk-runtime-${t.bin.replace('_', '-')}${ext}`;
  return {
    key, ...t, ...bin,
    asset,
    // 1. the binary alone, attached to the hivedesk GitHub release by .github/workflows/desktop.yml
    // 2. the upstream zip, then the one file is taken out of it
    sources: [
      { kind: 'file', url: `https://github.com/kwy404/hivedesk/releases/download/v${appVersion}/${asset}` },
      { kind: 'zip', url: RUNTIME.zip.url, sha256: RUNTIME.zip.sha256, bytes: RUNTIME.zip.bytes, entry: bin.file }
    ],
    localName: `hivedesk-runtime${ext}`
  };
}

/** The cache folder: ~/.hivedesk/runtime/desktop-<runtime version>/ (next to the model runtime). */
export function cacheDir(home) {
  return path.join(home, 'runtime', `desktop-${RUNTIME.version}`);
}
