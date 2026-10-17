// Hive City geometry: where the islands, rooms, desks, doors and bridges are, and the walking
// paths between them. Pure module (no DOM), shared by the scene and the unit tests.
// World units: x runs to the lower right, y to the lower left, z is up. One unit is one floor tile.

export const HOME = { cx: 8, cy: 5, r: 13.5 };
export const FRIEND_R = 8;
export const CORRIDOR_Y = 5;
export const WALK_Z = 0.42;
export const SEAT_Z = 0.95;

/** Rooms of your building: back row follows the pipeline, front row holds the Lobby. */
export const ROOMS = {
  design: { x0: 0, x1: 4, y0: 0, y1: 4.6, row: 'back' },
  code: { x0: 4, x1: 8, y0: 0, y1: 4.6, row: 'back' },
  review: { x0: 8, x1: 12, y0: 0, y1: 4.6, row: 'back' },
  test: { x0: 12, x1: 16, y0: 0, y1: 4.6, row: 'back' },
  library: { x0: 0, x1: 4, y0: 5.4, y1: 10, row: 'front' },
  lobby: { x0: 4, x1: 12, y0: 5.4, y1: 10, row: 'front' },
  ops: { x0: 12, x1: 16, y0: 5.4, y1: 10, row: 'front' },
};
export const BUILDING = { x0: 0, x1: 16, y0: 0, y1: 10 };
export const ENTRANCE = { x: 8, y: 10.2 };
export const PLAZA = { x: 8, y: 12.2 };

/** Where friend islands go, in join order (offsets from the home island center). */
export const FRIEND_SLOTS = [[24, -7], [-5, 24], [21, 19], [-22, -5], [5, -23], [35, 11]];

export const roomCenter = (k) => { const r = ROOMS[k] || ROOMS.lobby; return { x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 }; };

/** The doorway of a room on the corridor side. */
export function roomDoor(k) {
  const r = ROOMS[k] || ROOMS.lobby;
  const x = (r.x0 + r.x1) / 2 + (k === 'lobby' ? -1.6 : 0);
  return r.row === 'back' ? { x, y: r.y1 } : { x, y: r.y0 };
}

/**
 * Seats and standing spots of each room, in world units. Desks face the back wall: the seat is
 * in front of the desk (toward the viewer). `desk` marks a seat with a desk drawn in front of it.
 */
export const SPOTS = {
  design: [{ x: 1.25, y: 2.25, desk: true }, { x: 3.0, y: 3.55, desk: false }, { x: 2.3, y: 3.9 }, { x: 1.0, y: 3.8 }],
  code: [{ x: 5.0, y: 2.0, desk: true }, { x: 7.0, y: 2.0, desk: true }, { x: 5.0, y: 3.95, desk: false }, { x: 7.0, y: 3.95 }],
  review: [{ x: 9.15, y: 2.45, desk: true }, { x: 10.85, y: 2.45, desk: true }, { x: 10.0, y: 3.9 }, { x: 11.3, y: 3.95 }],
  test: [{ x: 13.0, y: 2.1, desk: true }, { x: 15.0, y: 2.1, desk: true }, { x: 13.4, y: 3.9 }, { x: 14.8, y: 3.95 }],
  library: [{ x: 2.0, y: 7.6, desk: false }, { x: 1.2, y: 9.1 }, { x: 3.0, y: 9.2 }, { x: 2.8, y: 6.5 }],
  lobby: [{ x: 8.0, y: 6.9, desk: false }, { x: 5.6, y: 8.8 }, { x: 6.8, y: 9.3 }, { x: 9.4, y: 9.3 }, { x: 10.6, y: 8.6 }, { x: 5.4, y: 7.0 }, { x: 10.9, y: 7.1 }, { x: 8.0, y: 8.6 }],
  ops: [{ x: 14.0, y: 7.4, desk: true }, { x: 13.2, y: 9.2 }, { x: 15.0, y: 9.2 }, { x: 14.9, y: 6.4 }],
};

/** A stable spot for the i-th agent of a room (spots repeat with a small offset when full). */
export function spotFor(room, i) {
  const list = SPOTS[room] || SPOTS.lobby;
  const s = list[i % list.length];
  const lap = Math.floor(i / list.length);
  return { x: s.x + lap * 0.45, y: s.y + lap * 0.3, desk: !!s.desk && lap === 0 };
}

