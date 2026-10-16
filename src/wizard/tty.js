// Terminal front end of the wizard: raw mode arrow key menus with node:readline, ANSI colors, no dependencies.
import readline from 'node:readline';
import { t } from './i18n.js';

const ESC = '\x1b[';
const c = {
  honey: (s) => `${ESC}38;5;214m${s}${ESC}0m`,
  light: (s) => `${ESC}38;5;222m${s}${ESC}0m`,
  dim: (s) => `${ESC}2m${s}${ESC}0m`,
  bold: (s) => `${ESC}1m${s}${ESC}0m`,
  green: (s) => `${ESC}32m${s}${ESC}0m`,
  red: (s) => `${ESC}31m${s}${ESC}0m`
};

export const MEL = [
  '        __    __',
  '       /  \\__/  \\        hivedesk',
  '      |  (o)(o)  |       Mel, the foreman, at your service',
  '       \\   \\/   /',
  '     ___\\______/___',
  '    / /|##|##|##|\\ \\',
  '      \\_|##|##|##|_/',
  '         \\______/'
];

function header() {
  return MEL.map((l, i) => (i === 1 ? c.honey(l.replace('hivedesk', c.bold('hivedesk'))) : i === 2 ? c.light(l) : c.honey(l))).join('\n');
}

/**
 * Asks every question of a wizard (core.js) in the terminal.
 * @param {ReturnType<import('./core.js').createWizard>} wizard
 * @param {{ input?: NodeJS.ReadStream, output?: NodeJS.WriteStream, color?: boolean }} [io]
 * @returns {Promise<import('./core.js').Answers>}
 */
export function runTty(wizard, io = {}) {
  const input = io.input || process.stdin;
  const output = io.output || process.stdout;
  const color = io.color !== false;
  const paint = color ? c : Object.fromEntries(Object.keys(c).map((k) => [k, (s) => s]));
  readline.emitKeypressEvents(input);
  const raw = typeof input.setRawMode === 'function';
  if (raw) input.setRawMode(true);
  input.resume?.();
  let lines = 0;

  const write = (text) => {
    // Clear what the previous frame drew, then draw this one.
    if (lines) output.write(`${ESC}${lines}F${ESC}0J`);
    output.write(text + '\n');
    lines = text.split('\n').length;
  };

  return new Promise((resolve, reject) => {
    let q = null;
    let cursor = 0;
    let ticked = new Set();
    let text = '';
    let error = '';

    const load = () => {
      q = wizard.question();
      error = '';
      if (!q) return;
      if (q.type === 'select') cursor = Math.max(0, q.options.findIndex((o) => o.value === q.default));
      if (q.type === 'checkbox') { cursor = 0; ticked = new Set(q.default || []); }
      if (q.type === 'text' || q.type === 'secret') text = q.default || '';
    };

    const render = () => {
      const S = t(wizard.lang);
      const out = [];
      if (q.id === 'welcome' || q.id === 'reuse') out.push(color ? header() : MEL.join('\n'), '');
      out.push(paint.bold(paint.honey('? ')) + paint.bold(q.title));
      for (const b of q.body || []) out.push(`  ${paint.dim(b)}`);
      if (q.type === 'select') {
        q.options.forEach((o, i) => {
          const on = i === cursor;
          const tag = o.recommended ? ` ${paint.green(`(${S.recommended})`)}` : '';
          out.push(`${on ? paint.honey(' > ') : '   '}${on ? paint.bold(o.label) : o.label}${tag}`);
          if (on && o.hint) out.push(`     ${paint.dim(o.hint)}`);
        });
      } else if (q.type === 'checkbox') {
        q.options.forEach((o, i) => out.push(`${i === cursor ? paint.honey(' > ') : '   '}[${ticked.has(o.value) ? paint.honey('x') : ' '}] ${o.label}`));
      } else if (q.type === 'text') {
        out.push(`  ${paint.honey('>')} ${text}${paint.dim('_')}`);
      } else if (q.type === 'secret') {
        out.push(`  ${paint.honey('>')} ${'*'.repeat(text.length)}${paint.dim('_')}`);
      } else if (q.type === 'confirm') {
        out.push(`  ${paint.dim(`(${q.default ? S.yes : S.no})`)}`);
      }
      if (error) out.push(paint.red(`  ${error}`));
      write(out.join('\n'));
    };

    const finish = () => {
      input.removeListener('keypress', onKey);
      if (raw) input.setRawMode(false);
      input.pause?.();
      resolve(wizard.result());
    };

    const submit = (value) => {
      const err = wizard.answer(value);
      if (err) { error = err; render(); return; }
      lines = 0;
      output.write('\n');
      if (wizard.done) return finish();
      load();
      render();
    };

    const onKey = (str, key = {}) => {
      if (key.ctrl && key.name === 'c') {
        input.removeListener('keypress', onKey);
        if (raw) input.setRawMode(false);
        output.write('\n');
        reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
        return;
      }
      const enter = key.name === 'return' || key.name === 'enter';
      switch (q.type) {
        case 'info':
          if (enter) submit(undefined);
          return;
        case 'select':
          if (key.name === 'up') cursor = (cursor - 1 + q.options.length) % q.options.length;
          else if (key.name === 'down') cursor = (cursor + 1) % q.options.length;
          else if (enter) return submit(q.options[cursor].value);
          else return;
          render();
          return;
        case 'checkbox':
          if (key.name === 'up') cursor = (cursor - 1 + q.options.length) % q.options.length;
          else if (key.name === 'down') cursor = (cursor + 1) % q.options.length;
          else if (key.name === 'space') {
            const v = q.options[cursor].value;
            if (ticked.has(v)) ticked.delete(v); else ticked.add(v);
          } else if (enter) return submit(q.options.map((o) => o.value).filter((v) => ticked.has(v)));
          else return;
          render();
          return;
        case 'confirm':
          if (enter) return submit(undefined);
          if (/^[ysYS]$/.test(str || '')) return submit(true);
          if (/^[nN]$/.test(str || '')) return submit(false);
          return;
        case 'text':
        case 'secret':
          if (enter) return submit(text);
          if (key.name === 'backspace') text = text.slice(0, -1);
          else if (str && !key.ctrl && !key.meta && str >= ' ') text += str;
          else return;
          render();
          return;
        default:
          if (enter) submit(undefined);
      }
    };

    input.on('keypress', onKey);
    load();
    render();
  });
}
