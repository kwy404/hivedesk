// Achievements of the local profile (docs/1.0/PROFILE.md): unlocked only from the real counters of
// ui/profile/stats.js, each with the date it was unlocked. Badges are original hexagon marks with a
// stroke glyph from the 1.0 icon family. Pure module, no DOM: shared by the engine and the window.

import { streak, bestStreak } from './stats.js';

const H = (ms) => ms / 3_600_000;
const domains = (s) => Object.values(s.tasksByDomain).filter((v) => v > 0).length;

/** id, the glyph, the group, and the test on the stats. Titles and how-to texts are i18n keys profile.ach.<id>.title / .how. */
export const ACHIEVEMENTS = Object.freeze([
  { id: 'first_project', glyph: 'hive', group: 'build', test: (s) => s.jobs >= 1 },
  { id: 'projects_10', glyph: 'hive', group: 'build', test: (s) => s.projects.length >= 10 },
  { id: 'jobs_100', glyph: 'check', group: 'build', test: (s) => s.jobs >= 100 },
  { id: 'files_100', glyph: 'code', group: 'build', test: (s) => s.files >= 100 },
  { id: 'files_1000', glyph: 'code', group: 'build', test: (s) => s.files >= 1000 },
  { id: 'tokens_100k', glyph: 'model', group: 'build', test: (s) => s.tokens >= 100_000 },
  { id: 'tokens_1m', glyph: 'model', group: 'build', test: (s) => s.tokens >= 1_000_000 },
  { id: 'crew_10h', glyph: 'clock', group: 'build', test: (s) => H(s.crewMs) >= 10 },
  { id: 'crew_100h', glyph: 'clock', group: 'build', test: (s) => H(s.crewMs) >= 100 },
  { id: 'polyglot', glyph: 'plan', group: 'build', test: (s) => domains(s) >= 4 },
  { id: 'models_3', glyph: 'model', group: 'build', test: (s) => s.models.length >= 3 },
  { id: 'qa_25', glyph: 'qa', group: 'quality', test: (s) => s.qaPassed >= 25 },
  { id: 'approvals_25', glyph: 'approval', group: 'quality', test: (s) => s.approvals >= 25 },
  { id: 'audit_clean', glyph: 'lock', group: 'quality', test: (s) => s.auditClean >= 1 },
  { id: 'first_pr', glyph: 'github', group: 'quality', test: (s) => s.prs >= 1 },
  { id: 'changelog', glyph: 'tag', group: 'quality', test: (s) => s.changelogs >= 1 },
  { id: 'first_friend', glyph: 'hire', group: 'city', test: (s) => s.friends.length >= 1 },
  { id: 'friends_5', glyph: 'hire', group: 'city', test: (s) => s.friends.length >= 5 },
  { id: 'first_lend', glyph: 'gpu', group: 'city', test: (s) => s.lentJobs >= 1 },
  { id: 'lend_10h', glyph: 'gpu', group: 'city', test: (s) => H(s.lentGpuMs + s.lentCpuMs) >= 10 },
  { id: 'lend_100h', glyph: 'gpu', group: 'city', test: (s) => H(s.lentGpuMs + s.lentCpuMs) >= 100 },
  { id: 'first_borrow', glyph: 'lend', group: 'city', test: (s) => s.borrowedJobs >= 1 },
  { id: 'first_remote', glyph: 'preview', group: 'city', test: (s) => s.remoteSessions >= 1 },
  { id: 'first_mobile', glyph: 'macos', group: 'city', test: (s) => s.mobile >= 1 },
  { id: 'first_voice', glyph: 'chat', group: 'crew', test: (s) => s.voice >= 1 },
  { id: 'first_hire', glyph: 'hire', group: 'crew', test: (s) => s.hires >= 1 },
  { id: 'playbooks_10', glyph: 'playbook', group: 'crew', test: (s) => s.playbooksUsed >= 10 },
  { id: 'memory_10', glyph: 'words', group: 'crew', test: (s) => s.memories >= 10 },
  { id: 'theme_maker', glyph: 'design', group: 'crew', test: (s) => s.themes >= 1 },
  { id: 'extension', glyph: 'wand', group: 'crew', test: (s) => s.extensions >= 1 },
  { id: 'streak_7', glyph: 'star', group: 'habit', test: (s, now) => streak(s.days, now) >= 7 || bestStreak(s.days) >= 7 },
  { id: 'streak_30', glyph: 'star', group: 'habit', test: (s, now) => streak(s.days, now) >= 30 || bestStreak(s.days) >= 30 },
  { id: 'night_shift', glyph: 'clock', group: 'habit', test: (s) => s.nightJobs >= 1 },
]);
export const ACHIEVEMENT_IDS = new Set(ACHIEVEMENTS.map((a) => a.id));

/**
 * The achievements newly unlocked by these stats. `unlocked` maps id to the ISO date it was
 * unlocked; it is never rewritten, so a date always means the first time.
 * @returns {string[]} ids unlocked now
 */
