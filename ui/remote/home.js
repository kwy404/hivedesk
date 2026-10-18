// The remote screen home window: this computer's 10 digit address with Copy, the partner address field
// with Connect, what to ask for, unattended access with its warnings, the folder for pasted files, and
// a first time explanation.

import { h, icon } from '../js/dom.js';
import * as net from '../js/net.js';
import * as wm from '../js/wm.js';
import { notify } from '../js/notify.js';
import { tr, cmd, store, onState, refresh } from './common.js';
import { checkAddress, groupDigits } from './digits.js';

const HINT_KEY = 'hivedesk.remote.hintSeen';

export { checkAddress };

wm.register('remote-home', {
  title: () => tr('remote.home.title'),
  glyph: () => icon('globe'),
  size: [560, 640],
  min: [340, 360],
  create(ctx) {
    const root = h('div', { class: 'rd-home' });
    ctx.body.append(root);
    let seenHint = false;
    try { seenHint = localStorage.getItem(HINT_KEY) === '1'; } catch { /* private window */ }

    const addrBig = h('div', { class: 'rd-address', 'aria-live': 'polite' });
    const copyBtn = h('button', { type: 'button', class: 'btn btn-sm btn-quiet', text: tr('remote.home.copy'), on: { click: async () => {
      const a = store.state?.address;
      if (!a) return;
      try { await navigator.clipboard.writeText(a); notify({ title: tr('remote.home.copied'), tone: 'ok' }); } catch { /* no clipboard access */ }
    } } });
    const listen = h('input', { type: 'checkbox', on: { change: () => cmd('remote.listen', { on: listen.checked }).catch(() => { listen.checked = !listen.checked; }) } });

    const field = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', class: 'rd-address-in', placeholder: tr('remote.home.partnerHint'), 'aria-label': tr('remote.home.partner') });
    const err = h('div', { class: 'small rd-warn', role: 'alert' });
    field.addEventListener('input', () => { const pos = field.value.length; field.value = groupDigits(field.value); if (pos >= field.value.length) field.setSelectionRange(field.value.length, field.value.length); err.textContent = ''; err.classList.remove('rd-warn'); });
    field.addEventListener('paste', (e) => { e.preventDefault(); field.value = groupDigits(e.clipboardData.getData('text')); });
    const askControl = h('input', { type: 'checkbox' });
    const askClip = h('input', { type: 'checkbox' });
    const askFiles = h('input', { type: 'checkbox' });
    const pw = h('input', { type: 'password', autocomplete: 'off', placeholder: tr('remote.home.password'), 'aria-label': tr('remote.home.password') });
    const connectBtn = h('button', { type: 'button', class: 'btn btn-primary', text: tr('remote.home.connect') });
    const connect = async () => {
      const bad = checkAddress(field.value);
      if (bad) { err.textContent = tr(`remote.home.bad.${bad}`); field.focus(); return; }
      if (!store.state?.canDial) { err.textContent = tr('remote.home.noDial'); return; }
      connectBtn.disabled = true;
      err.textContent = tr('remote.home.calling', { address: field.value });
      try {
        const r = await net.command('remote.connect', { address: field.value, control: askControl.checked, clipboard: askClip.checked, files: askFiles.checked, password: pw.value || undefined }, { timeout: 60000 });
        pw.value = '';
        err.textContent = r.collision ? tr('remote.home.collision', { name: r.collision.name }) : '';
        await refresh();
        wm.open('remote', r.sessionId);
      } catch (e) {
        // A different key behind a known address: a hard warning, and the call stays blocked.
        const changed = e.code === 'address_key_changed';
        err.classList.toggle('rd-warn', changed);
        err.textContent = changed ? tr('remote.home.keyChanged') : tr('remote.error', { message: e.message });
      }
      finally { connectBtn.disabled = false; }
    };
    connectBtn.addEventListener('click', connect);
    field.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });

    // Unattended access: off by default, its own section with the warning first.
    const uEnable = h('input', { type: 'checkbox' });
    const uPw = h('input', { type: 'password', autocomplete: 'new-password', placeholder: tr('remote.unattended.password'), 'aria-label': tr('remote.unattended.password') });
    const uCtl = h('input', { type: 'checkbox' });
    const uClip = h('input', { type: 'checkbox' });
    const uFiles = h('input', { type: 'checkbox' });
    const uKnown = h('input', { type: 'checkbox', checked: true });
    const uState = h('div', { class: 'small' });
    const uSave = h('button', { type: 'button', class: 'btn btn-sm btn-quiet', text: tr('remote.unattended.save'), on: { click: async () => {
      const r = await cmd('remote.unattended.set', { enabled: uEnable.checked, password: uPw.value || undefined, allow: { control: uCtl.checked, clipboard: uClip.checked, files: uFiles.checked }, minutes: 60, peers: uKnown.checked ? 'known' : 'any' }).catch(() => null);
      if (r) { uPw.value = ''; refresh(); }
    } } });

    const folderLbl = h('span', { class: 'small muted ellipsis' });
    const folderBtn = h('button', { type: 'button', class: 'btn btn-xs btn-quiet', text: tr('remote.clip.folderPick'), on: { click: async () => {
      // The desktop app has a native folder picker; a browser window keeps the default folder.
      try {
        const r = await fetch(net.withToken('/api/desktop/bridge'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'pickFolder', data: { title: tr('remote.clip.folder') } }) });
        const j = await r.json();
        const p = j?.result?.path;
        if (p) { await cmd('remote.clip.folder', { path: p }); refresh(); }
      } catch { /* no native picker */ }
    } } });

    const hint = seenHint ? null : h('div', { class: 'rd-hint' },
      h('b', { text: tr('remote.hint.title') }),
      h('ol', {}, h('li', { text: tr('remote.hint.1') }), h('li', { text: tr('remote.hint.2') }), h('li', { text: tr('remote.hint.3', { hotkey: 'Ctrl+Alt+Shift+K' }) })),
      h('button', { type: 'button', class: 'btn btn-xs btn-quiet', text: tr('remote.hint.ok'), on: { click: (e) => { try { localStorage.setItem(HINT_KEY, '1'); } catch { /* private */ } e.currentTarget.closest('.rd-hint').remove(); } } }));

    const unavailable = h('p', { class: 'rd-warn', hidden: true, text: tr('remote.unavailable') });
    const noAddress = h('p', { class: 'small muted', hidden: true, text: tr('remote.home.noAddress') });
    root.append(
      unavailable, hint,
      h('section', { class: 'rd-sec' },
        h('div', { class: 'small muted', text: tr('remote.home.yours') }),
        h('div', { class: 'row' }, addrBig, copyBtn), noAddress,
        h('p', { class: 'small muted', text: tr('remote.home.yoursHelp') }),
        h('label', { class: 'rd-check' }, listen, h('span', { text: tr('remote.home.listen') })),
        h('p', { class: 'small muted', text: tr('remote.home.listenHelp') })),
      h('section', { class: 'rd-sec' },
        h('label', { class: 'small muted', text: tr('remote.home.partner') }),
        h('div', { class: 'row' }, field, connectBtn), err,
        h('div', { class: 'small muted', text: tr('remote.home.ask') }),
        h('label', { class: 'rd-check' }, askControl, h('span', { text: tr('remote.home.askControl') })),
        h('label', { class: 'rd-check' }, askClip, h('span', { text: tr('remote.home.askClipboard') })),
        h('label', { class: 'rd-check' }, askFiles, h('span', { text: tr('remote.home.askFiles') })),
        pw),
      h('section', { class: 'rd-sec' },
        h('div', { class: 'row' }, h('span', { class: 'small muted', text: tr('remote.clip.folder') }), folderLbl, folderBtn)),
      h('details', { class: 'rd-sec' },
        h('summary', { text: tr('remote.unattended.title') }),
        h('p', { class: 'small rd-warn', text: tr('remote.unattended.warn') }),
        uState,
        h('label', { class: 'rd-check' }, uEnable, h('span', { text: tr('remote.unattended.enable') })),
        uPw,
        h('label', { class: 'rd-check' }, uCtl, h('span', { text: tr('remote.unattended.allowControl') })),
        h('label', { class: 'rd-check' }, uClip, h('span', { text: tr('remote.unattended.allowClipboard') })),
        h('label', { class: 'rd-check' }, uFiles, h('span', { text: tr('remote.unattended.allowFiles') })),
        h('label', { class: 'rd-check' }, uKnown, h('span', { text: tr('remote.unattended.knownOnly') })),
        uSave));

    const render = (s) => {
      unavailable.hidden = !!s?.available;
      if (!s?.available) return;
      addrBig.textContent = s.addressText || '';
      copyBtn.hidden = !s.address;
      noAddress.hidden = !!s.address;
      listen.checked = !!s.listening;
      listen.disabled = !s.address;
      const u = s.unattended || {};
      uEnable.checked = !!u.enabled;
      uCtl.checked = !!u.allow?.control; uClip.checked = !!u.allow?.clipboard; uFiles.checked = !!u.allow?.files;
      uKnown.checked = u.peers !== 'any';
      uState.textContent = u.lockedFor ? tr('remote.unattended.locked', { minutes: Math.ceil(u.lockedFor / 60000) }) : u.enabled ? tr('remote.unattended.on', { minutes: u.minutes }) : tr('remote.unattended.off');
      folderLbl.textContent = s.clipboard?.folder || tr('remote.clip.folderDefault');
    };
    render(store.state);
    const off = onState(render);
    refresh();
    ctx.onDispose(off);
  }
});
