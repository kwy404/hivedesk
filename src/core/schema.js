// A small JSON schema subset for events and commands (PLAN.md section 1.3). No Node imports.
// Keywords: type, enum, const, required, properties, additionalProperties, items, anyOf,
// minLength, maxLength, pattern, minItems, maxItems, minimum, maximum.

const MAX_DEPTH = 32;
const MAX_ERRORS = 20;

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function typeMatches(want, v) {
  const t = typeOf(v);
  if (want === 'number') return t === 'number' || t === 'integer';
  return want === t;
}

/**
 * Validates `value` against `schema`.
 * @returns {string[]} the problems, empty when the value is valid
 */
export function validate(schema, value, at = '$', errors = [], depth = 0) {
  if (!schema || typeof schema !== 'object' || errors.length >= MAX_ERRORS) return errors;
  if (depth > MAX_DEPTH) { errors.push(`${at}: nested too deep`); return errors; }
  const push = (msg) => { if (errors.length < MAX_ERRORS) errors.push(`${at}: ${msg}`); };
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(t, value))) { push(`expected ${types.join(' or ')}, got ${typeOf(value)}`); return errors; }
  }
  if ('const' in schema && value !== schema.const) push(`must be ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) push(`must be one of ${schema.enum.join(', ')}`);
  if (Array.isArray(schema.anyOf)) {
    const ok = schema.anyOf.some((s) => validate(s, value, at, [], depth + 1).length === 0);
    if (!ok) push('matches none of the allowed shapes');
  }
  if (typeof value === 'string') {
    if (Number.isFinite(schema.minLength) && value.length < schema.minLength) push(`shorter than ${schema.minLength}`);
    if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) push(`longer than ${schema.maxLength}`);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) push(`does not match ${schema.pattern}`);
  }
  if (typeof value === 'number') {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) push(`below ${schema.minimum}`);
    if (Number.isFinite(schema.maximum) && value > schema.maximum) push(`above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (Number.isFinite(schema.minItems) && value.length < schema.minItems) push(`fewer than ${schema.minItems} items`);
    if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) push(`more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => validate(schema.items, v, `${at}[${i}]`, errors, depth + 1));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of schema.required || []) if (!(k in value) || value[k] === undefined) push(`${k} is required`);
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue; // JSON drops it: the same as an absent field
      if (props[k]) validate(props[k], v, `${at}.${k}`, errors, depth + 1);
      else if (schema.additionalProperties === false) push(`unknown field ${k}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validate(schema.additionalProperties, v, `${at}.${k}`, errors, depth + 1);
    }
  }
  return errors;
}

// ---- shorthands used by the registries ----
export const str = (maxLength = 4000, extra = {}) => ({ type: 'string', maxLength, ...extra });
export const id = (maxLength = 80) => ({ type: 'string', minLength: 1, maxLength });
export const int = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => ({ type: 'integer', minimum, maximum });
export const obj = (properties = {}, required = [], extra = {}) => ({ type: 'object', properties, required, ...extra });
export const arr = (items, maxItems = 1000) => ({ type: 'array', items, maxItems });
export const bool = () => ({ type: 'boolean' });
export const ANY_OBJECT = Object.freeze({ type: 'object' });
