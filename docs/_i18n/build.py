"""Builds the language pages of the site from docs/index.html (the English source).

  python docs/_i18n/build.py --export   writes docs/_i18n/en.json, the strings to translate
  python docs/_i18n/build.py            writes docs/<lang>/index.html for the 9 other languages,
                                        the SEO block of every page, sitemap.xml and robots.txt

Translations live in docs/_i18n/<lang>.json as {"units": {id: text}, "js": {key: text}}.
A unit missing from a translation stays in English and docs/_i18n/check.py reports it.
Standard library only.
"""
import html
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import units as U  # noqa: E402

BASE = 'https://kwy404.github.io/hivedesk/'
LANGS = ['en', 'pt-BR', 'es', 'fr', 'de', 'it', 'ja', 'ko', 'zh-Hans', 'ru']
LOCALE = {'en': 'en_US', 'pt-BR': 'pt_BR', 'es': 'es_ES', 'fr': 'fr_FR', 'de': 'de_DE', 'it': 'it_IT', 'ja': 'ja_JP', 'ko': 'ko_KR', 'zh-Hans': 'zh_CN', 'ru': 'ru_RU'}
VERSION = json.load(open(os.path.join(os.path.dirname(DOCS), 'package.json'), encoding='utf-8'))['version']
NATIVE = {'en': 'English', 'pt-BR': 'Português', 'es': 'Español', 'fr': 'Français', 'de': 'Deutsch', 'it': 'Italiano', 'ja': '日本語', 'ko': '한국어', 'zh-Hans': '简体中文', 'ru': 'Русский'}
LANG_WORD = {'en': 'Language', 'pt-BR': 'Idioma', 'es': 'Idioma', 'fr': 'Langue', 'de': 'Sprache', 'it': 'Lingua', 'ja': '言語', 'ko': '언어', 'zh-Hans': '语言', 'ru': 'Язык'}
ATTR_NAMES = '|'.join(re.escape(a) for a in U.ATTRS + ('content',))


def read(p):
    with open(p, encoding='utf-8') as f:
        return f.read()


def write(p, s):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'w', encoding='utf-8', newline='\n') as f:
        f.write(s)


def js_strings():
    """English strings of site.js: t('key', 'text') and P('key', 'text') (P adds the try.plan. prefix)."""
    src = read(os.path.join(DOCS, 'assets', 'site.js'))
    out = {}
    for m in re.finditer(r"\b([tP])\('([\w.]+)', '((?:[^'\\]|\\.)*)'\)", src):
        key = m.group(2) if m.group(1) == 't' else 'try.plan.' + m.group(2)
        out[key] = m.group(3).replace("\\'", "'")
    return out


def url_of(lang):
    return BASE if lang == 'en' else f'{BASE}{lang}/'


