import { describe, it, expect } from 'vitest';
import { classifyDomain } from '../../src/crew/domains/classify.js';
import {
  buildQuestions, validateCard, normalizeAnswers, decideForMe, decisionsText, decisionsLine, domainFromAnswers, matchSpoken, subjectOf,
  applyReword, QUESTION_SETS, TOPIC_ORDER, MAX_QUESTIONS
} from '../../src/crew/domains/questions.js';
import { answerQuestion, openQuestions, cardText } from '../../src/crew/domains/flow.js';
import { waitFor } from '../helpers.js';
import { rig, eventsOf } from './rig.js';

const cardFor = (text, lang = 'en') => buildQuestions({ text, cls: classifyDomain(text), lang });
const topics = (text) => (cardFor(text)?.questions || []).map((q) => q.topic);

/** Golden examples: request in, the topics Mel asks about out (in impact order). */
const GOLDEN = [
  ['I want an app', ['platform']],
  ['make an app to track my workouts', ['platform', 'data']],
  ['an app for my team to share tasks', ['platform', 'data', 'auth']],
  ['crie um sistema para meus clientes agendarem horarios', ['platform', 'data', 'auth']],
  ['crie um app de receitas para celular', ['data']],
  ['create a REST API for a todo list', ['data', 'auth']],
  ['crie uma api de pedidos com sqlite e chave de api', []],
  ['make a platformer game', ['controls', 'players']],
  ['um jogo da velha para dois jogadores no teclado', []],
  ['build a browser extension that hides ads on youtube.com', []],
  ['crie um site para minha padaria', []],
  ['escreva um Dockerfile para meu servico node', ['ci']]
];

describe('when Mel asks', () => {
  for (const [text, want] of GOLDEN) {
    it(`"${text}" asks about ${want.length ? want.join(', ') : 'nothing'}`, () => {
      expect(topics(text)).toEqual(want);
    });
  }

  it('never asks what the request already says, and says what it inferred', () => {
    const card = cardFor('crie uma api de pedidos com sqlite e chave de api');
    expect(card.questions).toEqual([]);
    expect(card.inferred).toEqual([{ question: 'backend.data', option: 'sqlfile' }, { question: 'backend.auth', option: 'key' }]);
    expect(card.defaults).toMatch(/node:test/);
  });

  it('a question uses the request words, the recommended option is first with a reason tied to the context', () => {
    const card = cardFor('an app for my team to share tasks');
    expect(card.questions[0].text).toMatch(/the app for my team/);
    expect(validateCard(card, 'an app for my team to share tasks')).toEqual([]);
    for (const q of card.questions) {
      expect(q.options[0].recommended).toBe(true);
      expect(q.options[0].reason.length).toBeGreaterThan(5);
      expect(q.options.slice(1).some((o) => o.recommended)).toBe(false);
    }
    // Shared by a team: the server and accounts are recommended, not the device.
    expect(card.questions.find((q) => q.topic === 'data').options[0].id).toBe('server');
    expect(card.questions.find((q) => q.topic === 'auth').options[0].id).toBe('accounts');
    expect(cardFor('make an app to track my workouts').questions.find((q) => q.topic === 'data').options[0].id).toBe('device');
  });

  it('the subject is the request own name for the thing', () => {
    expect(subjectOf('Build me a recipe app that works on phones')).toMatch(/^the recipe app/);
    expect(subjectOf('crie um app de receitas para celular', 'pt-BR')).toBe('app de receitas');
    expect(subjectOf('hello', 'en')).toBe('the project');
  });

  it('every curated question follows the rules in every set', () => {
    for (const [set, list] of Object.entries(QUESTION_SETS)) {
      for (const q of list) {
        expect(TOPIC_ORDER, `${set}.${q.id}`).toContain(q.topic);
        expect(q.options.length, q.id).toBeGreaterThanOrEqual(2);
        expect(q.options.length, q.id).toBeLessThanOrEqual(q.id === 'platform' ? 7 : 5);
        for (const o of q.options) {
          expect(o.label.split(' ').length, o.label).toBeLessThanOrEqual(5);
          expect(o.desc.length, o.id).toBeGreaterThan(20);
          expect(o.reason.length, o.id).toBeGreaterThan(5);
        }
      }
    }
  });
});

