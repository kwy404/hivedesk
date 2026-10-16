// Adapted from howlden (MIT, Alexandre Kohler), app/core/rtc.js and app/core/crypto.js, with the
// STUN order from filefinch (Cloudflare first, then Google).
// One RTCPeerConnection between the friend who lends and the host who borrows, with a single
// pre-negotiated data channel for the lend frames (frames.js). No audio, video or files.
//
// The offer and the answer wait for ICE gathering to finish (no trickle), so each one fits in a
// single sealed message on the rendezvous relays.

export const STUN_SERVERS = ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];

/** ICE servers: Cloudflare STUN, then Google STUN. No TURN server is built in. */
export function buildIceServers() {
  return [{ urls: STUN_SERVERS }];
}

/** The DTLS certificate fingerprints announced in an SDP, normalized. */
export function sdpFingerprints(sdp) {
  const out = [];
  for (const line of String(sdp || '').split(/\r?\n/)) {
    const m = /^a=fingerprint:(\S+)\s+([0-9A-Fa-f:]+)/.exec(line.trim());
    if (m) out.push(`${m[1].toLowerCase()} ${m[2].toUpperCase()}`);
  }
  return [...new Set(out)];
}

/** Count candidate types in an SDP. */
export function candidateTypes(sdp) {
  const out = { host: 0, srflx: 0, relay: 0, prflx: 0 };
  for (const m of String(sdp || '').matchAll(/^a=candidate:.* typ (host|srflx|relay|prflx)/gm)) out[m[1]]++;
  return out;
}

/** Why a connection did not open, as a key the UI explains: 'offline', 'blocked', 'no-stun' or 'strict-nat'. */
export function diagnose({ localSdp, remoteSdp, online = true }) {
  if (!online) return 'offline';
  const local = candidateTypes(localSdp);
  const remote = candidateTypes(remoteSdp);
  if (!local.srflx && !local.relay) return local.host ? 'no-stun' : 'blocked';
  if (!remote.srflx && !remote.relay && !remote.host) return 'blocked';
  return 'strict-nat';
}

const DC_LEND = 0;

export class RtcLink {
  constructor({ iceServers = buildIceServers(), gatherTimeout = 6000, RTCPeerConnection: PC = globalThis.RTCPeerConnection } = {}) {
    if (!PC) throw new Error('This browser has no WebRTC');
    this.pc = new PC({ iceServers, bundlePolicy: 'max-bundle' });
    this.gatherTimeout = gatherTimeout;
    this.open = false;
    this.closed = false;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onfail = null;
    this.onstate = null;

    this.dc = this.pc.createDataChannel('lend', { negotiated: true, id: DC_LEND, ordered: true });
    this.dc.onopen = () => {
      if (this.open || this.closed) return;
      this.open = true;
      clearTimeout(this.openTimer);
      this.onopen?.();
    };
    this.dc.onmessage = (e) => this.onmessage?.(e.data);
    this.dc.onclose = () => this._end('closed');

    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      this.onstate?.(s);
      if (s === 'failed') this._end('failed');
      else if (s === 'disconnected') {
        clearTimeout(this.lostTimer);
        this.lostTimer = setTimeout(() => {
          if (this.pc.connectionState !== 'connected') this._end('failed');
        }, 12000);
      } else if (s === 'connected') clearTimeout(this.lostTimer);
    };
  }

  async _gather() {
    const pc = this.pc;
    if (pc.iceGatheringState === 'complete') return;
    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      };
      const check = () => pc.iceGatheringState === 'complete' && done();
      const timer = setTimeout(done, this.gatherTimeout);
      pc.addEventListener('icegatheringstatechange', check);
    });
  }

  /** Create the offer and wait for every ICE candidate. */
  offer() {
    this._offering ??= (async () => {
      await this.pc.setLocalDescription(await this.pc.createOffer());
      await this._gather();
      return this.pc.localDescription.sdp;
    })();
    return this._offering;
  }

  /** Answer an offer and wait for every ICE candidate. Idempotent for a repeated offer. */
  answer(sdp) {
    this._answering ??= (async () => {
      await this.pc.setRemoteDescription({ type: 'offer', sdp });
      await this.pc.setLocalDescription(await this.pc.createAnswer());
      await this._gather();
      this._watchOpen();
      return this.pc.localDescription.sdp;
    })();
    return this._answering;
  }

  /** Apply the answer to the offer. A second answer is ignored and resolves false. */
  async complete(sdp) {
    if (this.answered || this.closed || this.pc.signalingState !== 'have-local-offer') return false;
    this.answered = true;
    try {
      await this.pc.setRemoteDescription({ type: 'answer', sdp });
    } catch (err) {
      this.answered = false;
      throw err;
    }
    this._watchOpen();
    return true;
  }

  _watchOpen(ms = 25000) {
    clearTimeout(this.openTimer);
    this.openTimer = setTimeout(() => {
      if (!this.open && !this.closed) this.onfail?.('timeout');
    }, ms);
  }

  send(text) {
    if (this.dc.readyState !== 'open') throw new Error('link is not open');
    this.dc.send(text);
  }

  /** Both DTLS fingerprints of this connection: [local, remote]. */
  fingerprints() {
    return [sdpFingerprints(this.pc.localDescription?.sdp)[0] || '', sdpFingerprints(this.pc.remoteDescription?.sdp)[0] || ''];
  }

  diagnose(online) {
    return diagnose({ localSdp: this.pc.localDescription?.sdp, remoteSdp: this.pc.remoteDescription?.sdp, online });
  }

  _end(reason) {
    if (this.closed) return;
    const wasOpen = this.open;
    this.closed = true;
    this.open = false;
    clearTimeout(this.openTimer);
    clearTimeout(this.lostTimer);
    try {
      this.pc.close();
    } catch {
      // already closed
    }
    if (wasOpen) this.onclose?.(reason);
    else this.onfail?.(reason);
  }

  close() {
    this._end('closed');
  }
}
