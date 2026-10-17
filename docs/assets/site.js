// Interactive parts of the hivedesk site.
// Declarative parts (the menu, the copy buttons, the screenshot tabs) are Voodoo.js
// attributes in the HTML (https://kwy404.github.io/Voodoo.js/). Voodoo loads after the
// first paint. The motion is CSS; the few scripts below only toggle classes, set CSS
// variables in requestAnimationFrame, and stop when things are off screen. With
// prefers-reduced-motion, nothing moves. Nothing here talks to a server.

const VOODOO = 'https://cdn.jsdelivr.net/npm/voodoojs@1.1.0/dist/voodoo.min.js';
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

/** The visitor's OS: 'win', 'mac' or 'linux'. */
function osGuess() {
  const p = `${navigator.userAgentData?.platform || ''} ${navigator.platform || ''} ${navigator.userAgent || ''}`.toLowerCase();
  if (/mac|iphone|ipad/.test(p)) return 'mac';
  if (/linux|x11|cros/.test(p) && !/android/.test(p)) return 'linux';
  return 'win';
}

// ---------- Voodoo, after the first paint ----------
const MONSOON = 'https://cdn.jsdelivr.net/npm/monsooncss@0.2.0/dist/monsoon.min.css';
function startVoodoo() {
  // Monsoon's reset and tokens: site.css already stands on its own, so this changes nothing on screen.
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = MONSOON;
  css.crossOrigin = 'anonymous';
  document.head.append(css);

  const s = document.createElement('script');
  s.src = VOODOO;
  s.crossOrigin = 'anonymous';
  s.dataset.manual = '';
  s.onload = () => {
    const V = window.V;
    if (!V) return;
    Object.assign(V.config.globals, { osGuess });
    V.start();
  };
  document.head.append(s);
}
const later = () => setTimeout(startVoodoo, 600);
if (document.readyState === 'complete') later();
else addEventListener('load', later, { once: true });

// ---------- the download card for this OS ----------
const os = osGuess();
for (const card of $$('.os-card')) card.classList.toggle('is-you', card.dataset.os === os);

// ---------- copy feedback: the icon turns into a check and a small "Copied" ----------
for (const btn of $$('[data-copy]')) {
  btn.addEventListener('click', () => {
    btn.classList.remove('is-copied');
    void btn.offsetWidth;
    btn.classList.add('is-copied');
    clearTimeout(btn._t);
    btn._t = setTimeout(() => btn.classList.remove('is-copied'), 1400);
  });
}

// ---------- visibility: reveal once; loops run only while on screen ----------
const shown = new WeakMap();
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) e.target.classList.add('is-in');
    e.target.classList.toggle('is-off', !e.isIntersecting);
    shown.set(e.target, e.isIntersecting);
  }
}, { rootMargin: '0px 0px -6% 0px' });
$$('.reveal, .tile, .stage, .office-stage, .download, [data-term]').forEach((el) => io.observe(el));
const onScreen = (el) => shown.get(el) === true && !document.hidden;

function every(el, ms, fn) {
  if (reduced || !el) return;
  let i = 0;
  setInterval(() => { if (onScreen(el)) fn(++i); }, ms);
}

// ---------- terminals type their lines, then start over ----------
for (const term of $$('[data-term]')) {
  const lines = $$('.tl', term);
  if (reduced) { lines.forEach((l) => l.classList.add('on')); continue; }
  let n = 0;
  const tick = () => {
    if (onScreen(term)) {
      if (n < lines.length) lines[n++].classList.add('on');
      else if (n++ > lines.length + 5) { lines.forEach((l) => l.classList.remove('on')); n = 0; }
    }
    setTimeout(tick, n === 0 ? 500 : 600);
  };
  tick();
}

// ---------- languages ----------
const hello = $('[data-hello]');
const HELLO = [['Hello, crew!', 'en'], ['Olá, equipe!', 'pt-BR'], ['¡Hola, equipo!', 'es'], ['Salut, l’équipe !', 'fr'], ['Hallo, Crew!', 'de'], ['Ciao, squadra!', 'it'], ['こんにちは、チーム！', 'ja'], ['안녕, 팀!', 'ko'], ['你好，团队！', 'zh-Hans'], ['Привет, команда!', 'ru']];
const helloTile = hello?.closest('.tile');
if (hello) $$('.lang-list li', helloTile)[0]?.classList.add('on');
every(helloTile, 2000, (i) => {
  hello.classList.add('out');
  setTimeout(() => {
    const k = i % HELLO.length;
    [hello.textContent, hello.lang] = HELLO[k];
    $$('.lang-list li', helloTile).forEach((li, j) => li.classList.toggle('on', j === k));
    hello.classList.remove('out');
  }, 250);
});

