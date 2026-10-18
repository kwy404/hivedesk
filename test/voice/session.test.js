// Voice actions always ask first: the read back, a spoken or clicked yes, never an automatic yes.
// Question cards by voice, the wake word, engine choice and consent, Mel's speech queue and the
// conversation loop with barge in.
import { describe, it, expect, vi } from 'vitest';
import { createVoiceSession, findPeer, groupAddress } from '../../ui/js/voice/session.js';
import { parseIntent } from '../../ui/js/voice/intents.js';
import { matchWake } from '../../ui/js/voice/wake.js';
import { parseChoice, speakQuestion, toAnswer, spokenOrder } from '../../ui/js/voice/questions.js';
import { chooseStt, chooseTts, sttPlan } from '../../ui/js/voice/engines.js';
import { createSpeaker } from '../../ui/js/voice/speaker.js';
import { createConversation } from '../../ui/js/voice/conversation.js';
import { tr, blocks } from './helpers.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function setup(code = 'en', extra = {}) {
  const t = tr(code);
  const spoken = [];
  const actions = {
    createJob: vi.fn(async () => ({ jobId: 'j_1' })),
    approvals: vi.fn(() => [{ id: 'a_1', summary: 'run npm test' }]),
    resolveApproval: vi.fn(async () => ({})),
    status: vi.fn(() => 'status text'),
    openWindow: vi.fn(() => true),
    peers: vi.fn(async () => [{ peerId: 'hd1ana', name: 'Ana' }, { peerId: 'hd1bob', name: 'Bob Stone' }]),
    share: vi.fn(async () => ({})),
    connect: vi.fn(async () => ({})),
    answerQuestion: vi.fn(async () => ({})),
    reply: vi.fn(async (text, { onToken }) => { onToken('Sure. '); onToken('It works.'); return { kind: 'answer', text: 'Sure. It works.' }; }),
    end: vi.fn(),
    ...extra,
  };
  const session = createVoiceSession({ t, lang: () => code, speak: async (s) => { spoken.push(s); }, actions });
  return { t, spoken, actions, session };
}

describe('voice intents for the app', () => {
  const t = tr('en');
  it('reads the new commands', () => {
    expect(parseIntent('create a mobile app for my bakery', t, 'en')).toMatchObject({ kind: 'build' });
    expect(parseIntent('open the editor', t, 'en')).toMatchObject({ kind: 'open', window: 'editor' });
    expect(parseIntent('share my GPU with Ana', t, 'en')).toMatchObject({ kind: 'share', resource: 'gpu', person: 'ana' });
    expect(parseIntent('connect to 123 456 7890', t, 'en')).toMatchObject({ kind: 'connect', address: '1234567890' });
    expect(parseIntent('connect to 123 456', t, 'en').kind).not.toBe('connect');
    expect(parseIntent("that's all, thanks", t, 'en').kind).toBe('end');
  });
  it('in Portuguese too', () => {
    const p = tr('pt-BR');
    expect(parseIntent('compartilhe minha GPU com a Ana', p, 'pt-BR')).toMatchObject({ kind: 'share', resource: 'gpu' });
    expect(parseIntent('conectar ao 123 456 7890', p, 'pt-BR')).toMatchObject({ kind: 'connect', address: '1234567890' });
    expect(parseIntent('abra o editor', p, 'pt-BR')).toMatchObject({ kind: 'open', window: 'editor' });
    expect(parseIntent('é só isso, tchau', p, 'pt-BR').kind).toBe('end');
  });
});

