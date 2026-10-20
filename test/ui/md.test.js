// The safe markdown of model text (ui/js/md.js): the marks a small model writes become HTML, nothing
// else does, and one line places get plain text.
import { describe, it, expect } from 'vitest';
import { mdToHtml, mdStrip, mdLine, safeUrl } from '../../ui/js/md.js';

describe('mdToHtml', () => {
  it('renders the owner\'s plan: an ordered list with bold names, then a paragraph', () => {
    const html = mdToHtml('1. **Dev**: Crie um esboço da landing page em HTML e CSS.\n2. **Designer**: Adicione cores.\n\nEstamos prontos!');
    expect(html).toBe('<ol><li><strong>Dev</strong>: Crie um esboço da landing page em HTML e CSS.</li><li><strong>Designer</strong>: Adicione cores.</li></ol><p>Estamos prontos!</p>');
  });

  it('renders italics, inline code, lists, scaled down headings, quotes and code blocks with a copy button', () => {
    expect(mdToHtml('*leve* e _rápido_ com `index.html`')).toBe('<p><em>leve</em> e <em>rápido</em> com <code class="ic">index.html</code></p>');
    expect(mdToHtml('- um\n- dois')).toBe('<ul><li>um</li><li>dois</li></ul>');
    expect(mdToHtml('3. três\n4. quatro')).toBe('<ol start="3"><li>três</li><li>quatro</li></ol>');
    expect(mdToHtml('# Plano')).toBe('<h4 class="md-h">Plano</h4>');
    expect(mdToHtml('> nota')).toBe('<blockquote>nota</blockquote>');
    const code = mdToHtml('```html\n<h1>Oi</h1>\n```', { copyLabel: 'Copiar' });
    expect(code).toContain('<pre class="cb" data-lang="html"><code>&lt;h1&gt;Oi&lt;/h1&gt;</code></pre>');
    expect(code).toContain('data-md-copy');
    expect(code).toContain('>Copiar</button>');
    // Inside code, marks stay literal.
    expect(mdToHtml('`**a**`')).toBe('<p><code class="ic">**a**</code></p>');
    expect(mdToHtml('a  \nb')).toBe('<p>a<br>b</p>');
  });

  it('links only http and https, with rel noopener', () => {
    expect(mdToHtml('[site](https://example.com/a?b=1&c=2)')).toBe('<p><a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">site</a></p>');
    expect(mdToHtml('veja https://example.com.')).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">https://example.com</a>.');
    expect(mdToHtml('[x](javascript:alert(1))')).not.toContain('<a');
    expect(mdToHtml('[x](data:text/html,<script>alert(1)</script>)')).not.toMatch(/<a|<script/);
    expect(mdToHtml('[x](/local)')).toBe('<p>x</p>');
    expect(safeUrl('JaVaScRiPt:alert(1)')).toBe(null);
    expect(safeUrl('https://ok.example/')).toBe('https://ok.example/');
  });

  it('never lets HTML through (XSS)', () => {
    const cases = [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '![a](https://x.example/p.png" onerror="alert(1))',
      '**<b onmouseover=alert(1)>x</b>**',
      '[<img src=x onerror=alert(1)>](https://example.com)',
      '[ok](https://example.com" onclick="alert(1))',
      '```\n</code></pre><script>alert(1)</script>\n```',
      '<a href="javascript:alert(1)">x</a>',
      '`<svg onload=alert(1)>`',
      '# <iframe src=//evil.example>'
    ];
    for (const c of cases) {
      const html = mdToHtml(c);
      expect(html, c).not.toMatch(/<(?!\/?(?:p|br|strong|em|del|code|pre|ol|ul|li|h[1-6]|blockquote|hr|a|div|button)\b)[a-z]/i);
      expect(html, c).not.toMatch(/<[^>]+\son\w+=/i);
      expect(html, c).not.toMatch(/href="(?!https?:)/i);
      expect(html, c).not.toContain('<img');
      expect(html, c).not.toContain('<script');
    }
    // Images are never shown: the alt text stays.
    expect(mdToHtml('![logo](https://x.example/l.png)')).toBe('<p>logo</p>');
  });
});

describe('mdStrip and mdLine', () => {
  it('gives plain text for bubbles, toasts and titles', () => {
    expect(mdStrip('1. **Dev**: Crie um *esboço* com `index.html`')).toBe('1. Dev: Crie um esboço com index.html');
    expect(mdStrip('# Plano\n- [site](https://example.com)\n> nota')).toBe('Plano\nsite\nnota');
    expect(mdStrip('```js\nconst a = 1;\n```')).toBe('const a = 1;');
    expect(mdLine('**Dev**: um\n\n- dois')).toBe('Dev: um dois');
    expect(mdLine('uma frase bem longa demais para um balão', 20)).toBe('uma frase bem...');
    expect(mdStrip('<b>x</b>')).toBe('<b>x</b>');
  });
});
