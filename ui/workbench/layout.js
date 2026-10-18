// Editor groups and tabs, as plain data (PLAN 11.2): up to three columns side by side, each
// with its own tabs and active tab; one model per file is shared by every group that shows it.
// Pure and DOM free, so the tests drive it directly and the layout can be saved as JSON.
//
// A tab is a key string: "f:<root>:<path>" a file, "d:<root>:<staged 0|1>:<path>" a diff,
// "s:settings" the settings page.

export const MAX_GROUPS = 3;

export const fileKey = (root, path) => `f:${root || 'ws'}:${path}`;
export const diffKey = (root, path, staged) => `d:${root || 'ws'}:${staged ? 1 : 0}:${path}`;
export const SETTINGS_KEY = 's:settings';

/** { kind, root, path, staged } from a tab key. */
export function parseKey(key) {
  const s = String(key || '');
  if (s === SETTINGS_KEY) return { kind: 'settings' };
  if (s.startsWith('f:')) {
    const i = s.indexOf(':', 2);
    return { kind: 'file', root: s.slice(2, i), path: s.slice(i + 1) };
  }
  if (s.startsWith('d:')) {
    const i = s.indexOf(':', 2);
    return { kind: 'diff', root: s.slice(2, i), staged: s[i + 1] === '1', path: s.slice(i + 3) };
  }
  return { kind: 'unknown' };
}

let gid = 0;
const newGroup = () => ({ id: `g${++gid}`, tabs: [], active: null });

export function createLayout() {
  const g = newGroup();
  return { groups: [g], activeGroup: g.id, sizes: [1] };
}

const clone = (l) => ({ groups: l.groups.map((g) => ({ ...g, tabs: [...g.tabs] })), activeGroup: l.activeGroup, sizes: [...l.sizes] });
const groupOf = (l, id) => l.groups.find((g) => g.id === id) || null;
export const activeGroup = (l) => groupOf(l, l.activeGroup) || l.groups[0];
export const activeTab = (l) => activeGroup(l)?.active || null;

function evenSizes(n) {
  return Array.from({ length: n }, () => 1 / n);
}

/** Opens a tab in a group (the active one by default), after the active tab, and makes it active. */
export function openTab(layout, key, { group } = {}) {
  const l = clone(layout);
  const g = groupOf(l, group) || activeGroup(l);
  if (!g.tabs.includes(key)) {
    const at = g.active ? g.tabs.indexOf(g.active) + 1 : g.tabs.length;
    g.tabs.splice(at, 0, key);
  }
  g.active = key;
  l.activeGroup = g.id;
  return l;
}

/** Closes a tab; the neighbor becomes active; an empty group other than the last one closes. */
export function closeTab(layout, key, { group } = {}) {
  const l = clone(layout);
  const g = groupOf(l, group) || l.groups.find((x) => x.tabs.includes(key));
  if (!g) return l;
  const i = g.tabs.indexOf(key);
  if (i < 0) return l;
  g.tabs.splice(i, 1);
  if (g.active === key) g.active = g.tabs[Math.min(i, g.tabs.length - 1)] || null;
  if (!g.tabs.length && l.groups.length > 1) return closeGroup(l, g.id);
  return l;
}

/** Closes a tab in every group (the file was deleted). */
export function closeEverywhere(layout, key) {
  let l = layout;
  for (const g of layout.groups) if (g.tabs.includes(key)) l = closeTab(l, key, { group: g.id });
  return l;
}

/** Renames a tab key in every group (the file was renamed or moved). */
export function renameTab(layout, from, to) {
  const l = clone(layout);
  for (const g of l.groups) {
    g.tabs = g.tabs.map((k) => (k === from ? to : k)).filter((k, i, a) => a.indexOf(k) === i);
    if (g.active === from) g.active = to;
  }
  return l;
}

/**
 * Splits: a new group to the right of `group` showing `key` (the active tab by default).
 * With three groups already, the tab moves to the next group instead.
 */
export function split(layout, { group, key } = {}) {
  let l = clone(layout);
  const g = groupOf(l, group) || activeGroup(l);
  const k = key || g.active;
  const i = l.groups.indexOf(g);
  if (l.groups.length >= MAX_GROUPS) {
    const next = l.groups[(i + 1) % l.groups.length];
    return k ? openTab(l, k, { group: next.id }) : { ...l, activeGroup: next.id };
  }
  const n = newGroup();
  l.groups.splice(i + 1, 0, n);
  l.sizes = evenSizes(l.groups.length);
  l.activeGroup = n.id;
  if (k) l = openTab(l, k, { group: n.id });
  return l;
}