export function unlock(stats, unlocked, now = Date.now()) {
  const fresh = [];
  for (const a of ACHIEVEMENTS) {
    if (unlocked[a.id]) continue;
    let ok = false;
    try { ok = !!a.test(stats, now); } catch { ok = false; }
    if (ok) { unlocked[a.id] = new Date(now).toISOString(); fresh.push(a.id); }
  }
  return fresh;
}

const GLYPH = {
  hive: '<path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z"/><path d="M4.2 10.2h15.6M4.2 13.8h15.6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  code: '<path d="M8.5 7l-5 5 5 5M15.5 7l5 5-5 5M13.4 4.6l-2.8 14.8"/>',
  model: '<path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z"/><path d="M12 8.2l3.3 1.9v3.8L12 15.8l-3.3-1.9v-3.8z"/>',
  clock: '<circle cx="12" cy="12" r="8.8"/><path d="M12 7v5l3.4 2"/>',
  plan: '<path d="M10 6.5h9.5M10 12h9.5M10 17.5h6"/><path d="M3.8 6.4l1.4 1.4 2.6-2.8M3.8 11.9l1.4 1.4 2.6-2.8"/><circle cx="5.6" cy="17.5" r="1.6"/>',
  qa: '<circle cx="12" cy="12" r="8.5"/><path d="M8.2 12.2l2.6 2.6 5-5.2"/>',
  approval: '<path d="M12 3l7.5 3v5.6c0 4.2-3 7.9-7.5 9.4-4.5-1.5-7.5-5.2-7.5-9.4V6z"/><path d="M8.6 12.1l2.4 2.4 4.4-4.6"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.2"/><path d="M8 10.5V7.6a4 4 0 0 1 8 0v2.9"/><path d="M12 14.6v2"/>',
  github: '<path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"/>',
  tag: '<path d="M3 12.2V4.5A1.5 1.5 0 0 1 4.5 3h7.7l8.8 8.8-9.2 9.2z"/><circle cx="7.8" cy="7.8" r="1.4"/>',
  hire: '<circle cx="9" cy="8" r="3.8"/><path d="M2.6 20c.8-3.6 3.3-5.6 6.4-5.6s5.6 2 6.4 5.6"/><path d="M19 7.5v6M16 10.5h6"/>',
  gpu: '<rect x="2.5" y="6" width="19" height="11" rx="2"/><circle cx="9.2" cy="11.5" r="3"/><path d="M15 10h3.5M15 13h3.5M5.5 17v2.6M8.5 17v2.6M11.5 17v2.6"/>',
  lend: '<rect x="3" y="4" width="8" height="6" rx="1"/><rect x="13" y="14" width="8" height="6" rx="1"/><path d="M7 13v1.5a2 2 0 0 0 2 2h2M17 11V9.5a2 2 0 0 0-2-2h-2"/>',
  preview: '<path d="M2.5 12S6 5.6 12 5.6 21.5 12 21.5 12 18 18.4 12 18.4 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  macos: '<rect x="7" y="2.5" width="10" height="19" rx="2.2"/><path d="M11 18.5h2"/>',
  chat: '<path d="M4.5 5h15a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H11l-4.5 3.5V16h-2a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/><path d="M8 10.5h8"/>',
  playbook: '<path d="M5 5a2 2 0 0 1 2-2h12v15H7a2 2 0 0 0-2 2z"/><path d="M5 20a2 2 0 0 0 2 2h12v-4"/><path d="M9 7.5h6M9 11h4"/>',
  words: '<rect x="2.5" y="5" width="8.5" height="5" rx="1.6"/><rect x="13" y="5" width="8.5" height="5" rx="1.6"/><rect x="2.5" y="14" width="8.5" height="5" rx="1.6"/><rect x="13" y="14" width="8.5" height="5" rx="1.6"/>',
  design: '<path d="M12 3.5l5 7-5 10-5-10z"/><path d="M12 10.5v3.2"/>',
  wand: '<path d="M4.5 19.5l10-10M13 8l3 3"/><path d="M17.5 3.5v3M16 5h3M20 10v2M19 11h2"/>',
  star: '<path d="M12 3.2l2.7 5.5 6 .9-4.35 4.25 1.03 6-5.38-2.83-5.38 2.83 1.03-6L3.3 9.6l6-.9z"/>',
};

/** A badge: a hexagon with a stroke glyph; amber hairline when unlocked, quiet gray when locked. */
export function badgeSvg(id, unlocked, size = 56) {
  const a = ACHIEVEMENTS.find((x) => x.id === id);
  const g = GLYPH[a?.glyph] || GLYPH.star;
  const c = unlocked ? '#F2A93B' : '#656C76';
  const fill = unlocked ? '#1F2329' : '#131519';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true"><path d="M32 3 57.1 17.5v29L32 61 6.9 46.5v-29z" fill="${fill}" stroke="${c}" stroke-opacity="${unlocked ? 0.8 : 0.5}" stroke-width="1.5"/><path d="M32 9.5 51.5 20.8v22.4L32 54.5 12.5 43.2V20.8z" fill="none" stroke="${c}" stroke-opacity="${unlocked ? 0.25 : 0.15}"/><g transform="translate(20 20)" fill="none" stroke="${unlocked ? '#E6E8EB' : '#656C76'}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${g}</g></svg>`;
}
