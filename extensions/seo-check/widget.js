// Runs inside a sandboxed frame. hivedesk.call runs the audit tool in the extension sandbox.
const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function show(report) {
  if (!report) return;
  $('score').textContent = report.pages.length ? String(report.score) : '--';
  $('score').className = `score ${report.score >= 80 ? 'good' : report.score >= 50 ? 'fair' : 'poor'}`;
  $('summary').textContent = report.summary;
  const box = $('pages');
  box.replaceChildren();
  for (const p of report.pages) {
    const sec = el('section');
    sec.append(el('h2', '', `${p.path}  ${p.score}`));
    const ul = el('ul');
    for (const i of p.issues) ul.append(el('li', 'bad', i));
    for (const ok of p.passed) ul.append(el('li', 'ok', ok));
    sec.append(ul);
    box.append(sec);
  }
}

async function run() {
  $('run').disabled = true;
  $('summary').textContent = 'Checking...';
  try {
    show(await hivedesk.call('audit', {}));
  } catch (err) {
    $('summary').textContent = err.message;
  } finally {
    $('run').disabled = false;
  }
}

$('run').addEventListener('click', run);
hivedesk.storage.get('last').then((last) => { if (last) show(last); else run(); }, () => run());
