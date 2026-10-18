// Small WAV helpers for the voice endpoints: check what the window sends (16 bit PCM, mono, 16 kHz,
// a size limit) and wrap raw PCM from Piper into a WAV the window can play.

export const STT_RATE = 16000;
/** The longest turn the endpoint takes: 30 seconds of 16 kHz, 16 bit mono, plus the header. */
export const MAX_STT_BYTES = STT_RATE * 2 * 30 + 44;

export class WavError extends Error {
  constructor(message) { super(message); this.code = 'bad_request'; }
}

/**
 * Reads the format of a WAV buffer and checks it is what whisper.cpp gets from us.
 * @param {Buffer} buf
 * @returns {{ rate: number, channels: number, bits: number, dataOffset: number, dataBytes: number, seconds: number }}
 */
export function readWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) throw new WavError('the audio is not a WAV file');
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new WavError('the audio is not a WAV file');
  let off = 12;
  let fmt = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > buf.length) throw new WavError('the WAV header is broken');
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      if (!fmt) throw new WavError('the WAV header is broken');
      if (fmt.format !== 1 || fmt.bits !== 16) throw new WavError('the audio must be 16 bit PCM');
      if (fmt.channels !== 1) throw new WavError('the audio must be mono');
      if (fmt.rate !== STT_RATE) throw new WavError('the audio must be 16 kHz');
      const dataBytes = Math.min(size, buf.length - body);
      return { rate: fmt.rate, channels: 1, bits: 16, dataOffset: body, dataBytes, seconds: dataBytes / (fmt.rate * 2) };
    }
    off = body + size + (size % 2);
  }
  throw new WavError('the WAV file has no audio data');
}

/** A WAV file around raw 16 bit mono PCM. */
export function pcmToWav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
