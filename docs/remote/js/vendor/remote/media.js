// Copied from ui/remote/media.js by scripts/phone-page.mjs. Edit the source, then run the script.
// WebRTC video between the host window and the viewer window (docs/1.0/PLAN.md section 12.2): one track
// per shared screen. The SDP and the ICE candidates travel through the two engines inside the encrypted
// p2p session (remote.signal, stream 3). After connecting, each side checks that the DTLS certificate the
// other window really uses is the one announced in that authenticated SDP, so the media is bound to the peer.

import { buildIceServers, sdpFingerprints } from '../lend/core/rtc.js';
import { nextBitrate, readStats, START_BPS, framerateFor } from './abr.js';

const ABR_MS = 2000;
const MAX_TRACKS = 4;

/** The remote certificate fingerprint actually used by the DTLS transport, as "sha-256 AA:BB:...", or null. */
export async function usedFingerprint(pc) {
  const report = await pc.getStats();
  const all = [...report.values()];
  const transport = all.find((s) => s.type === 'transport' && s.remoteCertificateId);
  const cert = transport && report.get(transport.remoteCertificateId);
  if (!cert?.fingerprint || !cert.fingerprintAlgorithm) return null;
  return `${String(cert.fingerprintAlgorithm).toLowerCase()} ${String(cert.fingerprint).toUpperCase()}`;
}

export class MediaLink {
  /**
   * @param {{ role: 'host' | 'viewer', signal: (s: object) => Promise<any>, onTracks?: (streams: MediaStream[]) => void,
   *   onState?: (state: string, detail?: string) => void, RTCPeerConnection?: any }} o
   */
  constructor(o) {
    const PC = o.RTCPeerConnection || globalThis.RTCPeerConnection;
    if (!PC) throw new Error('no WebRTC in this window');
    this.role = o.role;
    this.signalOut = o.signal;
    this.onTracks = o.onTracks || (() => {});
    this.onState = o.onState || (() => {});
    this.pc = new PC({ iceServers: buildIceServers(), bundlePolicy: 'max-bundle' });
    this.remoteSdp = null;
    this.pendingIce = [];
    this.senders = [];
    this.streams = [];
    this.bitrate = START_BPS;
    this.preset = 'auto';
    this.verified = false;
    this.closed = false;
    this.pc.onicecandidate = (e) => { this.signalOut({ kind: 'ice', candidate: e.candidate ? e.candidate.toJSON() : null }).catch(() => {}); };
    this.pc.ontrack = (e) => {
      const s = e.streams[0] || new MediaStream([e.track]);
      if (!this.streams.includes(s) && this.streams.length < MAX_TRACKS) this.streams.push(s);
      e.track.addEventListener('ended', () => { this.streams = this.streams.filter((x) => x.getVideoTracks().some((t) => t.readyState === 'live')); this.onTracks(this.streams.slice()); });
      this.onTracks(this.streams.slice());
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      this.onState(s);
      if (s === 'connected' && !this.verified) this._verify();
      if (s === 'failed') this.close('failed');
    };
  }

  async _verify() {
    try {
      const used = await usedFingerprint(this.pc);
      const announced = sdpFingerprints(this.remoteSdp);
      if (!used || !announced.includes(used)) { this.onState('rejected', 'fingerprint'); this.close('fingerprint'); return; }
      this.verified = true;
      this.onState('verified');
      if (this.role === 'host') this._abrLoop();
    } catch { this.onState('rejected', 'fingerprint'); this.close('fingerprint'); }
  }

