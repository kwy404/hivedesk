// Every string the City shows exists: in i18n/en.json or in the City part (i18n/parts/city.en.json,
// merged by Stream 1). The part follows the rules of the locale files.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, placeholders } from '../../i18n/index.js';
import { KINDS } from '../../ui/city/activity.js';
import { JOB_STATES } from '../../ui/city/compute.js';
import { ROLES } from '../../ui/city/roles.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const en = JSON.parse(read('i18n/en.json'));
const part = JSON.parse(read('i18n/parts/city.en.json'));
const known = (k) => k in en || k in part;
const FILES = ['ui/city/city.js', 'ui/city/panels.js', 'ui/city/onboarding.js', 'ui/city/scene.js', 'ui/js/widgets/machines.js', 'ui/js/widgets/activity.js'];

describe('City strings', () => {
  it('has every literal key the City code asks for', () => {
    const missing = [];
    for (const f of FILES) {
      const src = read(f);
      for (const m of src.matchAll(/\b(?:tr|t|this\.t)\(\s*'(city\.[A-Za-z0-9_.]+)'/g)) if (!known(m[1])) missing.push(`${f}: ${m[1]}`);
      for (const m of src.matchAll(/\b(?:tx|ta|tp): '(city\.[A-Za-z0-9_.]+)'/g)) if (!known(m[1])) missing.push(`${f}: ${m[1]}`);
    }
    expect(missing).toEqual([]);
  });

  it('has every key of the families built at run time', () => {
    const fam = {
      'city.act.kind': KINDS, 'city.act.export': ['csv', 'json', 'md'],
      'city.job.state': JOB_STATES, 'city.job.where': ['localGpu', 'localCpu', 'peerGpu', 'peerCpu'],
      'city.job.err': ['timeout', 'cancelled', 'revoked', 'crashed', 'oom', 'lease_expired', 'disconnected', 'bad_output', 'not_granted', 'sharing_off', 'busy', 'model_not_allowed', 'model_missing', 'vram', 'too_long', 'rate_limited', 'outside_hours', 'bad_input', 'failed', 'expired', 'partial', 'rejected'],
      'city.job.reject': ['not_granted', 'sharing_off', 'busy', 'model_not_allowed', 'model_missing', 'vram', 'too_long', 'rate_limited', 'outside_hours', 'bad_input', 'other'],
      'city.job.leaseState': ['active', 'released', 'expired', 'revoked'],
      'city.m.f': ['gpu', 'vram', 'gpuUtil', 'cpu', 'ram', 'model', 'tps', 'slots'],
      'city.m.state': ['measured', 'reported', 'stale', 'static', 'joined', 'unknown'],
      'city.state': ['queued', 'assigned', 'working', 'waiting', 'review', 'testing', 'completed', 'failed', 'cancelled'],
      'city.role': ['architect', 'developer', 'qa', 'reviewer', 'planner', 'writer', 'ops'],
      'city.ob.roleAbout': Object.keys(ROLES), 'city.thinks': ['local', 'peer', 'cloud'],
      'city.tp.verdictBy': ['agent', 'user', 'checks', 'qa'], 'city.tp.wait': ['approval', 'dependency', 'resource', 'peer', 'user'],
      'city.peer.trust': ['unknown', 'known', 'blocked'], 'city.peer.scope': ['session', 'standing'], 'city.peer.via': ['invite', 'known', 'local', 'demo'],
      'city.peer.reason': ['left', 'revoked', 'peer_lost'],
      'city.cap': ['city.view', 'city.member', 'workspace.read', 'workspace.propose', 'compute.inference', 'chat', 'terminal.share.read', 'terminal.share.write', 'remote.view', 'remote.control', 'clipboard.text', 'file.send']
    };
    const missing = [];
    for (const [prefix, list] of Object.entries(fam)) for (const k of list) if (!known(`${prefix}.${k}`)) missing.push(`${prefix}.${k}`);
    // every Activity line key
    const act = read('ui/city/activity.js');
    for (const m of act.matchAll(/mk\('[a-z]+', (?:[a-z]+ \? )?'([A-Za-z]+)'(?: : '([A-Za-z]+)')?/g)) for (const k of [m[1], m[2]].filter(Boolean)) if (!known(`city.act.${k}`)) missing.push(`city.act.${k}`);
    for (const m of act.matchAll(/'(fileCreated|fileDeleted|fileEdited|loop|hop|passed|failed|approved|rejected)'/g)) if (!known(`city.act.${m[1]}`)) missing.push(`city.act.${m[1]}`);
    expect(missing).toEqual([]);
  });

  it('keeps the part clean: no key twice, valid messages, no dashes, no emoji', () => {
    const DASH = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);
    const problems = [];
    for (const [k, v] of Object.entries(part)) {
      // Merged into en.json (scripts/merge-i18n.mjs): the same text there.
      if (k in en && en[k] !== v) problems.push(`${k}: differs from en.json`);
      if (typeof v !== 'string' || !v.trim()) problems.push(`${k}: empty`);
      const p = {};
      for (const n of placeholders(v)) p[n] = 2;
      try { if (/[{}]/.test(format('en', v, p))) problems.push(`${k}: braces`); } catch (err) { problems.push(`${k}: ${err.message}`); }
      if (DASH.test(v)) problems.push(`${k}: dash`);
      if (/\p{Extended_Pictographic}/u.test(v)) problems.push(`${k}: emoji`);
    }
    expect(problems).toEqual([]);
  });
});
