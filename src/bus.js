// The event bus. Since 1.0 it lives in src/core/bus.js (segments, snapshots, origin, schema checks);
// this file keeps the 0.x import path and the project layout.
import fs from 'node:fs';
import path from 'node:path';
import { EventBus, readEventsFile, SchemaError } from './core/bus.js';
import { initialState } from './replay/reduce.js';

export { EventBus, readEventsFile, SchemaError, initialState };

/** Creates the .hivedesk layout inside `dir` and returns the paths (PLAN.md section 1.4). */
export function initHome(dir) {
  const root = path.join(dir, '.hivedesk');
  const paths = {
    root,
    events: path.join(root, 'events.jsonl'),
    segments: path.join(root, 'events'),
    snapshots: path.join(root, 'snapshots'),
    state: path.join(root, 'state.json'),
    playbooks: path.join(root, 'playbooks'),
    workspace: path.join(root, 'workspace'),
    city: path.join(root, 'city'),
    demoMarker: path.join(root, 'demo')
  };
  for (const p of [root, paths.playbooks, paths.workspace]) fs.mkdirSync(p, { recursive: true });
  return paths;
}
