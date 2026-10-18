// Copied from ui/phone/core/invite.js by scripts/phone-page.mjs. Edit the source, then run the script.
// The one time invite the desktop shows as a QR code (docs/1.0/protocol/phone.md section 2).
// It travels in the URL fragment of the public page, which a browser never sends to the web server:
//   https://kwy404.github.io/hivedesk/remote/#p=<base64url( 0x01 || secret[32] || hostPin[12] )>
// From the secret (256 random bits) HKDF gives three independent values:
//   topic   16 bytes, the meeting point on the public relays ("hivedesk/p1/<topic>")
//   seal    32 bytes, the AES-GCM key that seals the relay messages (offer and answer)
//   psk     32 bytes, mixed into the handshake key; only the desktop and the phone hold it
// hostPin is the start of the hash of the desktop's phone key, so the phone checks that it talks to
// the computer whose screen it scanned. The desktop keeps the invite 5 minutes and burns it on the
// first handshake that names its topic.

import { b64u, fromB64u, hkdf, PhoneCryptoError, concatBytes } from './crypto.js';

export const PAGE_URL = 'https://kwy404.github.io/hivedesk/remote/';
export const INVITE_VERSION = 1;
export const INVITE_MS = 5 * 60_000;
export const SECRET_BYTES = 32;
export const PIN_BYTES = 12;

/** The QR payload and the link it encodes. */
export function inviteLink(secret, pin, base = PAGE_URL) {
  if (secret.length !== SECRET_BYTES || pin.length !== PIN_BYTES) throw new PhoneCryptoError('bad_invite', 'bad invite parts');
  return `${base}#p=${b64u(concatBytes([Uint8Array.of(INVITE_VERSION), secret, pin]))}`;
}

/** Reads #p=... from a location hash. Returns { secret, pin } or null when there is no invite. Throws on a broken one. */
export function readInviteHash(hash) {
  const m = /(?:^#|&)p=([A-Za-z0-9_-]{1,200})(?:&|$)/.exec(String(hash || ''));
  if (!m) return null;
  const raw = fromB64u(m[1], 1 + SECRET_BYTES + PIN_BYTES);
  if (raw[0] !== INVITE_VERSION) throw new PhoneCryptoError('bad_invite', 'this QR code is from another version of hivedesk');
  return { secret: raw.slice(1, 1 + SECRET_BYTES), pin: raw.slice(1 + SECRET_BYTES) };
}

/** { topicId, topic, seal, psk } for a secret. Both sides get the same values. */
export async function deriveInvite(secret) {
  const topicBytes = await hkdf(secret, '', 'hivedesk phone v1 topic', 16);
  const topicId = b64u(topicBytes);
  return {
    topicId,
    topic: `hivedesk/p1/${topicId}`,
    seal: await hkdf(secret, '', 'hivedesk phone v1 seal', 32),
    psk: await hkdf(secret, '', 'hivedesk phone v1 psk', 32)
  };
}

/** The relay topic where a desktop waits for its known phones: public, derived from its phone key. */
export async function homeTopic(hostPublicRaw) {
  return `hivedesk/p1/h${b64u(await hkdf(hostPublicRaw, '', 'hivedesk phone v1 home topic', 16))}`;
}

/** The AES-GCM key one known phone uses on the home topic, from the secret both kept at pairing. */
export async function homeSeal(reconnectSecret) {
  return hkdf(reconnectSecret, '', 'hivedesk phone v1 home seal', 32);
}
