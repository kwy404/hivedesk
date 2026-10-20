// What the user writes to the crew outside the top bar: a request starts a job, a question gets a
// model answer in the user's language, an unclear message gets two buttons, and no reply is a canned
// English line.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { EventBus } from '../src/bus.js';
import { Scheduler } from '../src/crew/scheduler.js';
import { Hive } from '../src/crew/engine.js';
import { ToolBox, Workspace } from '../src/tools/index.js';
import { Approvals } from '../src/tools/approvals.js';
import { PlaybookStore } from '../src/playbooks/index.js';
import { createFakeBrain } from '../src/brain/fake.js';
import { createDemoBrain } from '../src/demo.js';
import { startHive } from '../src/index.js';
import { keywordIntent, decideIntent } from '../src/crew/talk.js';
import { linkHints } from '../src/crew/engine.js';
import { say } from '../src/crew/say.js';
import { tmpDir, waitFor } from './helpers.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n', 'en.json'), 'utf8'));
const PT_REQUEST = 'crie um site landingpage simples por favor';
const PAGE = '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Landing</title></head><body><h1>Bem-vindo</h1></body></html>';

const isIntent = (o) => o.schema?.properties?.intent && o.schema?.properties?.confidence;
const userTask = (messages) => (messages.find((m) => m.role === 'user')?.content.match(/Your task: ([^\n]+)/) || [])[1];
const step = (messages) => messages.filter((m) => m.role === 'assistant').length;

/** A scripted crew: the intent and talk answers come from `talk`, the rest builds one page. */
function crew(talk = {}) {
  return (messages, options) => {
    if (isIntent(options)) return talk.intent ? talk.intent(messages) : 'not json';
    if (options.talk) return talk.answer ? talk.answer(messages) : '';
    if (options.schema?.properties?.tasks) return { summary: 'Uma página.', tasks: [{ title: 'Write the page', detail: 'index.html', assignee: 'designer', dependsOn: [] }, { title: 'Check it', detail: '', assignee: 'qa', dependsOn: [0] }] };
    if (userTask(messages) === 'Write the page') return step(messages) === 0 ? { tool: 'write_file', args: { path: 'index.html', content: PAGE } } : { tool: 'done', args: { summary: 'index.html pronto' } };
    return { tool: 'report', args: { passed: true, issues: [] } };
  };
}

function setup(respond, opts = {}) {
  const dir = tmpDir();
  const bus = new EventBus();
  bus.emit('settings.changed', { refine: false, approvalMode: false });
  const scheduler = new Scheduler(bus);
  const approvals = new Approvals(bus);
  const ws = new Workspace(path.join(dir, 'ws'));
  const toolbox = new ToolBox({ workspace: ws, bus, approvals });
  const hive = new Hive({ bus, scheduler, toolbox, approvals, playbooks: new PlaybookStore(path.join(dir, 'pb')) });
  hive.init();
  const brain = typeof respond === 'function' ? createFakeBrain({ respond }) : respond;
  if (opts.brain !== false) scheduler.addBrain(brain);
  return { bus, scheduler, ws, hive, brain };
}

const replies = (t, ch, from) => (t.bus.state.chat[ch] || []).filter((m) => m.from === from);
const pt = (key, params) => say('pt-BR', key, params);

