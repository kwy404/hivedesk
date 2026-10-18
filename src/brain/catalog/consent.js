// Consent for downloads: nothing is downloaded unless the user said yes to that exact file (its size,
// source and license were shown), and the first launch answer is remembered.
//
// <home>/models/consent.json:
//   { accepted: { "<pick id>": { at, via, license, bytes, sha256: [..] } }, firstLaunch: { at, answer } | null }
//
// Explicit yes comes from: the first launch dialog or the Models window ("models.consent"), the Download
// button of a consent card, the wizard's "Download it now?" and a model named on the command line
// (--model 7b). Choosing a model in Settings is not a yes by itself: it opens the consent card.
import fs from 'node:fs';
import path from 'node:path';

export const VIAS = ['dialog', 'models', 'card', 'wizard', 'cli'];
export const ANSWERS = ['recommended', 'faster', 'smarter', 'other', 'later'];

export class ConsentStore {
  constructor(home) {
    this.file = path.join(home, 'models', 'consent.json');
    this.data = this._read();
  }

  _read() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { accepted: d.accepted && typeof d.accepted === 'object' ? d.accepted : {}, firstLaunch: d.firstLaunch || null, selected: typeof d.selected === 'string' ? d.selected : null };
    } catch {
      return { accepted: {}, firstLaunch: null, selected: null };
    }
  }

  _write() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 1));
    } catch { /* read only home: the yes holds for this run */ }
  }

  /** True when the user said yes to this file (same checksums, so a changed file asks again). */
  has(model) {
    const rec = this.data.accepted[model.id];
    if (!rec) return false;
    const want = shaList(model);
    return !want.length || JSON.stringify(rec.sha256 || []) === JSON.stringify(want);
  }

  grant(model, via) {
    if (!VIAS.includes(via)) throw new Error(`unknown consent source: ${via}`);
    this.data.accepted[model.id] = { at: new Date().toISOString(), via, license: model.license?.id || null, bytes: model.bytes, sha256: shaList(model) };
    this._write();
  }

  revoke(id) {
    const had = !!this.data.accepted[id];
    delete this.data.accepted[id];
    this._write();
    return had;
  }

  /** The first launch dialog was answered (any answer, "Agora não" included): do not open it again by itself. */
  answerFirstLaunch(answer) {
    if (!ANSWERS.includes(answer)) throw new Error(`unknown answer: ${answer}`);
    this.data.firstLaunch = { at: new Date().toISOString(), answer };
    this._write();
  }

  /** The model the user chose last (loaded on the next start when it is downloaded); null clears it. */
  select(id) {
    this.data.selected = id || null;
    this._write();
  }

  get firstLaunch() {
    return this.data.firstLaunch;
  }
}

function shaList(model) {
  if (Array.isArray(model.files) && model.files.length) return model.files.map((f) => f.sha256).filter(Boolean);
  return model.sha256 ? [model.sha256] : [];
}

/**
 * The gate every download goes through.
 * @returns {{ ok: true } | { ok: false, reason: 'needs_consent' | 'no_download' }}
 */
export function downloadGate(model, { store, cli = new Set(), noDownload = false }) {
  if (noDownload) return { ok: false, reason: 'no_download' };
  if (cli.has(model.id) || store.has(model)) return { ok: true };
  return { ok: false, reason: 'needs_consent' };
}
