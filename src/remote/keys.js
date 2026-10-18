// The key allowlist for remote control. A viewer sends KeyboardEvent.code values (physical keys);
// anything not in this table is dropped. Each entry has the Windows virtual key, whether it is an
// extended key (KEYEVENTF_EXTENDEDKEY) and the X11 keysym name xdotool understands.
// Secure attention and lock combinations are dropped even though every key in them is allowed alone.

/** @type {Record<string, { vk: number, ext?: boolean, x: string }>} */
export const KEYS = {};

const add = (code, vk, x, ext = false) => { KEYS[code] = ext ? { vk, ext: true, x } : { vk, x }; };

for (let i = 0; i < 26; i++) {
  const c = String.fromCharCode(65 + i);
  add(`Key${c}`, 0x41 + i, c.toLowerCase());
}
for (let i = 0; i < 10; i++) {
  add(`Digit${i}`, 0x30 + i, String(i));
  add(`Numpad${i}`, 0x60 + i, `KP_${i}`);
}
for (let i = 1; i <= 12; i++) add(`F${i}`, 0x6f + i, `F${i}`);

[
  ['Enter', 0x0d, 'Return'], ['Escape', 0x1b, 'Escape'], ['Backspace', 0x08, 'BackSpace'], ['Tab', 0x09, 'Tab'],
  ['Space', 0x20, 'space'], ['Minus', 0xbd, 'minus'], ['Equal', 0xbb, 'equal'], ['BracketLeft', 0xdb, 'bracketleft'],
  ['BracketRight', 0xdd, 'bracketright'], ['Backslash', 0xdc, 'backslash'], ['Semicolon', 0xba, 'semicolon'],
  ['Quote', 0xde, 'apostrophe'], ['Backquote', 0xc0, 'grave'], ['Comma', 0xbc, 'comma'], ['Period', 0xbe, 'period'],
  ['Slash', 0xbf, 'slash'], ['IntlBackslash', 0xe2, 'less'], ['CapsLock', 0x14, 'Caps_Lock'],
  ['ShiftLeft', 0xa0, 'Shift_L'], ['ShiftRight', 0xa1, 'Shift_R'], ['ControlLeft', 0xa2, 'Control_L'], ['AltLeft', 0xa4, 'Alt_L'],
  ['ScrollLock', 0x91, 'Scroll_Lock'], ['Pause', 0x13, 'Pause'],
  ['NumpadMultiply', 0x6a, 'KP_Multiply'], ['NumpadAdd', 0x6b, 'KP_Add'], ['NumpadSubtract', 0x6d, 'KP_Subtract'],
  ['NumpadDecimal', 0x6e, 'KP_Decimal']
].forEach(([c, vk, x]) => add(c, vk, x));

[
  ['ControlRight', 0xa3, 'Control_R'], ['AltRight', 0xa5, 'Alt_R'], ['MetaLeft', 0x5b, 'Super_L'], ['MetaRight', 0x5c, 'Super_R'],
  ['ContextMenu', 0x5d, 'Menu'], ['ArrowLeft', 0x25, 'Left'], ['ArrowUp', 0x26, 'Up'], ['ArrowRight', 0x27, 'Right'],
  ['ArrowDown', 0x28, 'Down'], ['Insert', 0x2d, 'Insert'], ['Delete', 0x2e, 'Delete'], ['Home', 0x24, 'Home'], ['End', 0x23, 'End'],
  ['PageUp', 0x21, 'Prior'], ['PageDown', 0x22, 'Next'], ['PrintScreen', 0x2c, 'Print'], ['NumLock', 0x90, 'Num_Lock'],
  ['NumpadEnter', 0x0d, 'KP_Enter'], ['NumpadDivide', 0x6f, 'KP_Divide']
].forEach(([c, vk, x]) => add(c, vk, x, true));

Object.freeze(KEYS);

const MODS = { ShiftLeft: 'shift', ShiftRight: 'shift', ControlLeft: 'ctrl', ControlRight: 'ctrl', AltLeft: 'alt', AltRight: 'alt', MetaLeft: 'meta', MetaRight: 'meta' };

/**
 * Follows the modifier keys a viewer holds and decides each key event. A key down that completes
 * Ctrl+Alt+Delete, Ctrl+Alt+End, Win+L or the kill hotkey Ctrl+Alt+Shift+K is dropped, and so is its key up.
 */
export class KeyFilter {
  constructor() {
    this.down = new Set();
    this.dropped = new Set();
  }

  mods() {
    const m = { shift: false, ctrl: false, alt: false, meta: false };
    for (const c of this.down) if (MODS[c]) m[MODS[c]] = true;
    return m;
  }

  /** @returns {'ok' | 'unknown' | 'blocked'} */
  check(code, down) {
    if (!Object.hasOwn(KEYS, code)) return 'unknown';
    if (!down) {
      if (this.dropped.delete(code)) return 'blocked';
      this.down.delete(code);
      return 'ok';
    }
    const m = this.mods();
    const blocked =
      (m.ctrl && m.alt && (code === 'Delete' || code === 'End' || code === 'NumpadDecimal')) ||
      (m.meta && code === 'KeyL') ||
      (m.ctrl && m.alt && m.shift && code === 'KeyK');
    if (blocked) { this.dropped.add(code); return 'blocked'; }
    this.down.add(code);
    return 'ok';
  }

  /** The keys still held, so they can be released. Clears the state. */
  release() {
    const held = [...this.down];
    this.down.clear();
    this.dropped.clear();
    return held;
  }
}
