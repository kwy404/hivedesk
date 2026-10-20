// The owner's 1.0.0 run: a job sat at "waiting for the brief" while "certo, pode continuar]" and
// "ok. aceito" went to the chat model, Mel answered "Claro! Vou continuar..." and nothing was built;
// "cade a landingpage?" got a generic assistant disclaimer. Now a confirmation approves the brief,
// a change edits it, status questions are answered from the engine, and the chat model can never
// claim work or refuse to create files.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { EventBus } from '../src/bus.js';
import { Scheduler } from '../src/crew/scheduler.js';
import { Hive } from '../src/crew/engine.js';
import { ToolBox, Workspace } from '../src/tools/index.js';
import { Approvals } from '../src/tools/approvals.js';
import { PlaybookStore } from '../src/playbooks/index.js';
import { createFakeBrain } from '../src/brain/fake.js';
import { briefReply, isStatusQuestion, isRefusal, claimsWork } from '../src/crew/talk.js';
import { legacyKey, tagLegacyChat } from '../src/crew/legacy.js';
import { say } from '../src/crew/say.js';
import { tmpDir, waitFor } from './helpers.js';

const PAGE = '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Landing</title></head><body><h1>Bem-vindo</h1></body></html>';
const DISCLAIMER = 'Desculpe pela confusão. Como sou um assistente de inteligência artificial, não tenho a capacidade de criar arquivos ou sites diretamente em seu computador.';
const userTask = (messages) => (messages.find((m) => m.role === 'user')?.content.match(/Your task: ([^\n]+)/) || [])[1];
const step = (messages) => messages.filter((m) => m.role === 'assistant').length;
const isTalk = (c) => String(c.messages[0]?.content || '').includes('This reply itself does not build');

/** A stub crew: a brief, a plan, one page; chat answers come from `answer` (the bad answers of the real run). */
function crew({ answer = () => 'Claro! Vou continuar com o plano.', intent = 'question' } = {}) {
  return (messages, options) => {
    if (options.schema?.properties?.intent) return { intent, confidence: 'high' };
    if (options.talk) return answer(messages);
    if (options.schema?.properties?.goal) return { goal: 'Uma landing page simples.', build: ['index.html com a landing page'], constraints: [], acceptance: ['index.html existe', 'tem um título'], questions: [] };
    if (options.schema?.properties?.tasks) return { summary: 'Uma página.', tasks: [{ title: 'Write the page', detail: 'index.html', assignee: 'dev', dependsOn: [] }, { title: 'Check it', detail: '', assignee: 'qa', dependsOn: [0] }] };
    if (options.schema?.properties?.improvedPrompt) return { improvedPrompt: 'Crie uma landing page simples com título.', nextPrompts: ['Adicione um rodapé', 'Adicione um formulário'] };
    if (userTask(messages) === 'Write the page') return step(messages) === 0 ? { tool: 'write_file', args: { path: 'index.html', content: PAGE } } : { tool: 'done', args: { summary: 'index.html pronto' } };
    if (options.schema?.properties?.domain || options.schema?.properties?.kind) return 'not json';
    return { tool: 'report', args: { passed: true, issues: [] } };
  };
}

function setup(respond, dir = tmpDir()) {
  const bus = new EventBus();
  // The brief step on, as in the desktop; the domain question cards off so only the brief waits.
  bus.emit('settings.changed', { refine: true, approvalMode: false, questions: false });
  const scheduler = new Scheduler(bus);
  const approvals = new Approvals(bus);
  const ws = new Workspace(path.join(dir, 'ws'));
  const toolbox = new ToolBox({ workspace: ws, bus, approvals });
  const hive = new Hive({ bus, scheduler, toolbox, approvals, playbooks: new PlaybookStore(path.join(dir, 'pb')) });
  hive.init();
  const brain = createFakeBrain({ respond });
  scheduler.addBrain(brain);
  return { bus, ws, hive, brain };
}

const lines = (t, ch, from) => (t.bus.state.chat[ch] || []).filter((m) => m.from === from);
const keys = (t, ch, from) => lines(t, ch, from).map((m) => m.i18n?.key || null);
const job = (t) => t.bus.state.jobs[t.bus.state.jobs.length - 1];
const opts = { lang: 'pt-BR', jobs: true };

