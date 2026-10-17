// Plugs the Code editor and Code together into the desktop (imported once by ui/js/main.js).
// Kept small and defensive: the heavy parts load only when a window opens, and nothing here may
// break the desktop if it fails.
//   window types  editor (the Code window), collab (Code together), code (opens the Code window)
//   palette       entries through globalThis.hivedeskPalette
//   top bar       the avatars of everyone in the session; a click follows that person
//   dock          a Code button and a Code together button
//   API           window.hivedeskEditor.open(path)

import { h } from '/js/dom.js';
import * as wm from '/js/wm.js';

const CODE_ICON = '<svg class="ico" viewBox="0 0 24 24"><path d="M8.5 7 3.5 12l5 5M15.5 7l5 5-5 5"/></svg>';
const TOGETHER_ICON = '<svg class="ico" viewBox="0 0 24 24"><circle cx="8.5" cy="8.5" r="3"/><circle cx="16.5" cy="9.5" r="2.5"/><path d="M3 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5M14.5 14.6c.6-.4 1.3-.6 2-.6 2.2 0 3.9 1.5 4.5 4"/></svg>';

let cssDone = false;
function linkCss() {
  if (cssDone) return;
  cssDone = true;
  for (const href of ['/lend/lend.css', '/editor/editor.css']) document.head.append(h('link', { rel: 'stylesheet', href }));
}

let editorApi = null;
const queue = [];

/** Opens a file in the Code window (opening the window if needed). */
function openInEditor(path) {
  wm.open('editor');
  if (!path) return;
  if (editorApi) editorApi.open(path);
  else queue.push(path);
}

globalThis.hivedeskEditor = {
  open: openInEditor,
  get api() {
    return editorApi;
  },
};

function failBox(el, title, err) {
  el.replaceChildren(h('div', { class: 'ed-empty' }, h('p', { class: 'ed-error', text: `${title}: ${err.message}` })));
}

wm.register('editor', {
  title: 'Code',
  glyph: () => h('span', { html: CODE_ICON }),
  size: [1080, 680],
  min: [360, 300],
  cardH: 640,
  create(ctx) {
    linkCss();
    const el = h('div', { class: 'ed-host' });
    ctx.body.append(el);
    ctx.body.classList.add('ed-win-body');
    let api = null;
    let closed = false;
    ctx.onDispose(() => {
      closed = true;
      api?.dispose();
      if (editorApi === api) editorApi = null;
    });
    import('./code-window.js')
      .then(async (m) => {
        if (closed) return;
        api = m.mountEditor(el, { path: queue.shift() });
        editorApi = api;
        await api.ready;
        while (queue.length) api.open(queue.shift());
      })
      .catch((err) => !closed && failBox(el, 'The Code window did not load', err));
  },
});

// The desktop's file windows ("Open in code") now open the Code window on that file.
wm.register('code', {
  title: (path) => (path ? path.split('/').pop() : 'Code'),
  glyph: () => h('span', { html: CODE_ICON }),
  size: [320, 120],
  create(ctx, path) {
    setTimeout(() => {
      ctx.close();
      openInEditor(path);
    }, 0);
  },
});

wm.register('collab', {
  title: 'Code together',
  glyph: () => h('span', { html: TOGETHER_ICON }),
  size: [620, 640],
  min: [320, 360],
  cardH: 680,
  create(ctx, arg) {
    linkCss();
    const el = h('div', { class: 'pane lend-host collab-host' });
    ctx.body.append(el);
    let api = null;
    let closed = false;
    ctx.onDispose(() => {
      closed = true;
      api?.dispose(); // the session keeps running; the window only shows it
    });
    import('/lend/collab/panel.js')
      .then((m) => {
        if (!closed) api = m.mountCollab(el, { initial: arg || initialWords() });
      })
      .catch((err) => !closed && failBox(el, 'Code together did not load', err));
  },
});

