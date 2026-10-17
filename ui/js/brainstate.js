// One place that turns the brain status into honest words for the whole UI.

import { S, extra, ui } from './store.js';
import { fmtBytes } from './dom.js';
import { t } from './i18n.js';

const BACKEND = { ollama: 'Ollama', lmstudio: 'LM Studio' };
const BACKEND_KEY = { local: 'brain.backend.local', openai: 'brain.backend.openai', fake: 'brain.backend.fake', remote: 'brain.backend.remote' };
export const backendLabel = (b) => BACKEND[b] || (BACKEND_KEY[b] ? t(BACKEND_KEY[b]) : b || t('brain.backend.none'));

export function shortModel(m) {
  if (!m) return '';
  const base = String(m).split(/[\\/]/).pop().replace(/\.gguf$/i, '');
  const q = /qwen2\.5-coder-(\d+(?:\.\d+)?b)/i.exec(base);
  if (q) return `Qwen2.5-Coder ${q[1].toUpperCase()}`;
  return base.length > 28 ? `${base.slice(0, 26)}...` : base;
}

/**
 * @returns {{ key: string, dot: string, label: string, detail: string, canRequest: boolean,
 *   progress: number|null, indeterminate: boolean }}
 */
export function brainInfo() {
  const s = S();
  const b = s.brain || { state: 'none' };
  const dl = extra.download;
  const rt = extra.runtime;
  const model = shortModel(b.model || dl?.model);
  if (ui.connection === 'unauthorized') return { key: 'auth', dot: 'error', label: t('brain.auth.label'), detail: t('brain.auth.detail'), canRequest: false, progress: null };
  if (ui.connection !== 'open') return { key: 'offline', dot: 'offline', label: t('brain.offline.label'), detail: t('brain.offline.detail'), canRequest: false, progress: null };
  if (!ui.hello) return { key: 'hello', dot: 'loading', label: t('brain.hello.label'), detail: '', canRequest: false, progress: null, indeterminate: true };
  if (rt?.state === 'installing') return { key: 'runtime', dot: 'loading', label: t('brain.runtime.label'), detail: rt.line || t('brain.runtime.detail'), canRequest: false, progress: null, indeterminate: true };
  if (rt?.state === 'failed' && b.state !== 'ready') return { key: 'runtime-failed', dot: 'error', label: t('brain.runtimeFailed.label'), detail: rt.hint || rt.message || '', canRequest: false, progress: null };
  switch (b.state) {
    case 'ready': {
      const label = s.demo || b.backend === 'fake' ? t('brain.backend.fake') : [backendLabel(b.backend), model].filter(Boolean).join(' · ');
      return { key: 'ready', dot: 'ready', label, detail: b.detail || '', canRequest: true, progress: null };
    }
    case 'loading': return { key: 'loading', dot: 'loading', label: t('brain.loading.label'), detail: model ? t('brain.loading.detailModel', { model }) : t('brain.loading.detail'), canRequest: false, progress: null, indeterminate: true };
    case 'downloading': {
      const total = dl?.total || dl?.bytes || 0;
      const p = total ? Math.min(1, (dl?.received || 0) / total) : null;
      return { key: 'downloading', dot: 'downloading', label: p != null ? t('brain.downloading.labelPct', { pct: Math.floor(p * 100) }) : t('brain.downloading.label'), detail: total ? t('brain.downloading.detailSize', { model: model || t('brain.model'), size: fmtBytes(total) }) : model || t('brain.model'), canRequest: false, progress: p, indeterminate: p == null };
    }
    case 'needs_download': return { key: 'needs_download', dot: 'needs_download', label: t('brain.needsDownload.label'), detail: dl ? t('brain.needsDownload.detail', { model: shortModel(dl.model), size: fmtBytes(dl.bytes), source: dl.source || 'huggingface.co' }) : t('brain.needsDownload.detailNone'), canRequest: false, progress: null };
    case 'error': return { key: 'error', dot: 'error', label: t('brain.error.label'), detail: b.detail || t('brain.error.detail'), canRequest: false, progress: null };
    default: return { key: 'none', dot: 'none', label: t('brain.none.label'), detail: t('brain.none.detail'), canRequest: false, progress: null };
  }
}
