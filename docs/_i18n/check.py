"""Checks the language pages of the site. Exit code 1 on any problem.

  python docs/_i18n/check.py

For every language: every unit and script string is translated, the placeholders of each unit
match the English ones, no en or em dash, no AI product or company names, and no English source
sentence is left in the built page (except proper nouns and code, listed in ALLOW).
Also checks the SEO block: canonical, ten hreflang links plus x-default, and valid JSON-LD with
SoftwareApplication, Person and FAQPage.
"""
import html
import json
import os
import re
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import build as B  # noqa: E402

PH = re.compile(r'</?[xc]\d+/?>')
BRANDS = re.compile(r'\b(qwen|ollama|lm studio|llama\.cpp|node-llama|openai|chatgpt|gpt-\d|claude|anthropic|gemini|mistral|deepseek|copilot|hugging ?face|nvidia)\b', re.I)
# English that may stay in any language: names, commands, file names and labels of the app itself.
ALLOW = {
    'hivedesk', 'Hive City', 'Code together', 'Windows, macOS, Linux', 'Alexandre Kohler', 'npx hivedesk', 'Mel',
    'Monsoon', 'Voodoo.js', 'GitHub', 'LinkedIn', 'MIT',
}
# Words that are names in every language: they do not count toward an English sentence.
NAMES = {'hivedesk', 'npx', 'mel', 'dev', 'designer', 'qa', 'writer', 'crew', 'code', 'together', 'hive', 'city', 'github',
         'linkedin', 'windows', 'macos', 'linux', 'alexandre', 'kohler', 'monsoon', 'voodoo', 'js', 'mit', 'ana', 'crumb', 'pr'}


def plain(s):
    s = PH.sub(' ', s)
    return html.unescape(re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', s))).strip()


def page_text(doc):
    doc = re.sub(r'<(script|style)\b[^>]*>.*?</\1>', ' ', doc, flags=re.S | re.I)
    doc = re.sub(r'<(code|kbd|pre)\b[^>]*>.*?</\1>', ' ', doc, flags=re.S | re.I)
    attrs = ' '.join(m.group(1) for m in re.finditer(r'\s(?:alt|aria-label|title|placeholder|data-tip|content)="([^"]*)"', doc))
    return html.unescape(re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', doc) + ' ' + attrs))


def main():
    en = json.load(open(os.path.join(HERE, 'en.json'), encoding='utf-8'))
    units, js = en['units'], en['js']
    problems = []
    # English sentences worth looking for: three words or more, not an allowed name.
    probes = []
    for u in units:
        p = plain(u['text'])
        if p not in ALLOW and len([w for w in re.findall(r"[A-Za-z']+", p) if w.lower() not in NAMES]) >= 3:
            probes.append(p)
    probes += [v for v in js.values() if len(v.split()) >= 3]
    for lang in B.LANGS[1:]:
        path = os.path.join(HERE, f'{lang}.json')
        if not os.path.exists(path):
            problems.append(f'{lang}: no translation file')
            continue
        tr = json.load(open(path, encoding='utf-8'))
        tu, tj = tr.get('units', {}), tr.get('js', {})
        missing = [u['id'] for u in units if u['id'] not in tu]
        if missing:
            problems.append(f'{lang}: {len(missing)} units not translated, for example {missing[:3]}')
        missing_js = [k for k in js if k not in tj]
        if missing_js:
            problems.append(f'{lang}: script strings not translated: {missing_js[:5]}')
        for u in units:
            t = tu.get(u['id'])
            if t is None:
                continue
            if Counter(PH.findall(t)) != Counter(PH.findall(u['text'])):
                problems.append(f'{lang}: placeholders differ in {u["id"]}: {u["text"][:50]!r}')
        for k, t in list(tu.items()) + list(tj.items()):
            if '–' in t or '—' in t:
                problems.append(f'{lang}: dash in {k}')
            if BRANDS.search(t):
                problems.append(f'{lang}: product name in {k}: {BRANDS.search(t).group(0)}')
        page = os.path.join(DOCS, lang, 'index.html')
        if not os.path.exists(page):
            problems.append(f'{lang}: page not built')
            continue
        doc = open(page, encoding='utf-8').read()
        text = page_text(doc)
        left = [p for p in probes if p in text]
        if left:
            problems.append(f'{lang}: {len(left)} English sentences left, for example {left[:3]}')
        m = re.search(r'data-lang-label[^>]*>([^<]*)<', doc)
        if not m or m.group(1) != B.NATIVE[lang]:
            problems.append(f'{lang}: the language button does not name {B.NATIVE[lang]}')
        problems += [f'{lang}: {m}' for m in seo_problems(doc, lang)]
    en_doc = open(os.path.join(DOCS, 'index.html'), encoding='utf-8').read()
    problems += [f'en: {m}' for m in seo_problems(en_doc, 'en')]
    if BRANDS.search(page_text(en_doc)):
        problems.append(f'en: product name: {BRANDS.search(page_text(en_doc)).group(0)}')
    if problems:
        print('\n'.join(problems))
        print(f'\n{len(problems)} problems')
        sys.exit(1)
    print(f'i18n: {len(B.LANGS)} languages, {len(units)} units, {len(probes)} probes, no English left, SEO blocks ok')


def seo_problems(doc, lang):
    out = []
    if doc.count('<h1') != 1:
        out.append(f'{doc.count("<h1")} h1 elements')
    if f'<link rel="canonical" href="{B.url_of(lang)}">' not in doc:
        out.append('canonical missing')
    for l in B.LANGS:
        if f'hreflang="{l}" href="{B.url_of(l)}"' not in doc:
            out.append(f'hreflang {l} missing')
    if 'hreflang="x-default"' not in doc:
        out.append('x-default missing')
    m = re.search(r'<script type="application/ld\+json">\s*(.*?)\s*</script>', doc, re.S)
    if not m:
        return out + ['no JSON-LD']
    try:
        data = json.loads(m.group(1).replace('<\\/', '</'))
    except ValueError as e:
        return out + [f'JSON-LD does not parse: {e}']
    types = {g.get('@type') for g in data.get('@graph', [])}
    for t in ('SoftwareApplication', 'Person', 'FAQPage'):
        if t not in types:
            out.append(f'JSON-LD without {t}')
    app = next((g for g in data['@graph'] if g.get('@type') == 'SoftwareApplication'), {})
    for k in ('name', 'operatingSystem', 'applicationCategory', 'offers', 'downloadUrl', 'softwareVersion'):
        if k not in app:
            out.append(f'SoftwareApplication without {k}')
    faq = next((g for g in data['@graph'] if g.get('@type') == 'FAQPage'), {})
    for q in faq.get('mainEntity', []):
        if not q.get('name') or not q.get('acceptedAnswer', {}).get('text'):
            out.append('FAQ entry without a question or an answer')
    if not re.search(r'<title>[^<]{10,}</title>', doc) or not re.search(r'<meta name="description" content="[^"]{50,}"', doc):
        out.append('title or description missing')
    return out


if __name__ == '__main__':
    main()