describe('the guards', () => {
  const good = () => cardFor('create a REST API for a todo list');
  const request = 'create a REST API for a todo list';

  it('reject generic questions, bad labels, a wrong recommendation and a wrong order', () => {
    const generic = good();
    generic.questions[0] = { ...generic.questions[0], text: 'Any preferences for the REST API?' };
    expect(validateCard(generic, request).join(';')).toMatch(/generic/);
    const longLabel = good();
    longLabel.questions[0].options[1] = { ...longLabel.questions[0].options[1], label: 'a very long label with too many words' };
    expect(validateCard(longLabel, request).join(';')).toMatch(/1 to 5 words/);
    const rec = good();
    rec.questions[0].options = [rec.questions[0].options[1], rec.questions[0].options[0], ...rec.questions[0].options.slice(2)];
    expect(validateCard(rec, request).join(';')).toMatch(/recommended/);
    const order = good();
    order.questions.reverse();
    expect(validateCard(order, request).join(';')).toMatch(/ordered by impact/);
    const many = good();
    many.questions = [...many.questions, ...many.questions, ...many.questions].map((q, i) => ({ ...q, id: `${q.id}.${i}` }));
    expect(many.questions.length).toBeGreaterThan(MAX_QUESTIONS);
    expect(validateCard(many, request)).toEqual([`1 to ${MAX_QUESTIONS} questions`]);
    const one = good();
    one.questions[0].options = one.questions[0].options.slice(0, 1);
    expect(validateCard(one, request).join(';')).toMatch(/2 to 5 options/);
  });

  it('a model rewording is kept only where it follows the rules', () => {
    const card = good();
    const r = applyReword(card, { questions: [
      { id: 'backend.data', text: 'Where should the todo list API keep the todos?', options: [{ id: 'json', description: 'x' }, { id: 'memory', description: 'Quick for a demo of the todo list; all todos are lost when it restarts.' }] },
      { id: 'backend.auth', text: 'Anything else?', options: [] }
    ] }, request);
    expect(r.questions[0].text).toBe('Where should the todo list API keep the todos?');
    expect(r.questions[0].options.find((o) => o.id === 'json').description).toBe(card.questions[0].options.find((o) => o.id === 'json').description);
    expect(r.questions[0].options.find((o) => o.id === 'memory').description).toMatch(/lost when it restarts/);
    expect(r.questions[1].text).toBe(card.questions[1].text);
    expect(validateCard(r, request)).toEqual([]);
  });

  it('answers are checked: known options, one for single choice, Other text, decide for me', () => {
    const card = good();
    expect(normalizeAnswers(card, { 'backend.data': 'sqlfile', 'backend.auth': { options: ['key'] } }).problems).toEqual([]);
    expect(normalizeAnswers(card, { 'backend.data': { options: ['nope'] }, 'backend.auth': ['key'] }).problems.join(';')).toMatch(/unknown option nope/);
    expect(normalizeAnswers(card, { 'backend.data': ['json', 'memory'], 'backend.auth': ['key'] }).problems.join(';')).toMatch(/only one option/);
    expect(normalizeAnswers(card, { 'backend.data': { other: 'a CSV file per day' }, 'backend.auth': ['open'] }).problems).toEqual([]);
    expect(normalizeAnswers(card, { 'backend.data': ['json'] }).problems.join(';')).toMatch(/backend.auth: no answer/);
    const auto = decideForMe(card);
    expect(auto).toEqual({ 'backend.data': { options: ['sqlfile'] }, 'backend.auth': { options: ['key'] } });
    const text = decisionsText(card, auto);
    expect(text).toMatch(/^Decisions made with the user:/);
    expect(text).toMatch(/Embedded SQL file/);
    expect(text).toMatch(/Defaults: JSON over HTTP/);
    expect(decisionsLine(card, auto)).toBe('Embedded SQL file; Apps with an API key');
  });

  it('the platform answer picks the domain', () => {
    const card = cardFor('I want an app');
    expect(domainFromAnswers(card, { platform: { options: ['mobile'] } })).toBe('mobile');
    expect(cardText('en', card)).toMatch(/1\) Website \[Recommended: /);
  });

  it('spoken answers: ordinals, labels, distinctive words and "decide for me", in English and Portuguese', () => {
    const q = cardFor('I want an app').questions[0];
    expect(matchSpoken(q, 'the second one')).toEqual({ options: ['mobile'] });
    expect(matchSpoken(q, 'a segunda')).toEqual({ options: ['mobile'] });
    expect(matchSpoken(q, '3')).toEqual({ options: ['desktop'] });
    expect(matchSpoken(q, 'desktop app please')).toEqual({ options: ['desktop'] });
    expect(matchSpoken(q, 'backend')).toEqual({ options: ['backend'] });
    expect(matchSpoken(q, 'voce decide')).toMatchObject({ options: ['web'], decide: true });
    expect(matchSpoken(q, 'banana')).toBe(null);
  });
});

