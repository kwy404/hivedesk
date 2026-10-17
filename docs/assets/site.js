// Interactive parts of the hivedesk site.
// Declarative parts (the menu, the copy buttons, the screenshot tabs) are Voodoo.js
// attributes in the HTML (https://kwy404.github.io/Voodoo.js/). Voodoo loads after the
// first paint. The motion is CSS; the few scripts below only toggle classes, set CSS
// variables in requestAnimationFrame, and stop when things are off screen. With
// prefers-reduced-motion, nothing moves. Nothing here talks to a server.

const VOODOO = 'https://cdn.jsdelivr.net/npm/voodoojs@1.1.0/dist/voodoo.min.js';
// The site root (pages in /pt-BR/ and the other language folders load this same file).
const ROOT = new URL('../', import.meta.url).href;
// Strings for the parts this script writes. Each language page carries its own in #hd-t
// (written by docs/_i18n/build.py); English is the fallback.
let T = {};
try { T = JSON.parse(document.getElementById('hd-t')?.textContent || '{}'); } catch { T = {}; }
const t = (k, fallback) => (typeof T[k] === 'string' ? T[k] : fallback);
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
// The language dropdown, the command palette and the toasts are Monsoon components
// (menu, command-palette, toast) driven by Voodoo directives. Their state lives in the
// plain objects below; when Voodoo arrives they become reactive and the page wires up.
function startVoodoo() {
  const s = document.createElement('script');
  s.src = VOODOO;
  s.crossOrigin = 'anonymous';
  s.dataset.manual = '';
  s.onload = () => {
    const V = window.V;
    if (!V) return;
    LANGSEL = V.reactive(LANGSEL);
    PAL = V.reactive(PAL);
    TOAST = V.reactive(TOAST);
    Object.assign(V.config.globals, { osGuess, LANGSEL, PAL, TOAST });
    V.start();
    voodooReady = true;
    if (pendingClick) { const b = pendingClick; pendingClick = null; setTimeout(() => b.click(), 0); }
  };
  document.head.append(s);
}
// Voodoo starts on the first sign of a person (a pointer move, a touch, a key, a scroll) or when
// the page has been idle for a while, so the first load stays light. A click on the language or
// search button before that is replayed once Voodoo is ready.
let voodooAsked = false, voodooReady = false, pendingClick = null;
function wakeVoodoo() {
  if (voodooAsked) return;
  voodooAsked = true;
  for (const ev of WAKE) removeEventListener(ev, wakeVoodoo, true);
  startVoodoo();
}
const WAKE = ['pointermove', 'pointerdown', 'touchstart', 'keydown', 'scroll', 'focusin'];
for (const ev of WAKE) addEventListener(ev, wakeVoodoo, { capture: true, passive: true });
document.addEventListener('click', (e) => {
  if (voodooReady) return;
  const b = e.target.closest?.('#lang-btn, .search-btn');
  if (b) { pendingClick = b; wakeVoodoo(); }
}, true);
addEventListener('load', () => setTimeout(() => (window.requestIdleCallback || setTimeout)(wakeVoodoo), 9000), { once: true });

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
    const cmd = btn.closest('[role=group]')?.querySelector('code')?.textContent || '';
    toast(t('toast.copied', 'Copied to the clipboard'), cmd ? `${cmd}: ${t('toast.paste', 'paste it in a terminal')}` : '');
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
$$('.reveal, .tile, .stage, .office-live, .download, .film, .city-show, .next, [data-term]').forEach((el) => io.observe(el));
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

// ---------- theme switcher: a Monsoon segmented control in a popover ----------
function setTheme(id) {
  id = id || 'mel';
  if (id === 'mel') document.documentElement.removeAttribute('data-site-theme');
  else document.documentElement.setAttribute('data-site-theme', id);
  for (const r of $$('[data-theme-seg] input')) r.checked = r.value === id;
}
setTheme(store.get('hivedesk.site.theme') || 'mel');
$('[data-theme-seg]')?.addEventListener('change', (e) => {
  if (e.target.name !== 'site-theme') return;
  setTheme(e.target.value);
  store.set('hivedesk.site.theme', e.target.value);
});

