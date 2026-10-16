// The small API the desktop gives to plug-in panels (the lend window uses it).

import { command, sendRaw, on, isOpen } from './net.js';
import { S, ui, rev, onEvent, worker } from './store.js';
import { notify } from './notify.js';
import { play } from './sound.js';
import { beeAvatar } from './bees.js';
import * as wm from './wm.js';

export const hive = {
  /** Sends a command (PROTOCOL.md section 4) and resolves with its result. */
  command,
  /** Sends a raw frame, for frames without a reply such as `brain.token`. */
  send: sendRaw,
  /** Listens to raw frames by kind: 'brain.request', 'brain.cancel', 'event', 'live', 'hello', 'connection'. Returns an unsubscribe function. */
  on,
  /** Every logged event, after the store applied it. Returns an unsubscribe function. */
  onEvent,
  isConnected: isOpen,
  /** Current state snapshot (read only). */
  state: S,
  /** Reactive UI flags: demo, lend, connection, replay. */
  ui,
  rev,
  worker,
  notify,
  sound: play,
  beeAvatar,
  openWindow: (type, arg) => wm.open(type, arg),
  V: window.V,
};

window.hivedesk = hive;
