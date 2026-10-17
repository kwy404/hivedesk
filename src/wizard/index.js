// Gathers the facts, runs the wizard (or reuses the saved setup) and returns startHive options.
import fs from 'node:fs';
import path from 'node:path';
import { detectHardware } from '../brain/hardware.js';
import { probeOllama, probeLmStudio } from '../brain/http.js';
import { MODELS, isCached } from '../brain/models.js';
import { createWizard, defaults, toStartOptions } from './core.js';
import { detectLang } from './i18n.js';
import { loadConfig, saveConfig } from './config.js';
import { runTty } from './tty.js';
import { KeyStore } from '../brain/keys.js';
import { PROVIDERS, testConnection } from '../brain/cloud.js';

export async function gatherFacts({ home, cwd }) {
  const [hardware, ollama, lmstudio] = await Promise.all([
    detectHardware({ dir: fs.existsSync(home) ? home : path.dirname(home) }),
    probeOllama(),
    probeLmStudio()
  ]);
  return { cwd, home, lang: detectLang(), hardware, ollama, lmstudio, cached: MODELS.filter((m) => isCached(home, m)).map((m) => m.id) };
}

/**
 * @param {{ home: string, cwd: string, yes?: boolean, io?: any }} opts
 * @returns {Promise<ReturnType<typeof toStartOptions> | null>}
 */
export async function wizardSetup(opts) {
  const saved = loadConfig(opts.home);
  if (opts.yes) {
    // --yes, or no terminal: the saved setup, or nothing (the engine then picks the recommended defaults).
    return saved ? toStartOptions(saved) : null;
  }
  const facts = await gatherFacts(opts);
  const wizard = createWizard(facts, { saved });
  const answers = await runTty(wizard, opts.io);
  const b = answers.brain || {};
  if (PROVIDERS[b.backend]) {
    // Keys live in the key store only; config.json keeps the provider and the model.
    new KeyStore(opts.home).set(b.backend, { key: b.key, model: b.model, baseUrl: b.url });
    process.stdout.write(`  testing ${PROVIDERS[b.backend].label}...\n`);
    const r = await testConnection(b.backend, { key: b.key, model: b.model, baseUrl: b.url });
    process.stdout.write(r.ok ? `  OK: ${r.model} answered in ${r.ms} ms\n` : `  The test call failed: ${r.error}. You can fix the key later in Settings, Providers.\n`);
  }
  const { key, ...brainNoKey } = b;
  void key;
  const file = saveConfig(opts.home, { ...answers, brain: brainNoKey });
  process.stdout.write(`  saved to ${file}\n`);
  return toStartOptions(answers);
}

export { createWizard, defaults, toStartOptions };
