// The API without the network: routes as plain functions over a store, so tests can call them directly
// and through the HTTP server (src/server.js).

/** An in memory store with the same shape a database layer would have. Swap it for a real one later. */
export function memoryStore() {
  const items = new Map();
  let next = 1;
  return {
    list: () => [...items.values()],
    get: (id) => items.get(id) || null,
    create: (data) => { const item = { id: String(next++), ...data, createdAt: new Date().toISOString() }; items.set(item.id, item); return item; },
    update: (id, data) => { const cur = items.get(id); if (!cur) return null; const item = { ...cur, ...data, id }; items.set(id, item); return item; },
    remove: (id) => items.delete(id)
  };
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** Checks the body of a new or changed item; returns the clean fields or throws a 400. */
export function validateItem(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'the body must be a JSON object');
  const out = {};
  if (body.title !== undefined || !partial) {
    if (typeof body.title !== 'string' || !body.title.trim()) throw new HttpError(400, 'title is required');
    if (body.title.length > 200) throw new HttpError(400, 'title is at most 200 characters');
    out.title = body.title.trim();
  }
  if (body.done !== undefined) {
    if (typeof body.done !== 'boolean') throw new HttpError(400, 'done must be true or false');
    out.done = body.done;
  } else if (!partial) out.done = false;
  return out;
}

/** Route table: [method, pattern, handler(params, body, ctx) -> { status, body }]. */
export function routes(store) {
  return [
    ['GET', /^\/health$/, () => ({ status: 200, body: { ok: true } })],
    ['GET', /^\/items$/, () => ({ status: 200, body: { items: store.list() } })],
    ['POST', /^\/items$/, (p, body) => ({ status: 201, body: store.create(validateItem(body)) })],
    ['GET', /^\/items\/([\w-]+)$/, ([id]) => {
      const item = store.get(id);
      if (!item) throw new HttpError(404, 'no item with that id');
      return { status: 200, body: item };
    }],
    ['PATCH', /^\/items\/([\w-]+)$/, ([id], body) => {
      const item = store.update(id, validateItem(body, { partial: true }));
      if (!item) throw new HttpError(404, 'no item with that id');
      return { status: 200, body: item };
    }],
    ['DELETE', /^\/items\/([\w-]+)$/, ([id]) => {
      if (!store.remove(id)) throw new HttpError(404, 'no item with that id');
      return { status: 204, body: null };
    }]
  ];
}

/** Finds and runs the route of a request; unknown paths are 404, known paths with another method 405. */
export function dispatch(table, method, pathname, body) {
  let known = false;
  for (const [m, re, handler] of table) {
    const match = re.exec(pathname);
    if (!match) continue;
    known = true;
    if (m === method) return handler(match.slice(1), body);
  }
  throw new HttpError(known ? 405 : 404, known ? 'method not allowed' : 'not found');
}
