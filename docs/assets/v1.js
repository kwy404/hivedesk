// The 1.0 demos: invite a friend, borrow a GPU with the scheduler's reasons, the pooled model
// meter and the playbook picker. Everything here is a simulation in the page with example
// numbers; nothing talks to a server. Loops run only while on screen, and with
// prefers-reduced-motion the demos jump to their end states instead of animating.

const ROOT = new URL('../', import.meta.url).href;
let T = {};
try { T = JSON.parse(document.getElementById('hd-t')?.textContent || '{}'); } catch { T = {}; }
const t = (k, fallback) => (typeof T[k] === 'string' ? T[k] : fallback);
const fill = (s, v) => s.replace(/\{(\w+)\}/g, (_, k) => (k in v ? v[k] : `{${k}}`));
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const LOCALE = document.documentElement.lang || 'en';
const num = (n, d = 1) => n.toLocaleString(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d });

// ---------- on screen or not ----------
const visible = new WeakMap();
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    visible.set(e.target, e.isIntersecting);
    if (e.target.matches('[data-anim]')) e.target.classList.toggle('is-paused', !e.isIntersecting);
    e.target.dispatchEvent(new CustomEvent('hd:seen', { detail: e.isIntersecting }));
  }
}, { rootMargin: '80px 0px' });
const watch = (el) => { if (el) io.observe(el); };
const onScreen = (el) => visible.get(el) === true && !document.hidden;
$$('[data-anim]').forEach(watch);

// ---------- invite a friend ----------
const inv = $('[data-invite]');
if (inv) {
  const LAST = 5;
  let step = 0, auto = !reduced, timer = 0;
  const next = $('[data-inv-next]', inv);
  const labels = [t('inv.next', 'Next step'), t('inv.next', 'Next step'), t('inv.next', 'Next step'), t('inv.match', 'The words match'), t('inv.accept', 'Accept'), t('inv.again', 'Again')];
  const GRANT = { view: 'city.view', member: 'city.member', gpu: 'compute.inference', read: 'workspace.read' };
  function show() {
    inv.dataset.step = String(step);
    for (const v of $$('.inv-v', inv)) v.classList.toggle('is-on', v.dataset.v.split(' ').includes(String(step)));
    for (const v of $$('[data-v-only]', inv)) v.hidden = v.dataset.vOnly !== String(step);
    $$('.demo-steps li', inv).forEach((li, i) => { li.classList.toggle('is-now', i === step); li.classList.toggle('is-done', i < step); });
    next.textContent = labels[step];
    if (step === LAST) {
      const grants = $$('[data-perm]', inv).filter((c) => c.checked).map((c) => GRANT[c.dataset.perm]);
      $('[data-inv-log]', inv).textContent = `p2p.join accepted, grants: ${grants.length ? grants.join(', ') : 'none'}`;
    }
  }
  function go(n) { step = n > LAST ? 0 : n; show(); }
  function tick() {
    clearTimeout(timer);
    if (!auto) return;
    timer = setTimeout(() => {
      if (onScreen(inv) && step < LAST) go(step + 1);
      if (step < LAST) tick();
    }, step === 4 ? 3600 : 2400);
  }
  next.addEventListener('click', () => { auto = false; clearTimeout(timer); go(step + 1); });
  $('[data-inv-reset]', inv).addEventListener('click', () => { auto = false; clearTimeout(timer); go(0); });
  $$('[data-perm]', inv).forEach((c) => c.addEventListener('change', () => { auto = false; clearTimeout(timer); }));
  inv.addEventListener('hd:seen', (e) => { if (e.detail && auto) tick(); });
  watch(inv);
  show();
}

