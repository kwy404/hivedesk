// Who claims an open task: the agents in that room bid by skill, level and load (CITY-PROTOCOL.md section 7).
// Pure: the City engine calls it with the state and what it knows about busy agents and machine load.

/** score = 0.6 skill + 0.25 min(level, 10) / 10 + 0.15 (1 - load) */
export function bidScore({ skill, level, load }) {
  return Math.round((0.6 * skill + 0.25 * (Math.min(Math.max(level || 1, 1), 10) / 10) + 0.15 * (1 - Math.min(Math.max(load || 0, 0), 1))) * 1000) / 1000;
}

export function skillFor(agent, roomId) {
  const spec = agent.specialization || [];
  if (spec[0] === roomId) return 1;
  if (spec.includes(roomId)) return 0.6;
  return 0;
}

/**
 * @param {any} city CityState
 * @param {any} task CityTask (open)
 * @param {{ busy: (agentId: string) => boolean, load: (machineId: string) => number, canThink: (agent: any) => boolean }} ctx
 * @returns {{ agent: any, bid: { score, skill, load, level, rivals } } | null}
 */
export function pickAgent(city, task, ctx) {
  const roomId = task.pipeline?.[task.stage];
  const room = city.rooms[roomId];
  if (!room) return null;
  const candidates = [];
  for (const a of Object.values(city.agents)) {
    if (a.retired || a.status === 'sleeping' || a.status === 'offline') continue;
    if (task.wantAgent && a.id !== task.wantAgent) continue;
    if (ctx.busy(a.id)) continue;
    const m = city.machines[a.home];
    if (!m || !m.online) continue;
    if (!ctx.canThink(a)) continue;
    if (room.kind === 'board') {
      if (a.workerId !== 'mel') continue;
    } else {
      if (a.workerId === 'mel') continue;
      if (!task.wantAgent && skillFor(a, roomId) === 0) continue;
    }
    if (room.kind === 'review' && task.author && a.id === task.author && !task.wantAgent) continue;
    let skill = room.kind === 'board' ? 1 : (skillFor(a, roomId) || 0.6);
    if (room.kind === 'test' && !task.wantAgent) {
      const reviewer = [...(task.verdicts || [])].reverse().find((v) => city.rooms[v.room]?.kind === 'review')?.agentId;
      if (a.id === task.author || a.id === reviewer) skill *= 0.5;
    }
    const load = ctx.load(a.home);
    candidates.push({ agent: a, skill, level: a.level || 1, load, score: bidScore({ skill, level: a.level, load }) });
  }
  if (!candidates.length) return null;
  candidates.sort((x, y) => y.score - x.score || String(x.agent.id).localeCompare(String(y.agent.id)));
  const best = candidates[0];
  return { agent: best.agent, bid: { score: best.score, skill: best.skill, load: best.load, level: best.level, rivals: candidates.length - 1 } };
}
