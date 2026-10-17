// #general and direct chats with a worker.

import { h, icon, clear, fmtTime, richText, syncList } from '../dom.js';
import { beeAvatar } from '../bees.js';
import { register } from '../wm.js';
import { S, rev, ui, worker } from '../store.js';
import { provide } from '../menu.js';
import * as act from '../actions.js';
import { t, fmtList } from '../i18n.js';
import { track, stickyScroll, stateBox } from './util.js';
import * as wm from '../wm.js';

function quoteOf(text) {
  const m = /^> (.*)\n/.exec(text || '');
  return m ? { quote: m[1], rest: text.slice(m[0].length) } : { quote: null, rest: text };
}

function msgNode(m, prev) {
  if (m.from === 'system') {
    return h('div', { class: `msg sys${/demo/i.test(m.text) ? ' demo-note' : ''}`, role: 'listitem' }, h('div', { class: 'msg-b', text: m.text }));
  }
  const w = worker(m.from);
  const cont = prev && prev.from === m.from && prev.from !== 'system' && Date.parse(m.ts) - Date.parse(prev.ts) < 180000;
  const { quote, rest } = quoteOf(m.text);
  const el = h('div', { class: `msg${cont ? ' cont' : ''}${m.from === 'user' ? ' me' : ''}`, role: 'listitem', tabindex: '-1' },
    beeAvatar(m.from === 'user' ? { ...w, role: 'you' } : w, 30, { ring: true }),
    h('div', { style: 'min-width:0' },
      h('div', { class: 'msg-h' },
        h('span', { class: 'msg-n', text: w.name, style: m.from !== 'user' ? `color:color-mix(in oklab, ${w.color || '#FFB531'} 55%, #F2E9DA)` : '' }),
        w.role && m.from !== 'user' ? h('span', { class: 'msg-r', text: w.role }) : null,
        h('span', { class: 'msg-t', text: fmtTime(m.ts) })),
      quote ? h('div', { class: 'reply-to', text: quote }) : null,
      h('div', { class: 'msg-b' }, richText(rest))));
  if (m.from === 'user') el.querySelector('.bee-av').replaceWith(youAvatar());
  el.__msg = m;
  return el;
}

function youAvatar() {
  return h('span', { class: 'bee-av', style: '--av:30px', 'aria-hidden': 'true', html: '<svg viewBox="0 0 30 30"><path d="M15 1.5 27.5 8.5v13L15 28.5 2.5 21.5v-13z" fill="#2A251F" stroke="rgba(242,233,218,.18)"/><circle cx="15" cy="12.4" r="4.2" fill="#8C8172"/><path d="M7.8 22.2c1.3-3.6 4-5.2 7.2-5.2s5.9 1.6 7.2 5.2" fill="#8C8172"/></svg>' });
}

/**
 * Chat feed with a composer.
 * @param {string} channel "general" or "dm:<workerId>"
 * @param {{ placeholder?: string, emptyTitle?: string, emptyText?: string, args?: object }} [opts]
 *   translation keys (not text): the composer placeholder, the empty state title and text;
 *   `args` are the parameters for those keys
 */