// ---------- the lend wire: packets travel its real width ----------
for (const wire of $$('.ln-wire')) {
  const set = () => wire.style.setProperty('--wire', `${Math.max(0, wire.clientWidth - 8)}px`);
  set();
  new ResizeObserver(set).observe(wire);
}

// ---------- scroll story: the step in the middle of the screen drives the picture ----------
const story = $('[data-story]');
if (story) {
  const steps = $$('.st-step', story);
  const views = $$('.sv', story);
  const dots = $$('.sv-dots li', story);
  const show = (k) => {
    steps.forEach((s, j) => s.classList.toggle('on', j === k));
    views.forEach((v, j) => v.classList.toggle('on', j === k));
    dots.forEach((d, j) => d.classList.toggle('on', j === k));
  };
  show(0);
  const sio = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) show(steps.indexOf(e.target));
  }, { rootMargin: '-45% 0px -45% 0px' });
  steps.forEach((s) => sio.observe(s));
}

// ---------- hero: the glow follows the cursor, the window drifts on scroll ----------
const heroBg = $('.hero-bg');
if (heroBg && finePointer && !reduced) {
  let raf = 0, x = 0, y = 0;
  addEventListener('pointermove', (e) => {
    x = e.clientX; y = e.clientY + scrollY;
    if (!raf) raf = requestAnimationFrame(() => {
      raf = 0;
      if (y > 1000) return;
      heroBg.style.setProperty('--gx', `${x}px`);
      heroBg.style.setProperty('--gy', `${y}px`);
    });
  }, { passive: true });
}
const stage = $('[data-parallax]');
if (stage && !reduced) {
  const win = stage.firstElementChild;
  let raf = 0;
  const update = () => {
    raf = 0;
    const r = stage.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) return;
    const p = Math.max(-1, Math.min(1, (r.top + r.height / 2 - innerHeight / 2) / innerHeight));
    win.style.translate = `0 ${(p * 24).toFixed(1)}px`;
  };
  addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(update); }, { passive: true });
  update();
}

// ---------- micro interactions: magnetic buttons, tilting tiles ----------
if (finePointer && !reduced) {
  for (const el of $$('.magnetic')) {
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const dx = (e.clientX - r.left - r.width / 2) / r.width;
      const dy = (e.clientY - r.top - r.height / 2) / r.height;
      el.style.translate = `${(dx * 8).toFixed(1)}px ${(dy * 6).toFixed(1)}px`;
    });
    el.addEventListener('pointerleave', () => { el.style.translate = ''; });
  }
  for (const el of $$('.tilt')) {
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
      el.style.transform = `perspective(1200px) rotateX(${((0.5 - py) * 3).toFixed(2)}deg) rotateY(${((px - 0.5) * 3).toFixed(2)}deg)`;
      el.style.setProperty('--px', `${(px * 100).toFixed(1)}%`);
      el.style.setProperty('--py', `${(py * 100).toFixed(1)}%`);
    });
    el.addEventListener('pointerleave', () => { el.style.transform = ''; });
  }
}

// ---------- saved choices (best effort; the page works without storage) ----------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// ---------- theme switcher: the app's eight themes recolor the page ----------
const themePick = $('[data-theme-pick]');
function setTheme(id) {
  if (!id || id === 'mel') document.documentElement.removeAttribute('data-site-theme');
  else document.documentElement.setAttribute('data-site-theme', id);
  $$('[data-theme-id]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeId === (id || 'mel'))));
}
setTheme(store.get('hivedesk.site.theme') || 'mel');
$$('[data-theme-id]').forEach((b) => b.addEventListener('click', () => {
  setTheme(b.dataset.themeId);
  store.set('hivedesk.site.theme', b.dataset.themeId);
}));
document.addEventListener('click', (e) => { if (themePick?.open && !themePick.contains(e.target)) themePick.open = false; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && themePick?.open) { themePick.open = false; themePick.querySelector('summary').focus(); } });

