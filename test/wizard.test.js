import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { createWizard, runScripted, defaults, toStartOptions } from '../src/wizard/core.js';
import { runTty } from '../src/wizard/tty.js';
import { detectLang } from '../src/wizard/i18n.js';
import { loadConfig, saveConfig } from '../src/wizard/config.js';
import { tmpDir } from './helpers.js';

const MiB = 1024 * 1024;
const facts = (over = {}) => ({
  cwd: path.resolve('/projects/site'), home: path.resolve('/home/me/.hivedesk'), lang: 'en',
  hardware: { gpu: { name: 'NVIDIA GeForce GTX 1060 6GB', vramBytes: 6144 * MiB }, ramBytes: 16e9, diskFreeBytes: 100e9 },
  ollama: null, lmstudio: null, cached: [], ...over
});

describe('wizard state machine', () => {
  it('Enter everywhere gives the recommended defaults', () => {
    const r = runScripted(facts());
    expect(r).toEqual({ lang: 'en', dir: facts().cwd, brain: { backend: 'local', model: 'qwen2.5-coder-3b', gpu: true }, approvalMode: true, crew: ['dev', 'designer', 'qa', 'writer'], open: true });
    expect(r).toEqual(defaults(facts()));
  });

  it('walks the steps in order and asks to confirm the download', () => {
    const w = createWizard(facts());
    const seen = [];
    while (!w.done) {
      const q = w.question();
      seen.push(q.id);
      if (q.id === 'brain') {
        expect(q.body[0]).toMatch(/GTX 1060 6GB 6\.4 GB, RAM 16 GB, 100 GB free disk/);
        expect(q.options.find((o) => o.recommended).value).toBe('local:qwen2.5-coder-3b');
        expect(q.options.map((o) => o.value)).toEqual(expect.arrayContaining(['local:qwen2.5-coder-7b', 'local:qwen2.5-coder-0.5b', 'openai', 'demo']));
      }
      if (q.id === 'download') expect(q.body.join('\n')).toMatch(/2\.1 GB[\s\S]*huggingface\.co\/Qwen\/Qwen2\.5-Coder-3B-Instruct-GGUF[\s\S]*qwen2\.5-coder-3b-instruct-q4_k_m\.gguf/);
      w.answer(undefined);
    }
    expect(seen).toEqual(['welcome', 'lang', 'folder', 'brain', 'download', 'mode', 'crew', 'summary']);
  });

  it('skips the download question for a model already downloaded, and prefers a running Ollama', () => {
    const w = createWizard(facts({ cached: ['qwen2.5-coder-3b'] }));
    const ids = [];
    while (!w.done) { ids.push(w.question().id); w.answer(undefined); }
    expect(ids).not.toContain('download');
    expect(runScripted(facts({ ollama: ['qwen2.5-coder:7b'] })).brain).toEqual({ backend: 'ollama' });
  });

  it('goes back to the brain choice when the download is declined', () => {
    const w = createWizard(facts());
    for (const v of [undefined, undefined, undefined, undefined]) w.answer(v); // welcome, lang, folder, brain
    expect(w.step).toBe('download');
    w.answer(false);
    expect(w.step).toBe('brain');
    w.answer('demo');
    expect(w.step).toBe('mode');
  });

  it('takes a key for an endpoint, a folder path, Portuguese and a smaller crew', () => {
    const r = runScripted(facts(), [undefined, 'pt', 'other', 'work/site', 'openai', 'http://127.0.0.1:8080/v1/', 'my-model', 'sk-secret', 'auto', 'pick', ['dev', 'qa'], false]);
    expect(r).toEqual({
      lang: 'pt', dir: path.resolve(facts().cwd, 'work/site'),
      brain: { backend: 'openai', url: 'http://127.0.0.1:8080/v1', model: 'my-model', key: 'sk-secret' },
      approvalMode: false, crew: ['dev', 'qa'], open: false
    });
    expect(toStartOptions(r)).toMatchObject({ demo: false, approvalMode: false, open: false, flags: { brain: 'openai', url: 'http://127.0.0.1:8080/v1', model: 'my-model', key: 'sk-secret' } });
  });

  it('refuses empty required answers', () => {
    const w = createWizard(facts());
    for (const v of [undefined, undefined, undefined, 'openai', undefined]) w.answer(v);
    expect(w.step).toBe('keyModel');
    expect(w.answer('')).toMatch(/needed/);
    expect(w.step).toBe('keyModel');
  });

  it('asks only "use the same setup?" when a setup was saved', () => {
    const saved = { ...defaults(facts()), lang: 'pt' };
    const w = createWizard(facts(), { saved });
    expect(w.question()).toMatchObject({ id: 'reuse', type: 'confirm', title: 'Usar a mesma configuração da última vez?' });
    w.answer(undefined);
    expect(w.done).toBe(true);
    expect(w.result()).toEqual(saved);
    const again = createWizard(facts(), { saved });
    again.answer(false);
    expect(again.step).toBe('welcome');
  });

  it('warns on a machine with little RAM and picks the 0.5B', () => {
    const w = createWizard(facts({ hardware: { gpu: null, ramBytes: 4e9, diskFreeBytes: 50e9 } }));
    w.answer(undefined); w.answer(undefined); w.answer(undefined);
    const q = w.question();
    expect(q.body.join(' ')).toMatch(/basic/);
    expect(q.default).toBe('local:qwen2.5-coder-0.5b');
  });

  it('maps answers to start options', () => {
    expect(toStartOptions({ ...defaults(facts()), brain: { backend: 'local', model: 'qwen2.5-coder-1.5b', gpu: false } }).flags).toEqual({ brain: 'local', modelId: 'qwen2.5-coder-1.5b', gpu: false });
    expect(toStartOptions({ ...defaults(facts()), brain: { backend: 'demo' } }).demo).toBe(true);
  });

  it('detects the language from the locale', () => {
    expect(detectLang({ LANG: 'pt_BR.UTF-8' })).toBe('pt');
    expect(detectLang({ LANG: 'en_US.UTF-8' })).toBe('en');
  });

  it('saves and loads the setup', () => {
    const home = tmpDir();
    expect(loadConfig(home)).toBeNull();
    saveConfig(home, defaults(facts()));
    expect(loadConfig(home).brain.model).toBe('qwen2.5-coder-3b');
  });
});

