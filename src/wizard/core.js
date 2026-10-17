// First run wizard as a pure state machine: no terminal here, so it is easy to test.
// Every question has a recommended default, so pressing Enter all the way works.
import path from 'node:path';
import { t } from './i18n.js';
import { MODELS, chooseModel } from '../brain/models.js';
import { PROVIDERS } from '../brain/cloud.js';

const isCloud = (b) => !!PROVIDERS[b];
import { formatBytes } from '../brain/hardware.js';

export const ROLES = ['dev', 'designer', 'qa', 'writer'];

/**
 * Facts the wizard shows and chooses from.
 * @typedef {{
 *   cwd: string, lang: 'en' | 'pt', home: string,
 *   hardware: { gpu: null | { name?: string, vramBytes: number }, ramBytes: number, diskFreeBytes?: number | null },
 *   ollama?: string[] | null, lmstudio?: string[] | null,
 *   cached?: string[]   ids of models already downloaded
 * }} Facts
 *
 * The answers, also what config.json keeps.
 * @typedef {{
 *   lang: 'en' | 'pt', dir: string,
 *   brain: { backend: 'local' | 'ollama' | 'lmstudio' | 'openai' | 'demo', model?: string, url?: string, key?: string, gpu?: boolean },
 *   approvalMode: boolean, crew: string[], open: boolean
 * }} Answers
 */

/** The answers you get by pressing Enter everywhere. */
export function defaults(facts) {
  const choice = chooseModel(facts.hardware);
  return {
    lang: facts.lang,
    dir: facts.cwd,
    brain: facts.ollama?.length ? { backend: 'ollama' } : facts.lmstudio?.length ? { backend: 'lmstudio' } : { backend: 'local', model: choice.model.id, gpu: choice.gpu },
    approvalMode: true,
    crew: [...ROLES],
    open: true,
    app: true
  };
}

export function hardwareLine(facts, s = t(facts.lang)) {
  const hw = facts.hardware;
  const gpu = hw.gpu ? `${hw.gpu.name || 'GPU'} ${formatBytes(hw.gpu.vramBytes)}` : s.noGpu;
  return `${gpu}, RAM ${formatBytes(hw.ramBytes)}, ${formatBytes(hw.diskFreeBytes)} free disk`;
}

function brainOptions(facts, s) {
  const choice = chooseModel(facts.hardware);
  const cached = new Set(facts.cached || []);
  const opts = [];
  const local = (m, rec) => ({
    value: `local:${m.id}`,
    label: `${m.name.replace(' Instruct (Q4_K_M)', '')}  ${formatBytes(m.bytes)}${cached.has(m.id) ? ` (${s.downloaded})` : ''}`,
    hint: rec ? `${s.recommended}: ${choice.reason}` : s.otherSize,
    recommended: rec
  });
  if (facts.ollama?.length) opts.push({ value: 'ollama', label: s.ollama, hint: facts.ollama.slice(0, 3).join(', '), recommended: true });
  if (facts.lmstudio?.length) opts.push({ value: 'lmstudio', label: s.lmstudio, hint: facts.lmstudio.slice(0, 3).join(', '), recommended: !facts.ollama?.length });
  opts.push(local(choice.model, !facts.ollama?.length && !facts.lmstudio?.length));
  for (const m of MODELS) if (m.id !== choice.model.id) opts.push(local(m, false));
  for (const [id, p] of Object.entries(PROVIDERS)) {
    opts.push({ value: id, label: id === 'compatible' ? s.key : `${p.label} (${s.cloud})`, hint: id === 'compatible' ? '' : s.cloudHint });
  }
  opts.push({ value: 'demo', label: s.demo, hint: '' });
  return opts;
}

/**
 * @param {Facts} facts
 * @param {{ saved?: Answers | null }} [opts]
 */