describe('approval read back: write, run, share and connect need a yes', () => {
  it('"create a mobile app" is read back and starts only after yes', async () => {
    const v = setup();
    await v.session.hear('create a mobile app for my bakery');
    expect(v.session.pending?.kind).toBe('build');
    expect(v.spoken.at(-1)).toContain('create a mobile app for my bakery');
    expect(v.spoken.at(-1)).toMatch(/Should I go ahead/);
    expect(v.actions.createJob).not.toHaveBeenCalled();
    await v.session.hear('yes');
    expect(v.actions.createJob).toHaveBeenCalledWith('create a mobile app for my bakery');
  });

  it('share my GPU with Ana: the peer is found, read back, shared only after yes; no cancels', async () => {
    const v = setup();
    await v.session.hear('share my GPU with Ana');
    expect(v.session.pending?.kind).toBe('share');
    expect(v.spoken.at(-1)).toContain('your GPU with Ana');
    await v.session.hear('maybe later yes');
    expect(v.actions.share).not.toHaveBeenCalled();
    await v.session.hear('no');
    expect(v.actions.share).not.toHaveBeenCalled();
    expect(v.session.pending).toBe(null);
    await v.session.hear('share my GPU with Ana');
    await v.session.confirm(); // the card's Confirm button
    expect(v.actions.share).toHaveBeenCalledWith({ peerId: 'hd1ana', resource: 'gpu' });
  });

  it('connect to an address is read back grouped and needs a yes', async () => {
    const v = setup();
    await v.session.hear('connect to 123 456 7890');
    expect(v.session.pending?.summary).toContain('123 456 7890');
    expect(v.actions.connect).not.toHaveBeenCalled();
    await v.session.hear('yes please');
    expect(v.actions.connect).toHaveBeenCalledWith('1234567890');
  });

  it('a request found by the engine also waits for the yes; an answer streams and is never an action', async () => {
    const v = setup('en', { reply: vi.fn(async () => ({ kind: 'request', request: 'make the header blue' })) });
    await v.session.hear('could you turn the header to blue for me sometime');
    expect(v.session.pending?.kind).toBe('build');
    expect(v.actions.createJob).not.toHaveBeenCalled();
    const a = setup();
    const chunks = [];
    const s2 = createVoiceSession({ t: a.t, lang: () => 'en', speak: async () => {}, speakStream: () => ({ push: (x) => chunks.push(x), end: async () => {} }), actions: a.actions });
    await s2.hear('how does the preview work');
    expect(chunks.join('')).toBe('Sure. It works.');
    expect(s2.state.reply).toBe('Sure. It works.');
    expect(s2.pending).toBe(null);
  });

  it('unknown peers and missing features are said, not faked', async () => {
    const v = setup('en', { peers: vi.fn(async () => null) });
    await v.session.hear('share my GPU with Ana');
    expect(v.spoken.at(-1)).toMatch(/not available/);
    const w = setup();
    await w.session.hear('share my GPU with Zed');
    expect(w.spoken.at(-1)).toContain('Zed');
    expect(w.session.pending).toBe(null);
    expect(findPeer([{ name: 'Ana' }, { name: 'Ana Lima' }], 'share with ana lima', 'ana lima').peer.name).toBe('Ana Lima');
    expect(groupAddress('1234567890')).toBe('123 456 7890');
  });

  it('turn() resolves once Mel asks, so the loop can listen for the yes', async () => {
    const runIntent = vi.fn(async (text, { confirm }) => ({ ok: true, ran: await confirm({ title: 'Commit and push', steps: [{ text: 'git push' }] }) }));
    const v = setup('en', { runIntent });
    const how = await v.session.turn('commit and push to github');
    expect(how).toBe('asked');
    expect(v.session.pending?.kind).toBe('git');
    expect(await v.session.turn('yes')).toBe('done');
    expect(await runIntent.mock.results[0].value).toEqual({ ok: true, ran: true });
  });
});

