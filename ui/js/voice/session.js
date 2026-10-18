// Voice session: turns what Mel heard into replies and actions. Pure logic with injected
// actions, so it is unit tested with a mocked recognizer (test/voice.test.js, test/voice/*.test.js).
//
// Rule: Mel always asks before acting. Anything that writes, runs, shares or connects (a new request
// for the crew, approving or rejecting a step, git and GitHub, sharing the GPU, connecting to a
// remote desktop, answering a question card) becomes a pending confirmation: Mel reads it back, the
// card shows it, and only a short, clear yes (or a click) runs it. Any other sentence while a
// confirmation waits does not run it. Nothing is ever approved by itself.

import { parseIntent, yesNo, fold } from './intents.js';
import { speakQuestion, parseChoice, confirmText, toAnswer, validCard, spokenOrder } from './questions.js';

/** "1234567890" read as "123 456 7890". */
export const groupAddress = (a) => String(a).replace(/^(\d{3})(\d{3})(\d{4})$/, '$1 $2 $3');

/** The known peer whose name the user said (whole words, accents and case ignored). */
export function findPeer(peers, text, person) {
  const f = ` ${fold(text)} `;
  const named = (peers || []).filter((p) => p?.name && f.includes(` ${fold(p.name)} `));
  if (named.length === 1) return { peer: named[0] };
  if (named.length > 1) {
    const exact = named.filter((p) => fold(p.name) === fold(person));
    return exact.length === 1 ? { peer: exact[0] } : { ambiguous: named };
  }
  if (person) {
    const first = fold(person).split(' ')[0];
    const loose = (peers || []).filter((p) => fold(p.name).split(' ')[0] === first);
    if (loose.length === 1) return { peer: loose[0] };
    if (loose.length > 1) return { ambiguous: loose };
  }
  return {};
}

/**
 * @param {{
 *   t: (key: string, params?: object) => string,
 *   lang: () => string,
 *   speak: (text: string) => void | Promise<void>,
 *   speakStream?: () => { push: (text: string) => void, end: () => Promise<void> },
 *   onUpdate?: (state: object) => void,
 *   actions: {
 *     createJob: (request: string) => Promise<any>,
 *     approvals: () => Array<{ id: string, summary?: string, tool?: string }>,
 *     resolveApproval: (id: string, approved: boolean) => Promise<any>,
 *     status: () => string,
 *     openWindow: (type: string) => boolean,
 *     ask?: (text: string) => Promise<string>,
 *     reply?: (text: string, o: { mode: 'auto' | 'talk', onToken: (t: string) => void }) => Promise<any>,
 *     runIntent?: (text: string, opts: { confirm: (plan: object) => Promise<boolean> }) => Promise<any>,
 *     planTitle?: (plan: object) => string,
 *     planSteps?: (plan: object) => string[],
 *     peers?: () => Promise<Array<{ peerId: string, name: string, online?: boolean }> | null>,
 *     share?: (o: { peerId: string, resource: 'gpu' | 'cpu' }) => Promise<any>,
 *     connect?: (address: string) => Promise<any>,
 *     answerQuestion?: (payload: { questionId: string, answers?: object, decide?: boolean }) => Promise<any>,   crew.answer (docs/1.0/DOMAINS.md)
 *     end?: () => void,
 *   }
 * }} o
 */
