// Task graph: tasks with dependencies and a status. Pure data, no I/O.

export const TERMINAL = new Set(['done', 'failed', 'skipped', 'blocked']);

export class TaskGraph {
  constructor() {
    /** @type {Map<string, any>} */
    this.tasks = new Map();
  }

  /** Adds a task; unknown or self dependencies are dropped, cycles are refused. */
  add(task) {
    if (this.tasks.has(task.id)) throw new Error(`duplicate task id ${task.id}`);
    const deps = [...new Set((task.dependsOn || []).filter((d) => d !== task.id && this.tasks.has(d)))];
    const t = { status: 'pending', attempts: 0, kind: 'build', ...task, dependsOn: deps };
    this.tasks.set(t.id, t);
    return t;
  }

  get(id) {
    return this.tasks.get(id);
  }

  all() {
    return [...this.tasks.values()];
  }

  setStatus(id, status) {
    const t = this.tasks.get(id);
    if (!t) throw new Error(`unknown task ${id}`);
    t.status = status;
    return t;
  }

  /**
   * Pending tasks whose dependencies are all done. A QA task also runs when some of its dependencies
   * failed, once they all ended and at least one is done: its review starts the fix rounds for them.
   */
  ready() {
    return this.all().filter((t) => t.status === 'pending' && (t.dependsOn.every((d) => this.tasks.get(d)?.status === 'done') || this._reviewable(t)));
  }

  _reviewable(t) {
    if (t.kind !== 'qa' || !t.dependsOn.length) return false;
    const st = t.dependsOn.map((d) => this.tasks.get(d)?.status);
    return st.some((s) => s === 'done') && st.every((s) => ['done', 'failed', 'blocked', 'skipped'].includes(s));
  }

  /**
   * Marks pending tasks that can never run (a dependency failed, was skipped or is blocked) as blocked.
   * @returns {any[]} the tasks that changed
   */
  propagateBlocked() {
    const changed = [];
    let again = true;
    while (again) {
      again = false;
      for (const t of this.all()) {
        if (t.status !== 'pending') continue;
        if (t.kind === 'qa' && t.dependsOn.some((d) => ['done', 'pending', 'running', 'review', 'ready'].includes(this.tasks.get(d)?.status))) continue;
        if (t.dependsOn.some((d) => ['failed', 'blocked', 'skipped'].includes(this.tasks.get(d)?.status))) {
          t.status = 'blocked';
          changed.push(t);
          again = true;
        }
      }
    }
    return changed;
  }

  running() {
    return this.all().filter((t) => t.status === 'running' || t.status === 'review');
  }

  /** True when nothing can move anymore. */
  isFinished() {
    return this.all().every((t) => TERMINAL.has(t.status));
  }

  allDone() {
    return this.all().every((t) => t.status === 'done' || t.status === 'skipped');
  }

  /** Topological order (dependencies first), stable by insertion. */
  order() {
    const out = [];
    const seen = new Set();
    const visit = (t) => {
      if (seen.has(t.id)) return;
      seen.add(t.id);
      for (const d of t.dependsOn) visit(this.tasks.get(d));
      out.push(t);
    };
    for (const t of this.all()) visit(t);
    return out;
  }
}
