// CHANGELOG.md in the Keep a Changelog format (https://keepachangelog.com/en/1.1.0/):
// parse, render, merge a new entry, propose an entry from a job report and suggest a version bump.

export const SECTIONS = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];
export const PROPOSED = ['Added', 'Changed', 'Fixed'];

export const HEADER = `# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
`;

/** @typedef {{ Added?: string[], Changed?: string[], Fixed?: string[], Deprecated?: string[], Removed?: string[], Security?: string[] }} Entry */

/**
 * @param {string} text
 * @returns {{ header: string, releases: Array<{ title: string, version: string|null, date: string|null, sections: Record<string,string[]>, extra: string[] }>, footer: string[] }}
 */
export function parse(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const releases = [];
  const header = [];
  const footer = [];
  let cur = null;
  let section = null;
  for (const line of lines) {
    const rel = /^##\s+(.+?)\s*$/.exec(line);
    if (rel && !line.startsWith('###')) {
      const title = rel[1];
      const m = /^\[?([^\]\s]+)\]?(?:\s+-\s+(\d{4}-\d{2}-\d{2}))?/.exec(title);
      const version = m && !/^unreleased$/i.test(m[1]) ? m[1] : null;
      cur = { title, version, date: m?.[2] || null, unreleased: /unreleased/i.test(title), sections: {}, extra: [] };
      releases.push(cur);
      section = null;
      continue;
    }
    if (/^\[[^\]]+\]:\s*\S+/.test(line)) { footer.push(line); continue; }
    if (!cur) { header.push(line); continue; }
    const sec = /^###\s+(.+?)\s*$/.exec(line);
    if (sec) {
      section = normalizeSection(sec[1]);
      if (!cur.sections[section]) cur.sections[section] = [];
      continue;
    }
    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (item && section) { cur.sections[section].push(item[1].trim()); continue; }
    if (/^\s{2,}\S/.test(line) && section && cur.sections[section].length) {
      const list = cur.sections[section];
      list[list.length - 1] += ' ' + line.trim();
      continue;
    }
    if (line.trim()) cur.extra.push(line);
  }
  return { header: header.join('\n').trimEnd(), releases, footer };
}

function normalizeSection(s) {
  const found = SECTIONS.find((x) => x.toLowerCase() === s.trim().toLowerCase());
  return found || s.trim();
}

/** Markdown for one entry's sections (no release heading). */
export function renderSections(entry) {
  const out = [];
  const keys = [...SECTIONS, ...Object.keys(entry || {}).filter((k) => !SECTIONS.includes(k))];
  for (const k of keys) {
    const items = (entry?.[k] || []).map((s) => String(s).trim()).filter(Boolean);
    if (!items.length) continue;
    out.push(`### ${k}`, '', ...items.map((i) => `- ${i}`), '');
  }
  return out.join('\n').trimEnd();
}

export function render(doc) {
  const out = [doc.header ? doc.header.trimEnd() : HEADER.trimEnd(), ''];
  for (const r of doc.releases) {
    out.push(`## ${r.title}`, '');
    for (const x of r.extra) out.push(x);
    if (r.extra.length) out.push('');
    const body = renderSections(r.sections);
    if (body) out.push(body, '');
  }
  if (doc.footer?.length) out.push(...doc.footer, '');
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** Reads an edited entry back from markdown ("### Added" and "- item" lines). */
export function entryFromMarkdown(text) {
  const doc = parse(`## [Unreleased]\n${String(text || '')}`);
  return doc.releases[0]?.sections || {};
}

const key = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function mergeSections(into, entry) {
  for (const [k, items] of Object.entries(entry || {})) {
    const sec = normalizeSection(k);
    const list = into[sec] || (into[sec] = []);
    const seen = new Set(list.map(key));
    for (const i of items || []) {
      const t = String(i).trim();
      if (t && !seen.has(key(t))) { list.push(t); seen.add(key(t)); }
    }
  }
  return into;
}

/**
 * Adds an entry to a CHANGELOG.md text (or a new file when empty).
 * Without `version`, the items join the [Unreleased] section. With `version`, the current
 * [Unreleased] items and the entry become a new release under that version.
 * @param {string|null} text
 * @param {Entry} entry
 * @param {{ version?: string|null, date?: string, repoUrl?: string }} [opts]
 */
export function merge(text, entry, opts = {}) {
  const doc = text && text.trim() ? parse(text) : { header: HEADER.trimEnd(), releases: [], footer: [] };
  if (!doc.header.trim()) doc.header = HEADER.trimEnd();
  let unreleased = doc.releases.find((r) => r.unreleased);
  if (!unreleased) {
    unreleased = { title: '[Unreleased]', version: null, date: null, unreleased: true, sections: {}, extra: [] };
    doc.releases.unshift(unreleased);
  }
  if (!opts.version) {
    mergeSections(unreleased.sections, entry);
    return render(doc);
  }
  const v = String(opts.version).replace(/^v/, '');
  if (doc.releases.some((r) => r.version === v)) {
    const r = doc.releases.find((x) => x.version === v);
    mergeSections(r.sections, entry);
    return render(doc);
  }
  const date = opts.date || new Date().toISOString().slice(0, 10);
  const sections = mergeSections(mergeSections({}, unreleased.sections), entry);
  unreleased.sections = {};
  unreleased.extra = [];
  const idx = doc.releases.indexOf(unreleased);
  doc.releases.splice(idx + 1, 0, { title: `[${v}] - ${date}`, version: v, date, unreleased: false, sections, extra: [] });
  if (opts.repoUrl) updateLinks(doc, v, opts.repoUrl);
  return render(doc);
}

function updateLinks(doc, v, repoUrl) {
  const base = repoUrl.replace(/\.git$/, '').replace(/\/+$/, '');
  const prev = doc.releases.filter((r) => r.version && r.version !== v)[0]?.version;
  doc.footer = doc.footer.filter((l) => !/^\[unreleased\]:/i.test(l) && !l.startsWith(`[${v}]:`));
  doc.footer.unshift(`[unreleased]: ${base}/compare/v${v}...HEAD`, prev ? `[${v}]: ${base}/compare/v${prev}...v${v}` : `[${v}]: ${base}/releases/tag/v${v}`);
}

/** The newest released version in a changelog, or null. */
export function latestVersion(text) {
  for (const r of parse(text).releases) if (r.version && /^\d+\.\d+\.\d+/.test(r.version)) return r.version;
  return null;
}

export function bumpVersion(current, bump) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(current || '0.0.0'));
  let [maj, min, pat] = m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
  if (bump === 'major') { maj++; min = 0; pat = 0; } else if (bump === 'minor') { min++; pat = 0; } else pat++;
  return `${maj}.${min}.${pat}`;
}

