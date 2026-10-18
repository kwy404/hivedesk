// Voice activity detection, end of turn, the recorder with pre roll, WAV and sentence splitting.
import { describe, it, expect } from 'vitest';
import { createVad, levelDb } from '../../ui/js/voice/vad.js';
import { resample, encodeWav, createRecorder } from '../../ui/js/voice/audio.js';
import { createChunker, sentencesOf, speakable } from '../../ui/js/voice/sentences.js';
import { readWav, pcmToWav } from '../../src/voice/wav.js';
import { blocks } from './helpers.js';

const feed = (vad, list) => list.map((b) => vad.push(b)).filter(Boolean);

describe('voice activity detection', () => {
  it('finds the start of speech and the end of the turn after a pause', () => {
    const vad = createVad();
    expect(feed(vad, blocks(600))).toEqual([]);
    expect(feed(vad, blocks(400, 0.2))).toEqual(['start']);
    // a short breath inside the sentence is not the end
    expect(feed(vad, [...blocks(300), ...blocks(300, 0.2)])).toEqual([]);
    expect(feed(vad, blocks(900))).toEqual(['end']);
    expect(vad.speaking).toBe(false);
  });

  it('a click is not speech', () => {
    const vad = createVad();
    feed(vad, blocks(400));
    expect(feed(vad, [...blocks(40, 0.3), ...blocks(400)])).toEqual([]);
  });

  it('while Mel speaks, quiet leakage does not barge in but a clear voice does', () => {
    const vad = createVad();
    feed(vad, blocks(600));
    vad.setBargeIn(true);
    expect(feed(vad, blocks(600, 0.01))).toEqual([]);
    expect(feed(vad, blocks(400, 0.3))).toEqual(['start']);
  });

  it('stops a turn that runs too long', () => {
    const vad = createVad({ maxTurnMs: 1000 });
    feed(vad, blocks(400));
    // talking on after the cut starts the next turn
    expect(feed(vad, blocks(1400, 0.2))).toEqual(['start', 'max', 'start']);
  });

  it('levels in dBFS', () => {
    expect(levelDb(new Float32Array(10))).toBe(-100);
    expect(Math.round(levelDb(Float32Array.from({ length: 100 }, () => 0.5)))).toBe(-6);
  });
});

describe('audio for speech to text', () => {
  it('resamples 48 kHz to 16 kHz and writes a WAV the engine accepts', () => {
    const src = Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i / 10));
    const out = resample(src, 48000);
    expect(out.length).toBe(1600);
    const wav = encodeWav(out);
    const info = readWav(Buffer.from(wav));
    expect(info).toMatchObject({ rate: 16000, channels: 1, bits: 16 });
    expect(info.seconds).toBeCloseTo(0.1, 3);
  });

  it('the engine refuses audio it cannot use', () => {
    expect(() => readWav(Buffer.from('hello'))).toThrow(/WAV/);
    const wrongRate = Buffer.from(encodeWav(new Float32Array(100), 44100));
    expect(() => readWav(wrongRate)).toThrow(/16 kHz/);
    expect(readWav(pcmToWav(Buffer.alloc(320), 16000)).dataBytes).toBe(320);
  });

  it('the recorder keeps the pre roll so the first syllable is not cut', () => {
    const rec = createRecorder({ preRollMs: 100 });
    for (const b of blocks(500)) rec.push(b);
    rec.begin();
    for (const b of blocks(200, 0.2)) rec.push(b);
    const turn = rec.end();
    expect(turn.length).toBeGreaterThanOrEqual(1600 + 3200);
    expect(turn.length).toBeLessThanOrEqual(1600 + 320 + 3200);
  });
});

describe('sentences of a streamed answer', () => {
  it('speaks each sentence as soon as it is complete', () => {
    const got = [];
    const c = createChunker((s) => got.push(s));
    for (const tok of ['The crew ', 'is building ', 'your page. ', 'Lia writes the CSS', ' now! And ', 'Kai tests it']) c.push(tok);
    expect(got).toEqual(['The crew is building your page.', 'Lia writes the CSS now!']);
    c.flush();
    expect(got.at(-1)).toBe('And Kai tests it');
  });

  it('does not cut numbers, and splits Chinese and Japanese without spaces', () => {
    expect(sentencesOf('Version 3.5 is out. It is faster than before.')).toEqual(['Version 3.5 is out.', 'It is faster than before.']);
    expect(sentencesOf('团队正在工作。马上就好！')).toEqual(['团队正在工作。', '马上就好！']);
  });

  it('removes Markdown and links before speaking', () => {
    expect(speakable('**Done**, see https://example.com and `index.html`')).toBe('Done , see and index.html');
  });
});
