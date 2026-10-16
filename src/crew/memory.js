// Per worker memory: a few short notes, so prompts stay small for small models.

export class Memory {
  constructor(limit = 6, maxChars = 240) {
    this.limit = limit;
    this.maxChars = maxChars;
    /** @type {Map<string, string[]>} */
    this.notes = new Map();
  }

  add(workerId, note) {
    const text = String(note || '').replace(/\s+/g, ' ').trim().slice(0, this.maxChars);
    if (!text) return;
    const list = this.notes.get(workerId) || [];
    list.push(text);
    if (list.length > this.limit) list.splice(0, list.length - this.limit);
    this.notes.set(workerId, list);
  }

  get(workerId) {
    return [...(this.notes.get(workerId) || [])];
  }

  /** Notes from every worker, newest last, for the crew context. */
  crew(limit = 8) {
    const all = [];
    for (const [id, list] of this.notes) for (const n of list) all.push(`${id}: ${n}`);
    return all.slice(-limit);
  }

  clear(workerId) {
    if (workerId) this.notes.delete(workerId);
    else this.notes.clear();
  }
}
