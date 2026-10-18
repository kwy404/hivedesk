import { describe, it, expect } from 'vitest';
import { replyMessages, keywordIntent } from '../../src/crew/talk.js';
import { BUILTIN } from '../../src/crew/workers.js';
import { waitFor } from '../helpers.js';
import { rig, eventsOf } from './rig.js';

const mel = BUILTIN.find((w) => w.id === 'mel');

describe('chat mode with domain expertise', () => {
  it('a technical question gets the expertise of its field, small talk does not', () => {
    const sys = (text, lang = 'en') => replyMessages({ worker: mel, text, lang, crew: BUILTIN })[0].content;
    expect(sys('how do I build an android apk from my pwa?')).toMatch(/You know mobile apps well: PWAs, service workers, Capacitor/);
    expect(sys('o que e injecao de sql?', 'pt-BR')).toMatch(/application security well/);
    expect(sys('o que e injecao de sql?', 'pt-BR')).toMatch(/Reply in Português \(Brasil\)/);
    expect(sys('como faço deploy com docker?', 'pt-BR')).toMatch(/You know DevOps well/);
    expect(sys('oi, tudo bem?', 'pt-BR')).not.toMatch(/You know/);
    expect(sys('how do I build an android apk from my pwa?')).toMatch(/cannot build or change files/);
  });

  it('a question in the chat is answered without a job, a request in the chat starts the domain flow', async () => {
    const answers = [];
    const t = rig({ refine: false, respond: (messages, options) => {
      if (options.schema?.properties?.intent) return { intent: /\?$/.test(messages[1].content) ? 'question' : 'request', confidence: 'high' };
      if (!options.schema) { answers.push(messages[0].content); return 'Use Capacitor: npx cap add android, then build the APK in Android Studio.'; }
      if (options.schema?.properties?.tasks) return { summary: 's', tasks: [{ title: 'Build', detail: '', assignee: 'dev', dependsOn: [] }] };
      if (/You are QA/.test(messages[0].content)) return { tool: 'report', args: { passed: true, findings: [] } };
      return { tool: 'done', args: { summary: 'ok' } };
    } });
    t.hive.userChat('general', 'how do I turn my pwa into an android app?', { lang: 'en', jobs: true });
    await waitFor(() => t.bus.events.some((e) => e.type === 'chat.message' && /npx cap add android/.test(e.data.text)));
    expect(t.bus.state.jobs).toEqual([]);
    expect(answers[0]).toMatch(/You know mobile apps well/);
    expect(keywordIntent('write a CLI that renames files').intent).toBe('request');
    t.hive.userChat('general', 'write a CLI that renames files', { lang: 'en', jobs: true });
    await waitFor(() => t.bus.state.jobs[0]?.status === 'done' || t.bus.state.jobs[0]?.status === 'failed', { timeout: 20000 });
    expect(eventsOf(t.bus, 'job.domain')[0].data.domain).toBe('cli');
  }, 30000);
});
