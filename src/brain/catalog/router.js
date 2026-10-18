// The model router: which model answers this turn. Pure decisions, table tested.
//
// The router picks the model; the machine is picked by the scheduler (src/crew/scheduler.js today, the
// compute plane's ResourceScheduler later). A candidate that only a friend can run is returned with
// where: 'peer' and left to the scheduler; this file never chooses a machine.
//
// Inputs, per turn: the role (Mel plans, Dev codes, QA reviews...) and so the task profile, the context
// the turn needs, the installed models, what is loaded now, the VRAM and RAM free right now, the user's
// pins and per task overrides, recent failures, and what friends can run (from the scheduler).
import { pick as catalogPick, resolvePick, needFor, qualityOf } from './index.js';
import { placement, budgets, shortName } from './recommend.js';
import { CONTEXTS } from './estimate.js';

/**
 * Task profiles: which quality score counts, and how much speed matters.
 *   speed: 'quality' (a slow strong model is fine), 'balanced', 'fast' (a quick small model is better).
 */
export const PROFILES = {
  plan: { task: 'reasoning', speed: 'quality', label: 'planning' },
  code: { task: 'coding', speed: 'balanced', label: 'code' },
  design: { task: 'coding', speed: 'balanced', label: 'design' },
  review: { task: 'coding', speed: 'fast', label: 'review' },
  write: { task: 'chat', speed: 'balanced', label: 'writing' },
  chat: { task: 'chat', speed: 'fast', label: 'chat' }
};

/** The profile of a worker: built in roles by id, hired ones by the words of their role. */
export function profileFor(worker, turn = {}) {
  // A turn outside any job (no job, no task) is a chat reply, whoever answers.
  if (!turn.jobId && !turn.taskId && turn.kind !== 'job') return 'chat';
  const id = String(worker?.id || turn.workerId || '').toLowerCase();
  const byId = { mel: 'plan', dev: 'code', designer: 'design', qa: 'review', writer: 'write' }[id];
  if (byId) return byId;
  const role = `${worker?.role || ''} ${worker?.name || ''}`.toLowerCase();
  if (/plan|architect|lead|foreman|manager|research/.test(role)) return 'plan';
  if (/qa|test|review|check|audit/.test(role)) return 'review';
  if (/design|ui|ux|css|style/.test(role)) return 'design';
  if (/writ|doc|copy|content|translat/.test(role)) return 'write';
  if (/dev|code|engineer|program|backend|frontend|script/.test(role)) return 'code';
  return 'chat';
}

/** Tokens a turn needs: the prompt (about 3.5 characters per token) plus the answer, rounded up to a context size. */
export function contextFor(messages = [], maxTokens = 1024) {
  const chars = messages.reduce((n, m) => n + String(m?.content || '').length, 0);
  const need = Math.ceil(chars / 3.5) + (maxTokens || 1024) + 64;
  return CONTEXTS.find((c) => c >= need) || CONTEXTS[CONTEXTS.length - 1];
}

const sw = (tps) => (tps >= 25 ? 1 : tps >= 15 ? 0.95 : tps >= 8 ? 0.85 : tps >= 5 ? 0.7 : tps >= 3 ? 0.5 : tps >= 1.5 ? 0.3 : 0.1);
/** How speed weighs per profile: a planning turn accepts a slow strong model, a review wants a quick one. */
const SPEED = {
  quality: (tps) => Math.sqrt(sw(tps)),
  balanced: (tps) => sw(tps),
  fast: (tps) => Math.sqrt(Math.min(1, tps / 40)) * (tps >= 3 ? 1 : 0.3)
};

/**
 * Ranks the candidates for one turn.
 * @param {{
 *   profile: keyof PROFILES, ctx: number, hw: any,
 *   installed: string[],                   pick ids in the cache
 *   resident?: string[],                   pick ids loaded now
 *   freeVram?: number | null, freeRam?: number | null,   free right now (null: use the budgets)
 *   pin?: string | null, override?: string | null,       a role pin, a per task override
 *   failures?: Record<string, { count: number, until?: number, why?: string }>,
 *   peers?: Record<string, Array<{ peerId: string, name: string, tps?: number }>>,  pick id -> friends that can run it (scheduler)
 *   needsEvict?: string[],                 ids that would unload another model to fit (a swap costs a load)
 *   exclude?: string[], now?: number
 * }} input
 * @returns {{ choice: Candidate | null, candidates: Candidate[], reason: string, why: object[] }}
 *
 * @typedef {{ id: string, name: string, short: string, quality: number, tps: number, where: 'gpu'|'partial'|'cpu'|'peer',
 *   resident: boolean, score: number, need: number, peers?: any[], pinned?: boolean, override?: boolean, skip?: string }} Candidate
 */