// ---------- language: detected from the browser, or the visitor's own choice ----------
const LANGS = [
  { code: 'en', name: 'English', badge: 'EN' }, { code: 'pt-BR', name: 'Português', badge: 'PT' },
  { code: 'es', name: 'Español', badge: 'ES' }, { code: 'fr', name: 'Français', badge: 'FR' },
  { code: 'de', name: 'Deutsch', badge: 'DE' }, { code: 'it', name: 'Italiano', badge: 'IT' },
  { code: 'ja', name: '日本語', badge: 'JA' }, { code: 'ko', name: '한국어', badge: 'KO' },
  { code: 'zh-Hans', name: '简体中文', badge: 'ZH' }, { code: 'ru', name: 'Русский', badge: 'RU' },
];
const PAGE_LANG = document.documentElement.lang || 'en';
/** The URL of a language page: the root for English, a folder for the others. */
const langURL = (code) => `${ROOT}${code === 'en' ? '' : `${code}/`}`;

// The dropdown: a Monsoon menu with the WAI-ARIA listbox pattern (the list holds focus and
// points at the active option with aria-activedescendant).
let typed = '', typedAt = 0;
let LANGSEL = {
  open: false, active: 0, current: PAGE_LANG, list: LANGS,
  toggle() { if (LANGSEL.open) LANGSEL.close(true); else LANGSEL.show(); },
  show() {
    LANGSEL.active = Math.max(0, LANGS.findIndex((l) => l.code === LANGSEL.current));
    LANGSEL.open = true;
    requestAnimationFrame(() => requestAnimationFrame(() => $('#lang-list')?.focus({ preventScroll: true })));
  },
  close(focusButton) {
    if (!LANGSEL.open) return;
    LANGSEL.open = false;
    if (focusButton) $('#lang-btn')?.focus({ preventScroll: true });
  },
  choose(i) {
    const l = LANGS[i];
    if (!l) return;
    store.set('hivedesk.site.lang', l.code);
    LANGSEL.close(false);
    if (l.code !== PAGE_LANG) location.href = langURL(l.code) + location.hash;
  },
  btnKey(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); LANGSEL.show(); }
  },
  key(e) {
    const n = LANGS.length;
    const go = (i) => { e.preventDefault(); LANGSEL.active = (i + n) % n; $(`#lang-opt-${LANGSEL.active}`)?.scrollIntoView({ block: 'nearest' }); };
    switch (e.key) {
      case 'ArrowDown': return go(LANGSEL.active + 1);
      case 'ArrowUp': return go(LANGSEL.active - 1);
      case 'Home': return go(0);
      case 'End': return go(n - 1);
      case 'Enter': case ' ': e.preventDefault(); return LANGSEL.choose(LANGSEL.active);
      case 'Escape': e.preventDefault(); e.stopPropagation(); return LANGSEL.close(true);
      case 'Tab': return LANGSEL.close(false);
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const now = Date.now();
          typed = (now - typedAt > 600 ? '' : typed) + e.key.toLowerCase();
          typedAt = now;
          const order = [...LANGS.keys()].map((k) => (LANGSEL.active + (typed.length === 1 ? 1 : 0) + k) % n);
          const hit = order.find((k) => LANGS[k].name.toLowerCase().startsWith(typed) || LANGS[k].badge.toLowerCase().startsWith(typed));
          if (hit !== undefined) go(hit);
        }
    }
  },
};

// ---------- toasts: Monsoon's toast stack, filled by Voodoo ----------
let TOAST = { list: [] };
let toastId = 0;
function toast(title, text = '') {
  const id = ++toastId;
  TOAST.list.push({ id, title, text });
  if (TOAST.list.length > 3) TOAST.list.shift();
  setTimeout(() => { const k = TOAST.list.findIndex((x) => x.id === id); if (k >= 0) TOAST.list.splice(k, 1); }, 2600);
}

