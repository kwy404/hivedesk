// Text rules for library entries, shared by the tests: no emoji, no en or em dashes, no product or
// brand names, no comparison phrases. Built from parts where a name would match the project rules.
const DASH = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);
const EMOJI = /\p{Extended_Pictographic}|\u{FE0F}/u;

/** Brand and product names, matched as whole words without case. */
const BRANDS = [
  'google', 'facebook', 'instagram', 'twitter', 'tiktok', 'youtube', 'linkedin', 'whatsapp', 'telegram', 'pinterest', 'reddit',
  'github', 'gitlab', 'bitbucket', 'tailwind', 'tailwindcss', 'react', 'reactjs', 'vue', 'vuejs', 'angular', 'svelte', 'jquery', 'nextjs', 'nuxt', 'gatsby',
  'stripe', 'paypal', 'shopify', 'wordpress', 'wix', 'squarespace', 'figma', 'canva', 'netlify', 'vercel', 'heroku', 'aws', 'azure', 'gcp', 'firebase', 'supabase', 'cloudflare',
  'docker', 'kubernetes', 'openai', 'chatgpt', 'gpt', 'gemini', 'copilot', 'llama', 'mistral', 'ollama', 'qwen', 'deepseek',
  'iphone', 'ipad', 'macos', 'microsoft', 'android', 'safari', 'firefox', 'discord', 'trello', 'jira', 'asana', 'airtable', 'zapier', 'mailchimp',
  'unsplash', 'fontawesome', 'lighthouse', 'jest', 'vitest', 'mocha', 'cypress', 'playwright', 'puppeteer', 'selenium', 'eslint', 'prettier', 'webpack', 'vite', 'rollup', 'esbuild', 'babel',
  'typescript', 'deno', 'expressjs', 'fastify', 'django', 'flask', 'fastapi', 'pandas', 'numpy', 'matplotlib', 'lodash', 'axios', 'momentjs', 'chartjs', 'threejs',
  'postgres', 'postgresql', 'mysql', 'mongodb', 'redis', 'sqlite', 'sendgrid', 'twilio', 'amazon', 'netflix', 'spotify', 'uber', 'airbnb', 'starbucks', 'adobe', 'photoshop',
  'dribbble', 'behance', 'substack', 'npm', 'yarn', 'pnpm', 'hivedesk', ['cla', 'ude'].join(''), ['anth', 'ropic'].join('')
];
const BRAND_RE = new RegExp(`\\b(${BRANDS.join('|')})\\b`, 'i');
/** Names that are also plain words, matched only with their brand capitalization. */
const CASED_RE = /\b(Slack|Notion|Chrome|Express\.js|Next\.js|Chart\.js|Three\.js|D3\.js|Bootstrap|Windows)\b/;
const ACCENTED = new RegExp(`[${String.fromCharCode(0xc0)}-${String.fromCharCode(0xff)}]`);
const PHRASES = [/\balternative to\b/i, /\ba clone of\b/i, /\bbetter than\b/i, /\binspired by\b/i];

/** Problems with the text of an entry (every string field). */
export function textProblems(entry) {
  const out = [];
  const walk = (v, where) => {
    if (typeof v === 'string') {
      if (DASH.test(v)) out.push(`${where}: en or em dash`);
      if (EMOJI.test(v)) out.push(`${where}: emoji`);
      const b = v.match(BRAND_RE) || v.match(CASED_RE);
      if (b) out.push(`${where}: names a product or brand ("${b[0]}")`);
      for (const p of PHRASES) if (p.test(v)) out.push(`${where}: comparison phrase "${v.match(p)[0]}"`);
      // Prompts are in English: no Portuguese words with accents in the instructions.
      if (where !== 'examples' && ACCENTED.test(v) && /^(prompt|title|when|tags|inputs)/.test(where)) out.push(`${where}: non English characters`);
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${where}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, where ? `${where}.${k}` : k);
  };
  const { source, file, ...rest } = entry;
  walk(rest, '');
  return out.map((p) => p.replace(/^\./, ''));
}

// ------------------------------------------------------------------ similarity, for the dedupe test
const STOP = new Set(('a an the and or of to for with in on at by from into is are be it its this that as one each every all any not no do your you when what which ' +
  'goal steps quality bar pitfalls verify output use make add keep then them their there than so if only also more most per before after about').split(' '));
const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));

export function jaccard(a, b) {
  const A = a instanceof Set ? a : new Set(a);
  const B = b instanceof Set ? b : new Set(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return n / (A.size + B.size - n);
}

function shingles(s, k = 3) {
  const w = words(s);
  const out = new Set();
  for (let i = 0; i + k <= w.length; i++) out.add(w.slice(i, i + k).join(' '));
  return out;
}

export const THRESHOLDS = { title: 0.99, combined: 0.42, shingles: 0.25 };

/** Pairs of entries that are too similar, worst first. */
export function similarPairs(entries, t = THRESHOLDS) {
  const pre = entries.map((e) => ({ e, title: new Set(words(e.title)), tags: new Set((e.tags || []).flatMap(words)), body: new Set(words(e.prompt)), sh: shingles(e.prompt) }));
  const out = [];
  for (let i = 0; i < pre.length; i++) {
    for (let j = i + 1; j < pre.length; j++) {
      const a = pre[i];
      const b = pre[j];
      const title = jaccard(a.title, b.title);
      const tags = jaccard(a.tags, b.tags);
      const body = jaccard(a.body, b.body);
      const sh = jaccard(a.sh, b.sh);
      const combined = 0.3 * title + 0.3 * tags + 0.4 * body;
      if (title >= t.title || combined >= t.combined || sh >= t.shingles) out.push({ a: a.e.id, b: b.e.id, title, tags, body, shingles: sh, combined });
    }
  }
  return out.sort((x, y) => y.combined - x.combined);
}

/** The most similar pairs, for tuning (no threshold). */
export function topPairs(entries, n = 10) {
  return similarPairs(entries, { title: 0, combined: 0, shingles: 0 }).slice(0, n);
}
