// One place that turns the brain status into honest words for the whole UI.

import { S, extra, ui } from './store.js';
import { fmtBytes } from './dom.js';

const BACKEND = { local: 'Local', ollama: 'Ollama', lmstudio: 'LM Studio', openai: 'Endpoint', fake: 'Demo script', remote: 'Friend' };
export const backendLabel = (b) => BACKEND[b] || b || 'None';

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
  if (ui.connection === 'unauthorized') return { key: 'auth', dot: 'error', label: 'Needs the secret link', detail: 'Open the address printed in the terminal.', canRequest: false, progress: null };
  if (ui.connection !== 'open') return { key: 'offline', dot: 'offline', label: 'Not connected', detail: 'Reconnecting to hivedesk on this computer.', canRequest: false, progress: null };
  if (!ui.hello) return { key: 'hello', dot: 'loading', label: 'Connecting', detail: '', canRequest: false, progress: null, indeterminate: true };
  if (rt?.state === 'installing') return { key: 'runtime', dot: 'loading', label: 'Installing the local runtime', detail: rt.line || 'node-llama-cpp, one time only', canRequest: false, progress: null, indeterminate: true };
  if (rt?.state === 'failed' && b.state !== 'ready') return { key: 'runtime-failed', dot: 'error', label: 'Runtime install failed', detail: rt.hint || rt.message || '', canRequest: false, progress: null };
  switch (b.state) {
    case 'ready': {
      const label = s.demo || b.backend === 'fake' ? 'Demo script' : [backendLabel(b.backend), model].filter(Boolean).join(' · ');
      return { key: 'ready', dot: 'ready', label, detail: b.detail || '', canRequest: true, progress: null };
    }
    case 'loading': return { key: 'loading', dot: 'loading', label: 'Model loading', detail: model ? `${model} is loading into memory. The crew starts when it is ready.` : 'The crew starts when it is ready.', canRequest: false, progress: null, indeterminate: true };
    case 'downloading': {
      const total = dl?.total || dl?.bytes || 0;
      const p = total ? Math.min(1, (dl?.received || 0) / total) : null;
      return { key: 'downloading', dot: 'downloading', label: p != null ? `Downloading model ${Math.floor(p * 100)}%` : 'Downloading model', detail: `${model || 'Model'}${total ? `, ${fmtBytes(total)}` : ''}`, canRequest: false, progress: p, indeterminate: p == null };
    }
    case 'needs_download': return { key: 'needs_download', dot: 'needs_download', label: 'Model download needed', detail: dl ? `${shortModel(dl.model)}, ${fmtBytes(dl.bytes)} from ${dl.source || 'huggingface.co'}` : 'Open Settings to download a model.', canRequest: false, progress: null };
    case 'error': return { key: 'error', dot: 'error', label: 'Model error', detail: b.detail || 'Open Settings for details.', canRequest: false, progress: null };
    default: return { key: 'none', dot: 'none', label: 'No model yet: choose one', detail: 'Without a model nothing is generated. Pick one in Settings.', canRequest: false, progress: null };
  }
}