/* ---------- islands and bridges ---------- */

/** Hexagon corners of an island (flat top in the world plane). */
export function hexCorners(cx, cy, r) {
  const out = [];
  for (let i = 0; i < 6; i++) { const a = (Math.PI / 3) * i; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return out;
}

export function friendCenter(i) {
  const s = FRIEND_SLOTS[i % FRIEND_SLOTS.length];
  const lap = Math.floor(i / FRIEND_SLOTS.length);
  return { x: HOME.cx + s[0] * (1 + lap * 0.6), y: HOME.cy + s[1] * (1 + lap * 0.6) };
}

/** A bridge from the home plaza edge to a friend island edge. */
export function bridgeTo(fc) {
  const dx = fc.x - HOME.cx; const dy = fc.y - HOME.cy;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len; const uy = dy / len;
  const a = { x: HOME.cx + ux * HOME.r * 0.84, y: HOME.cy + uy * HOME.r * 0.84 };
  const b = { x: fc.x - ux * FRIEND_R * 0.8, y: fc.y - uy * FRIEND_R * 0.8 };
  return { a, b, ux, uy, len: Math.hypot(b.x - a.x, b.y - a.y), arch: Math.min(2.2, 0.6 + Math.hypot(b.x - a.x, b.y - a.y) * 0.08) };
}

/** A point on the bridge deck, u from 0 (home) to 1 (friend). */
export function bridgePoint(br, u) {
  return { x: br.a.x + (br.b.x - br.a.x) * u, y: br.a.y + (br.b.y - br.a.y) * u, z: Math.sin(Math.PI * u) * br.arch };
}

/** The tower of a friend machine: footprint and the spots around it. */
export function towerOf(fc) {
  return { x0: fc.x - 2.4, x1: fc.x + 2.4, y0: fc.y - 2.4, y1: fc.y + 2.4 };
}
export function friendSpot(fc, i, toward) {
  // terrace spots on the side that faces home, so visitors are seen
  const tx = toward ? -toward.ux : 0; const ty = toward ? -toward.uy : 1;
  const px = -ty; const py = tx;
  const off = (i % 5) - 2;
  return { x: fc.x + tx * 4.1 + px * off * 0.95, y: fc.y + ty * 4.1 + py * off * 0.95 };
}

/* ---------- walking paths ---------- */

const inside = (k, p) => { const r = ROOMS[k]; return r && p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1; };

/** Which home room a world point is in (null outside the building). */
export function roomAt(x, y) {
  for (const k of Object.keys(ROOMS)) if (inside(k, { x, y })) return k;
  return null;
}

/** A walking path from a room spot to another room spot, through doors and the corridor. */
export function roomPath(fromRoom, from, toRoom, to) {
  if (fromRoom === toRoom) return [to];
  const pts = [];
  const d0 = roomDoor(fromRoom); const d1 = roomDoor(toRoom);
  const r0 = ROOMS[fromRoom] || ROOMS.lobby; const r1 = ROOMS[toRoom] || ROOMS.lobby;
  pts.push({ x: d0.x, y: d0.y + (r0.row === 'back' ? -0.5 : 0.5) });
  pts.push({ x: d0.x, y: d0.y });
  pts.push({ x: d0.x, y: CORRIDOR_Y });
  pts.push({ x: d1.x, y: CORRIDOR_Y });
  pts.push({ x: d1.x, y: d1.y });
  pts.push({ x: d1.x, y: d1.y + (r1.row === 'back' ? -0.5 : 0.5) });
  pts.push(to);
  void from;
  return pts;
}

/** From a home room out through the Lobby, the entrance and the plaza, to the start of a bridge. */
export function exitPath(fromRoom, br) {
  const pts = fromRoom === 'lobby' ? [] : roomPath(fromRoom, null, 'lobby', { x: 8, y: 7.4 }).slice(0, -1);
  pts.push({ x: 8, y: 8.6 }, { ...ENTRANCE }, { ...PLAZA });
  const n = 18;
  for (let i = 0; i <= n; i++) pts.push(bridgePoint(br, i / n));
  return pts;
}

/** Total length of a path (x, y only) from a start point. */
export function pathLength(start, pts) {
  let len = 0; let p = start;
  for (const q of pts) { len += Math.hypot(q.x - p.x, q.y - p.y); p = q; }
  return len;
}
