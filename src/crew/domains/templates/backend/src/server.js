import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { memoryStore, routes, dispatch, HttpError } from './app.js';

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      // The body size limit: 100 KB, then 413.
      if (size > 100 * 1024) { reject(new HttpError(413, 'the body is too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve(undefined);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'the body is not valid JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  if (body === null || body === undefined) { res.writeHead(status); res.end(); return; }
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** Creates the server (not listening yet), so tests can start it on a random port. */
export function createApp({ store = memoryStore(), log = () => {} } = {}) {
  const table = routes(store);
  return http.createServer(async (req, res) => {
    const started = Date.now();
    // Only origin form paths ("/items"); anything else is not a route of this API.
    if (!String(req.url || '').startsWith('/')) { send(res, 404, { error: 'not found' }); return; }
    try {
      const url = new URL(req.url, 'http://localhost');
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : undefined;
      const out = dispatch(table, req.method, url.pathname, body);
      send(res, out.status, out.body);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      // Never send a stack trace to the client.
      send(res, status, { error: status === 500 ? 'internal error' : err.message });
      if (status === 500) log(`error ${err.stack || err}`);
    } finally {
      log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`);
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '127.0.0.1';
  const server = createApp({ log: (line) => process.stdout.write(`${line}\n`) });
  server.listen(port, host, () => process.stdout.write(`listening on http://${host}:${port}\n`));
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