describe('wizard in a terminal (simulated keys)', () => {
  function term() {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = '';
    output.on('data', (d) => (text += d));
    return { input, output, get text() { return text; } };
  }
  const keys = { enter: '\r', down: '\x1b[B', up: '\x1b[A', space: ' ' };
  async function press(io, seq) {
    for (const k of seq) {
      io.input.write(keys[k] ?? k);
      await new Promise((r) => setImmediate(r));
    }
  }

  it('Enter all the way gives the defaults', async () => {
    const io = term();
    const p = runTty(createWizard(facts()), { input: io.input, output: io.output, color: false });
    await press(io, Array(8).fill('enter'));
    expect(await p).toEqual(defaults(facts()));
    expect(io.text).toContain('hivedesk');
    expect(io.text).toContain('(recommended)');
  });

  it('arrows and space change the answers; the key is masked', async () => {
    const io = term();
    const p = runTty(createWizard(facts()), { input: io.input, output: io.output, color: false });
    await press(io, ['enter', 'enter', 'enter']); // welcome, English (preselected), this folder
    // Brain: move down to the OpenAI compatible option.
    const order = ['local:qwen2.5-coder-3b', 'local:qwen2.5-coder-0.5b', 'local:qwen2.5-coder-1.5b', 'local:qwen2.5-coder-7b', 'local:qwen2.5-coder-14b', 'openai'];
    await press(io, Array(order.length - 1).fill('down'));
    await press(io, ['enter', 'enter']); // endpoint URL default
    await press(io, [...'m1', 'enter', ...'secret', 'enter']);
    await press(io, ['down', 'enter', 'down', 'enter']); // auto mode, pick roles
    await press(io, ['space', 'down', 'down', 'space', 'enter']); // untick dev and qa
    await press(io, ['n']);
    const r = await p;
    expect(r).toMatchObject({ lang: 'en', brain: { backend: 'openai', model: 'm1', key: 'secret' }, approvalMode: false, crew: ['designer', 'writer'], open: false });
    expect(io.text).toContain('******');
    expect(io.text).not.toContain('secret');
  });

  it('Ctrl+C cancels', async () => {
    const io = term();
    const p = runTty(createWizard(facts()), { input: io.input, output: io.output, color: false });
    const check = expect(p).rejects.toMatchObject({ code: 'cancelled' });
    await press(io, ['\x03']);
    await check;
  });
});
