// The question card: Mel's clarifying questions before a plan (src/crew/domains/questions.js). When a job
// asks, the card opens as a centered sheet over the desk (the style of the profile sheet): the questions,
// options as full width rows (number, label, Recommended, the tradeoff), Other, Decide for me, Continue.
// Keys 1 to 5 pick an option of the question that has the focus, Enter continues, Esc closes the sheet and
// leaves the card pending. The chat shows one compact line ("Mel has 2 questions") that opens it again.
// Its words come from the engine in the language of the request (crew.question labels).
// Engine contract: the crew.question event, the crew.answer and crew.questions commands, crew.answered.

import { h } from '../dom.js';
import { command } from '../net.js';
import { onEvent } from '../store.js';
import { notify } from '../notify.js';
import { t, has } from '../i18n.js';

/** id -> { id, questions, defaults, labels, seq, answered? } */
const cards = new Map();
/** id -> the mounted card elements, updated in place when the answer arrives. */
const mounted = new Map();
let hydrating = null;

const tt = (key, fallback, params) => (has(key) ? t(key, params) : fallback);

/** Cards whose sheet opened by itself once in this window (a reload does not pop it again). */
const autoOpened = new Set();
const FRESH_MS = 2 * 60_000;

onEvent((ev) => {
  if (ev.type === 'crew.question' && ev.data?.id) {
    const c = { ...ev.data, seq: ev.seq, jobId: ev.jobId };
    cards.set(ev.data.id, c);
    // A question asked just now opens the sheet; one from the history waits for a click on its line.
    const fresh = !ev.ts || Date.now() - Date.parse(ev.ts) < FRESH_MS;
    if (fresh && !autoOpened.has(c.id) && typeof document !== 'undefined') { autoOpened.add(c.id); setTimeout(() => { if (!cards.get(c.id)?.answered) openSheet(c); }, 0); }
  }
  if (ev.type === 'crew.answered' && ev.data?.id) {
    const c = cards.get(ev.data.id);
    if (c) c.answered = ev.data;
    for (const el of mounted.get(ev.data.id) || []) el.__answered?.(ev.data);
    if (sheet?.id === ev.data.id) closeSheet();
  }
});

/** The open cards from the engine, for a desktop that connected after the question was asked. */
function hydrate() {
  hydrating ||= command('crew.questions').then((r) => {
    for (const q of r?.questions || []) if (!cards.has(q.id)) cards.set(q.id, { ...q, seq: -1 });
  }).catch(() => {}).finally(() => { setTimeout(() => { hydrating = null; }, 2000); });
  return hydrating;
}

/** The card a chat line announces: the last crew.question before it (or the open one after a reload). */
function cardOf(m) {
  let best = null;
  for (const c of cards.values()) if (c.seq >= 0 && c.seq <= (m.seq ?? Infinity) && (!best || c.seq > best.seq)) best = c;
  if (!best) for (const c of cards.values()) if (!c.answered) best = c;
  return best;
}

/** True for the chat line that carries a question card. */
export const isQuestionLine = (m) => m?.i18n?.key === 'domains.ask.card';

/**
 * The card element for a chat line, or null. Lines from before this session (no card known) show
 * their text only; the card fills in when the engine says it is still open.
 */
export function questionCard(m, fallback) {
  if (!isQuestionLine(m)) return null;
  const host = h('div', { class: 'qcard-host' });
  const draw = (last) => {
    const c = cardOf(m);
    if (c) host.replaceChildren(questionLine(c));
    else if (last && fallback) host.replaceChildren(h('div', { class: 'msg-b' }, fallback()));
    return !!c;
  };
  if (!draw(false)) hydrate().then(() => draw(true));
  injectStyle();
  return host;
}

const labelsOf = (c) => ({
  sheet: c.labels?.sheet || tt('domains.ask.sheet', `Mel has ${c.questions.length} questions`, { n: c.questions.length }),
  answered: c.labels?.answered || tt('domains.ask.answered', 'Decided'),
  later: c.labels?.later || tt('domains.ask.later', 'Answer later'),
});

/** The compact chat line: "Mel has 2 questions", a button that opens the sheet; "Decided: ..." once answered. */
function questionLine(c) {
  const L = labelsOf(c);
  const btn = h('button', { type: 'button', class: 'qline', on: { click: () => openSheet(c) } },
    h('span', { class: 'qline-dot', 'aria-hidden': 'true' }), h('span', { class: 'qline-t', text: L.sheet }));
  const box = h('div', { class: 'qline-box' }, btn);
  box.__answered = (a) => box.replaceChildren(h('p', { class: 'qcard-done', text: `${L.answered}: ${a.summary || ''}` }));
  if (!mounted.has(c.id)) mounted.set(c.id, new Set());
  mounted.get(c.id).add(box);
  if (c.answered) box.__answered(c.answered);
  return box;
}