  async _offer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this.signalOut({ kind: 'offer', sdp: this.pc.localDescription.sdp });
  }

  /** Host: send a captured screen as a new track (index = this.senders.length). */
  async share(stream) {
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error('no video track');
    if (this.senders.length >= MAX_TRACKS) throw new Error('at most four screens');
    try { track.contentHint = 'detail'; } catch { /* old engines */ }
    const tr = this.pc.addTransceiver(track, { direction: 'sendonly', streams: [stream], sendEncodings: [{ maxBitrate: START_BPS, maxFramerate: framerateFor(START_BPS) }] });
    this.senders.push(tr.sender);
    await this._params(tr.sender, nextBitrate({ current: this.bitrate, preset: this.preset }));
    await this._offer();
    return this.senders.length - 1;
  }

  /** Host: show another screen in place of track `index`, with no renegotiation. */
  async replace(index, stream) {
    const sender = this.senders[index];
    const track = stream.getVideoTracks()[0];
    if (!sender || !track) throw new Error('no such shared screen');
    try { track.contentHint = 'detail'; } catch { /* old engines */ }
    await sender.replaceTrack(track);
  }

  /** Host: stop sending track `index`. */
  async remove(index) {
    const sender = this.senders[index];
    if (!sender) return;
    try { this.pc.removeTrack(sender); } catch { /* gone */ }
    this.senders.splice(index, 1);
    await this._offer();
  }

  /** Host: pause sends nothing (the track is disabled, so the viewer sees a still frame or black). */
  setPaused(on) {
    for (const s of this.senders) if (s.track) s.track.enabled = !on;
  }

  setPreset(preset) {
    this.preset = preset || 'auto';
    const p = nextBitrate({ current: this.bitrate, preset: this.preset });
    this.bitrate = p.maxBitrate;
    for (const s of this.senders) this._params(s, p);
  }

  async _params(sender, { maxBitrate, maxFramerate, scale = 1, degradation = 'maintain-resolution' }) {
    const p = sender.getParameters();
    if (!p.encodings?.length) p.encodings = [{}];
    p.encodings[0].maxBitrate = maxBitrate;
    p.encodings[0].maxFramerate = maxFramerate;
    p.encodings[0].scaleResolutionDownBy = scale;
    p.degradationPreference = degradation;
    try { await sender.setParameters(p); } catch { /* applied on the next round */ }
  }

  _abrLoop() {
    clearInterval(this.abrTimer);
    this.abrTimer = setInterval(async () => {
      if (this.closed || !this.senders.length) return;
      try {
        const s = readStats(await this.pc.getStats());
        const next = nextBitrate({ current: this.bitrate, available: s.available, loss: s.loss, preset: this.preset });
        if (Math.abs(next.maxBitrate - this.bitrate) / this.bitrate > 0.05) {
          this.bitrate = next.maxBitrate;
          for (const snd of this.senders) await this._params(snd, next);
        }
        this.onState('stats', `${Math.round(next.maxBitrate / 1000)} kbps, ${s.fps != null ? Math.round(s.fps) : next.maxFramerate} fps`);
      } catch { /* stats unavailable this round */ }
    }, ABR_MS);
  }

  /** A signaling message from the other window, through the engines. */
  async handle(sig) {
    if (this.closed || !sig) return;
    if (sig.kind === 'offer' && this.role === 'viewer') {
      this.remoteSdp = sig.sdp;
      await this.pc.setRemoteDescription({ type: 'offer', sdp: sig.sdp });
      await this._drainIce();
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      await this.signalOut({ kind: 'answer', sdp: this.pc.localDescription.sdp });
    } else if (sig.kind === 'answer' && this.role === 'host') {
      this.remoteSdp = sig.sdp;
      await this.pc.setRemoteDescription({ type: 'answer', sdp: sig.sdp });
      await this._drainIce();
    } else if (sig.kind === 'ice') {
      if (!this.pc.remoteDescription) { this.pendingIce.push(sig.candidate); return; }
      await this._addIce(sig.candidate);
    }
  }

  async _drainIce() {
    const list = this.pendingIce.splice(0);
    for (const c of list) await this._addIce(c);
  }

  async _addIce(c) {
    try { await this.pc.addIceCandidate(c || null); } catch { /* a stale candidate */ }
  }

  close(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.abrTimer);
    try { this.pc.close(); } catch { /* closed */ }
    this.onState('closed', reason);
  }
}