// ---------- language switcher: headlines, buttons, the try panel and downloads ----------
let STR = null;
const langSelect = $('[data-lang-select]');
const h1 = $('[data-i18n-h1]');
function setH1(lines) {
  let i = 0;
  h1.textContent = '';
  lines.forEach((line, n) => {
    if (n) h1.append(document.createElement('br'));
    line.split(' ').forEach((w, k) => {
      if (k) h1.append(' ');
      const sp = document.createElement('span');
      sp.className = n ? 'w hl' : 'w';
      sp.style.setProperty('--i', String(i++));
      sp.setAttribute('aria-hidden', 'true');
      sp.textContent = w;
      h1.append(sp);
    });
  });
  h1.setAttribute('aria-label', lines.join(' '));
  h1.classList.toggle('display-long', Math.max(...lines.map((l) => l.length)) > 20);
}
async function setLang(code) {
  if (!STR) STR = (await import('./i18n.js')).STRINGS;
  const t = STR[code] || STR.en;
  document.documentElement.lang = code;
  for (const el of $$('[data-i18n]')) { const v = t[el.dataset.i18n]; if (typeof v === 'string') el.textContent = v; }
  for (const el of $$('[data-i18n-2]')) {
    const v = t[el.dataset.i18n2];
    if (!Array.isArray(v)) continue;
    const sp = document.createElement('span');
    sp.textContent = v[1];
    el.replaceChildren(v[0], document.createElement('br'), sp);
  }
  for (const el of $$('[data-i18n-ph]')) { const v = t[el.dataset.i18nPh]; if (v) el.placeholder = v; }
  if (h1 && t['hero.h1']) setH1(t['hero.h1']);
  if (langSelect) langSelect.value = code;
}
const savedLang = store.get('hivedesk.site.lang');
if (savedLang && savedLang !== 'en') setLang(savedLang);
langSelect?.addEventListener('change', () => { setLang(langSelect.value); store.set('hivedesk.site.lang', langSelect.value); });

