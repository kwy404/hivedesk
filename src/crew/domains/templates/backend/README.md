# My API

A small JSON HTTP API on `node:http`, with no dependencies and tests on `node:test`.

## Run it

- `npm test` starts the server on a random port and calls every route.
- `npm start` listens on http://127.0.0.1:3000 (set `PORT` and `HOST` to change it).

## Routes

| Method | Path | Result |
| --- | --- | --- |
| GET | /health | `{ "ok": true }` |
| GET | /items | `{ "items": [...] }` |
| POST | /items | 201 with the new item; body `{ "title": "...", "done": false }` |
| GET | /items/:id | the item, or 404 |
| PATCH | /items/:id | the changed item; body with `title` and or `done` |
| DELETE | /items/:id | 204, or 404 |

Errors are JSON `{ "error": "..." }` with 400 (bad input), 404, 405, 413 (body over 100 KB) or 500 (no stack trace is sent).

## Files

- `src/app.js`: validation, routes and the store (in memory; replace `memoryStore` with a database layer that has the same methods).
- `src/server.js`: the HTTP server, body limit, JSON responses, logging and graceful shutdown.
- `test/api.test.js`: the API tests.