describe('question cards by voice', () => {
  const card = {
    id: 'q_1',
    questions: [
      { id: 'style', text: 'Which style?', multi: false, options: [{ id: 'minimal', label: 'Minimal' }, { id: 'playful', label: 'Playful', recommended: true }, { id: 'corporate', label: 'Corporate' }] },
      { id: 'pages', text: 'Which pages?', multi: true, options: [{ id: 'home', label: 'Home', recommended: true }, { id: 'contact', label: 'Contact' }] },
    ],
  };
  const t = tr('en');

  it('reads the recommended option first', () => {
    expect(spokenOrder(card.questions[0]).map((o) => o.label)).toEqual(['Playful', 'Minimal', 'Corporate']);
    expect(speakQuestion(card.questions[0], t, 1, 2)).toMatch(/Question 1 of 2\. Which style\? 1, recommended: Playful\. 2: Minimal\./);
  });

  it('understands the second one, number 3, a label, both and decide for you', () => {
    const q = card.questions[0];
    expect(parseChoice('the second one', q, t, 'en')).toEqual({ kind: 'pick', indexes: [0] });
    expect(parseChoice('number 3', q, t, 'en')).toEqual({ kind: 'pick', indexes: [2] });
    expect(parseChoice('corporate please', q, t, 'en')).toEqual({ kind: 'pick', indexes: [2] });
    expect(parseChoice('the first', q, t, 'en')).toEqual({ kind: 'pick', indexes: [1] });
    expect(parseChoice('you decide', q, t, 'en')).toEqual({ kind: 'decide' });
    expect(parseChoice('both', card.questions[1], t, 'en')).toEqual({ kind: 'pick', indexes: [0, 1] });
    expect(parseChoice('minimal and corporate', q, t, 'en')).toBe(null); // one answer only
    expect(parseChoice('banana', q, t, 'en')).toBe(null);
    expect(parseChoice('a segunda', q, tr('pt-BR'), 'pt-BR')).toEqual({ kind: 'pick', indexes: [0] });
  });

  it('asks, confirms the choice back, and sends crew.answer after the yes', async () => {
    const v = setup();
    await v.session.question(card);
    expect(v.spoken.at(-1)).toMatch(/The crew has a question\. Question 1 of 2/);
    await v.session.turn('the second one');
    expect(v.spoken.at(-1)).toBe('You chose Minimal. Is that right?');
    await v.session.turn('no');
    expect(v.spoken.at(-1)).toMatch(/Which style/);
    await v.session.turn('number 1');
    await v.session.turn('yes');
    await tick();
    expect(v.spoken.at(-1)).toMatch(/Question 2 of 2/);
    await v.session.turn('both');
    await v.session.turn('yes');
    await tick();
    // The crew.answer contract of docs/1.0/DOMAINS.md: option ids per question.
    expect(v.actions.answerQuestion).toHaveBeenCalledWith({ questionId: 'q_1', answers: { style: { options: ['playful'] }, pages: { options: ['home', 'contact'] } } });
    expect(v.spoken.at(-1)).toMatch(/passed that on/);
  });

  it('decide for you leaves the card to the crew, and a single question left to Mel takes its recommended option', async () => {
    const v = setup();
    await v.session.question(card);
    await v.session.turn('decide for you');
    await v.session.turn('yes');
    await tick();
    expect(v.actions.answerQuestion).toHaveBeenCalledWith({ questionId: 'q_1', decide: true });
    expect(toAnswer(card, { style: { kind: 'pick', indexes: [2] } })).toEqual({ questionId: 'q_1', answers: { style: { options: ['corporate'] }, pages: { options: ['home'] } } });
  });

  it('a card answered on screen stops the voice question', async () => {
    const v = setup();
    await v.session.question(card);
    v.session.dropQuestion('q_1');
    expect(v.session.pending).toBe(null);
  });
});

describe('wake word', () => {
  it('hears "Mel" at the start and keeps the command after it', () => {
    const t = tr('en');
    expect(matchWake('Mel.', t, 'en')).toEqual({ hit: true, rest: '' });
    expect(matchWake('Hey Mel, open the files', t, 'en')).toEqual({ hit: true, rest: 'open the files' });
    expect(matchWake('I told Melissa about the melody', t, 'en').hit).toBe(false);
    expect(matchWake('we will talk about it later with mel', t, 'en').hit).toBe(false);
    expect(matchWake('Oi Mel, abra o editor', tr('pt-BR'), 'pt-BR')).toEqual({ hit: true, rest: 'abra o editor' });
    expect(matchWake('メル、ファイルを開いて', tr('ja'), 'ja').hit).toBe(true);
  });
});