// ---------- borrow a GPU: the scheduler and the lease ----------
const bor = $('[data-borrow]');
if (bor) {
  // Example machines. Memory in GB; the reserve is what the scheduler keeps free on a GPU.
  const RESERVE = 1;
  const YOU = { vramTotal: 6, vramUsed: 1.8, ramFree: 9, cpu: 12, util: 6 };
  const ANA = { vramTotal: 12, vramUsed: 1.6, share: 8, cpu: 8, util: 3 };
  // What each model needs (4 bit file plus its context) and example speeds in tokens per second.
  const MODELS = {
    3: { need: 2.6, local: 42, peer: 55, cpu: 9, tokens: 360 },
    7: { need: 5.4, local: 0, peer: 30, cpu: 4.5, tokens: 420 },
    14: { need: 9.6, local: 0, peer: 0, cpu: 2.2, tokens: 420 }
  };
  const ICON = (id) => `<svg class="i" aria-hidden="true"><use href="${ROOT}assets/icons.svg#i-${id}"/></svg>`;
  const els = {
    cands: $('[data-cands]', bor), reason: $('[data-reason]', bor), lease: $('[data-lease]', bor), left: $('[data-lease-left]', bor),
    tok: $('[data-tok]', bor), choices: $('[data-choices]', bor), msg: $('[data-choice-msg]', bor),
    run: $('[data-bor-run]', bor), stop: $('[data-bor-stop]', bor)
  };
  const mach = { you: $('[data-mach="you"]', bor), ana: $('[data-mach="ana"]', bor) };
  let job = null;

  function meter(who, key, v, text) {
    const m = mach[who];
    const bar = $(`[data-m="${key}"]`, m);
    if (bar) bar.style.setProperty('--v', String(Math.max(0, Math.min(1, v))));
    const val = $(`[data-mv="${key}"]`, m);
    if (val) val.textContent = text;
  }
  function idle() {
    meter('you', 'vram', YOU.vramUsed / YOU.vramTotal, fill(t('bor.gb', '{a} of {b} GB'), { a: num(YOU.vramUsed), b: num(YOU.vramTotal) }));
    meter('you', 'util', YOU.util / 100, `${YOU.util}%`);
    meter('you', 'cpu', YOU.cpu / 100, `${YOU.cpu}%`);
    meter('ana', 'vram', ANA.vramUsed / ANA.vramTotal, fill(t('bor.gb', '{a} of {b} GB'), { a: num(ANA.vramUsed), b: num(ANA.vramTotal, 0) }));
    meter('ana', 'util', ANA.util / 100, `${ANA.util}%`);
    meter('ana', 'cpu', ANA.cpu / 100, `${ANA.cpu}%`);
    mach.you.classList.remove('is-busy'); mach.ana.classList.remove('is-busy');
  }

  /** The scheduler's decision: hard filters with a reason each, then the lowest estimate (local first on ties). */
  function decide(size) {
    const m = MODELS[size];
    const youFree = YOU.vramTotal - YOU.vramUsed - RESERVE;
    const anaFree = Math.min(ANA.share, ANA.vramTotal - ANA.vramUsed - RESERVE);
    const est = (tps) => Math.round(m.tokens / tps + 2);
    const c = [];
    c.push(m.need <= youFree && m.local
      ? { id: 'you-gpu', who: 'you', name: t('bor.youGpu', 'Your GPU'), ok: true, s: est(m.local), score: est(m.local) * 0.85,
          d: fill(t('bor.fits', 'fits in {free} GB free'), { free: num(youFree) }) }
      : { id: 'you-gpu', name: t('bor.youGpu', 'Your GPU'), ok: false,
          d: fill(t('bor.noVram', 'needs {need} GB, {free} GB free'), { need: num(m.need), free: num(youFree) }) });
    c.push(m.need <= anaFree && m.peer
      ? { id: 'ana-gpu', who: 'ana', name: t('bor.anaGpu', "Ana's GPU"), ok: true, s: est(m.peer) + 1, score: est(m.peer) + 1,
          d: fill(t('bor.fitsShare', 'fits in the {share} GB she shares'), { share: num(anaFree) }) }
      : { id: 'ana-gpu', name: t('bor.anaGpu', "Ana's GPU"), ok: false,
          d: fill(t('bor.noShare', 'needs {need} GB, she shares at most {share} GB'), { need: num(m.need), share: num(anaFree) }) });
    const ramNeed = m.need + 1.5;
    c.push(ramNeed <= YOU.ramFree
      ? { id: 'you-cpu', who: 'you', cpu: true, name: t('bor.youCpu', 'Your CPU'), ok: true, s: est(m.cpu), score: est(m.cpu) * 0.85,
          d: fill(t('bor.ram', 'needs {need} GB of RAM, {free} GB free'), { need: num(ramNeed), free: num(YOU.ramFree) }) }
      : { id: 'you-cpu', name: t('bor.youCpu', 'Your CPU'), ok: false,
          d: fill(t('bor.noRam', 'needs {need} GB of free RAM, {free} GB free'), { need: num(ramNeed), free: num(YOU.ramFree) }) });
    const ok = c.filter((x) => x.ok).sort((a, b) => a.score - b.score);
    return { size, m, cands: c, win: ok[0] || null, next: ok[1] || null };
  }

  function render(dec) {
    els.cands.innerHTML = '';
    for (const x of dec.cands) {
      const li = document.createElement('li');
      li.className = x.ok ? (dec.win && x.id === dec.win.id ? 'ok win' : 'ok') : 'no';
      li.innerHTML = `${ICON(x.ok ? 'check' : 'x')}<span><span class="c-t"></span><span class="c-d"></span></span><span class="c-e"></span>`;
      $('.c-t', li).textContent = x.name;
      $('.c-d', li).textContent = x.d;
      $('.c-e', li).textContent = x.ok ? fill(t('bor.about', 'about {s} s'), { s: x.s }) : '';
      els.cands.append(li);
    }
    const model = fill(t('bor.model', 'the {size}B model'), { size: dec.size });
    if (!dec.win) {
      els.reason.textContent = fill(t('bor.none', 'No machine can run {model} now. The task waits for a resource and lists these reasons; a pooled giant model is not in 1.0.'), { model });
      return;
    }
    const best = dec.cands.find((x) => !x.ok);
    let why = fill(t('bor.why', '{target}: {model} {detail}, about {s} s.'), { target: dec.win.name, model, detail: dec.win.d, s: dec.win.s });
    if (dec.win.who === 'you' && !dec.win.cpu) why += ' ' + t('bor.whyLocal', 'Local goes first: private and no network.');
    else if (best) why += ' ' + fill(t('bor.whyNot', '{target} {detail}.'), { target: best.name, detail: best.d });
    if (dec.next) why += ' ' + fill(t('bor.whyNext', '{target} would take about {s} s.'), { target: dec.next.name, s: dec.next.s });
    els.reason.textContent = why;
  }

  function size() { return Number($('input[name="bor-model"]:checked', bor)?.value || 3); }
  function stopJob(msg) {
    if (!job) return;
    clearInterval(job.iv);
    const partial = job.tokens;
    const peer = job.dec.win.who === 'ana';
    job = null;
    els.stop.disabled = true; els.run.disabled = false;
    els.lease.hidden = true;
    if (msg === 'revoked') {
      els.msg.textContent = fill(t('bor.revoked', 'Ana stopped the job. The {n} tokens written so far are kept.'), { n: partial });
      els.choices.hidden = false;
    } else {
      els.reason.textContent = fill(t('bor.done', 'Done: {n} tokens on {target}.'), { n: partial, target: peer ? t('bor.anaGpu', "Ana's GPU") : els.reason.dataset.target });
    }
    idle();
  }
  function run() {
    els.choices.hidden = true;
    const dec = decide(size());
    render(dec);
    if (!dec.win || job) return;
    const w = dec.win, m = dec.m;
    els.reason.dataset.target = w.name;
    const peer = w.who === 'ana';
    const total = Math.round(m.tokens);
    const tps = total / Math.max(1, w.s - 2);
    const startedAt = performance.now();
    job = { dec, tokens: 0, iv: 0, beat: startedAt };
    els.run.disabled = true;
    els.stop.disabled = !peer;
    els.lease.hidden = !peer;
    mach[w.who].classList.add('is-busy');
    if (w.cpu) meter('you', 'cpu', .95, '95%');
    else if (peer) { meter('ana', 'vram', (ANA.vramUsed + m.need) / ANA.vramTotal, fill(t('bor.gb', '{a} of {b} GB'), { a: num(ANA.vramUsed + m.need), b: num(ANA.vramTotal, 0) })); meter('ana', 'util', .92, '92%'); }
    else { meter('you', 'vram', (YOU.vramUsed + m.need) / YOU.vramTotal, fill(t('bor.gb', '{a} of {b} GB'), { a: num(YOU.vramUsed + m.need), b: num(YOU.vramTotal) })); meter('you', 'util', .9, '90%'); }
    const speed = reduced ? 50 : 1; // reduced motion: finish almost at once
    job.iv = setInterval(() => {
      if (!job) return;
      const now = performance.now();
      const secs = ((now - startedAt) / 1000) * speed;
      job.tokens = Math.min(total, Math.round(Math.max(0, secs - 1.2) * tps));
      els.tok.textContent = String(job.tokens);
      if (now - job.beat >= 5000) job.beat = now;
      els.left.textContent = `${Math.max(0, 15 - Math.floor((now - job.beat) / 1000))} s`;
      if (job.tokens >= total) stopJob('done');
    }, 200);
  }
  els.run.addEventListener('click', run);
  els.stop.addEventListener('click', () => stopJob('revoked'));
  $$('[data-bor-reset]', bor).forEach((b) => b.addEventListener('click', () => { els.choices.hidden = true; render(decide(size())); }));
  $$('input[name="bor-model"]', bor).forEach((r) => r.addEventListener('change', () => { if (!job) { els.choices.hidden = true; render(decide(size())); } }));
  idle();
  render(decide(3));
}