// ---------- Ctrl K: a Monsoon command palette that jumps to a section ----------
const fold = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
let PAL = {
  q: '', sel: '',
  dialog: () => $('#palette'),
  items: () => $$('#palette .command-palette-item').filter((a) => PAL.match(a.getAttribute('href'))),
  show() {
    const d = PAL.dialog();
    if (!d || d.open) return;
    PAL.q = '';
    d.showModal();
    PAL.sel = PAL.items()[0]?.getAttribute('href') || '';
    requestAnimationFrame(() => $('#palette .command-palette-input')?.focus());
  },
  hide() { PAL.dialog()?.close(); },
  closed() { PAL.q = ''; },
  backdrop(e) { if (e.target === PAL.dialog()) PAL.hide(); },
  setQ(v) { PAL.q = v; PAL.sel = PAL.items()[0]?.getAttribute('href') || ''; },
  match(href) {
    const q = fold(PAL.q).trim();
    if (!q) return true;
    const a = document.querySelector(`#palette .command-palette-item[href="${href}"]`);
    return !!a && fold(`${a.textContent} ${a.dataset.keywords || ''}`).includes(q);
  },
  none() { return PAL.items().length === 0; },
  key(e) {
    const list = PAL.items();
    const k = list.findIndex((a) => a.getAttribute('href') === PAL.sel);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = list[(k + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length];
      if (next) { PAL.sel = next.getAttribute('href'); next.scrollIntoView({ block: 'nearest' }); }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const a = list[k] || list[0];
      if (a) { PAL.hide(); location.hash = a.getAttribute('href'); }
    }
  },
};

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
  const P = (k, en) => t(`try.plan.${k}`, en);
  const PLANS = [
    { re: /game|snake|pong|tetris|jogo|juego|spiel|gioco/i, build: P('game.build', 'A canvas game loop, keyboard and touch controls, a score and a restart button.'), checks: P('game.checks', 'The game starts, the score counts, restart works.'),
      tasks: [['des', P('look', 'Set the look')], ['dev', P('game.loop', 'Write the game loop')], ['wri', P('game.howto', 'Write how to play')], ['qa', P('game.test', 'Play test the controls')]] },
    { re: /todo|to-do|list|crud|notes|tarefa|lista|notas/i, build: P('list.build', 'A list with add, edit, done and delete, saved in localStorage.'), checks: P('list.checks', 'Items survive a reload, empty input is refused.'),
      tasks: [['des', P('list.style', 'Style the list')], ['dev', P('list.crud', 'Build add, edit and delete')], ['dev', P('list.save', 'Save to localStorage')], ['qa', P('list.edge', 'Check the edge cases')]] },
    { re: /readme|docs|documentation|documenta/i, build: P('docs.build', 'What it does, how to install it, how to use it, and an example.'), checks: P('docs.checks', 'Every command in the README runs as written.'),
      tasks: [['wri', P('docs.outline', 'Outline the README')], ['wri', P('docs.write', 'Write install and usage')], ['dev', P('docs.cmds', 'Check the commands')], ['qa', P('docs.read', 'Read it like a newcomer')]] },
    { re: /.*/, build: P('page.build', 'A hero, the main sections, a contact form and a footer.'), checks: P('page.checks', 'Images have alt text, the form has labels, it works at 375 px.'),
      tasks: [['des', P('look', 'Set the look')], ['dev', P('page.build2', 'Build the page')], ['wri', P('page.copy', 'Write the copy')], ['qa', P('page.check', 'Check the page')]] },
  ];
  let run = 0;
  const wait = (ms) => new Promise((r) => setTimeout(r, reduced ? 0 : ms));
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  function bee() {
    if (reduced) return;
    const w = bees.clientWidth, h = bees.clientHeight;
    const img = el('img', 'try-bee');
    img.src = `${ROOT}assets/art/bee.svg`; img.alt = ''; img.width = 30; img.height = 23;
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
    think.append(el('span', null, t('try.writing', 'Mel is writing the brief')), dots);
    brief.append(think); bee();
    await wait(900); if (id !== run) return;
    think.remove();
    const goal = q.charAt(0).toUpperCase() + q.slice(1).replace(/[.!?]+$/, '') + '.';
    for (const [k, v] of [[t('try.goal', 'Goal'), goal], [t('try.build', 'Build'), plan.build], [t('try.constraints', 'Constraints'), t('try.constraintsV', 'Plain HTML, CSS and JavaScript, works on phones.')], [t('try.checks', 'Checks'), plan.checks]]) {
      const p = el('p', 'bl'); p.append(el('b', null, k), v); brief.append(p);
      await wait(260); if (id !== run) return;
    }
    await wait(300);
    const rows = plan.tasks.map(([who, title]) => {
      const li = el('li');
      const img = el('img'); img.src = `${ROOT}assets/crew/${AV[who]}.svg`; img.alt = ''; img.width = 28; img.height = 28;
      const mid = el('span'); mid.append(el('b', null, title), el('span', 'who', NAME[who]));
      const st = el('span', 'ts', t('try.queued', 'queued')); st.dataset.s = 'queued';
      li.append(img, mid, st); tasks.append(li);
      return st;
    });
    for (const st of rows) {
      if (id !== run) return;
      st.textContent = t('try.running', 'running'); st.dataset.s = 'running'; bee();
      await wait(900); if (id !== run) return;
      st.textContent = t('try.done', 'done'); st.dataset.s = 'done';
    }
    done.textContent = t('try.finished', 'Done in this preview. In the Hive, this writes real files in your folder.');
    done.hidden = false; bee(); bee();
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); go(input.value); });
  for (const chip of $$('[data-try-chips] button', tryBox)) chip.addEventListener('click', () => { input.value = chip.textContent; go(chip.textContent); });
  const tio = new IntersectionObserver(([e]) => {
    if (!e.isIntersecting) return;
    tio.disconnect();
    if (!input.value) { input.value = $('[data-try-chips] button', tryBox)?.textContent || 'a landing page for my bakery'; go(input.value); }
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
for (const fx of $$('.fx, .office-fx')) {
  new ResizeObserver(([e]) => {
    fx.style.setProperty('--fw', `${Math.round(e.contentRect.width)}px`);
    fx.style.setProperty('--fh', `${Math.round(e.contentRect.height)}px`);
  }).observe(fx);
}

// ---------- the film: a muted preview while it is on screen, sound on a click ----------
const film = $('[data-film]');
if (film) {
  const video = $('video', film);
  const btn = $('[data-film-play]', film);
  let chosen = false;
  const showCaptions = () => {
    const want = document.documentElement.lang.startsWith('pt') ? 'pt-BR' : 'en';
    for (const t of video.textTracks) t.mode = t.language === want ? 'showing' : 'disabled';
  };
  const preview = () => {
    if (chosen || reduced) return;
    video.muted = true;
    showCaptions();
    film.classList.add('is-preview');
    video.play().catch(() => {});
  };
  new IntersectionObserver(([e]) => {
    if (e.intersectionRatio >= 0.5) preview();
    else if (!video.paused) video.pause();
  }, { threshold: [0, 0.5] }).observe(film);
  btn.addEventListener('click', () => {
    chosen = true;
    film.classList.remove('is-preview');
    film.classList.add('is-playing');
    video.muted = false;
    video.loop = false;
    video.controls = true;
    showCaptions();
    video.currentTime = 0;
    video.play().catch(() => {});
    video.focus({ preventScroll: true });
  });
  video.addEventListener('ended', () => { film.classList.remove('is-playing'); video.controls = false; chosen = false; });
}

// ---------- Hive City: tabs that also advance by themselves while on screen ----------
const city = $('[data-city]');
if (city) {
  const tabs = $$('[role=tab]', city);
  const slides = $$('.city-slide', city);
  const bar = $('.city-progress span', city);
  let cur = 0, timer = 0, manual = false;
  const show = (k, focus) => {
    cur = (k + slides.length) % slides.length;
    tabs.forEach((t, j) => { t.setAttribute('aria-selected', String(j === cur)); t.tabIndex = j === cur ? 0 : -1; });
    slides.forEach((sl, j) => { sl.hidden = j !== cur; sl.classList.toggle('is-on', j === cur); });
    if (focus) tabs[cur].focus();
    if (bar) { bar.style.animation = 'none'; void bar.offsetWidth; bar.style.animation = ''; }
  };
  const tick = () => {
    clearTimeout(timer);
    if (manual || reduced) { city.classList.remove('is-auto'); return; }
    city.classList.add('is-auto');
    timer = setTimeout(() => { if (onScreen(city) && city.classList.contains('is-in')) show(cur + 1); tick(); }, 7000);
  };
  tabs.forEach((t, j) => t.addEventListener('click', () => { manual = true; show(j); tick(); }));
  city.addEventListener('keydown', (e) => {
    if (!e.target.matches('[role=tab]')) return;
    const d = { ArrowRight: 1, ArrowLeft: -1, Home: -cur, End: slides.length - 1 - cur }[e.key];
    if (d === undefined) return;
    e.preventDefault(); manual = true; show(cur + d, true); tick();
  });
  tick();
}
