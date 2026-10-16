// Plain language to a structured GitHub or changelog intent, in English and Portuguese.
// Mel asks the model with a JSON schema when one is ready; these keyword rules are the
// fallback and the gate that decides whether a chat message is meant for GitHub at all.

export const INTENTS = [
  'connect', 'disconnect', 'status', 'list_repos', 'clone', 'create_repo', 'branch',
  'commit', 'push', 'commit_push', 'open_pr', 'pr_status', 'show_changelog', 'show_activity', 'none'
];

export const INTENT_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: INTENTS },
    name: { type: 'string', maxLength: 100 },
    private: { type: 'boolean' },
    repo: { type: 'string', maxLength: 200 },
    branch: { type: 'string', maxLength: 100 },
    message: { type: 'string', maxLength: 500 }
  },
  required: ['intent']
};

/** Lower case without accents, so "repositório" and "repositorio" match the same rule. */
export function fold(text) {
  return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const GATE = /\b(github|git|repos?|repositori\w*|repository|repositories|commit\w*|push\w*|pull ?requests?|pr|prs|branch\w*|changelog|clon\w*|merge request)\b/;

/** True when the text is likely a GitHub, git or changelog request (used to filter chat). */
export function looksLikeGitIntent(text) {
  return GATE.test(fold(text));
}

const has = (t, re) => re.test(t);
const SHOW = /\b(ver|veja|mostr\w*|exib\w*|abr\w*|show|open|view|see|display|read|leia|ler)\b/;
const CREATE = /\b(cri\w*|create|new|novo|nova|make|faca|fazer|gera\w*|start|inici\w*|set ?up)\b/;

/**
 * Keyword rules. Returns { intent, ...fields, confidence }.
 * @param {string} text
 */
export function parseRules(text) {
  const raw = String(text || '').trim();
  const t = fold(raw);
  const out = { intent: 'none', confidence: 0 };
  if (!t) return out;
  const set = (intent, extra = {}) => Object.assign(out, { intent, confidence: 0.8 }, extra);

  const repoWord = /\b(repos?|repositori\w*|repository|repositories)\b/;
  const priv = /\b(privad\w*|private|secret\w*|fechad\w*)\b/.test(t) ? true : /\b(public\w*|aberto|aberta|open source)\b/.test(t) ? false : undefined;

  if (has(t, /\b(changelog|registro de mudancas|historico de (mudancas|versoes)|release notes|notas de versao)\b/) && !has(t, /\bcommit\w*\b/)) {
    return set('show_changelog');
  }
  if (has(t, /\b(activity|atividade\w*|quem fez|who did|log de atividade|activity log)\b/)) return set('show_activity');
  if (has(t, /\b(desconect\w*|disconnect|sign ?out|log ?out|sair do github|esquec\w* (o |meu )?(token|github))\b/)) return set('disconnect');
  if (has(t, /\b(conect\w*|connect\w*|log ?in|sign ?in|entr\w* no|link\w*|vincul\w*|ligar?)\b/) && has(t, /\bgithub\b/)) return set('connect');

  if (has(t, /\bclon\w*\b/)) {
    const repo = extractRepo(raw);
    return set('clone', repo ? { repo } : { confidence: 0.6 });
  }
  if (has(t, repoWord) && has(t, CREATE)) {
    const name = extractName(raw);
    return set('create_repo', { ...(name ? { name } : {}), ...(priv !== undefined ? { private: priv } : {}) });
  }
  if (has(t, /\b(pull ?requests?|prs?|merge requests?)\b/)) {
    if (has(t, /\b(status|ci|checks?|testes?|tests?|passou|passed|como (esta|vai)|how is|state)\b/) && !has(t, CREATE) && !has(t, /\b(abr\w*|open)\b/)) return set('pr_status');
    return set('open_pr');
  }
  const commit = has(t, /\b(commit\w*|comit\w*)\b/);
  const push = has(t, /\b(push\w*|envi\w* (para|pro|ao) (o )?(github|remoto|origin)|sub\w* (para|pro) (o )?github|upload)\b/);
  if (commit && push) return set('commit_push', msgOf(raw));
  if (commit) return set('commit', msgOf(raw));
  if (push) return set('push');
  if (has(t, /\b(branch\w*|ramo|ramifica\w*)\b/)) {
    const name = extractBranch(raw);
    return set('branch', name ? { branch: name } : {});
  }
  if (has(t, repoWord) && has(t, /\b(list\w*|mostr\w*|show|ver|veja|meus|minhas|my|search|busc\w*|procur\w*|encontr\w*|find)\b/)) {
    const q = /\b(?:busc\w*|procur\w*|search|find|encontr\w*)\s+(?:por\s+|for\s+)?["']?([\w.-]{2,})/i.exec(raw);
    return set('list_repos', q ? { query: q[1] } : {});
  }
  if (has(t, /\bgithub\b/) && has(t, /\b(status|conta|account|quem sou|who am i|estado)\b/)) return set('status');
  if (has(t, /\bgithub\b/) && has(t, SHOW)) return set('status', { confidence: 0.5 });
  return out;
}

const NAME_RE = /(?:chamad[oa]|com o nome(?: de)?|de nome|nomead[oa]|named|called|name it|name)\s+["'`]?([A-Za-z0-9][\w.-]{0,99})/i;

export function extractName(text) {
  const m = NAME_RE.exec(String(text));
  if (m) return cleanRepoName(m[1]);
  const q = /["'`]([A-Za-z0-9][\w.-]{0,99})["'`]/.exec(String(text));
  if (q) return cleanRepoName(q[1]);
  const after = /\b(?:repos?|reposit[oó]rios?|repository)\s+(?:(?:privad[oa]|p[uú]blic[oa]|private|public)\s+)?([A-Za-z0-9][\w.-]{0,99})\s*$/i.exec(String(text).trim());
  if (after && !/^(privad|public|private|novo|nova|new|para|for|on|no|in|chamad)/i.test(after[1])) return cleanRepoName(after[1]);
  return null;
}

export function cleanRepoName(s) {
  const n = String(s || '').trim().replace(/[.,;:!?]+$/, '').replace(/[^\w.-]/g, '-').slice(0, 100);
  return /^[A-Za-z0-9._-]+$/.test(n) && n !== '.' && n !== '..' ? n : null;
}

export function extractRepo(text) {
  const s = String(text);
  const url = /https?:\/\/[^\s/]+\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[\s/#?]|$)/i.exec(s);
  if (url) return `${url[1]}/${url[2]}`;
  const full = /\b([A-Za-z0-9][\w-]{0,38})\/([\w.-]{1,100})\b/.exec(s);
  if (full) return `${full[1]}/${full[2].replace(/\.git$/, '')}`;
  const name = extractName(s) || /\bclon\w*\s+(?:o\s+|the\s+|meu\s+|my\s+)?(?:repo\w*\s+)?["'`]?([A-Za-z0-9][\w.-]{0,99})/i.exec(s)?.[1];
  const n = cleanRepoName(name);
  return n && !/^(repo\w*|um|uma|a|the|meu|my)$/i.test(n) ? n : null;
}

export function extractBranch(text) {
  const m = /(?:branch|ramo)\s+(?:chamad[oa]\s+|named\s+|called\s+)?["'`]?([A-Za-z0-9][\w./-]{0,99})/i.exec(String(text));
  if (!m) return null;
  const b = m[1].replace(/[.,;:!?]+$/, '');
  return /^(para|for|pra|nova|novo|new|um|uma|a|the|de|do|da)$/i.test(b) ? null : b;
}

function msgOf(raw) {
  const m = /(?:mensagem|message|msg)\s*[:=]?\s*["'`](.+?)["'`]/i.exec(raw);
  return m ? { message: m[1].slice(0, 500) } : {};
}

/**
 * Parses with the model when `ask` is given (ask(messages, schema) resolves to JSON or null),
 * falling back to the rules. The model never decides alone: unknown or empty answers use the rules.
 * @param {string} text
 * @param {{ ask?: (messages: any[], schema: object) => Promise<any> }} [opts]
 */
export async function parseIntent(text, opts = {}) {
  const rules = parseRules(text);
  if (!opts.ask) return { ...rules, by: 'rules' };
  let json = null;
  try {
    json = await opts.ask([
      { role: 'system', content: `You turn a request about GitHub, git or the project changelog into JSON. Intents: ${INTENTS.join(', ')}. Use "none" when the request is about something else. "name" is a new repository name, "repo" is owner/name to clone, "private" is true for a private repository and false for a public one; leave fields out when the request does not say. The request may be in Portuguese or English.` },
      { role: 'user', content: String(text).slice(0, 1000) }
    ], INTENT_SCHEMA);
  } catch { json = null; }
  if (!json || !INTENTS.includes(json.intent) || json.intent === 'none') return { ...rules, by: 'rules' };
  const out = { intent: json.intent, confidence: 0.9, by: 'model' };
  const name = cleanRepoName(json.name) || rules.name;
  if (name) out.name = name;
  if (typeof json.private === 'boolean') out.private = json.private;
  else if (rules.private !== undefined) out.private = rules.private;
  if (json.repo || rules.repo) out.repo = String(json.repo || rules.repo).trim();
  if (json.branch || rules.branch) out.branch = String(json.branch || rules.branch).trim();
  if (json.message || rules.message) out.message = String(json.message || rules.message).trim();
  return out;
}
