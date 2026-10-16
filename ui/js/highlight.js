// Tiny, safe syntax highlighter for the code viewer: JS/TS, JSON, CSS, HTML, Markdown,
// shell and Python. Output is built from escaped text only.

import { esc } from './dom.js';

const JS_KW = 'await break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield async true false null undefined';
const PY_KW = 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield';
const CSS_KW = 'important media supports keyframes import from to and not only screen';

function langOf(path = '') {
  const ext = path.split('.').pop().toLowerCase();
  if (['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx'].includes(ext)) return 'js';
  if (ext === 'json') return 'json';
  if (['css', 'scss'].includes(ext)) return 'css';
  if (['html', 'htm', 'svg', 'xml', 'vue'].includes(ext)) return 'html';
  if (['md', 'markdown'].includes(ext)) return 'md';
  if (['sh', 'bash', 'ps1'].includes(ext)) return 'sh';
  if (ext === 'py') return 'py';
  return 'txt';
}

const rules = {
  js: [
    ['c', /\/\/[^\n]*|\/\*[\s\S]*?\*\//y],
    ['s', /`(?:\\[\s\S]|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/y],
    ['n', /\b(?:0x[\da-f]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)\b/iy],
    ['w', /[A-Za-z_$][\w$]*/y],
  ],
  py: [
    ['c', /#[^\n]*/y],
    ['s', /"""[\s\S]*?"""|'''[\s\S]*?'''|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/y],
    ['n', /\b\d[\d_]*(?:\.\d+)?\b/y],
    ['w', /[A-Za-z_][\w]*/y],
  ],
  json: [
    ['a', /"(?:\\.|[^"\\\n])*"(?=\s*:)/y],
    ['s', /"(?:\\.|[^"\\\n])*"/y],
    ['n', /-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/iy],
    ['k', /\b(?:true|false|null)\b/y],
  ],
  css: [
    ['c', /\/\*[\s\S]*?\*\//y],
    ['s', /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/y],
    ['k', /@[\w-]+/y],
    ['a', /[\w-]+(?=\s*:(?!:))/y],
    ['n', /#[\da-f]{3,8}\b|-?\b\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|s|ms|deg|fr)?\b/iy],
    ['f', /[\w-]+(?=\()/y],
  ],
  sh: [
    ['c', /#[^\n]*/y],
    ['s', /'[^'\n]*'|"(?:\\.|[^"\\\n])*"/y],
    ['k', /\b(?:if|then|else|fi|for|do|done|in|echo|export|cd|npm|npx|node)\b/y],
  ],
};

function hlGeneric(src, lang) {
  const rs = rules[lang];
  const kw = new Set((lang === 'py' ? PY_KW : lang === 'css' ? CSS_KW : JS_KW).split(' '));
  let out = '';
  let i = 0;
  let plain = '';
  const flush = () => { if (plain) { out += esc(plain); plain = ''; } };
  outer: while (i < src.length) {
    for (const [cls, re] of rs) {
      re.lastIndex = i;
      const m = re.exec(src);
      if (m && m[0].length) {
        let c = cls;
        if (cls === 'w') {
          if (kw.has(m[0])) c = 'k';
          else if (src[i + m[0].length] === '(') c = 'f';
          else { plain += m[0]; i += m[0].length; continue outer; }
        }
        flush();
        out += `<span class="tk-${c}">${esc(m[0])}</span>`;
        i += m[0].length;
        continue outer;
      }
    }
    plain += src[i++];
  }
  flush();
  return out;
}

function hlHtml(src) {
  let out = '';
  const re = /(<!--[\s\S]*?-->)|(<\/?)([\w-]+)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?>)|([^<]+|<)/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[1]) out += `<span class="tk-c">${esc(m[1])}</span>`;
    else if (m[3]) {
      out += `<span class="tk-p">${esc(m[2])}</span><span class="tk-t">${esc(m[3])}</span>`;
      out += (m[4] || '').replace(/([^\s=]+)(\s*=\s*)?("[^"]*"|'[^']*'|[^\s>]+)?|\s+/g, (all, name, eq, val) => {
        if (!name) return esc(all);
        return `<span class="tk-a">${esc(name)}</span>${eq ? esc(eq) : ''}${val ? `<span class="tk-s">${esc(val)}</span>` : ''}`;
      });
      out += `<span class="tk-p">${esc(m[5])}</span>`;
    } else out += esc(m[6]);
  }
  return out;
}

function hlMd(src) {
  return src.split('\n').map((line) => {
    if (/^#{1,6}\s/.test(line)) return `<span class="tk-k">${esc(line)}</span>`;
    if (/^\s*([-*]|\d+\.)\s/.test(line)) return esc(line).replace(/^(\s*(?:[-*]|\d+\.))/, '<span class="tk-n">$1</span>');
    if (/^```/.test(line)) return `<span class="tk-c">${esc(line)}</span>`;
    return esc(line).replace(/`([^`]+)`/g, '<span class="tk-s">`$1`</span>');
  }).join('\n');
}

/** Returns highlighted HTML for the whole file. */
export function highlight(src, path) {
  const lang = langOf(path);
  if (src.length > 400000) return esc(src);
  if (lang === 'html') return hlHtml(src);
  if (lang === 'md') return hlMd(src);
  if (rules[lang]) return hlGeneric(src, lang);
  return esc(src);
}

/** Splits highlighted HTML into lines, closing and reopening spans across line breaks. */
export function toLines(html) {
  const lines = [];
  let open = [];
  let cur = '';
  const re = /(<span class="[^"]+">)|(<\/span>)|(\n)|([^<\n]+|<)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1]) { open.push(m[1]); cur += m[1]; }
    else if (m[2]) { open.pop(); cur += m[2]; }
    else if (m[3]) { cur += '</span>'.repeat(open.length); lines.push(cur); cur = open.join(''); }
    else cur += m[4];
  }
  lines.push(cur + '</span>'.repeat(open.length));
  return lines;
}

export function codeHtml(src, path) {
  return toLines(highlight(src, path)).map((l) => `<span class="l">${l || ' '}</span>`).join('');
}