/* ---------- the sheet ---------- */
let sheet = null; // { id, el, back, prevFocus }

/** Opens the card as a centered sheet. Esc or "Answer later" closes it; the card stays pending. */
export function openSheet(c) {
  if (typeof document === 'undefined' || !c || c.answered) return null;
  if (sheet?.id === c.id) { sheet.el.querySelector('.qcard')?.focus(); return sheet; }
  closeSheet();
  injectStyle();
  const L = labelsOf(c);
  const card = renderCard(c, { sheet: true });
  const close = h('button', { type: 'button', class: 'btn btn-sm btn-quiet qsheet-later', text: L.later, on: { click: () => closeSheet() } });
  const el = h('section', { class: 'qsheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': L.sheet },
    h('header', { class: 'qsheet-head' },
      h('h2', { class: 'qsheet-title', text: L.sheet }),
      c.subject ? h('p', { class: 'qsheet-sub', text: c.subject }) : null),
    card,
    h('footer', { class: 'qsheet-foot' }, close));
  const back = h('div', { class: 'qsheet-back', on: { mousedown: (e) => { if (e.target === back) closeSheet(); } } }, el);
  back.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeSheet(); } });
  sheet = { id: c.id, el, back, prevFocus: document.activeElement };
  document.body.append(back);
  card.focus();
  return sheet;
}

export function closeSheet() {
  if (!sheet) return;
  const { back, prevFocus } = sheet;
  sheet = null;
  back.remove();
  try { prevFocus?.focus?.(); } catch { /* gone */ }
}

