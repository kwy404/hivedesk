// One spoken turn of the conversation, on the engine: is it a request for the crew or something to
// answer? A request is never started here: it goes back to the window, which reads it out and waits
// for a yes (the voice rule: always ask before acting). An answer streams from the model token by
// token as `voice.token` live frames, so the window speaks it sentence by sentence while the text
// appears, and it lands in #general like a typed exchange.
import { keywordIntent, decideIntent, replyMessages, cleanReply } from '../crew/talk.js';
import { languageName } from '../crew/say.js';

export const VOICE_RULES = [
  'This answer is spoken aloud by a voice in a live conversation.',
  'Answer in one to three short sentences that sound natural when spoken. No lists, no Markdown, no code, no links, no emoji.',
  'If the user wants something built, changed, shared or connected, do not say it is done: say what you understood in one sentence; the app asks the user to confirm.'
].join(' ');

/** The answer prompt of the chat with the voice rules added to the system message. */
export function voiceMessages(ctx) {
  const msgs = replyMessages(ctx);
  msgs[0] = { ...msgs[0], content: `${msgs[0].content}\n${VOICE_RULES} Speak ${languageName(ctx.lang)}.` };
  return msgs;
}

/**
 * Classifies one sentence with the keyword rules only (the voice turn cannot wait for a second model call).
 * @returns {{ kind: 'request' | 'ambiguous' | 'talk', request: string }}
 */
export function voiceIntent(text, lang) {
  const kw = keywordIntent(text, lang);
  const d = decideIntent(null, kw);
  if (d === 'request') return { kind: 'request', request: kw.request };
  if (d === 'ambiguous' && kw.intent === 'request') return { kind: 'ambiguous', request: kw.request };
  return { kind: 'talk', request: kw.request };
}

export class VoiceReplies {
  /** @param {{ hive: any, scheduler: any, bus: any, toolbox?: any, timeoutMs?: number }} o */
  constructor(o) {
    this.o = { timeoutMs: 60000, ...o };
    this.running = new Map();
  }

  /**
   * @param {{ text: string, lang: string, replyId: string, mode?: 'auto' | 'talk' }} d
   * @returns {Promise<{ kind: 'request' | 'ambiguous', request: string } | { kind: 'answer', text: string, messageId?: string } | { kind: 'noModel' } | { kind: 'cancelled' }>}
   */
  async reply({ text, lang, replyId, mode = 'auto' }) {
    const { hive, scheduler, bus } = this.o;
    const said = String(text || '').trim().slice(0, 2000);
    if (!said) throw Object.assign(new Error('nothing was said'), { code: 'bad_request' });
    if (mode !== 'talk') {
      const intent = voiceIntent(said, lang);
      if (intent.kind !== 'talk') return intent;
    }
    if (!scheduler.hasBrain) return { kind: 'noModel' };
    const s = hive.state;
    const worker = s.crew.find((w) => w.id === 'mel') || s.crew[0];
    const userMsg = hive.chat('user', said, undefined, 'general', undefined, { voice: true });
    const files = (() => { try { return this.o.toolbox?.ws.list().map((f) => f.path) || []; } catch { return []; } })();
    const messages = voiceMessages({
      worker, text: said, lang, crew: s.crew, files, jobs: s.jobs, tasks: s.tasks,
      history: (s.chat.general || []).filter((m) => m.from !== 'system').slice(-7, -1)
    });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs);
    timer.unref?.();
    this.running.set(replyId, ctrl);
    let streamed = '';
    try {
      const r = await scheduler.turn({
        workerId: worker.id, messages, signal: ctrl.signal,
        options: { maxTokens: 220, temperature: 0.5, talk: true, onToken: (t) => { streamed += t; bus.live('voice.token', { replyId, text: t }); } }
      });
      const answer = cleanReply(r.text || streamed, worker);
      bus.live('voice.done', { replyId });
      if (!answer) return { kind: 'answer', text: '' };
      const messageId = hive.chat(worker.id, answer, undefined, 'general', undefined, { replyTo: userMsg, voice: true });
      return { kind: 'answer', text: answer, messageId };
    } catch (err) {
      bus.live('voice.done', { replyId });
      if (ctrl.signal.aborted && this.running.get(replyId) === null) return { kind: 'cancelled' };
      if (ctrl.signal.aborted) throw Object.assign(new Error('the model took too long to answer'), { code: 'timeout' });
      throw err;
    } finally {
      clearTimeout(timer);
      this.running.delete(replyId);
      if (!hive._inJob?.(worker.id)) bus.emit('worker.status', { workerId: worker.id, status: 'idle' });
    }
  }

  /** Barge in: the user spoke over Mel, so the answer stops right away. */
  cancel(replyId) {
    const c = this.running.get(replyId);
    if (!c) return false;
    this.running.set(replyId, null);
    c.abort();
    return true;
  }
}