describe('a request in a direct chat', () => {
  it('starts a job in Portuguese with that worker as the lead', async () => {
    const t = setup(crew({ intent: () => ({ intent: 'request', confidence: 'high' }) }));
    t.hive.userChat('dm:dev', PT_REQUEST, { lang: 'pt-BR', jobs: true });
    const job = await waitFor(() => t.bus.state.jobs[0]);
    expect(job).toMatchObject({ request: PT_REQUEST, lead: 'dev', lang: 'pt-BR' });
    await waitFor(() => t.bus.state.jobs[0].status === 'done');
    // The plan gave the build task to the lead, the page was written.
    expect(job.taskIds.map((id) => t.bus.state.tasks[id].assignee)).toEqual(['dev', 'qa']);
    expect(t.ws.read('index.html')).toContain('Bem-vindo');
    // The workers are told to write the page in the user's language.
    const told = t.brain.calls.filter((c) => c.messages.some((m) => m.content.includes('write every visible text in the files in Português (Brasil)')));
    expect(told.length).toBeGreaterThan(0);
    // Dev answered in the direct chat, in Portuguese, with no English line.
    const dev = replies(t, 'dm:dev', 'dev');
    expect(dev).toHaveLength(1);
    expect(dev[0].text).toBe(pt('crew.talk.startedLead', { request: PT_REQUEST }));
    expect(dev[0].i18n.key).toBe('crew.talk.startedLead');
    // Mel narrates the job in Portuguese too.
    const mel = replies(t, 'general', 'mel').map((m) => m.text);
    expect(mel[0]).toBe(pt('crew.say.onItPlan', { request: PT_REQUEST }));
    expect(mel.some((x) => x.startsWith('Uma página.\nPlano:\n1. Dev: Write the page'))).toBe(true);
    expect(mel.some((x) => x.startsWith('Terminado, e o QA aprovou.'))).toBe(true);
  });

  it('starts it from the keyword rules when the model answer is not usable, and from #general too', async () => {
    const t = setup(crew());
    const asked = t.hive.userChat('general', 'Quero uma calculadora em HTML', { lang: 'pt-BR', jobs: true });
    const job = await waitFor(() => t.bus.state.jobs[0]);
    expect(job.lead).toBeUndefined();
    // In #general Mel's first line about the job is the reply (one line, not two).
    const first = replies(t, 'general', 'mel')[0];
    expect(first).toMatchObject({ replyTo: asked, text: pt('crew.say.onItPlan', { request: 'Quero uma calculadora em HTML' }) });
    await waitFor(() => !t.hive.active.size);

    t.hive.userChat('dm:mel', 'make a todo app', { lang: 'en', jobs: true });
    await waitFor(() => replies(t, 'dm:mel', 'mel').length);
    expect(replies(t, 'dm:mel', 'mel')[0].text).toBe(say('en', 'crew.talk.startedMel', { request: 'make a todo app' }));
    expect(t.bus.state.jobs[1].lead).toBeUndefined();
    await waitFor(() => !t.hive.active.size);
  });

  it('starts it with no model at all (the job waits for one)', async () => {
    const t = setup(crew(), { brain: false });
    t.hive.userChat('dm:designer', 'Task: make the header blue', { lang: 'en', jobs: true });
    const job = await waitFor(() => t.bus.state.jobs[0]);
    expect(job).toMatchObject({ request: 'make the header blue', lead: 'designer' });
    await t.hive.close();
  });

  it('a guest message never starts a job, and a running job takes the request as a note', async () => {
    const t = setup(crew({ intent: () => ({ intent: 'request', confidence: 'high' }) }));
    t.hive.userChat('general', 'Ana: crie um site', { lang: 'pt-BR' });
    await waitFor(() => replies(t, 'general', 'mel').length);
    expect(t.bus.state.jobs).toHaveLength(0);
    expect(replies(t, 'general', 'mel')[0].i18n.key).toBe('crew.talk.hostOnly');

    t.brain.chat = ((orig) => async (m, o) => { await new Promise((r) => setTimeout(r, 10)); return orig(m, o); })(t.brain.chat);
    const { done } = t.hive.createJob({ request: 'a page' });
    t.hive.userChat('dm:dev', 'adicione um rodapé com o email', { lang: 'pt-BR', jobs: true });
    await waitFor(() => replies(t, 'dm:dev', 'dev').length);
    const noted = replies(t, 'dm:dev', 'dev')[0];
    expect(noted.i18n.key).toBe('crew.talk.noted');
    expect(noted.choices.map((c) => c.id)).toEqual(['task']);
    await done;
    expect(t.bus.state.jobs).toHaveLength(1);
  });
});