function renderCard(c, { sheet: asSheet = false } = {}) {
  const L = {
    recommended: c.labels?.recommended || tt('domains.ask.recommended', 'Recommended'),
    other: c.labels?.other || tt('domains.ask.other', 'Other'),
    otherHint: c.labels?.otherHint || tt('domains.ask.otherHint', 'Write your own answer'),
    decide: c.labels?.decide || tt('domains.ask.decide', 'Decide for me'),
    send: asSheet ? (c.labels?.continue || tt('domains.ask.continue', 'Continue')) : (c.labels?.send || tt('domains.ask.send', 'Start with these')),
    multi: c.labels?.multi || tt('domains.ask.multi', 'pick one or more'),
    keys: c.labels?.keys || tt('domains.ask.keys', 'Keys 1 to 5 pick, Enter starts'),
    answered: c.labels?.answered || tt('domains.ask.answered', 'Decided')
  };
  /** questionId -> { options: Set, other: string } */
  const picks = new Map(c.questions.map((q) => [q.id, { options: new Set(), other: '' }]));
  let active = 0;
  const groups = [];
  const sendBtn = h('button', { type: 'button', class: 'btn btn-sm btn-primary', text: L.send, disabled: true });
  const decideBtn = h('button', { type: 'button', class: 'btn btn-sm', text: L.decide });
  const status = h('p', { class: 'qcard-status', role: 'status' });
  const complete = () => c.questions.every((q) => { const p = picks.get(q.id); return p.options.size || p.other.trim(); });
  const refresh = () => {
    c.questions.forEach((q, qi) => {
      const p = picks.get(q.id);
      for (const b of groups[qi].buttons) {
        const on = p.options.has(b.dataset.id);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        b.classList.toggle('on', on);
      }
      groups[qi].el.classList.toggle('active', qi === active);
    });
    sendBtn.disabled = !complete();
  };
  const pick = (qi, id) => {
    const q = c.questions[qi];
    const p = picks.get(q.id);
    if (q.multi) { if (p.options.has(id)) p.options.delete(id); else p.options.add(id); }
    else { p.options = new Set([id]); p.other = ''; groups[qi].other.value = ''; }
    if (!q.multi && qi < c.questions.length - 1 && !picks.get(c.questions[qi + 1].id).options.size) active = qi + 1;
    refresh();
  };

  const body = c.questions.map((q, qi) => {
    const buttons = q.options.map((o, i) => h('button', {
      type: 'button', class: 'qopt', 'data-id': o.id, 'aria-pressed': 'false',
      title: o.recommended && o.reason ? `${L.recommended}: ${o.reason}` : o.description,
      on: { click: () => { active = qi; pick(qi, o.id); } }
    },
    h('span', { class: 'qopt-k', text: String(i + 1), 'aria-hidden': 'true' }),
    h('span', { class: 'qopt-t' },
      h('span', { class: 'qopt-l', text: o.label }),
      o.recommended ? h('span', { class: 'qopt-rec', text: L.recommended }) : null,
      h('span', { class: 'qopt-d', text: o.description }),
      o.recommended && o.reason ? h('span', { class: 'qopt-why', text: o.reason }) : null)));
    const other = h('input', {
      class: 'qopt-other', type: 'text', maxlength: '300', placeholder: L.otherHint, 'aria-label': `${q.text} ${L.other}`,
      on: { input: (e) => { const p = picks.get(q.id); p.other = e.target.value; if (!q.multi && p.other.trim()) p.options.clear(); active = qi; refresh(); } }
    });
    const el = h('fieldset', { class: 'qgroup', on: { focusin: () => { active = qi; refresh(); } } },
      h('legend', { class: 'qtext', text: `${q.text}${q.multi ? ` (${L.multi})` : ''}` }),
      h('div', { class: 'qopts', role: q.multi ? 'group' : 'radiogroup' }, ...buttons),
      h('label', { class: 'qother' }, h('span', { text: L.other }), other));
    groups.push({ el, buttons, other });
    return el;
  });

  const answers = () => Object.fromEntries(c.questions.map((q) => {
    const p = picks.get(q.id);
    return [q.id, { options: [...p.options], ...(p.other.trim() ? { other: p.other.trim() } : {}) }];
  }));
  const submit = async (decide) => {
    sendBtn.disabled = true;
    decideBtn.disabled = true;
    try {
      await command('crew.answer', decide ? { questionId: c.id, decide: true } : { questionId: c.id, answers: answers() });
    } catch (err) {
      notify({ title: tt('domains.ask.failed', 'Could not send the answers'), body: err.message, tone: 'bad' });
      decideBtn.disabled = false;
      refresh();
    }
  };
  sendBtn.addEventListener('click', () => submit(false));
  decideBtn.addEventListener('click', () => submit(true));

  const card = h('section', { class: `qcard${asSheet ? ' in-sheet' : ''}`, tabindex: '0', 'aria-label': tt('domains.ask.title', 'Questions before the plan') },
    ...body,
    c.defaults ? h('p', { class: 'qcard-defaults', text: c.labels?.defaultsLine || tt('domains.ask.defaults', `I will use: ${c.defaults}.`, { defaults: c.defaults }) }) : null,
    h('div', { class: 'qcard-actions' }, sendBtn, decideBtn, h('span', { class: 'qcard-keys', text: L.keys })),
    status);
  card.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) { if (e.key === 'Enter' && complete()) { e.preventDefault(); submit(false); } return; }
    const n = Number(e.key);
    if (n >= 1 && n <= 5) {
      const q = c.questions[active];
      if (q?.options[n - 1]) { e.preventDefault(); pick(active, q.options[n - 1].id); }
    } else if (e.key === 'Enter' && complete()) { e.preventDefault(); submit(false); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { active = Math.max(0, Math.min(c.questions.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1))); refresh(); }
  });
  card.__answered = (a) => {
    const done = h('p', { class: 'qcard-done', text: `${L.answered}: ${a.summary || ''}` });
    card.replaceChildren(done);
    card.classList.add('answered');
  };
  if (!mounted.has(c.id)) mounted.set(c.id, new Set());
  mounted.get(c.id).add(card);
  if (c.answered) card.__answered(c.answered);
  refresh();
  injectStyle();
  return card;
}