// ---------- the pooled giant model meter ----------
const pool = $('[data-pool]');
if (pool) {
  const NEED = 45, SCALE = 60;
  const YOU = { vram: 5, ram: 12 }, FRIEND = 10;
  const GPU_BW = 300, CPU_BW = 20, RTT = 0.06;
  const n = $('[data-pool-n]', pool), out = $('[data-pool-out]', pool), read = $('[data-pool-read]', pool);
  const vb = $('[data-pool-vram]', pool), rb = $('[data-pool-ram]', pool), bar = $('.pool-bar', pool);
  function update() {
    const k = Number(n.value);
    const vram = YOU.vram + k * FRIEND, ram = YOU.ram, total = vram + ram;
    out.textContent = String(k);
    vb.style.setProperty('--w', `${(vram / SCALE) * 100}%`);
    rb.style.setProperty('--w', `${(ram / SCALE) * 100}%`);
    bar.style.setProperty('--n', `${(NEED / SCALE) * 100}%`);
    if (total < NEED) {
      read.textContent = fill(t('pool.short', '{have} GB pooled, {need} GB needed: {miss} GB missing.'), { have: total, need: NEED, miss: NEED - total });
      read.classList.remove('is-ok');
      return;
    }
    const onGpu = Math.min(NEED, vram), onCpu = NEED - onGpu;
    const sec = onGpu / GPU_BW + onCpu / CPU_BW + k * RTT;
    const tps = 1 / sec;
    read.textContent = tps >= 1
      ? fill(t('pool.ok', '{have} GB pooled, {need} GB needed. Speed estimate: about {tps} tokens per second, enough for the meter to unlock.'), { have: total, need: NEED, tps: num(tps) })
      : fill(t('pool.slow', '{have} GB pooled, {need} GB needed, but only about {tps} tokens per second: too slow to unlock.'), { have: total, need: NEED, tps: num(tps) });
    read.classList.toggle('is-ok', tps >= 1);
  }
  n.addEventListener('input', update);
  update();
}

