// Playbooks: the plan of a job that went well, saved so the planner can reuse it for similar requests.
import fs from 'node:fs';
import path from 'node:path';

const STOP = new Set(('a an the and or of to for with in on at by from into is are be it this that my our your me us i we you ' +
  'make build create write add small tiny simple new please some one page using use').split(' '));

/** Lowercase keywords without stop words, with light stemming. */
export function keywords(text) {
  const words = String(text || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9+#]+/).filter((w) => w.length > 1 && !STOP.has(w));
  return [...new Set(words.map(stem))];
}

function stem(w) {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && /(s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** Similarity between a request and a playbook: Jaccard over their keywords (0 to 1). */
export function similarity(a, b) {
  const A = new Set(Array.isArray(a) ? a : keywords(a));
  const B = new Set(Array.isArray(b) ? b : keywords(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

let n = 0;

export class PlaybookStore {
  /** @param {string | null} dir folder for <id>.json files; null keeps them in memory */
  constructor(dir) {
    this.dir = dir;
    /** @type {Map<string, any>} */
    this.items = new Map();
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        try {
          const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          if (p && p.id && Array.isArray(p.tasks)) this.items.set(p.id, p);
        } catch { /* skip a broken file */ }
      }
    }
  }

  list() {
    return [...this.items.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  get(id) {
    return this.items.get(id) || null;
  }

  /**
   * Saves the plan of a finished job.
   * @param {{ title?: string, request: string, tasks: Array<{ title: string, detail: string, assignee: string, dependsOn: number[], kind?: string }> }} spec
   */
  save(spec) {
    const id = `pb_${Date.now().toString(36)}${++n}`;
    const playbook = {
      id,
      title: (spec.title || spec.request).slice(0, 80),
      request: spec.request,
      keywords: keywords(spec.request),
      tasks: spec.tasks.map((t) => ({ title: t.title, detail: t.detail, assignee: t.assignee, dependsOn: t.dependsOn || [], kind: t.kind || 'build' })),
      createdAt: new Date().toISOString(),
      uses: 0
    };
    this.items.set(id, playbook);
    this._write(playbook);
    return playbook;
  }

  markUsed(id) {
    const p = this.items.get(id);
    if (!p) return;
    p.uses = (p.uses || 0) + 1;
    this._write(p);
  }

  delete(id) {
    if (!this.items.delete(id)) return false;
    if (this.dir) fs.rmSync(path.join(this.dir, `${id}.json`), { force: true });
    return true;
  }

  /**
   * Playbooks most similar to a request, best first.
   * @returns {Array<{ playbook: any, score: number }>}
   */
  search(request, { limit = 3, min = 0.2 } = {}) {
    const k = keywords(request);
    return this.list()
      .map((playbook) => ({ playbook, score: Math.round(similarity(k, playbook.keywords) * 1000) / 1000 }))
      .filter((r) => r.score >= min)
      .sort((a, b) => b.score - a.score || (b.playbook.uses || 0) - (a.playbook.uses || 0))
      .slice(0, limit);
  }

  _write(p) {
    if (!this.dir) return;
    fs.writeFileSync(path.join(this.dir, `${p.id}.json`), JSON.stringify(p, null, 2));
  }
}
