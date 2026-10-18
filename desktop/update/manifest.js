// The update manifest (latest.json) of a release and its Ed25519 signature (latest.json.sig).
//
// The signature covers the exact bytes of latest.json, prefixed with a fixed context string so the key can
// sign nothing else by accident. The app embeds the public key (desktop/update/pubkey.js); CI signs with the
// private key from the HIVEDESK_UPDATE_KEY secret (desktop/scripts/manifest.mjs). See desktop/RELEASE.md.
import crypto from 'node:crypto';
import { parseVersion, CHANNELS } from './version.js';

export const SIGN_CONTEXT = 'hivedesk-update-manifest-v1\n';
export const MANIFEST_NAME = 'latest.json';
export const SIGNATURE_NAME = 'latest.json.sig';
export const LOCALES = Object.freeze(['en', 'pt-BR', 'es', 'fr', 'de', 'it', 'ja', 'ko', 'zh-CN', 'ru']);
/** The app packages the updater installs, by install kind. */
export const ASSETS = Object.freeze({
  'windows-x64': 'hivedesk-windows-x64.zip',
  'macos-universal': 'hivedesk-macos-universal.zip',
  'linux-x64': 'hivedesk-linux-x64.tar.gz',
  'linux-x64-appimage': 'hivedesk-linux-x86_64.AppImage'
});

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

/** A public key object from the raw 32 byte key in base64, or from a PEM. */
export function publicKeyFrom(key) {
  if (key && typeof key === 'object' && key.type === 'public') return key;
  const s = String(key || '').trim();
  if (s.startsWith('-----BEGIN')) return crypto.createPublicKey(s);
  const raw = Buffer.from(s, 'base64');
  if (raw.length !== 32) throw fail('bad_key', 'the update public key must be 32 bytes');
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: 'der', type: 'spki' });
}

/** The raw public key (base64) of a private key PEM. */
export function rawPublicKey(privatePem) {
  const pub = crypto.createPublicKey(crypto.createPrivateKey(privatePem));
  return pub.export({ format: 'der', type: 'spki' }).subarray(SPKI_ED25519.length).toString('base64');
}

const signedBytes = (bytes) => Buffer.concat([Buffer.from(SIGN_CONTEXT, 'utf8'), Buffer.from(bytes)]);

/** @returns {string} the base64 signature of the manifest bytes */
export function signManifest(bytes, privatePem) {
  const key = crypto.createPrivateKey(privatePem);
  if (key.asymmetricKeyType !== 'ed25519') throw fail('bad_key', 'the update key must be an Ed25519 private key');
  return crypto.sign(null, signedBytes(bytes), key).toString('base64');
}

/** Checks the shape of a parsed manifest; throws code 'bad_manifest'. */
export function validateManifest(m) {
  const bad = (why) => { throw fail('bad_manifest', `latest.json: ${why}`); };
  if (!m || typeof m !== 'object' || Array.isArray(m)) bad('not an object');
  if (m.product !== 'hivedesk') bad('wrong product');
  if (m.schema !== 1) bad('unknown schema');
  if (!parseVersion(m.version)) bad('bad version');
  if (!CHANNELS.includes(m.channel)) bad('bad channel');
  if (typeof m.date !== 'string' || Number.isNaN(Date.parse(m.date))) bad('bad date');
  if (!m.notes || typeof m.notes !== 'object' || typeof m.notes.en !== 'string') bad('notes need at least English');
  for (const [k, v] of Object.entries(m.notes)) if (!LOCALES.includes(k) || typeof v !== 'string' || v.length > 8000) bad(`bad notes for ${k}`);
  if (!m.assets || typeof m.assets !== 'object') bad('no assets');
  for (const [k, a] of Object.entries(m.assets)) {
    if (!(k in ASSETS)) bad(`unknown asset ${k}`);
    if (!a || typeof a.url !== 'string' || !/^https:\/\/github\.com\/kwy404\/hivedesk\/releases\/download\/[^/?#]+\/[^/?#]+$/.test(a.url)) bad(`asset ${k}: url outside the hivedesk releases`);
    if (!Number.isSafeInteger(a.size) || a.size <= 0) bad(`asset ${k}: bad size`);
    if (typeof a.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(a.sha256)) bad(`asset ${k}: bad sha256`);
  }
  return m;
}

/**
 * Verifies the signature, then parses and validates the manifest.
 * @param {Buffer | string} bytes the latest.json bytes as downloaded
 * @param {string} signature base64 (the content of latest.json.sig)
 * @param {string | crypto.KeyObject} publicKey
 */
export function verifyManifest(bytes, signature, publicKey) {
  const sig = Buffer.from(String(signature || '').trim(), 'base64');
  if (sig.length !== 64) throw fail('bad_signature', 'the update manifest signature is missing or malformed');
  let ok = false;
  try { ok = crypto.verify(null, signedBytes(bytes), publicKeyFrom(publicKey), sig); } catch { ok = false; }
  if (!ok) throw fail('bad_signature', 'the update manifest signature does not match');
  let m;
  try { m = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { throw fail('bad_manifest', 'latest.json is not JSON'); }
  return validateManifest(m);
}

/**
 * Builds the manifest of a release.
 * @param {{ version: string, date?: string, notes: Record<string, string>, tag?: string,
 *   files: Record<string, { size: number, sha256: string }> }} o files by file name
 */
export function buildManifest(o) {
  const tag = o.tag || `v${o.version}`;
  const assets = {};
  for (const [key, file] of Object.entries(ASSETS)) {
    const f = o.files[file];
    if (!f) continue;
    assets[key] = { file, url: `https://github.com/kwy404/hivedesk/releases/download/${tag}/${file}`, size: f.size, sha256: f.sha256 };
  }
  const notes = {};
  for (const l of LOCALES) if (typeof o.notes?.[l] === 'string') notes[l] = o.notes[l];
  const m = {
    product: 'hivedesk', schema: 1, version: o.version,
    channel: (parseVersion(o.version)?.pre.length ? 'beta' : 'stable'),
    date: o.date || new Date().toISOString(), notes, assets
  };
  return validateManifest(m);
}

/** The notes in a locale, then its language, then English. */
export function notesFor(m, locale) {
  const n = m?.notes || {};
  if (n[locale]) return n[locale];
  const lang = String(locale || '').split('-')[0];
  const k = Object.keys(n).find((x) => x.split('-')[0] === lang);
  return (k && n[k]) || n.en || '';
}
