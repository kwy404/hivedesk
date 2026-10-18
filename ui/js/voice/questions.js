// Clarifying question cards by voice. The crew sends
//   crew.question { id, questions: [{ id, text, multi, options: [{ id, label, description, recommended }] }] }
// Mel reads each question with its options (the recommended one first), understands "the second one",
// "number 3", an option's label, "both" or "decide for you", says the choice back, and after a yes
// sends crew.answer { questionId, answers: { [id]: { options } } } or { questionId, decide: true }
// (docs/1.0/DOMAINS.md). This adapter is the one place that knows the shape.
import { fold, isCjk, phrases } from './intents.js';

/** The options in speaking order: the recommended ones first, the others as the card lists them. */
export function spokenOrder(q) {
  const opts = (q?.options || []).map((o, i) => ({ ...o, index: i }));
  return [...opts.filter((o) => o.recommended), ...opts.filter((o) => !o.recommended)];
}

/** What Mel says for one question. */
export function speakQuestion(q, t, n = 1, total = 1) {
  const order = spokenOrder(q);
  const opts = order.map((o, k) => t(o.recommended ? 'voice.q.optionRecommended' : 'voice.q.option', { n: k + 1, label: o.label }));
  return [
    total > 1 ? t('voice.q.nth', { n, total }) : '',
    String(q.text || '').trim(),
    opts.join(' '),
    t(q.multi ? 'voice.q.howMulti' : 'voice.q.how'),
  ].filter(Boolean).join(' ');
}

/** "first,one|second,two|..." into [["first","one"],["second","two"],...] (folded). */
function ordinals(t) {
  const raw = t('voice.lex.ordinals');
  if (!raw || raw === 'voice.lex.ordinals') return [];
  return raw.split('|').map((pos) => pos.split(',').map((w) => fold(w)).filter(Boolean));
}

function hasPhrase(f, list, cjk) {
  return list.some((p) => (cjk ? f.replace(/\s/g, '').includes(p.replace(/\s/g, '')) : ` ${f} `.includes(` ${p} `)));
}

/**
 * Reads the answer to one question.
 * Numbers and ordinals count in the spoken order (the recommended option was "the first one").
 * @returns {{ kind: 'pick', indexes: number[] } | { kind: 'decide' } | null}  indexes into q.options
 */
export function parseChoice(text, q, t, lang) {
  const f = fold(text);
  if (!f) return null;
  const cjk = isCjk(lang);
  const order = spokenOrder(q);
  if (hasPhrase(f, [...phrases(t, 'voice.lex.decide'), 'decide for me', 'you decide', 'decide for you'], cjk)) return { kind: 'decide' };
  if (q.multi && hasPhrase(f, phrases(t, 'voice.lex.both'), cjk)) return { kind: 'pick', indexes: order.map((o) => o.index) };
  const picked = new Set();
  // option labels, longest first, so "dark blue" wins over "blue"
  const labels = order.map((o) => ({ o, l: fold(o.label) })).filter((x) => x.l).sort((a, b) => b.l.length - a.l.length);
  let rest = cjk ? f.replace(/\s/g, '') : ` ${f} `;
  for (const { o, l } of labels) {
    const key = cjk ? l.replace(/\s/g, '') : ` ${l} `;
    if (rest.includes(key)) { picked.add(o.index); rest = rest.split(key).join(' '); }
  }
  // digits: "number 3", "2"
  for (const m of f.matchAll(/(?:^|\D)(\d{1,2})(?!\d)/g)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= order.length) picked.add(order[n - 1].index);
  }
  // ordinal words: "the second one"
  const ords = ordinals(t);
  ords.forEach((words, k) => {
    if (k >= order.length) return;
    if (hasPhrase(cjk ? f : rest.trim(), words, cjk)) picked.add(order[k].index);
  });
  if (!picked.size) return null;
  const indexes = [...picked];
  if (!q.multi && indexes.length > 1) return null; // two answers to a one answer question: ask again
  return { kind: 'pick', indexes };
}

/** What Mel says back before sending. */
export function confirmText(q, choice, t) {
  if (choice.kind === 'decide') return t('voice.q.confirmDecide');
  const labels = choice.indexes.map((i) => q.options[i]?.label).filter(Boolean);
  return t('voice.q.confirm', { choice: labels.join(', ') });
}

/**
 * The crew.answer payload for all questions of a card (docs/1.0/DOMAINS.md):
 *   { questionId, answers: { [questionId]: { options: [optionId] } } }, or { questionId, decide: true } when
 *   every question was left to Mel. A single question left to Mel takes its recommended option (the default
 *   the crew would use), so a card is never half answered.
 * @param {{ id: string, questions: any[] }} card
 * @param {Record<string, { kind: 'pick', indexes: number[] } | { kind: 'decide' }>} choices  by question id
 */
export function toAnswer(card, choices) {
  const qs = card.questions || [];
  if (qs.every((q) => !choices[q.id] || choices[q.id].kind === 'decide')) return { questionId: card.id, decide: true };
  const idOf = (o) => (typeof o?.id === 'string' && o.id ? o.id : o?.label);
  const answers = {};
  for (const q of qs) {
    const c = choices[q.id];
    const picked = c && c.kind === 'pick'
      ? c.indexes.map((i) => q.options[i]).filter(Boolean)
      : (q.options.filter((o) => o.recommended).slice(0, q.multi ? undefined : 1));
    const opts = (picked.length ? picked : [q.options[0]]).map(idOf).filter(Boolean);
    answers[q.id] = { options: opts };
  }
  return { questionId: card.id, answers };
}

/** Rejects a card that does not have the shape this adapter knows. */
export function validCard(card) {
  return !!card && typeof card.id === 'string' && Array.isArray(card.questions) && card.questions.length > 0
    && card.questions.every((q) => q && typeof q.id === 'string' && Array.isArray(q.options) && q.options.length > 0);
}