export function route(input) {
  const prof = PROFILES[input.profile] || PROFILES.chat;
  const now = input.now ?? Date.now();
  const ctx = input.ctx || 4096;
  const hw = input.hw || {};
  const b = budgets(hw);
  const resident = new Set(input.resident || []);
  const exclude = new Set(input.exclude || []);
  const failures = input.failures || {};
  const ids = [...new Set([...(input.installed || []), ...Object.keys(input.peers || {})])];
  const candidates = [];
  for (const id of ids) {
    const p = resolvePick(id);
    if (!p) continue;
    const c = { id: p.id, name: p.name, short: shortName({ modelId: p.modelId, quant: p.quant }), quality: qualityOf(p, prof.task), tps: 0, where: 'gpu', resident: resident.has(p.id), score: 0, need: needFor(p, ctx) };
    const local = (input.installed || []).includes(p.id);
    const f = failures[p.id];
    if (exclude.has(p.id)) c.skip = 'excluded';
    else if (f?.until && f.until > now) c.skip = `failed: ${f.why || 'error'}`;
    else if ((p.contextLength || 4096) < ctx) c.skip = 'context too long';
    if (local) {
      const pl = placement(hw, p, ctx, b);
      c.where = pl.where;
      c.tps = pl.tps;
      // Memory free right now: a model that is not loaded must fit next to what is.
      if (!c.resident && pl.where === 'gpu' && input.freeVram != null && c.need > input.freeVram && !c.skip) c.skip = 'not enough free VRAM now';
      if (!c.resident && pl.where === 'cpu' && input.freeRam != null && c.need > input.freeRam && !c.skip) c.skip = 'not enough free RAM now';
      if (pl.where === 'none' && !c.skip) c.skip = 'does not fit this PC';
    }
    if ((!local || c.skip === 'does not fit this PC') && input.peers?.[p.id]?.length) {
      c.where = 'peer';
      c.peers = input.peers[p.id];
      // The scheduler may say how fast the friend's machine runs it; a GPU on the same network is about 8 tokens/s.
      c.tps = c.tps || Math.max(...c.peers.map((x) => Number(x.tps) || 8));
      if (c.skip === 'does not fit this PC') delete c.skip;
    } else if (!local) continue;
    if (!c.skip) {
      // Loading a model costs time: prefer what is loaded, a little.
      const residentBonus = c.resident ? 1.08 : 1;
      const swapPenalty = !c.resident && (input.needsEvict || []).includes(p.id) ? 0.9 : 1;
      const peerPenalty = c.where === 'peer' ? 0.85 : 1;
      c.score = Math.round(c.quality * SPEED[prof.speed](c.tps) * residentBonus * swapPenalty * peerPenalty * 10) / 10;
    }
    if (input.override && p.id === input.override) c.override = true;
    if (input.pin && p.id === input.pin) c.pinned = true;
    candidates.push(c);
  }
  candidates.sort((x, y) => (!!x.skip - !!y.skip) || y.score - x.score || x.need - y.need);
  const usable = candidates.filter((c) => !c.skip);
  // An override for this task wins, then a pin for this role, while they can run.
  const forced = usable.find((c) => c.override) || usable.find((c) => c.pinned);
  const choice = forced || usable[0] || null;
  const why = [];
  if (choice) {
    if (choice.override) why.push({ k: 'override' });
    else if (choice.pinned) why.push({ k: 'pinned' });
    else why.push({ k: 'best', task: prof.task, speed: prof.speed });
    why.push({ k: choice.where === 'peer' ? 'peer' : choice.where === 'gpu' ? 'fitsGpu' : choice.where === 'partial' ? 'partial' : 'cpu' });
    if (choice.resident) why.push({ k: 'loaded' });
    const skipped = candidates.find((c) => c.skip && c.quality > choice.quality);
    if (skipped) why.push({ k: 'skipped', short: skipped.short, reason: skipped.skip });
  }
  return { choice, candidates, why, reason: choice ? reasonText(input.worker || input.profile, choice, prof, why) : 'no installed model can run this turn' };
}

/** "Dev used Qwen2.5-Coder 7B IQ4_XS: best for code and fits on the GPU." (the UI translates the parts) */
export function reasonText(who, c, prof, why) {
  const what = why.find((w) => w.k === 'override') ? 'chosen for this task'
    : why.find((w) => w.k === 'pinned') ? 'pinned to this role'
    : `best for ${prof.label}${prof.speed === 'fast' ? ' at speed' : ''}`;
  const where = c.where === 'gpu' ? 'fits on the GPU' : c.where === 'partial' ? 'partly on the GPU' : c.where === 'cpu' ? 'runs on the CPU' : `runs on a friend's machine`;
  const loaded = c.resident ? ', already loaded' : '';
  return `${who} used ${c.name.replace(/ Instruct| it\b/g, '')}: ${what} and ${where}${loaded}.`;
}

/**
 * The next candidate after a failure, with the failed one excluded.
 * @param {Parameters<typeof route>[0]} input
 * @param {string} failedId
 */
export function rotate(input, failedId) {
  return route({ ...input, exclude: [...(input.exclude || []), failedId] });
}

/**
 * Which loaded models to unload so `need` fits: least recently used first, then least used; never the
 * model in use, and never more than needed. Keeps at most `maxResident` models.
 * @param {Array<{ id: string, need: number, where: 'gpu'|'cpu'|'partial', lastUsed: number, uses: number, busy?: boolean }>} resident
 * @param {{ need: number, where: 'gpu'|'cpu'|'partial', budget: { vram: number, ram: number }, maxResident: number }} want
 * @returns {{ evict: string[], fits: boolean }}
 */
export function evictionPlan(resident, want) {
  const pool = (w) => (w === 'cpu' ? 'ram' : 'vram');
  const used = { vram: 0, ram: 0 };
  for (const r of resident) used[pool(r.where)] += r.need;
  const order = resident.filter((r) => !r.busy).sort((a, b) => a.lastUsed - b.lastUsed || a.uses - b.uses);
  const evict = [];
  let count = resident.length;
  const target = pool(want.where);
  const fitsNow = () => used[target] + want.need <= want.budget[target] && count + 1 <= want.maxResident;
  for (const r of order) {
    if (fitsNow()) break;
    // Unload from the pool that is short first; for the count limit any model will do.
    const countShort = count + 1 > want.maxResident;
    if (pool(r.where) !== target && !countShort) continue;
    evict.push(r.id);
    used[pool(r.where)] -= r.need;
    count--;
  }
  return { evict, fits: fitsNow() };
}

/** Resolves a role pin or a task override to a catalog pick id, or null. */
export function normalizePin(spec) {
  if (!spec) return null;
  const p = resolvePick(String(spec)) || catalogPick(String(spec));
  return p ? p.id : null;
}
