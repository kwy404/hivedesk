// What the user writes to the crew outside the top bar (#general, a worker's direct chat, the voice
// orb): a build or change request starts a job, a question or small talk gets a real answer from the
// model, in the user's language and in the voice of the worker who was asked.
import { raw, languageName } from './say.js';
import { classifyDomain } from './domains/classify.js';
import { EXPERTISE } from './prompts/roles.js';

/** The field a question is about (mobile, backend, security...), from the domain keywords; null for small talk. */
export function topicOf(text) {
  const c = classifyDomain(text);
  const t = c.domain === 'chat' ? c.topic : c.domain;
  return t && EXPERTISE[t] && (c.domain !== 'chat' || (c.scores?.[t] || 0) >= 3) ? t : null;
}

export const INTENT_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: ['request', 'question', 'chat'] },
    confidence: { type: 'string', enum: ['high', 'low'] }
  },
  required: ['intent', 'confidence'],
  additionalProperties: false
};

/** Lower case, no accents, punctuation as spaces. */
export function fold(text) {
  return String(text || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}?]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

// Build and change verbs in Portuguese and English (the voice lexicon of the user's language adds its own).
const VERBS = [
  'crie', 'cria', 'criar', 'crio', 'faca', 'faz', 'fazer', 'gere', 'gera', 'gerar', 'monte', 'montar', 'construa', 'construir', 'desenvolva', 'desenvolver',
  'adicione', 'adiciona', 'adicionar', 'coloque', 'coloca', 'colocar', 'ponha', 'bote', 'inclua', 'mude', 'muda', 'mudar', 'altere', 'altera', 'alterar',
  'troque', 'troca', 'trocar', 'corrija', 'corrige', 'corrigir', 'conserte', 'arrume', 'arruma', 'ajuste', 'ajusta', 'implemente', 'implementa', 'escreva',
  'escreve', 'escrever', 'remova', 'remove', 'remover', 'tire', 'apague', 'atualize', 'atualiza', 'melhore', 'melhora', 'refatore', 'traduza', 'desenhe', 'programe',
  'create', 'make', 'build', 'generate', 'write', 'add', 'change', 'fix', 'update', 'implement', 'remove', 'delete', 'design', 'refactor', 'improve', 'rewrite',
  'translate', 'replace', 'rename', 'turn', 'set', 'put', 'code'
];
// "Quero um site", "I need a page": a wish for something built.
const WANT = /^(?:eu )?(?:quero|queria|preciso|gostaria|i want|i d like|i would like|i need|we need|let s|vamos)\b/;
// "Pode criar...", "can you make...": a polite request, not a question.
const POLITE = /^(?:voce |vc |tu )?(?:pode|poderia|podes|consegue|da pra|can you|could you|would you|will you|please)\b/;
const THINGS = /\b(?:site|sites|pagina|paginas|page|pages|landing|landingpage|app|apps|aplicativo|aplicacao|botao|button|formulario|form|menu|header|footer|rodape|cabecalho|secao|section|arquivo|arquivos|file|files|html|css|js|javascript|script|jogo|game|api|readme|tema|theme|cor|cores|color|colors|layout|logo|imagem|image|galeria|gallery|tabela|table|lista|list|todo|calculadora|calculator|portfolio|blog|loja|store|shop|dashboard|painel|componente|component|funcao|function|estilo|style|fonte|font|titulo|title|texto|text)\b/;
const QUESTION = /^(?:o que|oque|que|como|por que|porque|pq|quando|onde|qual|quais|quem|quanto|quantos|quantas|sera|e possivel|what|how|why|when|where|which|who|whose|is|are|was|were|do|does|did|have|has|should|qu est ce|que es|cual|wie|was|warum|cosa|come|perche)\b/;
const CHAT = /^(?:oi|ola|opa|e ai|eai|bom dia|boa tarde|boa noite|tudo bem|tudo bom|beleza|blz|valeu|obrigad[oa]|brigad[oa]|vlw|tchau|ate mais|legal|show|massa|top|ok|okay|certo|entendi|hi|hello|hey|yo|good morning|good evening|good night|thanks|thank you|thx|cool|nice|great|bye|see you|lol|haha|kkk+|hola|gracias|bonjour|merci|hallo|danke|ciao|grazie)\b/;