describe('a question', () => {
  it('gets a model answer in pt-BR, in the worker persona, with the project context', async () => {
    let prompt = null;
    const t = setup(crew({
      intent: () => ({ intent: 'question', confidence: 'high' }),
      answer: (messages) => { prompt = messages; return 'Dev: Ainda não há arquivos no projeto. Peça o que quiser e a equipe começa.'; }
    }));
    t.ws.write('notes.md', '# notas');
    t.hive.userChat('dm:dev', 'o que tem no projeto agora?', { lang: 'pt-BR', jobs: true });
    await waitFor(() => replies(t, 'dm:dev', 'dev').length);
    const answer = replies(t, 'dm:dev', 'dev')[0];
    expect(answer.text).toBe('Ainda não há arquivos no projeto. Peça o que quiser e a equipe começa.');
    expect(answer.i18n).toBeUndefined();
    expect(t.bus.state.jobs).toHaveLength(0);
    const system = prompt[0].content;
    expect(system).toContain('You are Dev, the Developer');
    expect(system).toContain('careful web developer');
    expect(system).toContain('Português (Brasil) (pt-BR)');
    expect(system).toContain('notes.md');
    expect(prompt[1].content).toBe('o que tem no projeto agora?');
    // The worker is idle again after the talk turn.
    expect(t.bus.state.workers.dev.status).toBe('idle');
  });

  it('says it in the user language when no model is ready or the model fails', async () => {
    const t = setup(crew(), { brain: false });
    t.hive.userChat('general', 'como funciona a prévia?', { lang: 'pt-BR', jobs: true });
    await waitFor(() => replies(t, 'general', 'mel').length);
    expect(replies(t, 'general', 'mel')[0].text).toBe(pt('crew.talk.noModel'));

    const f = setup(crew({ intent: () => ({ intent: 'chat', confidence: 'high' }), answer: () => { throw new Error('boom'); } }));
    f.hive.userChat('general', 'oi, tudo bem?', { lang: 'pt-BR', jobs: true });
    await waitFor(() => replies(f, 'general', 'mel').length);
    expect(replies(f, 'general', 'mel')[0].text).toBe(pt('crew.talk.failed', { error: 'boom' }));
  });
});

