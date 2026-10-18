#!/usr/bin/env node
// Real benchmark of catalog entries on this PC (docs/BENCHMARKS.md). Not part of the test suite.
//
//   node test/catalog/bench.mjs                       the default plan below
//   node test/catalog/bench.mjs --one <id> <ctx> <gpu|cpu> [tokens] [probe]   one run (used by the plan)
//
// Rules: one model process at a time, never while another model runs on this PC (nvidia-smi memory and
// the process list are checked first, and the plan waits), the free RAM guard of the local brain, and the
// process exits after each run so the VRAM is released.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const HOME = process.env.HIVEDESK_HOME || path.join(os.homedir(), '.hivedesk');
const OUT = path.join(HOME, 'bench-results.json');

const PLAN = [
  // id, ctx, where, tokens, quality probe
  ['qwen2.5-coder-3b:Q4_K_M', 4096, 'gpu', 1500, true],
  ['qwen2.5-coder-3b:Q8_0', 4096, 'gpu', 1500, true],
  ['qwen2.5-coder-7b:Q3_K_M', 4096, 'gpu', 1500, true],
  ['qwen2.5-coder-7b:IQ4_XS', 4096, 'gpu', 1500, true],
  ['qwen2.5-coder-7b:Q4_K_M', 4096, 'gpu', 1500, true],
  ['qwen2.5-coder-7b:Q4_K_M', 2048, 'gpu', 300, false],
  ['qwen2.5-coder-7b:Q3_K_M', 8192, 'gpu', 300, false],
  ['qwen2.5-coder-7b:IQ4_XS', 8192, 'gpu', 300, false],
  ['qwen2.5-coder-7b:Q4_K_M', 8192, 'gpu', 300, false],
  ['qwen2.5-coder-3b:Q4_K_M', 4096, 'cpu', 600, true]
];

const PROMPT = [
  { role: 'system', content: 'You are a senior front end developer. Answer with exactly two fenced code blocks: first ```html with the full index.html, then ```css with the full style.css. No other text.' },
  { role: 'user', content: 'Crie uma landing page para a padaria "Pao da Vila" em portugues: titulo, um paragrafo sobre a padaria, um cardapio com paes, doces e bolos com precos em reais, horario de funcionamento de segunda a domingo (domingo fechado), endereco com link de telefone (tel:) e um botao para encomendar bolos. Use HTML semantico (main, h1, listas), meta viewport, meta description, lang="pt-BR", imagens com alt, JSON-LD de LocalBusiness no head, um media query para celular, :focus-visible e texto escuro sobre fundo claro.' }
];
const CHECKS = ['html.doctype', 'html.lang', 'html.title', 'html.viewport', 'html.h1', 'html.main', 'html.img-alt', 'css.media-query', 'css.focus-visible', 'text.no-placeholder', 'html.json-ld', 'html.meta-description', 'css.contrast'];

