// API keys for cloud providers: only in ~/.hivedesk/keys.json on this machine (mode 600 where supported).
// Keys never go to the browser, the event log or a WebSocket frame: the rest of the engine sees publicView().
import fs from 'node:fs';
import path from 'node:path';
import { PROVIDERS } from './cloud.js';

export class KeyStore {
  /** @param {string | null} home  null keeps keys in memory (tests) */
  constructor(home) {
    this.file = home ? path.join(home, 'keys.json') : null;
    this.data = { providers: {} };
    if (this.file) {
      try {
        const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (j && typeof j.providers === 'object') this.data = j;
      } catch { /* none yet */ }
    }
  }

  get(provider) {
    return this.data.providers[provider] || null;
  }

  set(provider, { key, model, baseUrl } = {}) {
    if (!PROVIDERS[provider]) throw Object.assign(new Error(`unknown provider ${provider}`), { code: 'bad_request' });
    const cur = this.data.providers[provider] || {};
    const next = { ...cur };
    if (typeof model === 'string' && model.trim()) next.model = model.trim();
    if (typeof baseUrl === 'string') {
      const u = baseUrl.trim().replace(/\/$/, '');
      if (u && !/^https?:\/\//.test(u)) throw Object.assign(new Error('the base URL must start with http:// or https://'), { code: 'bad_request' });
      // A key is bound to the address it was saved for: a new base URL never inherits the old key.
      if ((u || undefined) !== cur.baseUrl) delete next.key;
      next.baseUrl = u || undefined;
    }
    if (typeof key === 'string' && key.trim()) next.key = key.trim();
    if (!next.key && provider !== 'compatible') throw Object.assign(new Error('an API key is needed'), { code: 'bad_request' });
    if (provider === 'compatible' && !next.baseUrl) throw Object.assign(new Error('a base URL is needed'), { code: 'bad_request' });
    this.data.providers[provider] = next;
    this.save();
    return this.publicView()[provider];
  }

  remove(provider) {
    const had = !!this.data.providers[provider];
    delete this.data.providers[provider];
    this.save();
    return had;
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    try { fs.chmodSync(this.file, 0o600); } catch { /* not supported here */ }
  }

  /** What the UI may see: configured yes or no, the model and the base URL. Never the key. */
  publicView() {
    const out = {};
    for (const [id, p] of Object.entries(PROVIDERS)) {
      const s = this.data.providers[id] || {};
      out[id] = { label: p.label, configured: !!(s.key || (id === 'compatible' && s.baseUrl)), model: s.model || p.models[0] || null, baseUrl: id === 'compatible' ? s.baseUrl || null : undefined, keyHint: p.keyHint };
    }
    return out;
  }
}
