// Voice session: turns what Mel heard into replies and actions. Pure logic with injected
// actions, so it is unit tested with a mocked SpeechRecognition (test/voice.test.js).
//
// Rule: Mel always asks before acting. Anything that changes the project (a new request for the
// crew, approving or rejecting a step, git and GitHub) becomes a pending confirmation: Mel reads
// it out loud, the card shows it, and only a short, clear yes (or a click) runs it. Any other
// sentence while a confirmation waits does not run it.

import { parseIntent, yesNo } from './intents.js';

/**
 * @param {{
 *   t: (key: string, params?: object) => string,
 *   lang: () => string,
 *   speak: (text: string) => void | Promise<void>,
 *   onUpdate?: (state: object) => void,
 *   actions: {
 *     createJob: (request: string) => Promise<any>,
 *     approvals: () => Array<{ id: string, summary?: string, tool?: string }>,
 *     resolveApproval: (id: string, approved: boolean) => Promise<any>,
 *     status: () => string,
 *     openWindow: (type: string) => boolean,
 *     runIntent?: (text: string, opts: { confirm: (plan: object) => Promise<boolean> }) => Promise<any>,
 *     planTitle?: (plan: object) => string,
 *   }
 * }} o
 */
export function createVoiceSession({ t, lang, speak, onUpdate, actions }) {
  const state = { pending: null, heard: '', reply: '', busy: false };
  const update = () => onUpdate?.({ ...state, pending: state.pending ? { ...state.pending } : null });

  async function say(text) {
    state.reply = text;
    update();
    try { await speak(text); } catch { /* speaking is best effort */ }
  }

  /** Waits for the user's yes or no on a pending action. */
  function ask({ kind, summary, details = [], run, cancel }) {
    if (state.pending) state.pending.cancel?.();
    return new Promise((resolve) => {
      state.pending = {
        kind, summary, details,
        yes: async () => { state.pending = null; update(); resolve(true); try { await run?.(); } catch (err) { await say(t('voice.say.failed', { message: err?.message || '' })); } },
        no: () => { state.pending = null; update(); resolve(false); cancel?.(); },
        cancel: () => { resolve(false); cancel?.(); },
      };
      say(t('voice.say.confirm', { summary }));
    });
  }

  async function confirm() {
    const p = state.pending;
    if (!p) return false;
    await say(t('voice.say.doing'));
    await p.yes();
    return true;
  }

  async function cancel() {
    const p = state.pending;
    if (!p) return false;
    p.no();
    await say(t('voice.say.cancelled'));
    return true;
  }

  /** One final transcript from the recognizer. Resolves with the parsed intent. */
  async function hear(text) {
    const heard = String(text || '').trim();
    state.heard = heard;
    update();
    if (!heard) return { kind: 'unknown' };
    const code = lang();

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
      case 'stop':
        await say(t('voice.say.ok'));
        break;
      case 'status':
        await say(actions.status());
        break;
      case 'help':
        await say(t('voice.say.help'));
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
        ask({
          kind: 'build',
          summary: t('voice.sum.build', { request: intent.request }),
          details: [intent.request],
          run: async () => { const r = await actions.createJob(intent.request); if (r) await say(t('voice.say.started')); },
        });
        break;
      case 'git': {
        if (!actions.runIntent) { await say(t('voice.say.noGit')); break; }
        try {
          const r = await actions.runIntent(heard, {
            confirm: (plan) => ask({
              kind: 'git',
              summary: actions.planTitle ? actions.planTitle(plan) : plan.title,
              details: (plan.steps || []).map((s) => s.text || s.label || '').filter(Boolean),
            }),
          });
          if (r && r.ok === false && r.message) await say(r.message);
          else if (r?.ran) await say(t('voice.say.gitDone'));
        } catch (err) { await say(t('voice.say.failed', { message: err?.message || '' })); }
        break;
      }
      default:
        await say(t('voice.say.unknown'));
    }
    return intent;
  }

  return { hear, confirm, cancel, state, get pending() { return state.pending; } };
}