describe('an unclear message', () => {
  it('gets the two buttons, and each one does what it says', async () => {
    const t = setup(crew({ intent: () => ({ intent: 'request', confidence: 'low' }), answer: () => 'Claro, podemos conversar sobre isso.' }));
    const first = t.hive.userChat('dm:designer', 'uma landing page para a padaria', { lang: 'pt-BR', jobs: true });
    await waitFor(() => replies(t, 'dm:designer', 'designer').length);
    const ask = replies(t, 'dm:designer', 'designer')[0];
    expect(ask.text).toBe('Quer que eu comece isso como uma tarefa para a equipe, ou prefere só conversar?');
    expect(ask.replyTo).toBe(first);
    expect(ask.choices.map((c) => pt(c.key))).toEqual(['Começar como tarefa', 'Só conversar']);
    expect(t.bus.state.jobs).toHaveLength(0);

    expect(t.hive.chooseChat(first, 'task')).toMatchObject({ jobId: 'j_1' });
    expect(t.bus.state.jobs[0]).toMatchObject({ request: 'uma landing page para a padaria', lead: 'designer' });
    expect(t.bus.state.chat['dm:designer'].find((m) => m.choices).chosen).toBe('task');
    expect(() => t.hive.chooseChat(first, 'task')).toThrow('no longer open');
    await waitFor(() => !t.hive.active.size);

    const second = t.hive.userChat('dm:designer', 'um tema escuro talvez', { lang: 'pt-BR', jobs: true });
    await waitFor(() => replies(t, 'dm:designer', 'designer').filter((m) => m.replyTo === second).length);
    t.hive.chooseChat(second, 'chat');
    await waitFor(() => replies(t, 'dm:designer', 'designer').some((m) => m.text === 'Claro, podemos conversar sobre isso.'));
    expect(t.bus.state.jobs).toHaveLength(1);
  });

  it('the keyword rules and the model decide together', () => {
    expect(keywordIntent(PT_REQUEST, 'pt-BR')).toMatchObject({ intent: 'request', strong: true });
    expect(keywordIntent('pode criar uma página de contato?', 'pt-BR')).toMatchObject({ intent: 'request', strong: true });
    expect(keywordIntent('Nova tarefa para Dev: arrume o menu', 'pt-BR')).toMatchObject({ intent: 'request', strong: true, request: 'arrume o menu' });
    expect(keywordIntent('make the header blue', 'en').intent).toBe('request');
    expect(keywordIntent('o que vocês estão fazendo?', 'pt-BR').intent).toBe('question');
    expect(keywordIntent('how does the preview work?', 'en').intent).toBe('question');
    expect(keywordIntent('oi, tudo bem?', 'pt-BR').intent).toBe('chat');
    expect(keywordIntent('thanks!', 'en').intent).toBe('chat');
    expect(keywordIntent('uma landing page para a padaria', 'pt-BR').intent).toBe(null);
    const kw = (intent, strong = false) => ({ intent, strong, request: '' });
    expect(decideIntent({ intent: 'question', confidence: 'high' }, kw('request', true))).toBe('request');
    expect(decideIntent({ intent: 'request', confidence: 'high' }, kw('chat'))).toBe('ambiguous');
    expect(decideIntent({ intent: 'request', confidence: 'high' }, kw(null))).toBe('request');
    expect(decideIntent({ intent: 'request', confidence: 'low' }, kw(null))).toBe('ambiguous');
    expect(decideIntent(null, kw('request'))).toBe('ambiguous');
    expect(decideIntent(null, kw(null))).toBe('ambiguous');
    expect(decideIntent({ intent: 'chat', confidence: 'low' }, kw('question'))).toBe('question');
  });
});