// ---------- release sizes from GitHub, and the "first release today" note ----------
function fmtSize(b) { return b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`; }
addEventListener('load', () => {
  setTimeout(() => {
    // The list endpoint answers 200 with [] before the first release (no 404 in the console).
    fetch('https://api.github.com/repos/kwy404/hivedesk/releases?per_page=5', { headers: { accept: 'application/vnd.github+json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((list) => {
        const rel = Array.isArray(list) ? list.find((x) => !x.draft && !x.prerelease) : null;
        if (!rel || !Array.isArray(rel.assets)) return;
        $('[data-first-release]')?.setAttribute('hidden', '');
        for (const el of $$('[data-size]')) {
          const a = rel.assets.find((x) => x.name === el.dataset.size);
          if (a) el.textContent = `${el.textContent.replace(/, about .*$/, '')}, ${fmtSize(a.size)}, ${rel.tag_name}`;
        }
      })
      .catch(() => {});
  }, 1500);
}, { once: true });

// ---------- try it: a scripted mini crew that reacts to what you type ----------
const tryBox = $('[data-try]');
if (tryBox) {
  const form = $('[data-try-form]', tryBox);
  const input = form.elements.q;
  const brief = $('[data-try-brief]', tryBox);
  const tasks = $('[data-try-tasks]', tryBox);
  const done = $('[data-try-done]', tryBox);
  const bees = $('[data-try-bees]', tryBox);
  const AV = { dev: 'dev', des: 'designer', qa: 'qa', wri: 'writer' };
  const NAME = { dev: 'Dev', des: 'Designer', qa: 'QA', wri: 'Writer' };
  const PLANS = [
    { re: /game|snake|pong|tetris|jogo|juego|spiel|gioco/i, build: 'A canvas game loop, keyboard and touch controls, a score and a restart button.', checks: 'The game starts, the score counts, restart works.',
      tasks: [['des', 'Set the look'], ['dev', 'Write the game loop'], ['wri', 'Write how to play'], ['qa', 'Play test the controls']] },
    { re: /todo|to-do|list|crud|notes|tarefa|lista|notas/i, build: 'A list with add, edit, done and delete, saved in localStorage.', checks: 'Items survive a reload, empty input is refused.',
      tasks: [['des', 'Style the list'], ['dev', 'Build add, edit and delete'], ['dev', 'Save to localStorage'], ['qa', 'Check the edge cases']] },
    { re: /readme|docs|documentation|documenta/i, build: 'What it does, how to install it, how to use it, and an example.', checks: 'Every command in the README runs as written.',
      tasks: [['wri', 'Outline the README'], ['wri', 'Write install and usage'], ['dev', 'Check the commands'], ['qa', 'Read it like a newcomer']] },
    { re: /.*/, build: 'A hero, the main sections, a contact form and a footer.', checks: 'Images have alt text, the form has labels, it works at 375 px.',
      tasks: [['des', 'Set the look'], ['dev', 'Build the page'], ['wri', 'Write the copy'], ['qa', 'Check the page']] },
  ];
  let run = 0;
  const wait = (ms) => new Promise((r) => setTimeout(r, reduced ? 0 : ms));
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  function bee() {
    if (reduced) return;
    const w = bees.clientWidth, h = bees.clientHeight;
    const img = el('img', 'try-bee');
    img.src = 'assets/art/bee.svg'; img.alt = ''; img.width = 30; img.height = 23;
    const ltr = Math.random() > 0.5;
    img.style.setProperty('--x0', `${ltr ? -40 : w + 10}px`); img.style.setProperty('--y0', `${20 + Math.random() * (h - 60)}px`);
    img.style.setProperty('--x1', `${ltr ? w + 10 : -40}px`); img.style.setProperty('--y1', `${20 + Math.random() * (h - 60)}px`);
    if (!ltr) img.style.scale = '-1 1';
    bees.append(img);
    setTimeout(() => img.remove(), 2800);
  }
  async function go(text) {
    const id = ++run;
    const q = text.trim().replace(/\s+/g, ' ').slice(0, 120);
    if (!q) { input.focus(); return; }
    const plan = PLANS.find((p) => p.re.test(q));
    brief.replaceChildren(); tasks.replaceChildren(); done.hidden = true;
    const think = el('p', 'thinking');
    const dots = el('span', 'dots'); dots.append(el('i'), el('i'), el('i'));
    think.append(el('span', null, 'Mel is writing the brief'), dots);
    brief.append(think); bee();
    await wait(900); if (id !== run) return;
    think.remove();
    const goal = q.charAt(0).toUpperCase() + q.slice(1).replace(/[.!?]+$/, '') + '.';
    for (const [k, v] of [['Goal', goal], ['Build', plan.build], ['Constraints', 'Plain HTML, CSS and JavaScript, works on phones.'], ['Checks', plan.checks]]) {
      const p = el('p', 'bl'); p.append(el('b', null, k), v); brief.append(p);
      await wait(260); if (id !== run) return;
    }
    await wait(300);
    const rows = plan.tasks.map(([who, title]) => {
      const li = el('li');
      const img = el('img'); img.src = `assets/crew/${AV[who]}.svg`; img.alt = ''; img.width = 28; img.height = 28;
      const mid = el('span'); mid.append(el('b', null, title), el('span', 'who', NAME[who]));
      const st = el('span', 'ts', 'queued'); st.dataset.s = 'queued';
      li.append(img, mid, st); tasks.append(li);
      return st;
    });
    for (const st of rows) {
      if (id !== run) return;
      st.textContent = 'running'; st.dataset.s = 'running'; bee();
      await wait(900); if (id !== run) return;
      st.textContent = 'done'; st.dataset.s = 'done';
    }
    done.textContent = 'Done in this preview. In the Hive, this writes real files in your folder.';
    done.hidden = false; bee(); bee();
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); go(input.value); });
  for (const chip of $$('[data-try-chips] button', tryBox)) chip.addEventListener('click', () => { input.value = chip.textContent; go(chip.textContent); });
  const tio = new IntersectionObserver(([e]) => {
    if (!e.isIntersecting) return;
    tio.disconnect();
    if (!input.value) { input.value = 'a landing page for my bakery'; go(input.value); }
  }, { threshold: 0.4 });
  tio.observe(tryBox);
}

// ---------- download: a thank you panel with the first launch steps ----------
for (const card of $$('.os-card')) {
  const panel = $('.os-thanks', card);
  $('.os-dl', card)?.addEventListener('click', () => {
    card.classList.add('is-thanks');
    panel.hidden = false;
    setTimeout(() => $('[data-thanks-close]', panel)?.focus({ preventScroll: true }), 50);
  });
  $('[data-thanks-close]', card)?.addEventListener('click', () => {
    panel.hidden = true;
    card.classList.remove('is-thanks');
    $('.os-dl', card)?.focus({ preventScroll: true });
  });
}

// ---------- the live window's overlay knows its own size, so bees fly in pixels ----------
for (const fx of $$('.fx')) {
  new ResizeObserver(([e]) => {
    fx.style.setProperty('--fw', `${Math.round(e.contentRect.width)}px`);
    fx.style.setProperty('--fh', `${Math.round(e.contentRect.height)}px`);
  }).observe(fx);
}