describe('the question card in a job', () => {
  it('asks before the brief, waits, merges the answers into the brief and the plan, and starts as a mobile app', async () => {
    const t = rig();
    const { jobId, done } = t.hive.createJob({ request: 'Build me a recipe app that works on phones' });
    const q = await waitFor(() => eventsOf(t.bus, 'crew.question')[0]);
    // The event contract the desktop and the voice orb read.
    expect(q.jobId).toBe(jobId);
    expect(q.data.id).toMatch(/^q_/);
    expect(q.data.questions[0]).toMatchObject({ id: 'mobile.data', topic: 'data', multi: false });
    expect(q.data.questions[0].options[0]).toMatchObject({ id: 'device', recommended: true });
    expect(q.data.labels.decide).toBe('Decide for me');
    expect(q.data.defaults).toMatch(/Android and iOS/);
    expect(openQuestions(t.hive).map((c) => c.id)).toEqual([q.data.id]);
    const line = t.bus.events.find((e) => e.type === 'chat.message' && e.data.i18n?.key === 'domains.ask.card');
    expect(line.data.text).toMatch(/1\) On the phone \[Recommended/);
    expect(eventsOf(t.bus, 'job.refining')).toEqual([]);
    expect(() => answerQuestion(t.hive, q.data.id, { answers: { 'mobile.data': { options: ['nope'] } } })).toThrow(/unknown option/);
    answerQuestion(t.hive, q.data.id, { answers: { 'mobile.data': { options: ['server'] } } });
    const answered = await waitFor(() => eventsOf(t.bus, 'crew.answered')[0]);
    expect(answered.data).toMatchObject({ id: q.data.id, answers: { 'mobile.data': { options: ['server'] } }, decided: false, summary: 'Synced through a server' });
    await waitFor(() => t.hive.active.get(jobId)?.briefWaiter);
    expect(t.seen.brief).toMatch(/Decisions made with the user:[\s\S]*Synced through a server/);
    t.hive.approveBrief(jobId, { use: 'refined' });
    await done;
    const dom = eventsOf(t.bus, 'job.domain')[0];
    expect(dom.data).toMatchObject({ domain: 'mobile', specialist: 'mobile', confidence: 'high' });
    expect(dom.data.text).toMatch(/^Mobile app: /);
    expect(dom.data.honest).toMatch(/Android Studio or Xcode/);
    expect(t.bus.state.crew.some((w) => w.id === 'mobile')).toBe(true);
    expect(t.ws.exists('capacitor.config.json')).toBe(true);
    expect(t.ws.exists('www/sw.js')).toBe(true);
    expect(t.seen.plan).toMatch(/mobile app skeleton/);
    expect(t.seen.plan).toMatch(/Synced through a server/);
    const planned = eventsOf(t.bus, 'job.planned')[0].data.tasks;
    expect(planned[0].assignee).toBe('mobile');
    expect(t.seen.report).toMatch(/Decisions made with the user/);
    expect(openQuestions(t.hive)).toEqual([]);
  }, 30000);

  it('"Decide for me" takes the recommended options, a cancel ends the wait, and no card when the brief step is off', async () => {
    const t = rig();
    const a = t.hive.createJob({ request: 'make an app to track my workouts' });
    const q = await waitFor(() => eventsOf(t.bus, 'crew.question')[0]);
    expect(q.data.questions.map((x) => x.topic)).toEqual(['platform', 'data']);
    answerQuestion(t.hive, q.data.id, { decide: true });
    const answered = await waitFor(() => eventsOf(t.bus, 'crew.answered')[0]);
    expect(answered.data.decided).toBe(true);
    expect(answered.data.answers).toEqual({ platform: { options: ['web'] }, 'any.data': { options: ['device'] } });
    await waitFor(() => t.hive.active.get(a.jobId)?.briefWaiter);
    t.hive.cancelJob(a.jobId);
    await a.done;

    const b = t.hive.createJob({ request: 'I want an app' });
    await waitFor(() => eventsOf(t.bus, 'crew.question').length === 2);
    t.hive.cancelJob(b.jobId);
    await b.done;
    expect(t.hive.questions.size).toBe(0);
    expect(() => answerQuestion(t.hive, eventsOf(t.bus, 'crew.question')[1].data.id, { decide: true })).toThrow(/no longer open/);

    const off = rig({ refine: false });
    await off.hive.createJob({ request: 'I want an app' }).done;
    expect(eventsOf(off.bus, 'crew.question')).toEqual([]);
  }, 30000);

  it('the demo and tests answer by themselves with the recommended options', async () => {
    const t = rig({ autoApproveBriefMs: 5 });
    await t.hive.createJob({ request: 'write a CLI that renames files' }).done;
    const answered = eventsOf(t.bus, 'crew.answered')[0];
    expect(answered.data).toMatchObject({ by: 'auto', decided: true, answers: { 'cli.input': { options: ['args'] } } });
    expect(t.ws.exists('bin/cli.js')).toBe(true);
    expect(eventsOf(t.bus, 'job.domain')[0].data.domain).toBe('cli');
  }, 30000);
});
