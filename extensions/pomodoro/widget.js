// Pomodoro timer. Runs in a sandboxed frame; settings and the daily count go to hivedesk.storage.
const $ = (id) => document.getElementById(id);
const LEN = { focus: 25, short: 5, long: 15 };
let mode = 'focus';
let left = LEN.focus * 60;
let total = left;
let timer = null;
let endAt = 0;
let done = { day: new Date().toDateString(), count: 0 };

const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

function paint() {
  $('time').textContent = fmt(Math.max(0, left));
  const c = 2 * Math.PI * 44;
  $('fill').style.strokeDasharray = `${c}`;
  $('fill').style.strokeDashoffset = `${c * (1 - left / total)}`;
  $('start').textContent = timer ? 'Pause' : left < total ? 'Resume' : 'Start';
  $('count').textContent = `${done.count} focus block${done.count === 1 ? '' : 's'} today`;
  for (const b of document.querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
}

function setMode(m) {
  stop();
  mode = m;
  total = left = LEN[m] * 60;
  paint();
}

function tick() {
  left = Math.round((endAt - Date.now()) / 1000);
  if (left <= 0) {
    stop();
    left = 0;
    if (mode === 'focus') {
      done.count++;
      hivedesk.storage.set('done', done).catch(() => {});
      hivedesk.notify('Focus block done', 'Time for a break.').catch(() => {});
      setMode(done.count % 4 === 0 ? 'long' : 'short');
    } else {
      hivedesk.notify('Break is over', 'Back to the hive.').catch(() => {});
      setMode('focus');
    }
    return;
  }
  paint();
}

function start() { endAt = Date.now() + left * 1000; timer = setInterval(tick, 250); paint(); }
function stop() { clearInterval(timer); timer = null; paint(); }

$('start').addEventListener('click', () => (timer ? stop() : start()));
$('reset').addEventListener('click', () => setMode(mode));
for (const b of document.querySelectorAll('[data-mode]')) b.addEventListener('click', () => setMode(b.dataset.mode));
$('len').addEventListener('change', () => {
  const v = Math.min(90, Math.max(5, Number($('len').value) || 25));
  $('len').value = v;
  LEN.focus = v;
  hivedesk.storage.set('focus', v).catch(() => {});
  if (mode === 'focus' && !timer) setMode('focus');
});

Promise.all([hivedesk.storage.get('focus'), hivedesk.storage.get('done')]).then(([focus, d]) => {
  if (focus) { LEN.focus = focus; $('len').value = focus; }
  if (d && d.day === new Date().toDateString()) done = d;
  setMode('focus');
}, () => setMode('focus'));
paint();
