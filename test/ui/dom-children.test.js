// The native DOM inserts (append, prepend, replaceChildren, before, after, replaceWith) turn null,
// undefined and false into text: "phones.length ? null : empty" put a "null" line above the phone in the
// desktop's phone list. h() and append() from the dom helpers skip them; a native call must never get one.
// This walks the browser code of the desktop window and of the phone page and flags every native insert
// with an argument that can be null, undefined or false (a ternary with such a branch, or "a && b").
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'rollup/parseAst';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP = new Set(['vendor', 'editor', 'node_modules', 'screenshots']);
const INSERTS = new Set(['append', 'prepend', 'replaceChildren', 'before', 'after', 'replaceWith']);
// Objects whose before() and after() are not DOM nodes (the chat's sticky scroll helper).
const NOT_NODES = new Set(['sticky']);

function files(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) files(p, out); } else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const empty = (n) => (n.type === 'Literal' && (n.value === null || n.value === false)) || (n.type === 'Identifier' && n.name === 'undefined');
const maybeEmpty = (n) => !!n && (empty(n)
  || (n.type === 'ConditionalExpression' && (maybeEmpty(n.consequent) || maybeEmpty(n.alternate)))
  || (n.type === 'LogicalExpression' && n.operator === '&&'));

/** "file:line method() argument n" for each native insert in src that may get null, undefined or false. */
function findings(src, name) {
  const out = [];
  const visit = (n) => {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && !n.callee.computed && INSERTS.has(n.callee.property.name)
      && !(n.callee.object.type === 'Identifier' && NOT_NODES.has(n.callee.object.name))) {
      n.arguments.forEach((a, i) => {
        if (maybeEmpty(a)) out.push(`${name}:${src.slice(0, n.start).split('\n').length} ${n.callee.property.name}() argument ${i + 1}`);
      });
    }
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === 'object' && typeof v.type === 'string') visit(v);
    }
  };
  visit(parseAst(src));
  return out;
}

describe('native DOM inserts', () => {
  it('never get an argument that can be null, undefined or false', () => {
    const list = [...files(path.join(ROOT, 'ui')), ...files(path.join(ROOT, 'docs', 'remote', 'js'))];
    expect(list.length).toBeGreaterThan(50);
    const found = list.flatMap((f) => findings(fs.readFileSync(f, 'utf8'), path.relative(ROOT, f).split(path.sep).join('/')));
    expect(found).toEqual([]);
  });

  it('flags the pattern that showed "null" in the phone list', () => {
    const src = "list.replaceChildren(title, phones.length ? null : empty, ...rows);\nbox.append(ok && note);\nel.append(h('p', {}, a ? b : null));\n";
    expect(findings(src, 'sample.js')).toEqual(['sample.js:1 replaceChildren() argument 2', 'sample.js:2 append() argument 1']);
  });
});