// ---------- the playbook picker ----------
const pb = $('[data-playbooks]');
if (pb) {
  const input = $('[data-pb-q]', pb), list = $('[data-pb-list]', pb), count = $('[data-pb-count]', pb);
  let lib = null, loading = null;
  const STOP = new Set('a an the and or of to for with in on at by from into is are be it this that my our your me i we you make build create write add small simple new please some one use want need can could should get just also page app'.split(' '));
  const terms = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w));
  function load() {
    if (!loading) loading = fetch(`${ROOT}assets/playbooks.json`).then((r) => r.json()).then((d) => { lib = d.map((e) => ({ ...e, f: { t: terms(e.title), g: terms(e.tags.join(' ')), w: terms(e.when) } })); return lib; }).catch(() => (lib = []));
    return loading;
  }
  function score(e, q) {
    let s = 0;
    for (const w of q) {
      if (e.f.t.includes(w)) s += 3;
      if (e.f.g.includes(w)) s += 2;
      if (e.f.w.includes(w)) s += 0.6;
      else if (w.length > 3 && e.f.t.some((x) => x.startsWith(w))) s += 1;
    }
    return s;
  }
  async function search() {
    const q = terms(input.value);
    if (!q.length) { list.innerHTML = `<li><span class="pb-t"></span></li>`; $('.pb-t', list).textContent = t('pb.hint', 'Type a task to see what would be picked'); count.textContent = ''; return; }
    await load();
    const hits = lib.map((e) => [score(e, q), e]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]).slice(0, 3);
    list.innerHTML = '';
    if (!hits.length) {
      const li = document.createElement('li'); li.innerHTML = '<span class="pb-t"></span>';
      $('.pb-t', li).textContent = t('pb.none', 'No close playbook. The crew works from the brief alone.');
      list.append(li);
    }
    hits.forEach(([, e], i) => {
      const li = document.createElement('li');
      if (i === 0) li.className = 'is-hit';
      li.innerHTML = '<span class="pb-t" translate="no"></span><span class="pb-c" translate="no"></span><span class="pb-w" translate="no"></span>';
      $('.pb-t', li).textContent = e.title;
      $('.pb-c', li).textContent = e.category;
      $('.pb-w', li).textContent = e.when.length > 150 ? `${e.when.slice(0, 147)}...` : e.when;
      list.append(li);
    });
    count.textContent = fill(t('pb.count', 'From {n} playbooks, in English. In the app the role, the room and the file types count too.'), { n: lib.length });
  }
  let deb = 0;
  input.addEventListener('focus', load, { once: true });
  input.addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(search, 120); });
}

// ---------- the remote screen card counts down while on screen ----------
const cd = $('[data-countdown]');
if (cd && !reduced) {
  const card = cd.closest('.rem-card');
  watch(card);
  let left = 58;
  setInterval(() => {
    if (!onScreen(card)) return;
    left = left <= 1 ? 60 : left - 1;
    cd.textContent = `0:${String(left).padStart(2, '0')}`;
  }, 1000);
}