export function chatFeed(channel, { placeholder, emptyTitle, emptyText, args } = {}) {
  const feed = h('div', { class: 'feed', role: 'list', 'aria-live': 'polite', 'aria-relevant': 'additions' });
  const pane = h('div', { class: 'pane' }, feed);
  const typing = h('div', { class: 'typing', 'aria-live': 'polite' });
  const replyBar = h('div', { class: 'replying', hidden: true });
  const ta = h('textarea', { rows: 1, tp: placeholder || 'chat.placeholder', ta: placeholder || 'chat.messageLabel', txArgs: args, 'data-autofocus': '' });
  const send = h('button', { type: 'button', class: 'btn btn-sm btn-primary', ta: 'chat.send', tip: 'tip.chat.send', kb: 'Enter' }, icon('arrow', 'ico-sm'));
  const composer = h('div', { class: 'composer' }, ta, send);
  const root = h('div', { class: 'win-body', style: 'display:flex;flex-direction:column;min-height:0;flex:1' }, pane, typing, replyBar, composer);
  const sticky = stickyScroll(pane);
  let replyTo = null;

  const setReply = (m) => {
    replyTo = m;
    clear(replyBar);
    replyBar.hidden = !m;
    if (m) {
      const w = worker(m.from);
      replyBar.append(icon('chat', 'ico-sm'), h('span', { class: 'grow ellipsis', tx: 'chat.replyingTo', txArgs: { name: w.name, text: quoteOf(m.text).rest.split('\n')[0] } }),
        h('button', { class: 'ibtn ibtn-sm', type: 'button', ta: 'chat.cancelReply', tip: 'tip.chat.cancelReply', on: { click: () => setReply(null) } }, icon('x', 'ico-sm')));
      ta.focus();
    }
  };

  const autosize = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(140, ta.scrollHeight + 2)}px`; };
  ta.addEventListener('input', autosize);
  const submit = async () => {
    const text = ta.value.trim();
    if (!text || ui.replay) return;
    const full = replyTo ? `> ${quoteOf(replyTo.text).rest.split('\n')[0].slice(0, 120)}\n${text}` : text;
    ta.value = '';
    autosize();
    setReply(null);
    const r = await act.sendChat(channel, full);
    if (!r) ta.value = text;
  };
  send.addEventListener('click', submit);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } });

  provide(feed, (target) => {
    const el = target.closest?.('.msg');
    const m = el?.__msg;
    if (!m) return null;
    const sel = String(getSelection() || '');
    return [
      { label: sel ? t('chat.menu.copySelection') : t('chat.menu.copyMessage'), icon: 'copy', kb: 'Ctrl+C', action: () => act.copy(sel || quoteOf(m.text).rest, t('chat.copied')) },
      { label: t('chat.menu.reply'), icon: 'chat', disabled: m.from === 'user' || !!ui.replay, action: () => setReply(m) },
      m.from !== 'user' && m.from !== 'system' && !channel.startsWith('dm:') ? { label: t('chat.menu.chatWith', { name: worker(m.from).name }), icon: 'arrow', action: () => wm.open('worker', m.from) } : null,
    ];
  });

  let shown = 0;
  track(() => [rev.chat, rev.crew, ui.replay], () => {
    const list = S().chat[channel] || [];
    const pinned = sticky.before();
    if (!list.length) {
      clear(feed);
      feed.append(stateBox({ icon: 'chat', title: t(emptyTitle || 'chat.empty.title', args), text: t(emptyText || 'chat.empty.text', args) }));
      shown = 0;
      return;
    }
    if (feed.querySelector('.state')) clear(feed);
    syncList(feed, list, (m) => m.id || `s${m.seq}`, (m) => msgNode(m, list[list.indexOf(m) - 1]));
    sticky.after(list.length !== shown && pinned);
    shown = list.length;
    composer.hidden = !!ui.replay;
  });

  track(() => [rev.workers, rev.queue, rev.crew], () => {
    const s = S();
    clear(typing);
    const ids = channel.startsWith('dm:') ? [channel.slice(3)] : s.crew.map((w) => w.id);
    const thinking = ids.filter((id) => ['thinking', 'tool'].includes(s.workers[id]?.status)).map((id) => worker(id).name);
    const waiting = ids.filter((id) => s.workers[id]?.status === 'queued').map((id) => worker(id).name);
    if (!thinking.length && !waiting.length) return;
    if (thinking.length) typing.append(h('span', { class: 'dots' }, h('i'), h('i'), h('i')), h('span', { text: t('chat.thinking', { names: names(thinking), count: thinking.length }) }));
    if (waiting.length) typing.append(h('span', { class: 'faint', text: `${thinking.length ? '· ' : ''}${t('chat.waiting', { names: names(waiting), count: waiting.length })}` }));
  });
  return { root, focus: () => ta.focus(), setReply, prefill: (text) => { ta.value = text; autosize(); ta.focus(); ta.setSelectionRange(text.length, text.length); } };
}

/** "Dev and QA", or "Dev, QA and 2 more" in the current language. */
function names(list) {
  if (list.length <= 2) return fmtList(list);
  return t('chat.namesMore', { first: list[0], second: list[1], count: list.length - 2 });
}

register('chat', {
  title: '#general',
  glyph: () => icon('chat'),
  size: [440, 520],
  min: [300, 240],
  cardH: 480,
  create(ctx) {
    const c = chatFeed('general', { placeholder: 'chat.placeholderGeneral' });
    ctx.body.append(c.root);
    track(() => [rev.chat], () => {
      const n = (S().chat.general || []).length;
      ctx.setSub(n ? t('chat.count', { count: n }) : '');
    });
  },
});