def plain(s):
    return html.unescape(re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', s))).strip()


def seo_block(doc, lang):
    """Canonical, hreflang alternates, Open Graph locale and JSON-LD for one page."""
    title = plain(re.search(r'<title>(.*?)</title>', doc, re.S).group(1))
    desc = html.unescape(re.search(r'<meta name="description" content="([^"]*)"', doc).group(1))
    lines = [f'<link rel="canonical" href="{url_of(lang)}">']
    for l in LANGS:
        lines.append(f'<link rel="alternate" hreflang="{l}" href="{url_of(l)}">')
    lines.append(f'<link rel="alternate" hreflang="x-default" href="{BASE}">')
    lines.append(f'<meta property="og:url" content="{url_of(lang)}">')
    lines.append(f'<meta property="og:locale" content="{LOCALE[lang]}">')
    for l in LANGS:
        if l != lang:
            lines.append(f'<meta property="og:locale:alternate" content="{LOCALE[l]}">')
    faq = []
    for q, a in re.findall(r'<summary class="collapse-title">(.*?)</summary><div class="collapse-content">(.*?)</div></details>', doc, re.S):
        faq.append({'@type': 'Question', 'name': plain(q), 'acceptedAnswer': {'@type': 'Answer', 'text': plain(a)}})
    graph = [
        {'@type': 'SoftwareApplication', '@id': BASE + '#app', 'name': 'hivedesk', 'url': url_of(lang), 'description': desc,
         'inLanguage': lang, 'applicationCategory': 'DeveloperApplication', 'operatingSystem': 'Windows, macOS, Linux',
         'softwareVersion': VERSION, 'license': 'https://opensource.org/licenses/MIT', 'isAccessibleForFree': True,
         'downloadUrl': 'https://github.com/kwy404/hivedesk/releases/latest', 'installUrl': 'https://www.npmjs.com/package/hivedesk',
         'image': BASE + 'og.png', 'screenshot': BASE + 'assets/shots/city-overview.webp',
         'offers': {'@type': 'Offer', 'price': '0', 'priceCurrency': 'USD'}, 'author': {'@id': BASE + '#author'}},
        {'@type': 'Person', '@id': BASE + '#author', 'name': 'Alexandre Kohler', 'url': 'https://github.com/kwy404',
         'sameAs': ['https://github.com/kwy404', 'https://www.linkedin.com/in/alexandre-silva-173687256/']},
        {'@type': 'WebPage', '@id': url_of(lang) + '#page', 'url': url_of(lang), 'name': title, 'description': desc, 'inLanguage': lang,
         'isPartOf': {'@type': 'WebSite', 'name': 'hivedesk', 'url': BASE}, 'about': {'@id': BASE + '#app'}},
    ]
    if faq:
        graph.append({'@type': 'FAQPage', '@id': url_of(lang) + '#faq', 'inLanguage': lang, 'mainEntity': faq})
    ld = json.dumps({'@context': 'https://schema.org', '@graph': graph}, ensure_ascii=False, indent=1).replace('</', '<\\/')
    lines.append(f'<script type="application/ld+json">\n{ld}\n</script>')
    return '<!-- seo:start -->\n' + '\n'.join(lines) + '\n<!-- seo:end -->'


def with_seo(doc, lang):
    return re.sub(r'<!-- seo:start -->.*?<!-- seo:end -->', lambda m: seo_block(doc, lang), doc, count=1, flags=re.S)


def hero_h1(sentence):
    parts = [p.strip() for p in re.split(r'(?<=[.。!！?？])\s*', sentence) if p.strip()]
    if len(parts) > 2:
        parts = [parts[0], ' '.join(parts[1:])]
    out, n = [], 0
    for k, line in enumerate(parts):
        if k:
            out.append('<br>')
        words = line.split(' ')
        spans = []
        for w in words:
            spans.append(f'<span class="w{" hl" if k else ""}" style="--i:{n}" aria-hidden="true">{html.escape(w, quote=False)}</span>')
            n += 1
        out.append(' '.join(spans))
    longest = max(len(p) for p in parts)
    return ''.join(out), longest > 20


def localize(src, lang, tr):
    found = U.find_units(src)
    doc = src
    tu = tr.get('units', {})
    # 1. html units, from the end so the offsets stay valid
    for u in sorted([x for x in found if x['kind'] == 'html'], key=lambda x: -x['start']):
        t = tu.get(u['id'])
        if t is None:
            continue
        doc = doc[:u['start']] + U.from_placeholders(t, u['map']) + doc[u['end']:]
    # 2. attributes, by value
    for u in [x for x in found if x['kind'] == 'attr']:
        t = tu.get(u['id'])
        if t is None:
            continue
        doc = re.sub(r'(\s(?:' + ATTR_NAMES + r')=")' + re.escape(u['text']) + '"', lambda m: m.group(1) + t.replace('"', '&quot;') + '"', doc)
    # 3. the hero headline, from its translated aria-label
    m = re.search(r'(<h1 id="hero-h" class="display)([^"]*)(" aria-label=")([^"]*)("[^>]*>)(.*?)(</h1>)', doc, re.S)
    if m:
        inner, long_ = hero_h1(html.unescape(m.group(4)))
        cls = m.group(2).replace(' display-long', '') + (' display-long' if long_ else '')
        doc = doc[:m.start()] + m.group(1) + cls + m.group(3) + m.group(4) + m.group(5) + '\n      ' + inner + '\n    ' + m.group(7) + doc[m.end():]
    # 4. language, paths, strings for the script
    doc = doc.replace('<html lang="en"', f'<html lang="{lang}"', 1)
    doc = re.sub(r'(\s(?:src|href|poster)=")(?=(?:assets/|media/|download/|lend/|favicon\.svg|og\.png))', r'\1../', doc)
    doc = doc.replace('href="./"', 'href="../"')
    # the language button names the page's language in that language
    doc = re.sub(r'(<span class="lang-cur" data-lang-label>)[^<]*(</span>)', lambda m: m.group(1) + NATIVE[lang] + m.group(2), doc, count=1)
    doc = re.sub(r'(<button id="lang-btn" class="lang-btn" type="button" aria-label=")[^"]*', lambda m: m.group(1) + f'{LANG_WORD[lang]}: {NATIVE[lang]}', doc, count=1)
    js = {k: v for k, v in tr.get('js', {}).items()}
    doc = doc.replace('</body>', '<script type="application/json" id="hd-t">' + json.dumps(js, ensure_ascii=False).replace('</', '<\\/') + '</script>\n</body>', 1)
    return with_seo(doc, lang)


def sitemap():
    rows = []
    for lang in LANGS:
        alts = '\n'.join(f'    <xhtml:link rel="alternate" hreflang="{l}" href="{url_of(l)}"/>' for l in LANGS)
        rows.append(f'  <url>\n    <loc>{url_of(lang)}</loc>\n{alts}\n    <xhtml:link rel="alternate" hreflang="x-default" href="{BASE}"/>\n    <changefreq>weekly</changefreq>\n    <priority>{"1.0" if lang == "en" else "0.9"}</priority>\n  </url>')
    return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' + '\n'.join(rows) + '\n</urlset>\n'


def main():
    src = read(os.path.join(DOCS, 'index.html'))
    if '--export' in sys.argv:
        found = U.find_units(src)
        seen, items = set(), []
        for u in found:
            if u['id'] in seen:
                continue
            seen.add(u['id'])
            items.append({'id': u['id'], 'kind': u['kind'], 'text': u['text']})
        write(os.path.join(HERE, 'en.json'), json.dumps({'units': items, 'js': js_strings()}, ensure_ascii=False, indent=1) + '\n')
        print(f'en.json: {len(items)} units, {len(js_strings())} script strings')
        return
    write(os.path.join(DOCS, 'index.html'), with_seo(src, 'en'))
    for lang in LANGS[1:]:
        p = os.path.join(HERE, f'{lang}.json')
        tr = json.loads(read(p)) if os.path.exists(p) else {}
        write(os.path.join(DOCS, lang, 'index.html'), localize(src, lang, tr))
    write(os.path.join(DOCS, 'sitemap.xml'), sitemap())
    write(os.path.join(DOCS, 'robots.txt'), f'User-agent: *\nAllow: /\nDisallow: /_i18n/\nSitemap: {BASE}sitemap.xml\n')
    print('built', ', '.join(LANGS))


if __name__ == '__main__':
    main()