const BREAKING = /\b(breaking|remove[sd]?|drop(?:s|ped)?|rename[sd]?|incompatible|migrat\w*)\b|\b(remov\w+|quebra\w*|renome\w+|incompat\w+)\b/i;

/**
 * Suggests patch, minor or major with a short reason.
 * @param {Entry} entry
 * @param {string|null} current
 */
export function suggestBump(entry, current) {
  const all = Object.values(entry || {}).flat().join(' ');
  const removed = (entry?.Removed || []).length;
  let bump = 'patch';
  let reason = 'Only fixes and small changes, nothing new for users.';
  if (removed || BREAKING.test(all)) {
    bump = 'major';
    reason = removed ? 'Something was removed, which can break people who use it.' : 'The entry mentions a breaking change (removed, renamed or incompatible).';
  } else if ((entry?.Added || []).length) {
    bump = 'minor';
    reason = 'New features were added and nothing was removed.';
  } else if ((entry?.Changed || []).length && !(entry?.Fixed || []).length) {
    bump = 'patch';
    reason = 'Existing parts changed without new features or removals.';
  }
  const base = current || '0.0.0';
  // Before 1.0.0 a breaking change bumps the minor version (semver section 4 practice).
  const effective = bump === 'major' && /^0\./.test(base) ? 'minor' : bump;
  const note = effective !== bump ? ' Before 1.0.0, a breaking change moves the minor number.' : '';
  return { bump, version: bumpVersion(base, effective), current: current || null, reason: reason + note };
}

const tidy = (s) => String(s || '').replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const FIX_WORDS = /\b(fix\w*|bug\w*|broken|repair\w*|corrig\w*|consert\w*|erro\w*|arrum\w*)\b/i;
const CHANGE_WORDS = /\b(update\w*|change\w*|improv\w*|refactor\w*|rename\w*|polish\w*|tweak\w*|atualiz\w*|mud\w*|melhor\w*|ajust\w*)\b/i;

/**
 * The entry Mel proposes from a job report, without a model: done tasks become lines,
 * sorted by kind and by the files they touched.
 * @param {ReturnType<import('./report.js').jobReport>} r
 * @returns {Entry}
 */
export function proposeEntry(r) {
  const entry = { Added: [], Changed: [], Fixed: [] };
  if (!r) return entry;
  const created = r.files.filter((f) => f.op === 'create').length;
  const modified = r.files.filter((f) => f.op === 'modify' || f.op === 'delete').length;
  const done = r.tasks.filter((t) => t.status === 'done' && t.kind !== 'qa');
  for (const t of done) {
    const line = cap(tidy(t.title));
    if (!line) continue;
    if (t.kind === 'fix' || FIX_WORDS.test(t.title)) entry.Fixed.push(line);
    else if (CHANGE_WORDS.test(t.title) || (t.kind === 'docs' && !created) || (!created && modified)) entry.Changed.push(line);
    else entry.Added.push(line);
  }
  if (!done.length) {
    const line = cap(tidy(r.request));
    if (line) (FIX_WORDS.test(line) ? entry.Fixed : created ? entry.Added : entry.Changed).push(line);
  }
  for (const k of PROPOSED) entry[k] = [...new Map(entry[k].map((x) => [key(x), x])).values()].slice(0, 12);
  return entry;
}

export const ENTRY_SCHEMA = {
  type: 'object',
  properties: {
    Added: { type: 'array', items: { type: 'string', maxLength: 160 }, maxItems: 8 },
    Changed: { type: 'array', items: { type: 'string', maxLength: 160 }, maxItems: 8 },
    Fixed: { type: 'array', items: { type: 'string', maxLength: 160 }, maxItems: 8 }
  },
  required: ['Added', 'Changed', 'Fixed']
};

export function cleanEntry(e) {
  const out = {};
  for (const k of PROPOSED) out[k] = Array.isArray(e?.[k]) ? e[k].map((s) => cap(tidy(s))).filter(Boolean).slice(0, 12) : [];
  return out;
}

export const isEmpty = (entry) => !Object.values(entry || {}).some((v) => Array.isArray(v) && v.length);
