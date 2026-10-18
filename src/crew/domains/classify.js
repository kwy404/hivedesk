// Domain detection: a small deterministic classifier (weighted keywords in English and Portuguese plus
// the files already in the workspace) and, when it is not sure, one short model turn with a JSON schema.
// The result carries a reason the user sees ("Mobile app: ..., because the request mentions android").
import { fold, keywordIntent } from '../talk.js';
import { DOMAINS, DOMAIN_IDS } from './index.js';

/** [pattern on the folded text, weight]. Patterns are whole words or short phrases. */
const RULES = {
  mobile: [
    [/\b(android|ios|iphone|ipad|capacitor|cordova|apk|aab|ipa|play store|app store|google play)\b/, 4],
    [/\b(mobile app|phone app|app mobile|aplicativo (movel|mobile|de celular|para celular)|app (de|para) celular|app (no|pro|para o) celular|app nativo|native app)\b/, 5],
    [/\b(aplicativo|app) (android|ios)\b/, 5],
    [/\b(app|aplicativo|application)\b[^.]{0,40}\b(celular|android|ios|iphone|smartphone|phone|phones|telefone)\b/, 4],
    [/\b(mobile|celular|smartphone|telefone|tablet)\b/, 2],
    [/\b(pwa|progressive web app|installable|instalavel|push notifications?|notificacao push)\b/, 2],
    [/\b(react native|flutter|kotlin|swift)\b/, 3]
  ],
  desktop: [
    [/\b(desktop app|desktop application|app desktop|aplicativo (de )?desktop|programa (de|para) (computador|pc|desktop)|aplicativo para (pc|computador|windows|mac|linux))\b/, 5],
    [/\b(neutralino|neutralinojs|electron|tauri|exe|installer|instalador|system tray|bandeja do sistema)\b/, 4],
    [/\b(desktop|windows app|mac app|linux app|programa para windows|janela nativa|native window)\b/, 3]
  ],
  backend: [
    [/\b(backend|back end|rest api|api rest|graphql|http api|json api|web api|microservice|microsservico|servidor http|http server)\b/, 5],
    [/\b(api|endpoint|endpoints|rota|rotas|route|routes|crud api|webhook|webhooks)\b/, 3],
    [/\b(server|servidor|database|banco de dados|sql|sqlite|postgres|mysql|mongodb|redis|express|fastify|node server|jwt|auth server|autenticacao)\b/, 2]
  ],
  cli: [
    [/\b(cli|command line|linha de comando|terminal tool|ferramenta de terminal|comando de terminal|command line tool)\b/, 5],
    [/\b(flags?|argv|arguments?|argumentos|stdin|stdout|shell script|script de terminal|bin script)\b/, 2],
    [/\b(terminal|console)\b/, 1]
  ],
  extension: [
    [/\b(browser extension|chrome extension|firefox extension|extensao (do|para o|de) (chrome|navegador|firefox|edge)|extensao de navegador|web extension|addon|add on|plugin (do|para o) (chrome|navegador))\b/, 6],
    [/\b(manifest v3|manifest_version|content script|popup da extensao|extension popup)\b/, 4],
    [/\b(extensao|extension)\b/, 2]
  ],
  game: [
    [/\b(game|games|jogo|jogos|joguinho|platformer|plataforma 2d|shooter|puzzle|arcade|rpg|roguelike|tetris|snake|pong|breakout|flappy|tower defense|sprite|sprites|canvas game|jogo de navegador)\b/, 4],
    [/\b(score|pontuacao|level|levels|fase|fases|player|jogador|enemy|enemies|inimigos?|high score|recorde)\b/, 1.5]
  ],
  data: [
    [/\b(csv|xlsx|excel|spreadsheet|planilha|etl|dataset|data set|conjunto de dados|data analysis|analise de dados|data script|script de dados|scraper|scraping|raspagem|parquet|jupyter|notebook)\b/, 4],
    [/\b(data|dados|report|relatorio|statistics|estatisticas|aggregate|agregar|sum|soma|average|media|chart from|grafico de|parse|converter|convert|json to csv|csv to json)\b/, 1.5],
    [/\b(python|pandas|numpy|script)\b/, 1]
  ],
  security: [
    [/\b(security audit|auditoria de seguranca|audit|auditar|audite|pentest|pen test|vulnerabilit(y|ies)|vulnerabilidades?|security review|revisao de seguranca|owasp|cve|cves)\b/, 5],
    [/\b(secrets?|segredos?|leaked|vazad[oa]s?|api keys? exposed|chaves? expostas?|xss|sql injection|injecao de sql|csrf|ssrf|hardening)\b/, 3],
    [/\b(security|seguranca|seguro|secure|safe|inseguro|insecure)\b/, 1.5]
  ],
  devops: [
    [/\b(dockerfile|docker|docker compose|compose file|kubernetes|k8s|helm|terraform|ansible|ci cd|ci\/cd|pipeline|github actions|gitlab ci|workflow yaml|systemd|nginx|deploy|deployment|implantacao|containeriz\w*|container)\b/, 4],
    [/\b(ci|cd|devops|infra|infrastructure|infraestrutura|server setup|monitoring|monitoramento|backup|backups|cron)\b/, 2]
  ],
  web: [
    [/\b(website|web site|site|sites|landing ?page|pagina|paginas|webpage|web page|homepage|portfolio|blog|loja virtual|online store|html|css)\b/, 3],
    [/\b(web app|aplicacao web|app web|frontend|front end|dashboard|painel|formulario|form)\b/, 2]
  ]
};

