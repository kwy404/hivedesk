// The workbench's way to the engine: commands (src/workbench/index.js) and the `wb` frames the
// engine sends only to this window (terminal output, search results, shared document edits).

const desk = () => {
  const d = globalThis.hivedesk;
  if (!d) throw new Error('The desktop is not ready');
  return d;
};

/** Sends a workbench command; rejects with { code, message }. */
export function wb(type, data = {}, opts) {
  return desk().command(type, data, opts);
}

/** Listens to `wb` frames: fn({ type, data }). Returns an unsubscribe function. */
export function onFrame(fn) {
  return desk().on('wb', (f) => fn(f));
}

/** Listens to logged engine events (file.changed and so on). */
export function onEvent(fn) {
  return desk().onEvent(fn);
}

export const state = () => desk().state();
export const notify = (...a) => desk().notify?.(...a);