describe('a brief that waits for the user', () => {
  it('the owner\'s sequence: "certo, pode continuar]" approves it, the job builds files, status comes from the engine', async () => {
    const t = setup(crew());
    t.hive.userChat('general', 'crie uma landingpage por favor', opts);
    await waitFor(() => job(t)?.status === 'awaiting_brief');
    // The brief line carries the buttons, in Portuguese.
    const ready = lines(t, 'general', 'mel').find((m) => m.i18n?.key === 'crew.say.briefReady');
    expect(ready.text).toBe(say('pt-BR', 'crew.say.briefReady'));
    expect(ready.choices.map((c) => c.id)).toEqual(['use', 'original', 'open']);
    expect(ready.replyTo).toBe(`brief:${job(t).id}`);
    // Mel is not "thinking" while she waits for the user.
    expect(t.bus.state.workers.mel.status).toBe('idle');

    // "cade a landingpage?" mid job: the real status, never the model (which would say the disclaimer).
    t.hive.userChat('general', 'cade a landingpage?', opts);
    await waitFor(() => keys(t, 'general', 'mel').includes('crew.status.brief'));
    const status = lines(t, 'general', 'mel').find((m) => m.i18n?.key === 'crew.status.brief');
    expect(status.text).toBe(say('pt-BR', 'crew.status.brief', { request: 'crie uma landingpage por favor' }));
    expect(status.choices.map((c) => c.id)).toEqual(['use', 'original', 'open']);
    expect(t.brain.calls.some(isTalk)).toBe(false);

    // The DM to Mel with the stray "]": it approves the brief and Mel says so.
    t.hive.userChat('dm:mel', 'certo, pode continuar]', opts);
    await waitFor(() => keys(t, 'dm:mel', 'mel').includes('crew.talk.brief.approve'));
    expect(lines(t, 'dm:mel', 'mel')[0].text).toBe(say('pt-BR', 'crew.talk.brief.approve', { request: 'crie uma landingpage por favor' }));
    await waitFor(() => job(t).status === 'done');
    expect(job(t).brief.source).toBe('refined');
    expect(t.ws.read('index.html')).toContain('Bem-vindo');
    // The brief buttons were taken away once it was decided.
    expect(lines(t, 'general', 'mel').find((m) => m.replyTo === `brief:${job(t).id}`).chosen).toBe('use');
    // No crew line claims work that the engine did not do.
    expect(lines(t, 'dm:mel', 'mel').some((m) => /Vou continuar/.test(m.text))).toBe(false);

    t.hive.userChat('general', 'cade a landingpage?', opts);
    await waitFor(() => keys(t, 'general', 'mel').includes('crew.status.done'));
    expect(lines(t, 'general', 'mel').find((m) => m.i18n?.key === 'crew.status.done').text).toContain('index.html');
  });

  it('"ok. aceito" in #general approves it too, and a change edits the brief', async () => {
    const t = setup(crew());
    t.hive.userChat('general', 'crie uma landingpage por favor', opts);
    await waitFor(() => job(t)?.status === 'awaiting_brief');
    t.hive.userChat('general', 'ok. aceito', opts);
    await waitFor(() => job(t).status === 'done');
    expect(keys(t, 'general', 'mel')).toContain('crew.talk.brief.approve');

    t.hive.userChat('general', 'crie uma página de contato', opts);
    await waitFor(() => t.bus.state.jobs.length === 2 && job(t).status === 'awaiting_brief');
    t.hive.userChat('general', 'muda o fundo para azul', opts);
    await waitFor(() => job(t).status === 'done');
    expect(job(t).brief.source).toBe('edited');
    expect(job(t).brief.text).toContain('muda o fundo para azul');
    expect(keys(t, 'general', 'mel')).toContain('crew.talk.brief.edit');
  });

  it('a Portuguese request as a DM to Dev starts a job led by Dev that writes files after the brief button', async () => {
    const t = setup(crew());
    t.hive.userChat('dm:dev', 'crie um site landingpage simples por favor', opts);
    await waitFor(() => job(t)?.status === 'awaiting_brief');
    expect(job(t)).toMatchObject({ lead: 'dev', lang: 'pt-BR' });
    expect(keys(t, 'dm:dev', 'dev')).toEqual(['crew.talk.startedLead']);
    expect(lines(t, 'dm:dev', 'dev').every((m) => !/Type a request/.test(m.text))).toBe(true);
    t.hive.chooseChat(`brief:${job(t).id}`, 'use', { lang: 'pt-BR' });
    await waitFor(() => job(t).status === 'done');
    expect(t.ws.read('index.html')).toContain('Bem-vindo');
  });

  it('a brief left waiting when hivedesk stopped is approved later and the job builds', async () => {
    const dir = tmpDir();
    const a = setup(crew(), dir);
    a.hive.userChat('general', 'crie uma landingpage por favor', opts);
    await waitFor(() => job(a)?.status === 'awaiting_brief');
    // A new engine on the same state (a restart): the waiting brief is kept, not lost.
    const b = setup(crew(), dir);
    if (!b.bus.state.jobs.length) {
      b.bus.state.jobs.push(JSON.parse(JSON.stringify(job(a))));
    }
    b.hive.init();
    expect(job(b).status).toBe('awaiting_brief');
    b.hive.userChat('general', 'pode fazer', opts);
    await waitFor(() => job(b).status === 'done');
    expect(b.ws.read('index.html')).toContain('Bem-vindo');
    a.hive.cancelJob(job(a).id);
  });

  it('a generic disclaimer or a promise of work from the chat model is replaced with the real status', async () => {
    const t = setup(crew({ answer: () => DISCLAIMER }));
    t.hive.userChat('general', 'vocês sabem fazer sites?', opts);
    await waitFor(() => keys(t, 'general', 'mel').includes('crew.status.none'));
    expect(lines(t, 'general', 'mel').some((m) => m.text.includes('assistente'))).toBe(false);
    // The talk prompt says the crew writes real files and never to claim work.
    const talk = t.brain.calls.find(isTalk);
    expect(talk.messages[0].content).toContain('The crew writes real files');
  });
});