let styled = false;
function injectStyle() {
  if (styled) return;
  styled = true;
  document.head.append(h('style', { 'data-for': 'question-card', text: `
.qcard { margin-top: 8px; padding: 12px; border-radius: var(--r-ctl, 9px); background: var(--panel-2, #1F1B17); border: 1px solid var(--line-2, rgb(242 233 218 / .11)); display: grid; gap: 12px; max-width: 640px; }
.qcard:focus-visible { outline: 2px solid var(--honey, #FFB531); outline-offset: 2px; }
.qgroup { border: 0; margin: 0; padding: 0; display: grid; gap: 6px; min-width: 0; }
.qgroup.active .qtext { color: var(--text, #F2E9DA); }
.qtext { padding: 0; font-weight: 600; font-size: 13px; color: var(--text-2, #CFC4B3); }
.qopts { display: grid; gap: 6px; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); }
.qopt { display: flex; gap: 8px; align-items: flex-start; text-align: left; padding: 8px 10px; border-radius: var(--r-sm, 6px); border: 1px solid var(--line-2, rgb(242 233 218 / .11)); background: var(--bg-2, #141210); color: var(--text-2, #CFC4B3); font: inherit; cursor: pointer; }
.qopt:hover { border-color: var(--line-3, rgb(242 233 218 / .17)); }
.qopt:focus-visible { outline: 2px solid var(--honey, #FFB531); outline-offset: 1px; }
.qopt.on { border-color: var(--honey, #FFB531); background: var(--honey-a, rgb(255 181 49 / .12)); color: var(--text, #F2E9DA); }
.qopt-k { flex: none; width: 18px; height: 18px; border-radius: 5px; display: grid; place-items: center; font-size: 11px; background: var(--panel-3, #27221D); color: var(--muted-t, #8C8172); }
.qopt.on .qopt-k { background: var(--honey, #FFB531); color: var(--honey-ink, #1A1206); }
.qopt-t { display: grid; gap: 2px; min-width: 0; }
.qopt-l { font-weight: 600; font-size: 13px; color: var(--text, #F2E9DA); }
.qopt-rec { justify-self: start; font-size: 10.5px; padding: 0 6px; border-radius: 999px; background: var(--ok-a, rgb(125 196 155 / .13)); color: var(--ok, #7DC49B); }
.qopt-d { font-size: 12px; line-height: 1.45; }
.qopt-why { font-size: 11.5px; color: var(--muted-t, #8C8172); }
.qother { display: flex; gap: 8px; align-items: center; font-size: 12px; color: var(--muted-t, #8C8172); }
.qopt-other { flex: 1; min-width: 0; padding: 6px 8px; border-radius: var(--r-sm, 6px); border: 1px solid var(--line-2, rgb(242 233 218 / .11)); background: var(--bg-2, #141210); color: var(--text, #F2E9DA); font: inherit; font-size: 12px; }
.qopt-other:focus-visible { outline: 2px solid var(--honey, #FFB531); }
.qcard-defaults { margin: 0; font-size: 12px; color: var(--muted-t, #8C8172); }
.qcard-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.qcard-keys { font-size: 11px; color: var(--faint, #645B50); }
.qcard-status { margin: 0; min-height: 0; font-size: 12px; }
.qcard.answered { padding: 8px 12px; }
.qcard-done { margin: 0; font-size: 12.5px; color: var(--text-2, #CFC4B3); }
@media (max-width: 480px) { .qopts { grid-template-columns: 1fr; } }
.qline-box { margin-top: 6px; }
.qline { display: inline-flex; gap: 8px; align-items: center; padding: 6px 12px; border-radius: 999px; border: 1px solid var(--honey, #FFB531); background: var(--honey-a, rgb(255 181 49 / .12)); color: var(--text, #F2E9DA); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
.qline:hover { background: var(--honey-a2, rgb(255 181 49 / .2)); }
.qline:focus-visible { outline: 2px solid var(--honey, #FFB531); outline-offset: 2px; }
.qline-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--honey, #FFB531); }
.qsheet-back { position: fixed; inset: 0; z-index: 9000; display: grid; place-items: center; padding: 24px 16px; background: var(--scrim, rgb(8 9 11 / .62)); }
.qsheet { width: min(640px, 100%); max-height: calc(100vh - 48px); overflow: auto; display: grid; gap: 14px; padding: 22px 24px; border-radius: var(--r-card, 14px); background: var(--panel, #181B20); border: 1px solid var(--line-2, rgb(242 233 218 / .11)); box-shadow: var(--shadow-3, 0 24px 60px rgb(0 0 0 / .45)); }
.qsheet-head { display: grid; gap: 4px; }
.qsheet-title { margin: 0; font-size: 20px; font-weight: 650; color: var(--text, #F2E9DA); }
.qsheet-sub { margin: 0; font-size: 13px; color: var(--muted-t, #8C8172); }
.qcard.in-sheet { margin: 0; padding: 0; border: 0; background: none; max-width: none; gap: 18px; }
.qcard.in-sheet .qtext { font-size: 14.5px; }
.qcard.in-sheet .qopts { grid-template-columns: 1fr; }
.qcard.in-sheet .qopt { padding: 10px 12px; }
.qcard.in-sheet .qopt-t { grid-template-columns: auto 1fr; column-gap: 8px; align-items: center; }
.qcard.in-sheet .qopt-l, .qcard.in-sheet .qopt-rec { grid-row: 1; }
.qcard.in-sheet .qopt-d, .qcard.in-sheet .qopt-why { grid-column: 1 / -1; }
.qsheet-foot { display: flex; justify-content: flex-end; }
@media (prefers-reduced-motion: no-preference) { .qsheet { animation: qsheet-in .18s cubic-bezier(.2,0,0,1); } @keyframes qsheet-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } } }
@media (prefers-reduced-motion: no-preference) { .qopt { transition: border-color var(--t-fast, .12s), background var(--t-fast, .12s); } }
` }));
}