describe('speech to text engine selection and consent', () => {
  it('local by default; the browser only after its own opt in', () => {
    expect(chooseStt({}, { localReady: true, browserAvailable: true })).toEqual({ engine: 'local', reason: null });
    expect(chooseStt({}, { localReady: false, browserAvailable: true })).toEqual({ engine: null, reason: 'needs_download' });
    expect(chooseStt({ engine: 'browser' }, { browserAvailable: true })).toEqual({ engine: null, reason: 'needs_browser_consent' });
    expect(chooseStt({ engine: 'browser', browserOk: true }, { browserAvailable: true })).toEqual({ engine: 'browser', reason: null });
    expect(chooseStt({ engine: 'browser', browserOk: true }, { browserAvailable: false }).reason).toBe('browser_unsupported');
  });
  it('the voice: Piper only when installed for the language', () => {
    expect(chooseTts({ tts: 'piper' }, { piperReady: ['en'], lang: 'en', systemAvailable: true })).toBe('piper');
    expect(chooseTts({ tts: 'piper' }, { piperReady: ['en'], lang: 'ja', systemAvailable: true })).toBe('system');
    expect(chooseTts({}, { systemAvailable: false })).toBe('none');
  });
  it('the consent plan lists only the missing files with their sizes', () => {
    const status = { stt: { recommended: { model: 'base', runtime: 'rt' }, runtime: null, models: [{ id: 'base', bytes: 100, installed: false }, { id: 'tiny', bytes: 50, installed: true }], runtimes: [{ id: 'rt', bytes: 9, installed: false }] } };
    const plan = sttPlan(status);
    expect(plan.files.map((f) => f.id)).toEqual(['base', 'rt']);
    expect(plan.bytes).toBe(109);
    expect(sttPlan(status, { model: 'tiny' }).files.map((f) => f.id)).toEqual(['rt']);
    expect(sttPlan({ stt: { recommended: { model: 'tiny' }, runtime: null, models: [{ id: 'tiny', bytes: 1 }], runtimes: [] } }).needsSystem).toBe(true);
  });
});

/** A speechSynthesis stand in: each utterance ends after `ms`, cancel ends it at once. */
function fakeSynth(ms = 20) {
  const said = [];
  let cur = null;
  let timer = null;
  return {
    said,
    speak(u) { said.push(u.text); cur = u; timer = setTimeout(() => { cur = null; u.onend?.(); }, ms); },
    cancel() { clearTimeout(timer); const u = cur; cur = null; u?.onerror?.(); },
  };
}
class FakeUtterance { constructor(text) { this.text = text; } }

describe("Mel's speech queue", () => {
  it('speaks streamed sentences in order and stops at once', async () => {
    const synth = fakeSynth(15);
    const events = [];
    const sp = createSpeaker({ engine: () => 'system', synth, Utterance: FakeUtterance, onStart: () => events.push('start'), onIdle: () => events.push('idle') });
    const s = sp.stream();
    s.push('First sentence here. Second one ');
    s.push('is here too. And');
    const ended = s.end();
    await tick(5);
    expect(sp.busy).toBe(true);
    await ended;
    expect(synth.said).toEqual(['First sentence here.', 'Second one is here too.', 'And']);
    expect(events).toEqual(['start', 'idle']);
    const long = sp.say('A long answer that would take a while to say.');
    sp.say('Another one.');
    await tick(2);
    sp.stop();
    await long;
    expect(sp.busy).toBe(false);
    expect(synth.said.at(-1)).toBe('A long answer that would take a while to say.');
  });
});

