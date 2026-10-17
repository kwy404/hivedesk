"""Find the translatable parts of docs/index.html.

A unit is the inner HTML of the first element, walking down from <html>, that holds text of its own
and no block elements inside. Inside a unit, code, kbd and svg become atomic placeholders (<c1/>)
and every other tag becomes a numbered pair (<x1>...</x1>) or a void placeholder (<x2/>), so a
translator moves words around the markup without touching it. Attributes that people read
(alt, aria-label, title, placeholder, data-tip, data-keywords, v-copy-label, meta content) are
units too.

Shared by build.py and check.py. Standard library only.
"""
import hashlib
import re
from html.parser import HTMLParser

VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'}
BLOCK = {'address', 'article', 'aside', 'blockquote', 'details', 'dialog', 'div', 'dl', 'dd', 'dt', 'fieldset', 'figcaption', 'figure',
         'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section',
         'table', 'tbody', 'thead', 'tr', 'td', 'th', 'ul', 'summary', 'video', 'select'}
SKIP = {'script', 'style', 'svg', 'code', 'kbd', 'pre', 'noscript', 'template', 'video'}
ATOMIC = {'code', 'kbd', 'svg'}
ATTRS = ('alt', 'aria-label', 'title', 'placeholder', 'data-tip', 'data-keywords', 'v-copy-label')
META_NAMES = {'description', 'twitter:title', 'twitter:description'}
META_PROPS = {'og:title', 'og:description', 'og:image:alt'}
LETTERS = re.compile(r'[^\W\d_]{2,}', re.UNICODE)


class Node:
    def __init__(self, tag, attrs, start, open_end, parent):
        self.tag, self.attrs, self.start, self.open_end, self.parent = tag, attrs, start, open_end, parent
        self.close_start = self.end = open_end
        self.children = []  # Node or (text, start, end)


class Tree(HTMLParser):
    def __init__(self, src):
        super().__init__(convert_charrefs=False)
        self.src = src
        self.lines = [0]
        for i, ch in enumerate(src):
            if ch == '\n':
                self.lines.append(i + 1)
        self.root = Node('#root', [], 0, 0, None)
        self.cur = self.root
        self.feed(src)
        self.close()

    def off(self):
        line, col = self.getpos()
        return self.lines[line - 1] + col

    def handle_starttag(self, tag, attrs):
        start = self.off()
        text = self.get_starttag_text()
        node = Node(tag, attrs, start, start + len(text), self.cur)
        self.cur.children.append(node)
        if tag in VOID:
            node.end = node.open_end
        else:
            self.cur = node

    def handle_startendtag(self, tag, attrs):
        start = self.off()
        text = self.get_starttag_text()
        node = Node(tag, attrs, start, start + len(text), self.cur)
        node.end = node.open_end
        self.cur.children.append(node)

    def handle_endtag(self, tag):
        start = self.off()
        n = self.cur
        while n is not self.root and n.tag != tag:
            n = n.parent
        if n is self.root:
            return
        close_len = self.src.index('>', start) + 1 - start
        m = self.cur
        while True:
            if m is n:
                m.close_start, m.end = start, start + close_len
            else:
                m.close_start = m.end = start
            if m is n:
                break
            m = m.parent
        self.cur = n.parent

    def handle_data(self, data):
        start = self.off()
        self.cur.children.append((data, start, start + len(data)))

    def handle_entityref(self, name):
        start = self.off()
        self.cur.children.append((f'&{name};', start, start + len(name) + 2))

    def handle_charref(self, name):
        start = self.off()
        self.cur.children.append((f'&#{name};', start, start + len(name) + 3))


def attr(node, name):
    for k, v in node.attrs:
        if k == name:
            return v
    return None


def has_block(node):
    for c in node.children:
        if isinstance(c, Node):
            if c.tag in BLOCK or has_block(c):
                return True
    return False


def own_text(node):
    return any(isinstance(c, tuple) and LETTERS.search(c[0]) for c in node.children)