/** Files that say which domain an existing project is. */
const FILE_SIGNALS = [
  [/(^|\/)capacitor\.config\.(json|ts|js)$/, 'mobile', 6],
  [/(^|\/)(android|ios)\/.+/, 'mobile', 3],
  [/(^|\/)neutralino\.config\.json$/, 'desktop', 6],
  [/(^|\/)(Dockerfile|Containerfile|docker-compose\.ya?ml|compose\.ya?ml)$/, 'devops', 2],
  [/(^|\/)\.github\/workflows\/.+\.ya?ml$/, 'devops', 1],
  [/(^|\/)(server|app)\.(m?js|ts)$|(^|\/)routes\//, 'backend', 1.5],
  [/(^|\/)bin\/[\w.-]+$/, 'cli', 1.5],
  [/\.csv$/, 'data', 1.5]
];

/**
 * The keyword classifier.
 * @param {string} text the request (and the brief)
 * @param {{ files?: string[], manifest?: any }} [ctx] files of the workspace; manifest: a parsed manifest.json
 * @returns {{ domain: string, confidence: 'high' | 'low', score: number, scores: Record<string, number>, words: string[], files: string[], intent: string | null }}
 */
export function classifyDomain(text, ctx = {}) {
  const f = ` ${fold(text).replace(/\?/g, ' ')} `;
  const scores = Object.fromEntries(DOMAIN_IDS.filter((d) => d !== 'chat').map((d) => [d, 0]));
  const words = {};
  for (const [domain, rules] of Object.entries(RULES)) {
    for (const [re, w] of rules) {
      const g = new RegExp(re.source, 'g');
      for (const m of f.matchAll(g)) {
        scores[domain] += w;
        (words[domain] ||= new Set()).add(m[0].trim());
      }
    }
  }
  const fileHits = {};
  for (const p of ctx.files || []) {
    for (const [re, domain, w] of FILE_SIGNALS) {
      if (!re.test(p)) continue;
      if (!(fileHits[domain] ||= new Set()).has(p)) { fileHits[domain].add(p); scores[domain] += w; }
    }
  }
  if (ctx.manifest && ctx.manifest.manifest_version) { scores.extension += 6; (fileHits.extension ||= new Set()).add('manifest.json'); }
  // "Audit my project" with files present: the files are the thing to audit.
  if (scores.security >= 5 && (ctx.files || []).length) scores.security += 2;
  // "Create an API for my mobile app": the thing built is named first by a build word; the platform word
  // of the client loses weight when the request is clearly about a server.
  if (scores.backend >= 5 && scores.mobile > 0 && !/\b(app|aplicativo)\b[^.]*\b(android|ios|celular|mobile)\b/.test(f.split(/\b(api|backend)\b/)[0] || '')) scores.mobile *= 0.5;
  // A game on a phone is still a game; a site about games is still a site.
  if (scores.game >= 4 && scores.mobile > 0 && scores.mobile < 5) scores.mobile *= 0.5;
  if (scores.web > 0 && scores.game > 0 && /\b(site|website|pagina|landing)\b/.test(f) && !/\b(jogo|game)\b[^.]{0,20}\b(de|in|no|for)\b[^.]{0,12}\b(navegador|browser)\b/.test(f)) scores.game *= 0.6;
  const kw = keywordIntent(text);
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [top, best] = ranked[0];
  const second = ranked[1]?.[1] || 0;
  // Questions and small talk with no build word: a chat answer, no job.
  if ((kw.intent === 'question' || kw.intent === 'chat') && kw.strong) {
    return { domain: 'chat', confidence: 'high', score: 0, scores, words: [], files: [], intent: kw.intent, topic: best > 0 ? top : null };
  }
  // One weak word ("script", "celular") does not make a project another kind: below 3 it stays a website.
  if (best < 3) {
    return { domain: 'web', confidence: 'low', score: best, scores, words: [], files: [], intent: kw.intent, fallback: true };
  }
  const confidence = best >= 4 && best >= second * 1.6 ? 'high' : 'low';
  return { domain: top, confidence, score: best, scores, words: [...(words[top] || [])].slice(0, 4), files: [...(fileHits[top] || [])].slice(0, 3), intent: kw.intent };
}

export const DOMAIN_SCHEMA = {
  type: 'object',
  properties: {
    domain: { type: 'string', enum: DOMAIN_IDS.filter((d) => d !== 'chat') },
    confidence: { type: 'string', enum: ['high', 'low'] }
  },
  required: ['domain', 'confidence'],
  additionalProperties: false
};

export function domainMessages(text, files = []) {
  const list = DOMAIN_IDS.filter((d) => d !== 'chat').map((d) => `- ${d}: ${DOMAINS[d].label}, ${DOMAINS[d].stack}`).join('\n');
  return [
    { role: 'system', content: `You sort a request for a crew that builds software into one kind of project.\n${list}\nPick what the user wants built (an API for a phone app is backend; a game for phones is game). confidence is "low" when two kinds fit. Answer with one JSON object.` },
    { role: 'user', content: `Request: ${String(text).slice(0, 1500)}${files.length ? `\nFiles already in the project: ${files.slice(0, 30).join(', ')}` : ''}` }
  ];
}

/**
 * Keywords and the model together: sure keywords win; otherwise a confident model wins; otherwise
 * the keyword guess stays (low confidence, which can make the planner ask).
 */
export function decideDomain(model, kw) {
  const m = model && DOMAIN_IDS.includes(model.domain) && model.domain !== 'chat' ? model : null;
  if (kw.domain === 'chat') return { ...kw, source: 'keywords' };
  if (kw.confidence === 'high' || !m) return { ...kw, source: 'keywords' };
  if (m.domain === kw.domain) return { ...kw, confidence: 'high', source: 'both' };
  if (m.confidence === 'high') return { ...kw, domain: m.domain, confidence: kw.score > 0 && (kw.scores?.[m.domain] || 0) === 0 ? 'low' : 'high', words: [], files: [], source: 'model' };
  return { ...kw, source: 'keywords' };
}

/**
 * Classifies a request: keywords first, one short model turn only when they are not sure.
 * @param {{ text: string, files?: string[], manifest?: any, ask?: (messages: any[], schema: any) => Promise<any> }} input
 */
export async function detectDomain({ text, files = [], manifest, ask }) {
  const kw = classifyDomain(text, { files, manifest });
  // The model only settles a real doubt between kinds the keywords saw; with no hint at all the question card asks.
  if (kw.confidence === 'high' || kw.fallback || kw.domain === 'chat' || typeof ask !== 'function') return { ...kw, source: 'keywords' };
  let model = null;
  try { model = await ask(domainMessages(text, files), DOMAIN_SCHEMA); } catch { model = null; }
  return decideDomain(model, kw);
}

/** The why of a classification, as data for the i18n line (domains.reason). */
export function reasonOf(result) {
  if (result.source === 'answer') return { kind: 'answer' };
  if (result.source === 'model') return { kind: 'model' };
  if (result.words?.length) return { kind: 'words', words: result.words };
  if (result.files?.length) return { kind: 'files', files: result.files };
  return { kind: 'default' };
}