function gpuFreeMiB() {
  try {
    const out = execFileSync('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], { windowsHide: true }).toString();
    return Number(out.trim().split(/\r?\n/)[0]);
  } catch { return null; }
}

function gpuUsedMiB() {
  try {
    const out = execFileSync('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { windowsHide: true }).toString();
    return Number(out.trim().split('\n')[0]);
  } catch { return null; }
}

/** Another model process on this PC? (llama, ollama, LM Studio, a hivedesk engine, an e2e run with a model) */
function otherModelProcess() {
  let out = '';
  try {
    if (process.platform === 'win32') {
      out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process | ForEach-Object { '' + $_.ProcessId + ' ' + $_.Name + ' ' + $_.CommandLine }"], { windowsHide: true, maxBuffer: 16 << 20 }).toString();
    } else {
      out = execFileSync('ps', ['-eo', 'pid,args'], { maxBuffer: 16 << 20 }).toString();
    }
  } catch { return null; }
  const mine = new Set([String(process.pid)]);
  const lines = out.split(/\r?\n/).filter((l) => l.trim() && !mine.has(l.trim().split(' ')[0]));
  const hit = lines.find((l) => /llama-server|rpc-server|ollama|lm studio|lmstudio|koboldcpp|src[\\/]cli\.js(?!.*--demo)|e2e-local|real-chat|bench\.mjs --one/i.test(l) && !/powershell/i.test(l));
  return hit || null;
}

async function waitForFreeGpu(baseline) {
  for (let i = 0; i < 120; i++) {
    const used = gpuUsedMiB();
    const other = otherModelProcess();
    if ((used == null || used < baseline + 700) && !other) return used;
    console.log(`  waiting: ${other ? `another model process: ${other.slice(0, 120)}` : `GPU memory in use ${used} MiB`}`);
    await new Promise((r) => setTimeout(r, 30000));
  }
  throw new Error('the GPU stayed busy for an hour');
}

async function one(id, ctx, where, tokens, probe) {
  const { resolvePick } = await import(pathToFileURL(path.join(ROOT, 'src/brain/catalog/index.js')).href);
  const { modelPath, isCached } = await import(pathToFileURL(path.join(ROOT, 'src/brain/models.js')).href);
  const { createLocalBrain } = await import(pathToFileURL(path.join(ROOT, 'src/brain/local.js')).href);
  const { findRuntime } = await import(pathToFileURL(path.join(ROOT, 'src/brain/runtime.js')).href);
  const p = resolvePick(id);
  if (!p || !isCached(HOME, p)) throw new Error(`${id} is not downloaded`);
  const rt = await findRuntime(HOME);
  const mod = await import(pathToFileURL(rt.entry).href);
  const before = gpuUsedMiB();
  const freeBefore = gpuFreeMiB();
  const t0 = Date.now();
  const brain = await createLocalBrain({ mod, modelPath: modelPath(HOME, p), gpu: where === 'gpu', contextSize: ctx, name: id, minGpuShare: 0 });
  const loadMs = Date.now() - t0;
  const info = brain.info();
  const afterLoad = gpuUsedMiB();
  const rssLoad = process.memoryUsage().rss;
  let first = 0;
  let chunks = 0;
  const t1 = Date.now();
  const res = await brain.chat(PROMPT, { maxTokens: tokens, temperature: 0, onToken: () => { if (!first) first = Date.now(); chunks++; } });
  const end = Date.now();
  const genMs = end - (first || t1);
  const tps = res.completionTokens > 1 ? (res.completionTokens - 1) / (genMs / 1000) : 0;
  const peakGpu = gpuUsedMiB();
  let quality = null;
  if (probe) {
    const html = /```html\s*\n([\s\S]*?)```/i.exec(res.text)?.[1] || /<!doctype[\s\S]*<\/html>/i.exec(res.text)?.[0] || '';
    const css = /```css\s*\n([\s\S]*?)```/i.exec(res.text)?.[1] || '';
    const { runChecks } = await import(pathToFileURL(path.join(ROOT, 'src/crew/library/checks.js')).href);
    const files = [{ path: 'index.html', text: html }, ...(css ? [{ path: 'style.css', text: css }] : [])];
    const r = runChecks(CHECKS, { files });
    const pass = r.results.filter((x) => x.status === 'pass').length;
    const fail = r.results.filter((x) => x.status === 'fail').map((x) => x.id);
    quality = { pass, of: r.results.filter((x) => x.status !== 'skip').length, fail, htmlChars: html.length, cssChars: css.length };
  }
  await brain.close();
  return {
    id, ctx, where, freeVramMiB: freeBefore, backend: info.gpu, gpuLayers: info.gpuLayers, totalLayers: info.totalLayers, contextSize: info.contextSize,
    loadMs, firstTokenMs: first ? first - t1 : null, genMs, completionTokens: res.completionTokens, promptTokens: res.promptTokens, tps: Math.round(tps * 10) / 10,
    vramMiB: before != null && peakGpu != null ? Math.max(afterLoad, peakGpu) - before : null,
    rssLoadMB: Math.round(rssLoad / 1e6), peakRssMB: Math.round(process.resourceUsage().maxRSS / 1e3), quality
  };
}

async function plan() {
  const results = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : [];
  const baseline = gpuUsedMiB() ?? 0;
  for (const [id, ctx, where, tokens, probe] of PLAN) {
    if (results.some((r) => r.id === id && r.ctx === ctx && r.where === where && !r.error)) { console.log(`skip ${id} ${ctx} ${where} (done)`); continue; }
    await waitForFreeGpu(Math.min(baseline, 600));
    // The CPU run needs the whole file in RAM plus room (the free RAM guard of the local brain): wait for it.
    for (let i = 0; where === 'cpu' && os.freemem() < 4.1e9 && i < 480; i++) {
      console.log(`  waiting: ${(os.freemem() / 1e9).toFixed(1)} GB of RAM free, the CPU run needs 4.1 GB`);
      await new Promise((r) => setTimeout(r, 30000));
    }
    console.log(`run ${id} ctx ${ctx} on ${where}`);
    const r = await new Promise((resolve) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--one', id, String(ctx), where, String(tokens), probe ? '1' : '0'], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
      try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* fine */ }
      let out = '';
      const timer = setTimeout(() => child.kill(), 15 * 60 * 1000);
      child.stdout.on('data', (c) => { out += c; });
      child.on('close', (code) => {
        clearTimeout(timer);
        const line = out.trim().split('\n').reverse().find((l) => l.startsWith('{'));
        try { resolve(JSON.parse(line)); } catch { resolve({ id, ctx, where, error: `exit ${code}: ${out.slice(-300)}` }); }
      });
    });
    console.log(JSON.stringify(r));
    const i = results.findIndex((x) => x.id === id && x.ctx === ctx && x.where === where);
    if (i >= 0) results[i] = r; else results.push(r);
    fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
    // Let the driver release the VRAM before the next run.
    await new Promise((res) => setTimeout(res, 5000));
  }
  console.log(`results in ${OUT}`);
}

const args = process.argv.slice(2);
if (args[0] === '--one') {
  one(args[1], Number(args[2]), args[3], Number(args[4] || 400), args[5] === '1')
    .then((r) => { process.stdout.write(JSON.stringify(r) + '\n'); process.exit(0); })
    .catch((err) => { process.stdout.write(JSON.stringify({ id: args[1], ctx: Number(args[2]), where: args[3], freeVramMiB: gpuFreeMiB(), error: String(err.message || err) }) + '\n'); process.exit(1); });
} else {
  plan().catch((err) => { console.error(err.message || err); process.exit(1); });
}