export function createVoiceSession({ t, lang, speak, speakStream, onUpdate, actions }) {
  const state = { pending: null, heard: '', reply: '', busy: false, question: null };
  const update = () => onUpdate?.({ ...state, pending: state.pending ? { ...state.pending } : null });
  const askListeners = new Set();
  const announce = (spoken) => { for (const fn of askListeners) fn(spoken); };

  async function say(text) {
    state.reply = text;
    update();
    try { await speak(text); } catch { /* speaking is best effort */ }
  }

  /** Waits for the user's yes or no on a pending action. */
  function ask({ kind, summary, details = [], run, cancel, prompt }) {
    if (state.pending) state.pending.cancel?.();
    return new Promise((resolve) => {
      state.pending = {
        kind, summary, details,
        yes: async () => { state.pending = null; update(); resolve(true); try { await run?.(); } catch (err) { await say(t('voice.say.failed', { message: err?.message || '' })); } },
        no: () => { state.pending = null; update(); resolve(false); cancel?.(); },
        cancel: () => { resolve(false); cancel?.(); },
      };
      const spoken = say(prompt || t('voice.say.confirm', { summary }));
      state.pending.spoken = spoken;
      announce(spoken);
    });
  }

  async function confirm() {
    const p = state.pending;
    if (!p || p.kind === 'question') return false;
    if (p.kind !== 'questionConfirm') await say(t('voice.say.doing'));
    await p.yes();
    return true;
  }

  async function cancel() {
    const p = state.pending;
    if (!p) return false;
    if (p.kind === 'question') { dropQuestion(p.cardId); await say(t('voice.q.later')); return true; }
    p.no();
    if (p.kind !== 'questionConfirm') await say(t('voice.say.cancelled'));
    return true;
  }

  /* ---------- clarifying question cards ---------- */

  function askQuestion() {
    const qs = state.question;
    if (!qs) return;
    const q = qs.card.questions[qs.i];
    state.pending?.cancel?.();
    state.pending = {
      kind: 'question', summary: q.text, questionId: q.id, cardId: qs.card.id,
      details: spokenOrder(q).map((o, k) => `${k + 1}. ${o.label}${o.recommended ? ` (${t('voice.q.recommended')})` : ''}`),
      hear: async (text) => {
        const choice = parseChoice(text, q, t, lang());
        if (!choice) { await say(t('voice.q.again')); return; }
        // say the choice back; a yes goes on, a no asks the question again
        const summary = confirmText(q, choice, t);
        const ok = await ask({ kind: 'questionConfirm', summary, prompt: t('voice.q.confirmAsk', { summary }) });
        if (state.question !== qs) return;
        if (!ok) { askQuestion(); await say(speakQuestion(q, t, qs.i + 1, qs.card.questions.length)); return; }
        qs.choices[q.id] = choice;
        if (choice.kind === 'decide') { for (const other of qs.card.questions) if (!qs.choices[other.id]) qs.choices[other.id] = { kind: 'decide' }; }
        qs.i = qs.card.questions.findIndex((x) => !qs.choices[x.id]);
        if (qs.i >= 0) { askQuestion(); await say(speakQuestion(qs.card.questions[qs.i], t, qs.i + 1, qs.card.questions.length)); return; }
        state.question = null;
        update();
        try {
          await actions.answerQuestion?.(toAnswer(qs.card, qs.choices));
          await say(t('voice.q.sent'));
        } catch (err) { await say(t('voice.say.failed', { message: err?.message || '' })); }
      },
      yes: async () => {}, no: () => {}, cancel: () => {},
    };
    update();
  }

  /** A crew.question card arrived: Mel reads the first question out loud. */
  async function question(card) {
    if (!validCard(card)) return false;
    state.question = { card, i: 0, choices: {} };
    askQuestion();
    const spoken = say(`${t('voice.q.intro')} ${speakQuestion(card.questions[0], t, 1, card.questions.length)}`);
    state.pending.spoken = spoken;
    announce(spoken);
    await spoken;
    return true;
  }

  /** The card was answered on screen or went away: stop asking about it. */
  function dropQuestion(id) {
    if (!state.question || (id && state.question.card.id !== id)) return false;
    state.question = null;
    if (state.pending?.kind === 'question' || state.pending?.kind === 'questionConfirm') { state.pending.cancel?.(); state.pending = null; }
    update();
    return true;
  }

  /* ---------- one sentence ---------- */

  /** One final transcript. Resolves with the parsed intent when the turn is over. */
  async function hear(text) {
    const heard = String(text || '').trim();
    state.heard = heard;
    update();
    if (!heard) return { kind: 'unknown' };
    const code = lang();

    if (state.pending?.hear) {
      if (parseIntent(heard, t, code).kind === 'end') { await endTalk(); return { kind: 'end' }; }
      await state.pending.hear(heard);
      return { kind: 'answer' };
    }
    if (state.pending) {
      const yn = yesNo(heard, t, code);
      if (yn === 'yes') { await confirm(); return { kind: 'yes' }; }
      if (yn === 'no') { await cancel(); return { kind: 'no' }; }
      // anything else does not run the pending action
      await say(t('voice.say.stillWaiting', { summary: state.pending.summary }));
      return { kind: 'unclear' };
    }

    const intent = parseIntent(heard, t, code);
    switch (intent.kind) {
      case 'yes': case 'no':
        await say(t('voice.say.nothingPending'));
        break;
      case 'end':
        await endTalk();
        break;
      case 'stop':
        await say(t('voice.say.ok'));
        break;
      case 'status':
        await say(actions.status());
        break;
      case 'help':
        await say(t('voice.say.helpMore'));
        break;
      case 'open':
        if (actions.openWindow(intent.window)) await say(t('voice.say.opened', { name: t(`voice.winName.${intent.window}`) }));
        else await say(t('voice.say.cannotOpen'));
        break;
      case 'approve': case 'reject': {
        const list = actions.approvals();
        if (!list.length) { await say(t('voice.say.noApprovals')); break; }
        const a = list[0];
        const what = a.summary || a.tool || '';
        const approved = intent.kind === 'approve';
        ask({
          kind: intent.kind,
          summary: approved ? t('voice.sum.approve', { what }) : t('voice.sum.reject', { what }),
          details: list.length > 1 ? [t('voice.sum.more', { count: list.length - 1 })] : [],
          run: () => actions.resolveApproval(a.id, approved),
        });
        break;
      }
      case 'build':
        // a guess from the sentence length: the engine sorts it (a request still needs the yes)
        if (intent.guess && actions.reply) await converse(heard);
        else askBuild(intent.request);
        break;
      case 'connect': {
        if (!actions.connect) { await say(t('voice.say.noConnect')); break; }
        const address = groupAddress(intent.address);
        ask({
          kind: 'connect',
          summary: t('voice.sum.connect', { address }),
          details: [t('voice.sum.connectDetail')],
          run: async () => { await actions.connect(intent.address); await say(t('voice.say.connecting', { address })); },
        });
        break;
      }
      case 'share': {
        const peers = actions.peers ? await actions.peers().catch(() => null) : null;
        if (!peers || !actions.share) { await say(t('voice.say.noShare')); break; }
        const found = findPeer(peers, heard, intent.person);
        if (found.ambiguous) { await say(t('voice.say.whichPeer', { names: found.ambiguous.map((p) => p.name).join(', ') })); break; }
        if (!found.peer) { await say(t('voice.say.noPeer', { name: (intent.person || '?').replace(/(^|\s)(\p{L})/gu, (m, s, c) => s + c.toUpperCase()) })); break; }
        const resource = t(`voice.res.${intent.resource}`);
        ask({
          kind: 'share',
          summary: t('voice.sum.share', { resource, name: found.peer.name }),
          details: [t('voice.sum.shareDetail')],
          run: async () => { await actions.share({ peerId: found.peer.peerId, resource: intent.resource }); await say(t('voice.say.shared', { resource, name: found.peer.name })); },
        });
        break;
      }
      case 'git': {
        if (!actions.runIntent) { await say(t('voice.say.noGit')); break; }
        try {
          const r = await actions.runIntent(heard, {
            confirm: (plan) => ask({
              kind: 'git',
              summary: actions.planTitle ? actions.planTitle(plan) : plan.title,
              details: actions.planSteps ? actions.planSteps(plan) : (plan.steps || []).map((s) => s.text || s.label || '').filter(Boolean),
            }),
          });
          if (r && r.ok === false && r.message) await say(r.message);
          else if (r?.ran) await say(t('voice.say.gitDone'));
        } catch (err) { await say(t('voice.say.failed', { message: err?.message || '' })); }
        break;
      }
      default:
        await converse(heard);
    }
    return intent;
  }

  function askBuild(request, prompt) {
    return ask({
      kind: 'build',
      summary: t('voice.sum.build', { request }),
      details: [request],
      prompt,
      run: async () => { const r = await actions.createJob(request); if (r) await say(t('voice.say.started')); },
    });
  }

  async function endTalk() {
    state.pending?.cancel?.();
    state.pending = null;
    state.question = null;
    await say(t('voice.say.bye'));
    actions.end?.();
  }

  /**
   * Not a voice command: the engine sorts it (voice.reply). A request for the crew comes back for a
   * yes first; an answer streams in and Mel speaks it sentence by sentence while the text appears.
   */
  async function converse(heard, mode = 'auto') {
    if (!actions.reply) {
      // without the voice plug-in: the chat answers like a typed message
      const answer = actions.ask ? await Promise.resolve(actions.ask(heard)).catch(() => '') : '';
      await say(answer || t('voice.say.unknown'));
      return;
    }
    const stream = speakStream ? speakStream() : null;
    let text = '';
    state.reply = '';
    update();
    let r;
    try {
      r = await actions.reply(heard, { mode, onToken: (tok) => { text += tok; state.reply = text; update(); stream?.push(tok); } });
    } catch (err) {
      await stream?.end();
      await say(t('voice.say.failed', { message: err?.message || '' }));
      return;
    }
    if (r?.kind === 'request') { await stream?.end(); askBuild(r.request); return; }
    if (r?.kind === 'ambiguous') {
      await stream?.end();
      const yes = await askBuild(r.request, t('voice.say.taskOrTalk', { request: r.request }));
      if (!yes && state.pending === null) await converse(heard, 'talk');
      return;
    }
    if (r?.kind === 'cancelled') { await stream?.end(); return; }
    if (r?.kind === 'noModel') { await stream?.end(); await say(t('voice.say.noModel')); return; }
    const final = r?.text || text;
    if (stream) {
      state.reply = final || t('voice.say.unknown');
      update();
      if (!text && final) stream.push(final);
      await stream.end();
      if (!final) await say(t('voice.say.unknown'));
    } else {
      await say(final || t('voice.say.unknown'));
    }
  }

  /**
   * One turn for the conversation loop: resolves when Mel finished speaking for it, also when she now
   * waits for a yes or an answer (the loop listens again while the action waits).
   */
  function turn(text) {
    return new Promise((resolve) => {
      let finished = false;
      const onAsk = (spoken) => Promise.resolve(spoken).then(() => done('asked'));
      const done = (how) => { if (!finished) { finished = true; askListeners.delete(onAsk); resolve(how); } };
      askListeners.add(onAsk);
      hear(text).then(() => done('done'), () => done('error'));
    });
  }

  return { hear, turn, confirm, cancel, question, dropQuestion, state, get pending() { return state.pending; } };
}
