// Every schema the crew sends with a turn fits the bounded subset of PLAN section 5 once compacted,
// so any turn can run on a friend's machine. The QA tool call schema is the largest.
import { describe, it, expect } from 'vitest';
import { LIMITS, schemaProblem, compactSchema } from '../../src/compute/wire.js';
import { BRIEF_SCHEMA, REPORT_SCHEMA } from '../../src/crew/brief.js';
import { workerSchema } from '../../src/crew/worker.js';
import { ALL_TOOLS } from '../../src/tools/index.js';
import { BUILTIN } from '../../src/crew/workers.js';

const kinds = ['build', 'qa', 'fix'];

describe('crew schemas on the wire', () => {
  it('the brief, the report and every worker schema pass the bounded subset after compacting', () => {
    const schemas = [BRIEF_SCHEMA, REPORT_SCHEMA];
    for (const w of Object.values(BUILTIN)) for (const kind of kinds) schemas.push(workerSchema({ ...w, tools: ALL_TOOLS }, { kind }));
    for (const s of schemas) {
      const compact = compactSchema(s);
      expect(schemaProblem(compact)).toBe(null);
      expect(JSON.stringify(compact).length).toBeLessThan(LIMITS.schemaChars / 2);
    }
  });

  it('compacting keeps the constraints and drops only descriptions, titles and defaults', () => {
    const s = { type: 'object', description: 'x', title: 't', properties: { a: { type: 'string', enum: ['p', 'q'], description: 'd', default: 'p' } }, required: ['a'], additionalProperties: false };
    expect(compactSchema(s)).toEqual({ type: 'object', properties: { a: { type: 'string', enum: ['p', 'q'] } }, required: ['a'], additionalProperties: false });
  });
});
