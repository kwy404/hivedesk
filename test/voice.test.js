// Voice mode with a mocked SpeechRecognition: transcript in, intent out, a confirmation is
// required, and the action runs only after a clear "sim" (or "yes").
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { translator } from '../i18n/index.js';
import { createListener } from '../ui/js/voice/listener.js';
import { createVoiceSession } from '../ui/js/voice/session.js';
import { parseIntent, yesNo } from '../ui/js/voice/intents.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'i18n');
const en = JSON.parse(fs.readFileSync(path.join(DIR, 'en.json'), 'utf8'));
const table = (code) => (code === 'en' ? en : JSON.parse(fs.readFileSync(path.join(DIR, `${code}.json`), 'utf8')));

/** A SpeechRecognition stand in: say(text) emits interim then final results, like a browser. */
class MockRecognition {
  static last = null;
  constructor() { MockRecognition.last = this; this.started = false; }
  start() { this.started = true; queueMicrotask(() => this.onstart?.()); }
  stop() { this.started = false; queueMicrotask(() => this.onend?.()); }
  abort() { this.stop(); }
  say(text) {
    const words = text.split(' ');
    const half = words.slice(0, Math.ceil(words.length / 2)).join(' ');
    this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: half }], { isFinal: false })] });
    this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: true })] });
    this.stop();
  }
}

function setup(code) {
  const t = translator(code, table(code), en);
  const actions = {
    createJob: vi.fn(async () => ({ jobId: 'j_1' })),
    approvals: vi.fn(() => [{ id: 'a_1', summary: 'run npm test', tool: 'run' }]),
    resolveApproval: vi.fn(async () => ({})),
    status: vi.fn(() => 'status text'),
    openWindow: vi.fn(() => true),
    runIntent: vi.fn(async (text, { confirm }) => { const yes = await confirm({ id: 'p1', title: 'Commit and push', steps: [{ text: 'git commit' }, { text: 'git push' }] }); return { ok: true, ran: yes }; }),
  };
  const spoken = [];
  const session = createVoiceSession({ t, lang: () => code, speak: (s) => { spoken.push(s); }, actions });
  const finals = [];
  const listener = createListener(MockRecognition, { lang: code, onFinal: (text) => finals.push(session.hear(text)) });
  const say = async (text) => {
    listener.start();
    await new Promise((r) => queueMicrotask(r));
    MockRecognition.last.say(text);
    await new Promise((r) => setTimeout(r, 0));
    await finals.at(-1);
  };
  return { t, actions, session, spoken, say, finals };
}

describe('voice intents', () => {
  const t = translator('pt-BR', table('pt-BR'), en);
  it('reads intents from Portuguese speech', () => {
    expect(parseIntent('o que a equipe está fazendo?', t, 'pt-BR').kind).toBe('status');
    expect(parseIntent('crie uma landing page para uma padaria', t, 'pt-BR').kind).toBe('build');
    expect(parseIntent('faça commit e push no github', t, 'pt-BR').kind).toBe('git');
  });
  it('accepts only a short, clear yes', () => {
    expect(yesNo('sim', t, 'pt-BR')).toBe('yes');
    expect(yesNo('Sim, por favor.', t, 'pt-BR')).toBe('yes');
    expect(yesNo('confirmar', t, 'pt-BR')).toBe('yes');
    expect(yesNo('não', t, 'pt-BR')).toBe('no');
    expect(yesNo('sim, mas antes me diga como está o projeto', t, 'pt-BR')).toBe(null);
    expect(yesNo('acho que sim talvez amanhã', t, 'pt-BR')).toBe(null);
  });
});

describe('voice session with a mocked SpeechRecognition', () => {
  it('transcript in, build intent out, confirmation required, runs after "sim"', async () => {
    const v = setup('pt-BR');
    await v.say('crie uma landing page para uma padaria');
    expect(v.actions.createJob).not.toHaveBeenCalled();
    expect(v.session.pending?.kind).toBe('build');
    expect(v.spoken.at(-1)).toContain('landing page para uma padaria');
    // unrelated speech that contains a yes does not run it
    await v.say('sim, mas antes me diga como está o projeto');
    expect(v.actions.createJob).not.toHaveBeenCalled();
    expect(v.session.pending?.kind).toBe('build');
    await v.say('sim');
    await new Promise((r) => setTimeout(r, 0));
    expect(v.actions.createJob).toHaveBeenCalledWith('crie uma landing page para uma padaria');
    expect(v.session.pending).toBe(null);
  });

  it('a "não" cancels and nothing runs', async () => {
    const v = setup('pt-BR');
    await v.say('aprovar o passo');
    expect(v.session.pending?.kind).toBe('approve');
    await v.say('não');
    expect(v.actions.resolveApproval).not.toHaveBeenCalled();
    expect(v.session.pending).toBe(null);
  });

  it('approves the waiting step only after the confirmation', async () => {
    const v = setup('en');
    await v.say('approve it');
    expect(v.actions.resolveApproval).not.toHaveBeenCalled();
    await v.say('yes please');
    await new Promise((r) => setTimeout(r, 0));
    expect(v.actions.resolveApproval).toHaveBeenCalledWith('a_1', true);
  });

  it('answers status questions without asking', async () => {
    const v = setup('pt-BR');
    await v.say('o que a equipe está fazendo?');
    expect(v.actions.status).toHaveBeenCalled();
    expect(v.spoken.at(-1)).toBe('status text');
    expect(v.session.pending).toBe(null);
  });

  it('git goes through runIntent and its confirm, and runs after "sim"', async () => {
    const v = setup('pt-BR');
    const first = v.say('faça commit e push no github');
    await new Promise((r) => setTimeout(r, 5));
    expect(v.session.pending?.kind).toBe('git');
    expect(v.session.pending?.details).toEqual(['git commit', 'git push']);
    await v.say('sim');
    await first;
    expect(v.actions.runIntent).toHaveBeenCalled();
    expect(await v.actions.runIntent.mock.results[0].value).toEqual({ ok: true, ran: true });
  });
});
