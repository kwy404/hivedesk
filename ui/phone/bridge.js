// The desktop window's half of a phone connection: it moves text between the WebRTC data channel
// to the phone and this engine (phone.pipe.open / phone.pipe.in, live phone.pipe.out). It never
// sees plaintext: the engine runs the handshake and the session (src/phone/hub.js).

/**
 * @param {{ command: (type: string, data?: object) => Promise<any>, onLive: (fn: (type: string, data: any) => void) => () => void }} engine
 * @param {{ send: Function, close: Function, onmessage: any, onclose: any }} link a framed link (ui/phone/core/connect.js)
 * @returns {Promise<{ pipeId: string, close: () => void }>}
 */
export async function bridgePhone(engine, link) {
  let pipeId = null;
  let closed = false;
  const early = [];
  const fromPhone = [];
  const off = engine.onLive((type, d) => {
    if (type === 'phone.pipe.out' && d && typeof d.data === 'string') {
      if (pipeId === null) early.push(d);
      else if (d.pipeId === pipeId) send(d.data);
    } else if (type === 'phone.pipe.closed' && d?.pipeId === pipeId) end('engine');
  });
  const send = (text) => {
    try { link.send(text); } catch { end('link'); }
  };
  const toEngine = (text) => engine.command('phone.pipe.in', { pipeId, data: text }).catch(() => end('engine'));
  const end = (by) => {
    if (closed) return;
    closed = true;
    off();
    if (by !== 'engine' && pipeId) engine.command('phone.pipe.close', { pipeId, reason: 'the data channel closed' }).catch(() => {});
    if (by !== 'link') { try { link.close(); } catch { /* closed */ } }
  };
  link.onmessage = (text) => (pipeId === null ? fromPhone.push(text) : toEngine(text));
  link.onclose = () => end('link');
  const reply = await engine.command('phone.pipe.open', {});
  pipeId = reply.pipeId;
  for (const d of early.splice(0)) if (d.pipeId === pipeId) send(d.data);
  for (const t of fromPhone.splice(0)) toEngine(t);
  return { pipeId, close: () => end('window') };
}
