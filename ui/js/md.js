// Safe markdown for what the model writes: chat lines, the last turn, briefs, reports, tasks, Activity.
// Everything is escaped first, then a small set of marks becomes HTML: bold, italics, inline code, code
// blocks (with a copy button), ordered and unordered lists, headings (scaled down), links (http and https
// only, rel noopener) and paragraphs. No raw HTML, no images. No DOM here, so Node tests import it;
// mdNode() in dom.js puts the result in the page. mdStrip() gives plain text for one line places
// (speech bubbles, notifications, toasts, titles).

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const unesc = (s) => String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** An http or https URL as given, or null (javascript:, data:, relative and the rest are refused). */
export function safeUrl(u) {
  const s = String(u || '').trim();
  if (!/^https?:\/\/[^\s<>"']+$/i.test(s)) return null;
  try {
    const url = new URL(s);
    return url.protocol === 'http:' || url.protocol === 'https:' ? s : null;
  } catch {
    return null;
  }
}

/** Inline marks of one escaped line: code first (its content stays literal), then links, bold, italics. */
function inline(text) {
  const codes = [];
  const keep = (html) => { codes.push(html); return `\u0000${codes.length - 1}\u0000`; };
  let s = esc(text).replace(/\u0000/g, '');
  s = s.replace(/`([^`\n]+)`/g, (m, c) => keep(`<code class="ic">${c}</code>`));
  // Images are not shown: ![alt](url) stays as its alt text.
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]*)\)/g, (m, alt) => alt);
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    const u = safeUrl(unesc(url));
    return u ? keep(`<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${label}</a>`) : label;
  });
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>()]+[^\s<>().,;:!?])/g, (m, pre, url) => {
    const u = safeUrl(unesc(url));
    return u ? `${pre}${keep(`<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${url}</a>`)}` : m;
  });
  s = s.replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, '<strong>$1</strong>').replace(/__(?=\S)([^_\n]*?\S)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, '$1<em>$2</em>').replace(/(^|[^_\w])_(?=\S)([^_\n]*?\S)_(?![_\w])/g, '$1<em>$2</em>');
  s = s.replace(/~~(?=\S)([^~\n]*?\S)~~/g, '<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g, (m, i) => codes[Number(i)]);
}

/**
 * Markdown to safe HTML.
 * @param {string} md
 * @param {{ copyLabel?: string|false }} [o] copyLabel: the text of the copy button of code blocks (translated by
 *   the caller); false: no copy button
 */
export function mdToHtml(md, o = {}) {
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null; // { type: 'ul'|'ol', start, items: string[] }
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
  const flushList = () => {
    if (!list) return;
    const start = list.type === 'ol' && list.start !== 1 ? ` start="${list.start}"` : '';
    out.push(`<${list.type}${start}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.type}>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      flushPara(); flushList();
      const body = [];
      let j = i + 1;
      while (j < lines.length && !lines[j].trim().startsWith(fence[1])) body.push(lines[j++]);
      i = j;
      const lang = fence[2] ? ` data-lang="${esc(fence[2])}"` : '';
      const copy = esc(o.copyLabel || 'Copy');
      const button = o.copyLabel === false ? '' : `<button type="button" class="btn btn-xs btn-quiet md-copy" data-md-copy="" aria-label="${copy}">${copy}</button>`;
      out.push(`<div class="md-code">${button}<pre class="cb"${lang}><code>${esc(body.join('\n'))}</code></pre></div>`);
      continue;
    }
    const hd = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (hd) {
      flushPara(); flushList();
      // Scaled down: a chat line is no page, # is a small heading.
      const lvl = Math.min(hd[1].length + 3, 6);
      out.push(`<h${lvl} class="md-h">${inline(hd[2])}</h${lvl}>`);
      continue;
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*(\d{1,6})[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const type = ul ? 'ul' : 'ol';
      if (list && list.type !== type) flushList();
      if (!list) list = { type, start: ol ? Number(ol[1]) : 1, items: [] };
      list.items.push(ul ? ul[1] : ol[2]);
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1] += ` ${line.trim()}`; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushPara(); flushList(); out.push('<hr>'); continue; }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) { flushPara(); flushList(); out.push(`<blockquote>${inline(quote[1])}</blockquote>`); continue; }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    flushList();
    para.push(line.trim());
  }
  flushPara(); flushList();
  return out.join('');
}

/** Markdown to one plain line (or a few): marks gone, links as their label, code blocks as their text. */
export function mdStrip(md) {
  return String(md ?? '').replace(/\r\n?/g, '\n')
    .replace(/^\s*(```+|~~~+)[^\n]*$/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/__([^_\n]+)__/g, '$1')
    .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1$2').replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1$2')
    .replace(/~~([^~\n]+)~~/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** mdStrip on one line, for bubbles and toasts: newlines become spaces, cut at `max` characters. */
export function mdLine(md, max = 0) {
  const s = mdStrip(md).replace(/\s*\n\s*/g, ' ');
  return max && s.length > max ? `${s.slice(0, Math.max(1, max - 3)).replace(/\s+\S*$/, '')}...` : s;
}
