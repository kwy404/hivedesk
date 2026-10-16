// Changelog plug-in: the activity log (who did what and when) and the project's CHANGELOG.md.
// At the end of each job Mel proposes a Keep a Changelog entry; nothing is written until the
// user approves it (changelog.write).
import fs from 'node:fs';
import path from 'node:path';
import { jobReport, reportText } from './report.js';
import { merge, proposeEntry, suggestBump, renderSections, entryFromMarkdown, latestVersion, cleanEntry, isEmpty, ENTRY_SCHEMA } from './keepachangelog.js';
import { activityFrom, filterActivity, people, exportActivity, KINDS } from './activity.js';
import { melAsk } from './mel.js';
import { unifiedDiff, diffStats } from '../tools/diff.js';

export const CHANGELOG_FILE = 'CHANGELOG.md';
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const fail = (code, message) => Object.assign(new Error(message), { code });

export default function register(ctx) {
  const { bus, server, hive, scheduler } = ctx;
  const ws = ctx.workspace || ctx.toolbox?.ws;
  const root = ws?.root || ctx.config?.workspace;
  const ask = ctx.ask || melAsk(scheduler);
  const proposals = new Map();
  let seq = 0;

  const file = () => path.join(root, CHANGELOG_FILE);
  const readText = () => { try { return fs.readFileSync(file(), 'utf8'); } catch { return null; } };

  function currentVersion() {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      if (typeof pkg.version === 'string' && SEMVER.test(pkg.version)) return { version: pkg.version, from: 'package.json' };
    } catch { /* no package.json */ }
    const v = latestVersion(readText() || '');
    return v ? { version: v, from: CHANGELOG_FILE } : { version: null, from: null };
  }

  /** Builds a proposal from a job. With `useModel`, Mel writes the lines; the rules are the fallback. */
  async function propose(jobId, { useModel = false } = {}) {
    const report = jobReport(bus.events, jobId, bus.state);
    if (!report) throw fail('not_found', jobId ? `No job ${jobId} in the log.` : 'No finished job yet. Run a job first.');
    let entry = proposeEntry(report);
    let by = 'rules';
    if (useModel && ask) {
      const json = await ask([
        { role: 'system', content: 'You are Mel, the foreman. Write a changelog entry in the Keep a Changelog style for the work below: short lines for users, past tense is not needed, no file names unless they matter, Added for new things, Changed for changes to existing things, Fixed for bug fixes. Use only facts from the report. Empty arrays are fine.' },
        { role: 'user', content: reportText(report) }
      ], ENTRY_SCHEMA);
      const e = json && cleanEntry(json);
      if (e && !isEmpty(e)) { entry = e; by = 'mel'; }
    }
    const cur = currentVersion();
    const suggestion = suggestBump(entry, cur.version);
    const p = {
      proposalId: `cl_${Date.now().toString(36)}_${++seq}`, jobId: report.jobId, request: report.request,
      entry, markdown: renderSections(entry), suggestion: { ...suggestion, from: cur.from }, by, createdAt: new Date().toISOString()
    };
    proposals.set(p.proposalId, p);
    while (proposals.size > 20) proposals.delete(proposals.keys().next().value);
    return p;
  }

  /** Merges the approved entry into CHANGELOG.md in the workspace. */
  function write(d) {
    const p = d.proposalId ? proposals.get(d.proposalId) : null;
    if (d.proposalId && !p) throw fail('not_found', 'That proposal is gone (it expired or was already written). Ask Mel for a new one.');
    const entry = typeof d.markdown === 'string' ? entryFromMarkdown(d.markdown) : d.entry ? cleanEntry(d.entry) : p?.entry;
    if (!entry || isEmpty(entry)) throw fail('bad_request', 'The entry is empty. Add at least one line under Added, Changed or Fixed.');
    let version = null;
    if (d.release) {
      version = String(d.version || p?.suggestion?.version || '').replace(/^v/, '');
      if (!SEMVER.test(version)) throw fail('bad_request', `"${version}" is not a version like 1.2.3.`);
    }
    const before = readText();
    const after = merge(before, entry, { version, repoUrl: typeof d.repoUrl === 'string' && /^https:\/\//.test(d.repoUrl) ? d.repoUrl : undefined });
    if (ws?.write) ws.write(CHANGELOG_FILE, after);
    else fs.writeFileSync(file(), after);
    const diff = unifiedDiff(CHANGELOG_FILE, before, after);
    const st = diffStats(diff);
    const jobId = p?.jobId || d.jobId || undefined;
    const ev = jobId ? { jobId } : {};
    const by = typeof d.by === 'string' && d.by.startsWith('guest:') ? d.by.slice(0, 80) : 'user';
    bus.emit('file.changed', { path: CHANGELOG_FILE, op: before == null ? 'create' : 'modify', diff, bytes: Buffer.byteLength(after), added: st.added ?? st.add ?? 0, removed: st.removed ?? st.del ?? 0, ...(Buffer.byteLength(after) <= 64 * 1024 ? { content: after } : {}), workerId: by, proposedBy: 'mel' }, ev);
    const markdown = renderSections(entry);
    bus.emit('changelog.written', { path: CHANGELOG_FILE, version, markdown, proposalId: p?.proposalId || null, by }, ev);
    if (p) proposals.delete(p.proposalId);
    return { path: CHANGELOG_FILE, version, markdown, content: after };
  }

  // Mel drafts an entry when a job ends (rules only, so no model turn is taken from the crew).
  const off = bus.on((e) => {
    if (e.type !== 'job.done' || !e.jobId || !root) return;
    setTimeout(async () => {
      try {
        const p = await propose(e.jobId);
        if (isEmpty(p.entry)) return;
        bus.emit('changelog.proposed', { proposalId: p.proposalId, entry: p.entry, markdown: p.markdown, suggestion: p.suggestion, by: p.by }, { jobId: e.jobId });
        hive?.chat?.('mel', `I drafted a changelog entry for this job (suggested version ${p.suggestion.version}, ${p.suggestion.bump}: ${p.suggestion.reason}) Open the Changelog window to edit and approve it. Nothing is written until you do.`, undefined, 'general', e.jobId);
      } catch { /* a missing report is not an error here */ }
    }, 0);
  });

  const cmd = (type, fn) => server?.command?.(type, fn);
  cmd('changelog.read', () => {
    const content = readText();
    return { path: CHANGELOG_FILE, exists: content != null, content: content || '', current: currentVersion() };
  });
  cmd('changelog.propose', async (d) => {
    const p = await propose(typeof d.jobId === 'string' ? d.jobId : undefined, { useModel: d.useModel !== false });
    return p;
  });
  cmd('changelog.proposals', () => ({ proposals: [...proposals.values()].reverse() }));
  cmd('changelog.dismiss', (d) => { proposals.delete(d.proposalId); return {}; });
  cmd('changelog.write', (d) => write(d));
  cmd('changelog.preview', (d) => {
    const entry = typeof d.markdown === 'string' ? entryFromMarkdown(d.markdown) : cleanEntry(d.entry);
    const version = d.release ? String(d.version || '').replace(/^v/, '') : null;
    if (version && !SEMVER.test(version)) throw fail('bad_request', `"${version}" is not a version like 1.2.3.`);
    return { content: merge(readText(), entry, { version }), suggestion: suggestBump(entry, currentVersion().version) };
  });

  const entries = () => activityFrom(bus.events, bus.state);
  cmd('activity.list', (d) => {
    const all = entries();
    const list = filterActivity(all, d || {});
    const limit = Math.min(Math.max(Number(d?.limit) || 300, 1), 2000);
    return { entries: list.slice(-limit).reverse(), total: list.length, people: people(all), kinds: KINDS, lastSeq: bus.seq };
  });
  cmd('activity.detail', (d) => {
    const e = bus.events.find((x) => x.seq === Number(d.seq));
    if (!e) throw fail('not_found', 'No such entry.');
    const out = { seq: e.seq, ts: e.ts, type: e.type, jobId: e.jobId || null };
    if (e.type === 'file.changed') {
      Object.assign(out, { path: e.data.path, op: e.data.op, diff: e.data.diff || '', content: e.data.content ?? null, added: e.data.added, removed: e.data.removed });
      out.exists = !!ws?.exists?.(e.data.path);
    }
    return out;
  });
  server?.route?.('GET', '/api/activity/export', (req, res, url) => {
    const f = Object.fromEntries(['who', 'kind', 'q', 'jobId', 'since', 'until', 'path'].map((k) => [k, url.searchParams.get(k) || undefined]));
    const format = ['csv', 'md', 'json'].includes(url.searchParams.get('format')) ? url.searchParams.get('format') : 'json';
    const out = exportActivity(filterActivity(entries(), f), format);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    res.writeHead(200, { 'content-type': out.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-disposition': `attachment; filename="hivedesk-activity-${stamp}.${out.ext}"` });
    res.end(out.body);
  });

  return { propose, write, proposals, currentVersion, close: off };
}
