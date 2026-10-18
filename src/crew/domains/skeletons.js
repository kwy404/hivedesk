// Offline project skeletons per domain (templates/<id>/): small, buildable and tested. A job of that
// domain starts from its skeleton when the workspace does not have the domain's main files yet; the
// crew then edits the files for the request. Existing files are never overwritten.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMAINS } from './index.js';

export const TEMPLATES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'templates');

/** The file that says a workspace already is a project of that domain. */
const MARKERS = {
  mobile: ['capacitor.config.json', 'www/index.html'],
  desktop: ['neutralino.config.json'],
  backend: ['src/server.js', 'server.js', 'app.js', 'src/app.js'],
  cli: ['bin/cli.js'],
  extension: ['manifest.json'],
  game: ['src/game.js', 'game.js'],
  data: ['bin/run.js', 'src/csv.js']
};

/** The files of a template as { path, text }, sorted. */
export function templateFiles(id) {
  const root = path.join(TEMPLATES_DIR, id);
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) out.push({ path: path.relative(root, abs).split(path.sep).join('/'), text: fs.readFileSync(abs, 'utf8') });
    }
  };
  walk(root);
  return out;
}

export function templateIds() {
  return Object.values(DOMAINS).map((d) => d.template).filter(Boolean);
}

/**
 * Whether a job of this domain should start from the skeleton: the domain has one and the workspace has
 * none of its marker files (an existing project of that kind is edited as it is).
 * @param {string} domain
 * @param {string[]} files the workspace files
 */
export function wantsSkeleton(domain, files) {
  const d = DOMAINS[domain];
  if (!d?.template) return false;
  const have = new Set(files);
  if ((MARKERS[domain] || []).some((m) => have.has(m))) return false;
  // A workspace full of other work (more than a few files) is not mixed with a skeleton.
  const own = files.filter((f) => !/^(README\.md|\.gitignore|LICENSE|\.hivedesk\/.*)$/i.test(f));
  return own.length <= 3;
}

/**
 * Writes the skeleton into the workspace (only files that do not exist) through the toolbox, so every
 * file shows up as a normal change in the activity and the diff views.
 * @param {import('../../tools/index.js').ToolBox} toolbox
 * @param {string} domain
 * @param {{ jobId?: string, workerId?: string }} [ctx]
 * @returns {string[]} the files written
 */
export function seedSkeleton(toolbox, domain, ctx = {}) {
  const d = DOMAINS[domain];
  if (!d?.template) return [];
  const written = [];
  for (const f of templateFiles(d.template)) {
    if (toolbox.ws.exists(f.path)) continue;
    const { before, after } = toolbox.ws.write(f.path, f.text);
    toolbox.fileEvent(f.path, before, after, { jobId: ctx.jobId, workerId: ctx.workerId || d.specialist || 'dev' });
    written.push(f.path);
  }
  return written;
}
