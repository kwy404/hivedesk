// Code together and the Code editor, server side. Loaded by the lend plug-in (src/lend/index.js).
//   files.write { path, content, as? }  save a file from the editor through the engine's tools.
//     Without `as` it is the person at this PC saving their own file: it runs at once.
//     With `as: { id, name, role }` it is a guest's save, forwarded by the host's browser: it always
//     waits for the host's approval (new files too, whatever the approval mode), so the host sees
//     the diff and approves or rejects it.
// Guests never reach this server directly: their commands arrive through the host's browser,
// which checks their role first (ui/lend/collab/roles.js); the engine checks it again
// (src/collab/policy.js), so a viewer cannot save.

import { guestOf } from './policy.js';

export class CommandError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const MAX = 512 * 1024;

export function cleanPath(p) {
  const s = String(p ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!s || s.length > 300 || s.startsWith('/') || /^[a-zA-Z]:/.test(s) || /(^|\/)\.\.(\/|$)/.test(s) || s.includes('\0')) throw new CommandError('bad_request', 'path is missing or not allowed');
  return s;
}

/** Runs one editor save through the tools. Returns { path, bytes }. */
export async function writeFile(toolbox, data) {
  if (!toolbox) throw new CommandError('bad_request', 'this engine version cannot save from the editor yet');
  const path = cleanPath(data?.path);
  if (typeof data?.content !== 'string') throw new CommandError('bad_request', 'content must be text');
  if (Buffer.byteLength(data.content) > MAX) throw new CommandError('bad_request', 'file too large (max 512 KB)');
  const guest = guestOf(data);
  if (guest && guest.role !== 'collaborator') throw new CommandError('forbidden', 'a viewer cannot save files');
  const ctx = guest
    ? { workerId: `guest:${guest.name}`, approval: true, preexisting: new Set(toolbox.ws.list().map((f) => f.path)), origin: { kind: 'guest', id: guest.id, label: guest.name } }
    : { workerId: 'user', approval: false };
  const r = await toolbox.execute('write_file', { path, content: data.content }, ctx);
  if (!r.ok) throw new CommandError(/rejected/.test(r.error) ? 'rejected' : 'bad_request', r.error);
  return { path, bytes: Buffer.byteLength(data.content) };
}

export default function registerCollab({ server, toolbox }) {
  server?.command?.('files.write', (data) => writeFile(toolbox, data));
  return { writeFile: (data) => writeFile(toolbox, data) };
}