function lexicon(lang) {
  const out = new Set(VERBS);
  for (const code of new Set([lang, 'en', 'pt-BR'])) {
    for (const w of String(raw(code, 'voice.lex.build') || '').split('|')) { const f = fold(w); if (f) out.add(f); }
  }
  return out;
}

/** The task prefixes the desktop writes ("Task: ", "Nova tarefa para Dev: "): an explicit request. */
function taskPrefix(text, lang) {
  const s = String(text || '').trim();
  for (const code of new Set([lang, 'en', 'pt-BR'])) {
    const p = String(raw(code, 'worker.taskPrefix') || '').trim();
    if (p && s.toLowerCase().startsWith(p.toLowerCase())) return s.slice(p.length).trim();
    const tpl = String(raw(code, 'actions.newTask') || '');
    const i = tpl.indexOf('{text}');
    const head = tpl.slice(0, tpl.indexOf('{name}'));
    if (i > 0 && head && s.toLowerCase().startsWith(head.toLowerCase())) {
      const colon = s.indexOf(':', head.length);
      if (colon > 0) return s.slice(colon + 1).trim();
    }
  }
  return null;
}

/**
 * Keyword rules for Portuguese and English (and the build words of the user's language).
 * @returns {{ intent: 'request'|'question'|'chat'|null, strong: boolean, request: string }}
 *   intent null: the rules cannot tell. strong: sure enough to win over a model that disagrees.
 */
export function keywordIntent(text, lang = 'en') {
  const original = String(text || '').trim().replace(/^>[^\n]*\n/, '').trim();
  const task = taskPrefix(original, lang);
  if (task) return { intent: 'request', strong: true, request: task };
  const f = fold(original);
  const words = f.replace(/\?/g, ' ').split(' ').filter(Boolean);
  const out = (intent, strong) => ({ intent, strong, request: original });
  if (!words.length) return out('chat', true);
  const verbs = lexicon(lang);
  const head = words.slice(0, 4);
  const startsWithVerb = verbs.has(words[0]) || (POLITE.test(f) && head.some((w) => verbs.has(w))) || (/^(por favor|please|pls|pfv)\b/.test(f) && verbs.has(words[words[0] === 'por' ? 2 : 1]));
  const anyVerb = words.some((w) => verbs.has(w));
  const thing = THINGS.test(f);
  const asks = f.includes('?') || QUESTION.test(f);
  if (startsWithVerb && (thing || words.length >= 3)) return out('request', !asks || POLITE.test(f));
  if (WANT.test(f) && (thing || anyVerb)) return out('request', true);
  if (CHAT.test(f) && words.length <= 6 && !anyVerb) return out('chat', words.length <= 3);
  if (asks && !(anyVerb && thing && POLITE.test(f))) return out('question', QUESTION.test(f) && !anyVerb);
  if (anyVerb && thing) return out('request', false);
  if (words.length <= 2) return out('chat', false);
  return out(null, false);
}

/**
 * Puts the model's guess and the keyword rules together.
 * @param {{ intent: string, confidence?: string } | null} model
 * @param {{ intent: string|null, strong: boolean }} kw
 * @returns {'request'|'question'|'chat'|'ambiguous'}
 */
export function decideIntent(model, kw) {
  const m = model && ['request', 'question', 'chat'].includes(model.intent) ? model : null;
  if (kw.intent && kw.strong && (!m || m.intent === kw.intent || m.confidence !== 'high' || kw.intent === 'request')) return kw.intent;
  if (m && kw.intent === m.intent) return m.intent;
  if (m && !kw.intent) {
    if (m.intent !== 'request') return m.intent;
    return m.confidence === 'high' ? 'request' : 'ambiguous';
  }
  if (m && kw.intent) {
    // They disagree: a talk answer is harmless, starting a job by mistake is not.
    if (m.intent !== 'request' && kw.intent !== 'request') return m.confidence === 'high' ? m.intent : kw.intent;
    return 'ambiguous';
  }
  if (kw.intent === 'request') return kw.strong ? 'request' : 'ambiguous';
  return kw.intent || 'ambiguous';
}