export function createWizard(facts, opts = {}) {
  const saved = opts.saved || null;
  const a = saved ? JSON.parse(JSON.stringify(saved)) : defaults(facts);
  /** @type {string[]} */
  const history = [];
  let step = saved ? 'reuse' : 'welcome';
  let finished = false;

  const s = () => t(a.lang);

  function modelFor(id) {
    return MODELS.find((m) => m.id === id);
  }

  function needsDownload() {
    return a.brain.backend === 'local' && !(facts.cached || []).includes(a.brain.model);
  }

  function next(from) {
    switch (from) {
      case 'reuse': return null;
      case 'welcome': return 'lang';
      case 'lang': return 'folder';
      case 'folder': return a._folderOther ? 'folderPath' : 'brain';
      case 'folderPath': return 'brain';
      case 'brain':
        if (a.brain.backend === 'compatible') return 'keyUrl';
        if (isCloud(a.brain.backend)) return 'keyModel';
        return needsDownload() ? 'download' : 'mode';
      case 'keyUrl': return 'keyModel';
      case 'keyModel': return 'keySecret';
      case 'keySecret': return 'mode';
      case 'download': return a._downloadOk === false ? 'brain' : 'mode';
      case 'mode': return 'crew';
      case 'crew': return a._crewPick ? 'crewRoles' : 'summary';
      case 'crewRoles': return 'summary';
      case 'summary': return a.open ? 'app' : null;
      case 'app': return null;
      default: return null;
    }
  }

  /** The question for the current step, ready to render. */
  function question() {
    const S = s();
    switch (step) {
      case 'reuse':
        return { id: step, type: 'confirm', title: S.reuse, body: summaryLines(), default: true };
      case 'welcome':
        return { id: step, type: 'info', title: 'hivedesk', body: [S.welcome, '', S.pressEnter] };
      case 'lang':
        return { id: step, type: 'select', title: S.lang, options: [{ value: 'pt', label: 'Português' }, { value: 'en', label: 'English' }], default: a.lang };
      case 'folder':
        return { id: step, type: 'select', title: S.folder, options: [{ value: 'here', label: `${S.folderHere}: ${a.dir}` }, { value: 'other', label: S.folderOther }], default: 'here' };
      case 'folderPath':
        return { id: step, type: 'text', title: S.folderPath, default: a.dir };
      case 'brain': {
        const options = brainOptions(facts, S);
        const current = a.brain.backend === 'local' ? `local:${a.brain.model}` : a.brain.backend;
        const warning = chooseModel(facts.hardware).warning;
        return {
          id: step, type: 'select', title: S.brain, body: [`${S.hardware}: ${hardwareLine(facts, S)}`, ...(warning ? [`${S.warning}: ${warning}`] : [])],
          options, default: options.some((o) => o.value === current) ? current : options.find((o) => o.recommended)?.value || options[0].value
        };
      }
      case 'keyUrl':
        return { id: step, type: 'text', title: S.keyUrl, default: a.brain.url || 'http://127.0.0.1:8080/v1' };
      case 'keyModel':
        return { id: step, type: 'text', title: S.keyModel, default: a.brain.model || PROVIDERS[a.brain.backend]?.models[0] || '', required: true };
      case 'keySecret':
        return { id: step, type: 'secret', title: S.keySecret, body: [S.cloudNote], default: a.brain.key || '', required: a.brain.backend !== 'compatible' };
      case 'download': {
        const m = modelFor(a.brain.model);
        return {
          id: step, type: 'confirm', title: S.confirmDownload, default: true,
          body: [`${m.name}`, `${S.size}: ${formatBytes(m.bytes)}`, `${S.source}: ${m.source}`, `${S.destination}: ${path.join(facts.home, 'models', m.file)}`]
        };
      }
      case 'mode':
        return { id: step, type: 'select', title: S.mode, options: [{ value: 'approve', label: S.modeApprove, recommended: true }, { value: 'auto', label: S.modeAuto }], default: a.approvalMode ? 'approve' : 'auto' };
      case 'crew':
        return { id: step, type: 'select', title: S.crew, options: [{ value: 'default', label: S.crewDefault, recommended: true }, { value: 'pick', label: S.crewPick }], default: a.crew.length === ROLES.length ? 'default' : 'pick' };
      case 'crewRoles':
        return { id: step, type: 'checkbox', title: S.crewRoles, options: ROLES.map((r) => ({ value: r, label: r === 'qa' ? 'QA' : r[0].toUpperCase() + r.slice(1) })), default: a.crew };
      case 'summary':
        return { id: step, type: 'confirm', title: S.openBrowser, body: [S.summary, ...summaryLines()], default: a.open };
      case 'app':
        return { id: step, type: 'confirm', title: S.openApp, default: a.app !== false };
      default:
        return null;
    }
  }

  function summaryLines() {
    const S = s();
    const b = a.brain;
    const brain = b.backend === 'local' ? `${modelFor(b.model)?.name || b.model}${b.gpu === false ? ' (CPU)' : ''}`
      : isCloud(b.backend) ? `${PROVIDERS[b.backend].label} ${b.model}${b.url ? ` at ${b.url}` : ''} (key ${b.key ? 'set' : 'none'})`
      : b.backend === 'demo' ? S.demo : b.backend;
    return [
      `  ${S.lang}: ${a.lang === 'pt' ? 'Português' : 'English'}`,
      `  ${S.folder.split(' (')[0]}: ${a.dir}`,
      `  ${S.brain.replace('?', '')}: ${brain}`,
      `  ${S.mode.replace('?', '')}: ${a.approvalMode ? S.modeApprove.split(' (')[0] : S.modeAuto.split(':')[0]}`,
      `  ${S.crew}: Mel, ${a.crew.map((r) => (r === 'qa' ? 'QA' : r[0].toUpperCase() + r.slice(1))).join(', ')}`
    ];
  }

  /**
   * Answers the current question. `value` undefined means "the default" (Enter).
   * @returns {string | null} an error message to show, or null
   */
  function answer(value) {
    const q = question();
    if (!q) return null;
    const v = value === undefined ? q.default : value;
    switch (step) {
      case 'reuse':
        if (v) { finished = true; return null; }
        step = 'welcome';
        return null;
      case 'lang': a.lang = v === 'pt' ? 'pt' : 'en'; break;
      case 'folder': a._folderOther = v === 'other'; break;
      case 'folderPath': {
        const p = String(v || '').trim();
        if (!p) return s().required;
        a.dir = path.resolve(facts.cwd, p);
        break;
      }
      case 'brain':
        if (String(v).startsWith('local:')) {
          const id = String(v).slice(6);
          const choice = chooseModel(facts.hardware);
          const vram = facts.hardware.gpu?.vramBytes || 0;
          a.brain = { backend: 'local', model: id, gpu: id === choice.model.id ? choice.gpu : vram >= 3.8e9 };
        } else if (isCloud(v)) {
          const same = a.brain.backend === v;
          a.brain = { backend: v, url: same ? a.brain.url : undefined, model: same ? a.brain.model : '', key: same ? a.brain.key : undefined };
        } else {
          a.brain = { backend: v };
        }
        break;
      case 'keyUrl': {
        const u = String(v || '').trim();
        if (!/^https?:\/\//.test(u)) return s().required;
        a.brain.url = u.replace(/\/$/, '');
        break;
      }
      case 'keyModel':
        if (!String(v || '').trim()) return s().required;
        a.brain.model = String(v).trim();
        break;
      case 'keySecret':
        if (!String(v || '').trim() && a.brain.backend !== 'compatible') return s().required;
        a.brain.key = String(v || '').trim() || undefined;
        break;
      case 'download': a._downloadOk = !!v; break;
      case 'mode': a.approvalMode = v !== 'auto'; break;
      case 'crew': a._crewPick = v === 'pick'; if (!a._crewPick) a.crew = [...ROLES]; break;
      case 'crewRoles': {
        const list = (Array.isArray(v) ? v : []).filter((r) => ROLES.includes(r));
        a.crew = list.length ? list : [...ROLES];
        break;
      }
      case 'summary': a.open = !!v; break;
      case 'app': a.app = !!v; break;
      default: break;
    }
    history.push(step);
    const n = next(step);
    if (!n) finished = true;
    else step = n;
    return null;
  }

  function back() {
    const prev = history.pop();
    if (prev) step = prev;
  }

  /** The answers without the internal fields. */
  function result() {
    const { _folderOther, _downloadOk, _crewPick, ...clean } = a;
    return clean;
  }

  return {
    get step() { return step; },
    get done() { return finished; },
    get lang() { return a.lang; },
    question,
    answer,
    back,
    result
  };
}

/** Runs the wizard with scripted answers (undefined = Enter). Used by tests and non interactive runs. */
export function runScripted(facts, answers = [], opts = {}) {
  const w = createWizard(facts, opts);
  let i = 0;
  let guard = 0;
  while (!w.done && guard++ < 100) {
    const err = w.answer(i < answers.length ? answers[i] : undefined);
    i++;
    if (err && i >= answers.length) throw new Error(`wizard step ${w.step}: ${err}`);
  }
  return w.result();
}

/** Turns wizard answers into startHive options. */
export function toStartOptions(ans) {
  const b = ans.brain || {};
  const flags = {};
  if (b.backend === 'local') {
    flags.brain = 'local';
    if (b.model) flags.modelId = b.model;
    if (b.gpu === false) flags.gpu = false;
  } else if (b.backend === 'ollama' || b.backend === 'lmstudio') {
    flags.brain = b.backend;
  } else if (isCloud(b.backend)) {
    // The key itself goes to the key store (src/brain/keys.js), never into config.json.
    Object.assign(flags, { brain: b.backend, model: b.model });
  }
  return { dir: ans.dir, demo: b.backend === 'demo', flags, approvalMode: ans.approvalMode !== false, crew: ans.crew, open: ans.open !== false, app: ans.app !== false };
}
