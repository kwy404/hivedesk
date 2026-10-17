// A small, safe markdown renderer for CHANGELOG.md: headings, lists, paragraphs, links
// (http and https only), inline code, bold and italics. Everything is escaped first, so no
// HTML from the file reaches the page. Link reference lines ([1.0.0]: url) resolve [x] links.

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const safeUrl = (u) => (/^https?:\/\//i.test(u) ? u : null);

function inline(text, refs) {
  const codes = [];
  let s = esc(text).replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    const u = safeUrl(url.replace(/&amp;/g, '&'));
    return u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
  });
  s = s.replace(/\[([^\]]+)\](?!\()/g, (m, label) => {
    const u = refs.get(label.replace(/&amp;/g, '&').toLowerCase());
    return u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${label}</a>` : m;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>').replace(/(^|[\s(])_([^_\s][^_]*)_(?=[\s.,;:)]|$)/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (m, i) => `<code>${codes[Number(i)]}</code>`);
}

export function renderMarkdown(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const refs = new Map();
  for (const l of lines) {
    const m = /^\[([^\]]+)\]:\s*(\S+)/.exec(l);
    if (m && safeUrl(m[2])) refs.set(m[1].toLowerCase(), m[2]);
  }
  const out = [];
  let list = null;
  let para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '), refs)}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<ul>${list.map((i) => `<li>${inline(i, refs)}</li>`).join('')}</ul>`); list = null; } };
  for (const line of lines) {
    if (/^\[([^\]]+)\]:\s*\S+/.test(line)) continue;
    const hd = /^(#{1,6})\s+(.*)$/.exec(line);
    if (hd) {
      flushPara(); flushList();
      const lvl = Math.min(hd[1].length + 1, 6);
      const cls = hd[1].length === 3 ? ` class="cl-sec cl-${hd[2].trim().toLowerCase().replace(/[^a-z]/g, '')}"` : '';
      out.push(`<h${lvl}${cls}>${inline(hd[2], refs)}</h${lvl}>`);
      continue;
    }
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) { flushPara(); (list ||= []).push(li[1]); continue; }
    if (list && /^\s{2,}\S/.test(line)) { list[list.length - 1] += ` ${line.trim()}`; continue; }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    flushList();
    para.push(line.trim());
  }
  flushPara(); flushList();
  return out.join('\n');
}