const EXAMPLES = [
  ['crie um site landingpage simples por favor', 'request'],
  ['make the header blue and add a contact form', 'request'],
  ['quero uma calculadora em html', 'request'],
  ['o que vocês estão fazendo agora?', 'question'],
  ['how does the live preview work?', 'question'],
  ['qual arquivo tem o css?', 'question'],
  ['oi, tudo bem?', 'chat'],
  ['thanks, nice work', 'chat']
];

export function intentMessages(text, worker) {
  return [
    {
      role: 'system',
      content: [
        `You sort one message the user wrote to ${worker?.name || 'Mel'}, a worker in a small crew that builds files (web pages, apps, scripts) on this computer.`,
        'intent is "request" when the user wants the crew to build, create, change, fix or add something, in any language, also as a polite question ("can you make...") or a wish ("I want a site").',
        'intent is "question" when the user asks for information or an explanation, and "chat" for greetings, thanks and small talk.',
        'confidence is "high" when the message is clear, "low" when it could be read both ways.',
        'Examples:',
        ...EXAMPLES.map(([m, i]) => `"${m}" -> ${i}`),
        'Answer with one JSON object.'
      ].join('\n')
    },
    { role: 'user', content: `Message: ${String(text).slice(0, 1200)}` }
  ];
}

/**
 * The messages for a talk answer: the worker's persona, the user's language and what the crew is doing.
 * @param {{ worker: any, text: string, lang: string, files: string[], jobs: any[], tasks: Record<string, any>, history: any[], crew: any[] }} ctx
 */
export function replyMessages({ worker, text, lang, files = [], jobs = [], tasks = {}, history = [], crew = [] }) {
  const language = languageName(lang);
  const topic = topicOf(text);
  const jobLines = jobs.slice(-4).map((j) => {
    const list = (j.taskIds || []).map((id) => tasks[id]).filter(Boolean).map((t) => `${t.title} (${crew.find((w) => w.id === t.assignee)?.name || t.assignee}, ${t.status})`);
    return `- ${j.id} ${j.status}: ${String(j.request).slice(0, 200)}${list.length ? `\n  tasks: ${list.slice(0, 8).join('; ')}` : ''}${j.summary ? `\n  result: ${j.summary}` : ''}`;
  });
  const past = history.slice(-6).map((m) => `${m.from === 'user' ? 'User' : crew.find((w) => w.id === m.from)?.name || m.from}: ${String(m.text).slice(0, 300)}`);
  return [
    {
      role: 'system',
      content: [
        `You are ${worker.name}, the ${worker.role} of hivedesk: a crew of AI workers (${crew.map((w) => `${w.name}, ${w.role}`).join('; ')}) that plan, talk and build real files on the user's computer with a local model.`,
        String(worker.prompt || '').slice(0, 600),
        `Reply in ${language} (${lang}) only, as ${worker.name}, in one to four short sentences of plain text. No Markdown headings, no code unless the user asks for code.`,
        ...(topic ? [`${EXPERTISE[topic]} For this technical question give the real answer an experienced engineer would give: the concrete steps, commands or API names and the main tradeoff, in up to six short sentences. Say plainly when something needs a tool or account the user may not have.`] : []),
        'This reply cannot build or change files. When the user wants something built or changed, tell them to ask for it here and the crew starts a job.',
        'Only talk about work that is listed below; never say a file or job exists when it is not listed.',
        '',
        `Files in the project workspace: ${files.length ? files.slice(0, 40).join(', ') : 'none yet'}.`,
        `Jobs: ${jobLines.length ? `\n${jobLines.join('\n')}` : 'none yet.'}`,
        past.length ? `Recent messages in this chat:\n${past.join('\n')}` : ''
      ].filter(Boolean).join('\n')
    },
    { role: 'user', content: String(text).slice(0, 2000) }
  ];
}

/** A model answer cleaned for the chat: no name prefix, no JSON, no endless text. */
export function cleanReply(text, worker) {
  let s = String(text || '').trim();
  if (/^[{[]/.test(s)) return '';
  s = s.replace(new RegExp(`^(?:${worker?.name || 'Mel'}|assistant)\\s*:\\s*`, 'i'), '').trim();
  if (s.length > 1500) s = `${s.slice(0, 1500).replace(/\s+\S*$/, '')}...`;
  return s;
}
