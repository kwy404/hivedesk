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
function startVoodoo() {
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
if (document.readyState === 'complete') startVoodoo();
else addEventListener('load', startVoodoo, { once: true });

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
$$('.reveal, .tile, .stage, .office-stage, [data-term]').forEach((el) => io.observe(el));
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