describe('conversation loop with barge in', () => {
  function loop({ stt = async () => 'why is the sky so blue', speakMs = 200, handsFree = true } = {}) {
    const synth = fakeSynth(speakMs);
    let conv;
    const speaker = createSpeaker({ engine: () => 'system', synth, Utterance: FakeUtterance, onStart: () => conv.speakStart(), onIdle: () => conv.speakEnd() });
    const v = setup('en', { reply: vi.fn(async (text, { onToken }) => { onToken('The crew is free. Tell me what to build.'); return { kind: 'answer', text: 'The crew is free. Tell me what to build.' }; }) });
    const session = createVoiceSession({ t: v.t, lang: () => 'en', speak: (s) => speaker.say(s), speakStream: () => speaker.stream(), actions: v.actions });
    const cancelReply = vi.fn();
    const mic = { start: vi.fn(async () => {}), stop: vi.fn(), setMuted: vi.fn() };
    const states = [];
    conv = createConversation({ mic, stt: vi.fn(stt), session, speaker, cancelReply, prefs: () => ({ handsFree, wake: false }), onState: (s) => states.push(s), followupMs: 5000 });
    const talk = (ms, amp) => { for (const b of blocks(ms, amp)) conv.frame(b); };
    return { conv, synth, speaker, session, cancelReply, mic, states, talk, v };
  }

  it('listens, answers out loud, and listens again for the follow up', async () => {
    const l = loop();
    l.conv.open();
    l.talk(400, 0);
    l.talk(500, 0.2);
    l.talk(900, 0);
    expect(l.conv.state).toBe('transcribing');
    await tick(10);
    expect(['thinking', 'speaking']).toContain(l.conv.state);
    await tick(600);
    expect(l.conv.state).toBe('listening');
    expect(l.synth.said.join(' ')).toBe('The crew is free. Tell me what to build.');
    expect(l.mic.stop).not.toHaveBeenCalled();
  });

  it('barge in: the user talks over Mel, she stops at once, the answer is cancelled and the new turn is heard', async () => {
    const l = loop({ speakMs: 2000 });
    l.conv.open();
    l.talk(400, 0);
    l.talk(500, 0.2);
    l.talk(900, 0);
    await tick(30);
    expect(l.conv.state).toBe('speaking');
    l.talk(400, 0.4);
    expect(l.conv.state).toBe('hearing');
    expect(l.speaker.busy).toBe(false);
    expect(l.cancelReply).toHaveBeenCalled();
    expect(l.synth.said.length).toBe(1); // the second sentence never started
  });

  it('a pause that was not the end: both parts become one turn, nothing is cut or sent twice', async () => {
    const parts = ['why is the sky', 'so blue today'];
    let i = 0;
    const l = loop({ stt: () => new Promise((res) => { const text = parts[i++]; setTimeout(() => res(text), 60); }) });
    l.conv.open();
    l.talk(400, 0);
    l.talk(500, 0.2);
    l.talk(900, 0);
    expect(l.conv.state).toBe('transcribing');
    l.talk(400, 0.2); // talks on before the first part is written down
    expect(l.conv.state).toBe('hearing');
    l.talk(900, 0);
    await tick(200);
    expect(l.session.state.heard).toBe('why is the sky so blue today');
    expect(l.v.actions.reply).toHaveBeenCalledTimes(1);
  });

  it('a tap ends the conversation and turns the mic off', async () => {
    const l = loop();
    l.conv.open();
    l.conv.close();
    expect(l.conv.state).toBe('off');
    expect(l.mic.stop).toHaveBeenCalled();
  });

  it('saying "that is all" ends it', async () => {
    const l = loop({ stt: async () => 'that is all' });
    l.v.actions.end.mockImplementation(() => l.conv.close());
    l.conv.open();
    l.talk(400, 0);
    l.talk(500, 0.2);
    l.talk(900, 0);
    await tick(400);
    expect(l.conv.state).toBe('off');
  });
});