def any_text(node):
    for c in node.children:
        if isinstance(c, tuple):
            if LETTERS.search(c[0]):
                return True
        elif c.tag not in SKIP and any_text(c):
            return True
    return False


def unit_id(text):
    return hashlib.sha1(text.encode('utf-8')).hexdigest()[:10]


def to_placeholders(src, node):
    """Inner HTML of node with tags replaced by placeholders. Returns (text, mapping)."""
    out, mapping, counter = [], {}, [0]

    def walk(n):
        for c in n.children:
            if isinstance(c, tuple):
                out.append(c[0])
                continue
            counter[0] += 1
            k = counter[0]
            if c.tag in ATOMIC:
                mapping[f'<c{k}/>'] = src[c.start:c.end]
                out.append(f'<c{k}/>')
            elif c.tag in VOID or c.end == c.open_end:
                mapping[f'<x{k}/>'] = src[c.start:c.end]
                out.append(f'<x{k}/>')
            else:
                mapping[f'<x{k}>'] = src[c.start:c.open_end]
                mapping[f'</x{k}>'] = src[c.close_start:c.end]
                out.append(f'<x{k}>')
                walk(c)
                out.append(f'</x{k}>')
    walk(node)
    return ''.join(out), mapping


def find_units(src):
    """Returns a list of dicts: {id, kind, text, start, end, map} with source offsets to replace."""
    tree = Tree(src)
    units = []

    def add(kind, text, start, end, mapping=None):
        t = text.strip()
        if not LETTERS.search(re.sub(r'<[^>]+>', ' ', t)):
            return
        lead = len(text) - len(text.lstrip())
        trail = len(text) - len(text.rstrip())
        units.append({'id': unit_id(t), 'kind': kind, 'text': t, 'start': start + lead if kind == 'html' else start,
                      'end': end - trail if kind == 'html' else end, 'map': mapping or {}})

    def attrs_of(n):
        tag_src = src[n.start:n.open_end]
        for name in ATTRS:
            for m in re.finditer(r'\s' + re.escape(name) + r'="([^"]*)"', tag_src):
                val = m.group(1)
                if LETTERS.search(val):
                    add('attr', val, 0, 0)
        if n.tag == 'meta':
            nm, pr = attr(n, 'name'), attr(n, 'property')
            if nm in META_NAMES or pr in META_PROPS:
                m = re.search(r'\scontent="([^"]*)"', tag_src)
                if m:
                    add('attr', m.group(1), 0, 0)

    def walk(n, in_unit=False):
        for c in n.children:
            if isinstance(c, tuple):
                continue
            attrs_of(c)
            if c.tag in ('script', 'style', 'noscript', 'template') or attr(c, 'translate') == 'no' or attr(c, 'class') in ('lang-name',):
                continue
            if c.tag in SKIP:
                walk_attrs_only(c)
                continue
            if any(k == 'data-i18n-h1' for k, _ in c.attrs):
                continue
            if own_text(c) and not has_block(c):
                text, mapping = to_placeholders(src, c)
                add('html', text, c.open_end, c.close_start, mapping)
                walk_attrs_only(c)
                continue
            if own_text(c) and has_block(c):
                for t in c.children:
                    if isinstance(t, tuple) and LETTERS.search(t[0]):
                        add('html', t[0], t[1], t[2])
            walk(c, in_unit)

    def walk_attrs_only(n):
        for c in n.children:
            if isinstance(c, Node):
                attrs_of(c)
                walk_attrs_only(c)

    walk(tree.root)
    html_units = sorted([u for u in units if u['kind'] == 'html'], key=lambda u: u['start'])
    seen, attr_units = set(), []
    for u in units:
        if u['kind'] == 'attr' and u['text'] not in seen:
            seen.add(u['text'])
            attr_units.append(u)
    return html_units + attr_units


def from_placeholders(text, mapping):
    def rep(m):
        return mapping.get(m.group(0), m.group(0))
    return re.sub(r'</?[xc]\d+/?>', rep, text)
