// A small JSON schema subset: the one the engine uses for tool calls and plans.
// Supported: type, properties, required, additionalProperties, items, enum, const, oneOf, anyOf,
// minLength, maxLength, minItems, maxItems.

/** @returns {string[]} list of errors, empty when valid */
export function validate(schema, value, at = '$') {
  if (!schema || typeof schema !== 'object') return [];
  const errors = [];
  if ('const' in schema && value !== schema.const) errors.push(`${at} must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at} must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`);
  const alts = schema.oneOf || schema.anyOf;
  if (alts) {
    const results = alts.map((s) => validate(s, value, at));
    const ok = results.filter((r) => r.length === 0).length;
    if (ok === 0) {
      // Report the closest alternative.
      const best = results.reduce((a, b) => (b.length < a.length ? b : a));
      errors.push(...best);
    }
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(t, value))) {
      errors.push(`${at} must be ${types.join(' or ')}`);
      return errors;
    }
  }
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${at} is too short`);
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push(`${at} is too long`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${at} needs at least ${schema.minItems} items`);
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${at} allows at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => errors.push(...validate(schema.items, v, `${at}[${i}]`)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && (schema.properties || schema.required)) {
    const props = schema.properties || {};
    for (const key of schema.required || []) if (!(key in value)) errors.push(`${at}.${key} is required`);
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) errors.push(...validate(props[k], v, `${at}.${k}`));
      else if (schema.additionalProperties === false) errors.push(`${at}.${k} is not allowed`);
    }
  }
  return errors;
}

function typeMatches(t, v) {
  switch (t) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return Number.isInteger(v);
    case 'boolean': return typeof v === 'boolean';
    case 'null': return v === null;
    case 'array': return Array.isArray(v);
    case 'object': return !!v && typeof v === 'object' && !Array.isArray(v);
    default: return true;
  }
}

/**
 * Finds the first complete JSON value in model text (handles code fences and chatter around it).
 * @returns {any} the parsed value, or undefined
 */
export function extractJson(text) {
  if (typeof text !== 'string') return undefined;
  const t = text.trim();
  try { return JSON.parse(t); } catch { /* look inside */ }
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try { return JSON.parse(fence[1]); } catch { /* keep looking */ }
  }
  for (let start = 0; start < t.length; start++) {
    const ch = t[start];
    if (ch !== '{' && ch !== '[') continue;
    const end = matchBracket(t, start);
    if (end === -1) continue;
    try { return JSON.parse(t.slice(start, end + 1)); } catch { /* next */ }
  }
  return undefined;
}

function matchBracket(s, start) {
  const stack = [];
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') {
      const open = stack.pop();
      if ((c === '}' && open !== '{') || (c === ']' && open !== '[')) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

const KEEP = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'oneOf', 'anyOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'description']);

/** Copies a schema keeping only the keys grammar engines understand; anyOf becomes oneOf. */
export function simplifySchema(schema) {
  if (Array.isArray(schema)) return schema.map(simplifySchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (!KEEP.has(k)) continue;
    if (k === 'properties') out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, simplifySchema(pv)]));
    else if (k === 'anyOf' || k === 'oneOf') out.oneOf = v.map(simplifySchema);
    else if (k === 'items' || (k === 'additionalProperties' && typeof v === 'object')) out[k] = simplifySchema(v);
    else out[k] = v;
  }
  return out;
}

/** A plain text description of a schema for prompts (helps backends without grammar support). */
export function describeSchema(schema) {
  return JSON.stringify(simplifySchema(schema));
}
