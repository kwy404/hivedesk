// Adds extension tools to the engine's tool table so workers can call them through the normal
// ToolBox (events, the allowed tools list per worker, approval mode for destructive tools).
// When the engine grows `toolbox.registerTool(name, def, handler)` (see NOTES-engine.md) that is
// used; until then the shared TOOLS table and ALL_TOOLS list are extended in place.
import { TOOLS, ALL_TOOLS } from '../tools/index.js';

/**
 * @param {import('../tools/index.js').ToolBox} toolbox
 */
export function toolHook(toolbox) {
  const handlers = new Map();
  if (typeof toolbox.registerTool === 'function') {
    return {
      add: (name, def, handler) => toolbox.registerTool(name, def, handler),
      remove: (name) => toolbox.unregisterTool?.(name),
      has: (name) => !!TOOLS[name]
    };
  }
  const run = toolbox.run.bind(toolbox);
  toolbox.run = async (tool, args, ctx, callId) => {
    const h = handlers.get(tool);
    if (h) return h(args, ctx);
    return run(tool, args, ctx, callId);
  };
  return {
    add(name, def, handler) {
      if (TOOLS[name] && !handlers.has(name)) throw new Error(`a tool named ${name} already exists`);
      TOOLS[name] = { description: def.description, parameters: def.parameters, destructive: !!def.destructive };
      if (!ALL_TOOLS.includes(name)) ALL_TOOLS.push(name);
      handlers.set(name, handler);
    },
    remove(name) {
      if (!handlers.has(name)) return;
      handlers.delete(name);
      delete TOOLS[name];
      const i = ALL_TOOLS.indexOf(name);
      if (i !== -1) ALL_TOOLS.splice(i, 1);
    },
    has: (name) => !!TOOLS[name]
  };
}
