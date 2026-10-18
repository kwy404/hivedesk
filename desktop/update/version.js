// Version numbers of hivedesk releases: semantic versions (1.0.0, 1.1.0-beta.2) and the update channels.

const RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** @returns {{ major: number, minor: number, patch: number, pre: (string | number)[] } | null} */
export function parseVersion(v) {
  const m = RE.exec(String(v || '').trim());
  if (!m) return null;
  const pre = m[4] ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [];
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre };
}

/** -1, 0 or 1, by the semantic versioning rules (a pre-release sorts before its release). Invalid sorts lowest. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] > y[k] ? 1 : -1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === 'number' && typeof q === 'number') return p > q ? 1 : -1;
    if (typeof p === 'number') return -1;
    if (typeof q === 'number') return 1;
    return p > q ? 1 : -1;
  }
  return 0;
}

export const isNewer = (candidate, current) => compareVersions(candidate, current) > 0;
export const isPrerelease = (v) => (parseVersion(v)?.pre.length || 0) > 0;

export const CHANNELS = Object.freeze(['stable', 'beta']);

/** True when a version may be offered on a channel: stable gets releases only, beta gets both. */
export function fitsChannel(version, channel) {
  if (!parseVersion(version)) return false;
  return channel === 'beta' ? true : !isPrerelease(version);
}
