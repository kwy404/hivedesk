// The mini widget outside the page: a 360 by 480 popup window, or a Document
// Picture-in-Picture window where the browser supports it. Both load ui/widget.html,
// which opens its own WebSocket to this hivedesk and stays in sync by itself.

import { withToken } from '/js/net.js';
import { notify } from '/js/notify.js';

const W = 360;
const H = 480;
let pipWin = null;

export const pipSupported = () => 'documentPictureInPicture' in window;

export function openWidget() {
  const url = withToken('/widget.html');
  const left = Math.max(0, (screen.availWidth || 1280) - W - 32);
  const win = window.open(url, 'hivedesk-widget', `popup=yes,width=${W},height=${H},left=${left},top=80`);
  if (!win) {
    notify({ title: 'The browser blocked the pop up', body: 'Allow pop ups for this page, or open /widget.html in a new tab.', tone: 'warn' });
    return null;
  }
  win.focus?.();
  return win;
}

export async function openPip() {
  if (!pipSupported()) return openWidget();
  if (pipWin && !pipWin.closed) { pipWin.focus?.(); return pipWin; }
  try {
    pipWin = await window.documentPictureInPicture.requestWindow({ width: W, height: H });
  } catch (err) {
    notify({ title: 'Picture in picture did not open', body: String(err?.message || err), tone: 'warn' });
    return null;
  }
  const doc = pipWin.document;
  doc.title = 'hivedesk mini';
  const style = doc.createElement('style');
  style.textContent = 'html,body{margin:0;height:100%;background:#0A0B0D;overflow:hidden}iframe{border:0;width:100%;height:100%;display:block}';
  doc.head.append(style);
  const frame = doc.createElement('iframe');
  frame.src = withToken('/widget.html?pip=1');
  frame.title = 'hivedesk mini widget';
  doc.body.append(frame);
  pipWin.addEventListener('pagehide', () => { pipWin = null; });
  return pipWin;
}