function initialWords() {
  const m = /(?:^|[#&?])cw=([A-Za-z-]+)/.exec(location.hash + location.search);
  return m ? `#cw=${m[1]}` : '';
}

/* ---------- palette ---------- */
(globalThis.hivedeskPalette ??= []).push((q) => {
  const out = [
    { group: 'Code', label: 'Open the Code editor', run: () => wm.open('editor'), icon: 'code' },
    { group: 'Code', label: 'Code together: share or join a session', run: () => wm.open('collab'), icon: 'chat' },
  ];
  const api = editorApi;
  if (api?.active) {
    out.push({ group: 'Code', label: `Save ${api.active}`, run: () => api.save(), icon: 'check' });
    out.push({ group: 'Code', label: 'Go to line...', run: () => { wm.open('editor'); api.editor?.focus(); api.editor?.getAction('editor.action.gotoLine')?.run(); }, icon: 'arrow' });
    out.push({ group: 'Code', label: 'Find and replace...', run: () => { wm.open('editor'); api.editor?.focus(); api.editor?.getAction('editor.action.startFindReplaceAction')?.run(); }, icon: 'arrow' });
    out.push({ group: 'Code', label: 'Review crew changes', run: () => { wm.open('editor'); api.review(); }, icon: 'approval' });
  }
  if (q && /^[\w./-]+\.\w+$/.test(q)) out.push({ group: 'Code', label: `Open ${q} in the Code editor`, run: () => openInEditor(q), icon: 'code' });
  return out;
});

/* ---------- top bar avatars and dock buttons ---------- */
async function decorate() {
  const right = document.querySelector('.topbar .bar-right');
  if (right && !right.querySelector('.collab-bar')) {
    const box = h('div', { class: 'collab-bar', attrs: { 'aria-label': 'People in this session' } });
    right.prepend(box);
    const { collab } = await import('/lend/collab/client.js');
    const { avatar } = await import('/lend/collab/panel.js');
    linkCss();
    const paint = () => {
      box.replaceChildren();
      const people = collab.people();
      box.hidden = !people.length;
      for (const p of people) {
        const av = avatar(p, 24);
        av.title = `${p.name}${p.role ? `, ${p.role}` : ''}${p.file ? `, in ${p.file}` : ''}`;
        if (p.id !== collab.myId()) {
          av.classList.add('is-click');
          av.addEventListener('click', () => {
            openInEditor(p.file || undefined);
            setTimeout(() => editorApi?.follow(p.id), 200);
          });
        }
        box.append(av);
      }
      if (people.length) box.append(h('button', { type: 'button', class: 'collab-bar-btn', text: collab.mode === 'guest' ? 'Guest' : 'Sharing', on: { click: () => wm.open('collab') } }));
    };
    collab.on('people', paint);
    collab.on('change', paint);
    paint();
  }
  const shelf = document.querySelector('.dock-shelf');
  if (shelf && !shelf.querySelector('[data-win="editor"]')) {
    const btn = (id, label, svg) => h('button', { class: 'dk', type: 'button', dataset: { win: id }, title: label, attrs: { 'aria-label': label }, on: { click: () => wm.toggleFromDock(id) } }, h('span', { class: 'dk-hex', html: svg }));
    const sep = shelf.querySelector('.dock-sep:last-of-type');
    const nodes = [btn('editor', 'Code', CODE_ICON), btn('collab', 'Code together', TOGETHER_ICON)];
    if (sep) sep.before(...nodes);
    else shelf.append(...nodes);
  }
  if (initialWords()) wm.open('collab');
}

function whenShell(tries = 0) {
  if (document.querySelector('.topbar .bar-right') && document.querySelector('.dock-shelf')) {
    decorate().catch((err) => console.warn('[hivedesk] Code together decorations', err));
  } else if (tries < 100) setTimeout(() => whenShell(tries + 1), 100);
}
whenShell();
