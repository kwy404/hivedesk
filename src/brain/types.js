// Brain interface shared by every model adapter. See PROTOCOL.md section 6.
import { validate, extractJson, describeSchema } from './schema.js';

/**
 * @typedef {{ role: 'system' | 'user' | 'assistant', content: string }} Message
 *
 * @typedef {Object} ChatOptions
 * @property {object}  [schema]
 * @property {Array<{name:string, description:string, parameters:object}>} [tools]
 * @property {number}  [maxTokens]
 * @property {number}  [temperature]
 * @property {AbortSignal} [signal]
 * @property {(text:string)=>void} [onToken]
 *
 * @typedef {Object} ChatResult
 * @property {string} text
 * @property {any}    [json]
 * @property {number} promptTokens
 * @property {number} completionTokens
 * @property {number} ms
 * @property {string} [model]
 *
 * @typedef {Object} Brain
 * @property {string} id
 * @property {string} label
 * @property {'local'|'remote'} kind
 * @property {(messages: Message[], options?: ChatOptions) => Promise<ChatResult>} chat
 * @property {() => object} [info]
 * @property {() => Promise<void>} [close]
 */

/** Rough token estimate for backends that do not report usage. */
export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

export function messagesChars(messages) {
  return messages.reduce((n, m) => n + String(m.content || '').length, 0);
}

/**
 * Wraps a raw text generator so a schema is always honored:
 * parse, validate, and retry once with the errors appended.
 * Used by backends without grammar support (and as a safety net for those with it).
 * @param {(messages: Message[], options: ChatOptions) => Promise<ChatResult>} raw
 */
export function withSchema(raw) {
  return async (messages, options = {}) => {
    if (!options.schema) return raw(messages, options);
    let msgs = messages;
    let last;
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await raw(msgs, options);
      const json = r.json !== undefined ? r.json : extractJson(r.text);
      const errors = json === undefined ? ['the answer is not valid JSON'] : validate(options.schema, json);
      if (!errors.length) return { ...r, json };
      last = { r, errors };
      msgs = [
        ...messages,
        { role: 'assistant', content: r.text.slice(0, 2000) },
        { role: 'user', content: `That answer was not valid: ${errors.slice(0, 5).join('; ')}. Answer again with only one JSON value matching this schema: ${describeSchema(options.schema)}` }
      ];
    }
    const err = new Error(`the model did not produce valid JSON: ${last.errors.slice(0, 3).join('; ')}`);
    err.code = 'invalid_json';
    err.text = last.r.text;
    throw err;
  };
}