describe('no canned English for system replies', () => {
  it('the engine sends every crew line through i18n', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'crew', 'engine.js'), 'utf8');
    // this.chat(from, 'literal' or `template` ...) would be a line only English speakers can read.
    const literal = [...src.matchAll(/this\.chat\(\s*[^,]+,\s*(['"`])/g)].map((m) => m[0]);
    expect(literal).toEqual([]);
    expect(src).not.toMatch(/Type a request in the top bar/);
    // Every crew line has a use: the engine, or Mel's lines in the changelog, theme, extension and GitHub flows.
    const all = [src, ...['changelog/index.js', 'extensions/index.js', 'extensions/create.js', 'github/index.js', 'crew/legacy.js'].map((f) => fs.readFileSync(path.join(ROOT, 'src', f), 'utf8'))].join('\n');
    for (const k of Object.keys(en).filter((x) => x.startsWith('crew.'))) expect(all.includes(`'${k}'`) || /^crew.(talk.choice|talk.brief|role)./.test(k), k).toBe(true);
    for (const f of ['changelog/index.js', 'extensions/index.js', 'extensions/create.js', 'github/index.js']) {
      expect(fs.readFileSync(path.join(ROOT, 'src', f), 'utf8'), f).not.toMatch(/hive\??\.chat\??\.?\(\s*'mel',\s*`/);
    }
  });

  it('a whole Portuguese job from a direct chat speaks Portuguese', async () => {
    const t = setup(createDemoBrain({ delayMs: 0, tokenDelayMs: 0 }));
    t.hive.userChat('dm:dev', PT_REQUEST, { lang: 'pt-BR', jobs: true });
    await waitFor(() => t.bus.state.jobs[0]?.status === 'done' && t.bus.state.jobs[0].report, { timeout: 20000 });
    const crewLines = Object.values(t.bus.state.chat).flat().filter((m) => m.from !== 'user' && m.i18n);
    expect(crewLines.length).toBeGreaterThan(5);
    const english = new Set(Object.entries(en).filter(([k]) => k.startsWith('crew.')).map(([, v]) => v.split('{')[0].trim()).filter((v) => v.length > 8));
    for (const m of crewLines) {
      expect(m.text, m.i18n.key).toBe(say('pt-BR', m.i18n.key, m.i18n.params));
      for (const e of english) expect(m.text.startsWith(e), `${m.i18n.key}: ${m.text}`).toBe(false);
    }
    // Lines without a key are the model's own words (a worker's say tool), never the engine's.
    expect(Object.values(t.bus.state.chat).flat().filter((m) => m.from !== 'user' && !m.i18n).every((m) => m.from !== 'system')).toBe(true);
  });
});

describe('fix rounds', () => {
  it('name the file that exists when a link points next to it', () => {
    const issues = ['index.html: links to style.css, which does not exist', 'index.html: links to about.html, which does not exist', 'pages/a.html: links to app.js, which does not exist'];
    const hints = linkHints(issues, ['index.html', 'css/style.css', 'pages/a.html', 'js/app.js']);
    expect(hints).toContain('In index.html, change the link "style.css" to "css/style.css": that file exists.');
    expect(hints).toContain('In pages/a.html, change the link "app.js" to "../js/app.js": that file exists.');
    expect(hints).not.toContain('about.html');
    expect(linkHints(['index.html: no title'], ['index.html'])).toBe('');
  });
});

describe('the server path', () => {
  it('chat.send with the desktop language starts the job a brief and a plan away, and chat.choose answers buttons', async () => {
    const dir = tmpDir();
    const respond = crew({ intent: () => ({ intent: 'request', confidence: 'high' }) });
    const app = await startHive({ dir, brain: createFakeBrain({ id: 'fake', respond: (m, o) => (o.schema?.properties?.goal ? { goal: 'Uma landing page simples', build: ['index.html'], constraints: [], acceptance: ['index.html existe', 'tem um título'], questions: [] } : respond(m, o)) }), home: tmpDir() });
    try {
      const post = (type, data) => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: app.server.port, path: '/api/command', method: 'POST', headers: { host: `127.0.0.1:${app.server.port}`, authorization: `Bearer ${app.server.token}` } }, (res) => {
          let s = '';
          res.on('data', (c) => (s += c));
          res.on('end', () => resolve(JSON.parse(s)));
        });
        req.on('error', reject);
        req.end(JSON.stringify({ type, data }));
      });
      const sent = await post('chat.send', { channel: 'dm:dev', text: PT_REQUEST, lang: 'pt-BR', jobs: true });
      expect(sent.result?.id || sent.id).toBeTruthy();
      const proposed = await waitFor(() => app.bus.events.find((e) => e.type === 'brief.proposed'));
      expect(app.bus.state.chat.general.some((m) => m.text === say('pt-BR', 'crew.say.briefReady'))).toBe(true);
      await post('brief.approve', { jobId: proposed.jobId, use: 'refined' });
      await waitFor(() => app.bus.state.jobs[0]?.status === 'done' && app.bus.state.jobs[0].report, { timeout: 20000 });
      expect(fs.readFileSync(path.join(app.toolbox.ws.root, 'index.html'), 'utf8')).toContain('Bem-vindo');
      expect(app.bus.state.chat['dm:dev'].find((m) => m.from === 'dev').text).toBe(say('pt-BR', 'crew.talk.startedLead', { request: PT_REQUEST }));
      const r = await post('chat.choose', { messageId: 'nope', choice: 'task' });
      expect(r.error?.code || r.error).toBeTruthy();
    } finally {
      await app.close();
    }
  });
});