export function closeGroup(layout, id) {
  const l = clone(layout);
  if (l.groups.length <= 1) return l;
  const i = l.groups.findIndex((g) => g.id === id);
  if (i < 0) return l;
  const [gone] = l.groups.splice(i, 1);
  // Tabs that are not open anywhere else move to the neighbor, so nothing is lost silently.
  const into = l.groups[Math.max(0, i - 1)];
  for (const k of gone.tabs) if (!l.groups.some((g) => g.tabs.includes(k))) into.tabs.push(k);
  if (!into.active && into.tabs.length) into.active = into.tabs[0];
  l.sizes = evenSizes(l.groups.length);
  if (l.activeGroup === id) l.activeGroup = into.id;
  return l;
}

/** Moves a tab to another group (drag and drop between groups), at an index or at the end. */
export function moveTab(layout, key, toGroup, index) {
  const l = clone(layout);
  const from = l.groups.find((g) => g.tabs.includes(key) && (g.id !== toGroup || index !== undefined));
  const to = groupOf(l, toGroup);
  if (!to) return l;
  if (from) {
    const i = from.tabs.indexOf(key);
    from.tabs.splice(i, 1);
    if (from.active === key) from.active = from.tabs[Math.min(i, from.tabs.length - 1)] || null;
  }
  const at = index === undefined ? to.tabs.length : Math.max(0, Math.min(index, to.tabs.length));
  to.tabs = to.tabs.filter((k) => k !== key);
  to.tabs.splice(at, 0, key);
  to.active = key;
  l.activeGroup = to.id;
  if (from && from !== to && !from.tabs.length && l.groups.length > 1) return closeGroup(l, from.id);
  return l;
}

export function focusGroup(layout, idOrIndex) {
  const g = typeof idOrIndex === 'number' ? layout.groups[idOrIndex] : groupOf(layout, idOrIndex);
  return g ? { ...clone(layout), activeGroup: g.id } : layout;
}

export function setActive(layout, group, key) {
  const l = clone(layout);
  const g = groupOf(l, group);
  if (g && g.tabs.includes(key)) {
    g.active = key;
    l.activeGroup = g.id;
  }
  return l;
}

/** Cycles the active tab of the active group. */
export function cycleTab(layout, dir = 1) {
  const g = activeGroup(layout);
  if (!g?.tabs.length) return layout;
  const i = g.tabs.indexOf(g.active);
  return setActive(layout, g.id, g.tabs[(i + dir + g.tabs.length) % g.tabs.length]);
}

/** Every distinct tab key, for knowing which models are still needed. */
export const openKeys = (layout) => [...new Set(layout.groups.flatMap((g) => g.tabs))];

/** Column sizes after dragging the sash between group i and i + 1. */
export function resize(layout, i, fraction) {
  const l = clone(layout);
  if (i < 0 || i >= l.sizes.length - 1) return l;
  const pair = l.sizes[i] + l.sizes[i + 1];
  const min = 0.12;
  const a = Math.max(min, Math.min(pair - min, fraction));
  l.sizes[i] = a;
  l.sizes[i + 1] = pair - a;
  return l;
}

export function serialize(layout) {
  return JSON.stringify({ v: 1, groups: layout.groups.map((g) => ({ tabs: g.tabs.slice(0, 40), active: g.active })), active: layout.groups.findIndex((g) => g.id === layout.activeGroup), sizes: layout.sizes });
}

export function deserialize(text) {
  try {
    const o = JSON.parse(text);
    if (!o || o.v !== 1 || !Array.isArray(o.groups) || !o.groups.length) return createLayout();
    const groups = o.groups.slice(0, MAX_GROUPS).map((g) => {
      const n = newGroup();
      n.tabs = (Array.isArray(g.tabs) ? g.tabs : []).filter((k) => typeof k === 'string' && parseKey(k).kind !== 'unknown').slice(0, 40);
      n.active = n.tabs.includes(g.active) ? g.active : n.tabs[0] || null;
      return n;
    });
    const sizes = Array.isArray(o.sizes) && o.sizes.length === groups.length && o.sizes.every((x) => Number.isFinite(x) && x > 0) ? o.sizes : evenSizes(groups.length);
    const sum = sizes.reduce((a, b) => a + b, 0);
    return { groups, activeGroup: (groups[o.active] || groups[0]).id, sizes: sizes.map((x) => x / sum) };
  } catch {
    return createLayout();
  }
}