describe('the chat rules', () => {
  it('reads confirmations in 10 languages, typos included, and leaves questions alone', () => {
    for (const s of ['ok. aceito', 'certo, pode continuar]', 'sim', 'pode fazer', 'go ahead', 'yes please', 'sí, adelante', 'oui, vas-y', 'ja, mach weiter', 'sì, procedi', 'はい、お願いします', '네 진행해주세요', '好的，继续', 'да, давай']) expect(briefReply(s, 'pt-BR')).toBe('approve');
    expect(briefReply('mantenha meu pedido original')).toBe('original');
    expect(briefReply('muda o fundo para azul', 'pt-BR')).toBe('edit');
    expect(briefReply('cancela')).toBe('cancel');
    for (const s of ['oi', 'o que você acha?', 'quanto tempo leva?']) expect(briefReply(s, 'pt-BR')).toBe(null);
  });

  it('spots status questions, disclaimers and claims of work', () => {
    for (const s of ['cade a landingpage?', 'cadê o site', 'está pronto?', 'o que falta?', 'where is it?', 'is it ready?', '진행 상황은?', '进度怎么样？']) expect(isStatusQuestion(s)).toBe(true);
    for (const s of ['como faço um botão?', 'qual a cor do site?']) expect(isStatusQuestion(s)).toBe(false);
    expect(isRefusal(DISCLAIMER)).toBe(true);
    expect(isRefusal('As an AI language model, I cannot create files.')).toBe(true);
    expect(isRefusal('O index.html tem o título e o rodapé.')).toBe(false);
    expect(claimsWork('Entendido. Vou começar a preparar o briefing.')).toBe(true);
    expect(claimsWork('Claro! Vou continuar com o plano.')).toBe(true);
    expect(claimsWork('Oi! Como posso ajudar você hoje?')).toBe(false);
  });

  it('gives old English crew lines their key, so they show in the desktop language', () => {
    const chat = {
      general: [{ from: 'mel', text: 'On it: "crie um site". First I will write it up as a clear brief for you to check.' }, { from: 'mel', text: 'Here is the brief. Use it, edit it, or keep your original request.' }, { from: 'user', text: 'Job cancelled. The files written so far stay in the workspace.' }],
      'dm:dev': [{ from: 'dev', text: 'Got it. Type a request in the top bar and the crew will start a job.' }]
    };
    expect(tagLegacyChat(chat)).toBe(3);
    expect(chat.general[0].i18n).toEqual({ key: 'crew.say.onItBrief', params: { request: 'crie um site' } });
    expect(chat.general[1].i18n.key).toBe('crew.say.briefReady');
    expect(chat.general[2].i18n).toBeUndefined();
    expect(say('pt-BR', chat['dm:dev'][0].i18n.key)).toMatch(/^Entendi/);
    expect(legacyKey('hello')).toBe(null);
  });
});
