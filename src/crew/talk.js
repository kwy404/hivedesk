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
    return `- ${j.id} ${JOB_STATE[j.status] || j.status}: ${String(j.request).slice(0, 200)}${list.length ? `\n  tasks: ${list.slice(0, 8).join('; ')}` : ''}${j.summary ? `\n  result: ${j.summary}` : ''}`;
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
        'The crew writes real files in the project workspace on this computer when a job runs. Never say you are an AI, an assistant or a language model, and never say you cannot create files or sites.',
        'This reply itself does not build anything: never say you will start, continue or prepare work. When the user wants something built or changed, tell them to ask for it here and the crew starts a job.',
        'Only talk about work that is listed below; never say a file or job exists when it is not listed. A job that waits for the brief only moves when the user approves it.',
        '',
        `Files in the project workspace: ${files.length ? files.slice(0, 40).join(', ') : 'none yet'}.`,
        `Jobs: ${jobLines.length ? `\n${jobLines.join('\n')}` : 'none yet.'}`,
        past.length ? `Recent messages in this chat:\n${past.join('\n')}` : ''
      ].filter(Boolean).join('\n')
    },
    { role: 'user', content: String(text).slice(0, 2000) }
  ];
}

/** The job states in plain words for the talk prompt. */
const JOB_STATE = {
  refining: 'Mel is writing the brief',
  awaiting_brief: 'waiting for the user to approve the brief (the Brief window has Use the brief, Edit and Keep my request; replying "ok" here also approves it)',
  planning: 'brief approved, Mel is planning the tasks',
  running: 'the crew is building',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled'
};

/** A model answer cleaned for the chat: no name prefix, no JSON, no endless text. */
export function cleanReply(text, worker) {
  let s = String(text || '').trim();
  if (/^[{[]/.test(s)) return '';
  s = s.replace(new RegExp(`^(?:${worker?.name || 'Mel'}|assistant)\\s*:\\s*`, 'i'), '').trim();
  if (s.length > 1500) s = `${s.slice(0, 1500).replace(/\s+\S*$/, '')}...`;
  return s;
}

// ---- while a brief waits, status questions and answers the engine gives itself ----

const foldSet = (list) => new Set(list.map((w) => fold(w)));

// Words that confirm a waiting brief in the 10 languages (folded: lower case, no accents). A message made
// only of these and of filler words ("ok. aceito", "certo, pode continuar]", "go ahead") approves the brief.
const CONFIRM = foldSet([
  'ok', 'okay', 'okey', 'oki', 'okk', 'sim', 'yes', 'yep', 'yeah', 'yup', 'sure', 'go', 'ahead', 'aceito', 'aceita', 'aceitar', 'aprovo', 'aprovado', 'aprovada', 'aprova', 'aprovar',
  'pode', 'podem', 'continuar', 'continue', 'continua', 'continuem', 'seguir', 'segue', 'siga', 'prossiga', 'prosseguir', 'manda', 'mande', 'ver', 'fazer', 'faz', 'faca', 'facam',
  'certo', 'beleza', 'blz', 'perfeito', 'otimo', 'bom', 'boa', 'vai', 'vamos', 'fechado', 'combinado', 'show', 'massa', 'usar', 'use', 'usa', 'comecar', 'comece', 'comeca',
  'start', 'proceed', 'do', 'lets', 'fine', 'good', 'great', 'looks', 'lgtm', 'approve', 'approved', 'accept', 'accepted', 'agreed', 'alright', 'cool', 'perfect', 'nice',
  'si', 'vale', 'adelante', 'claro', 'dale', 'acepto', 'sigue', 'oui', 'accord', 'daccord', 'allez', 'parfait', 'vas', 'ja', 'jawohl', 'mach', 'weiter', 'los', 'gut', 'passt',
  'einverstanden', 'va', 'bene', 'procedi', 'avanti', 'perfetto', 'accetto', 'accordo',
  'ок', 'окей', 'да', 'давай', 'хорошо', 'продолжай', 'ладно', 'согласен', 'поехали', 'вперед'
]);
const FILLER = foldSet([
  'o', 'a', 'os', 'as', 'e', 'de', 'do', 'da', 'pra', 'para', 'por', 'favor', 'please', 'pls', 'pfv', 'plz', 'the', 'it', 'this', 'that', 'esse', 'essa', 'isso', 'este', 'esta', 'ai',
  'brief', 'briefing', 'mel', 'agora', 'now', 'entao', 'then', 'tudo', 'all', 'bem', 'well', 'with', 'com', 'can', 'you', 'voce', 'vc', 's', 'y', 'd', 'l', 'el', 'le',
  'la', 'lo', 'il', 'es', 'est', 'c', 'so', 'just', 'on', 'gracias', 'merci', 'danke', 'grazie', 'obrigado', 'obrigada', 'valeu', 'thanks', 'thank', 'favore',
  'bitte', 'plait', 'te', 'vous', 'пожалуйста', 'mesmo', 'um', 'uma', 'me', 'nur', 'pure', 'aussi'
]);
// Japanese, Korean and Chinese confirmations have no spaces: the whole message is compared.
const CONFIRM_CJK = ['はい', 'お願いします', 'おねがいします', '進めて', '進めてください', 'いいよ', 'いいです', 'それで', '네', '좋아요', '좋아', '진행해', '진행해주세요', '진행', '그래', '好', '好的', '可以', '继续', '开始', '开始吧', '行', '没问题', '是的', '确认'];
const ORIGINAL = /\b(?:original|meu pedido|minha mensagem|my request|my words|mi pedido|ma demande|meine anfrage|la mia richiesta)\b/;
const CANCEL = /^(?:cancela|cancele|cancelar|cancel|stop|pare|esquece|deixa pra la|annule|annuler|abbrechen|annulla|cancelalo|отмена|отмени)\b/;

/** True when the text is one or more of the phrases, back to back ("네 진행해주세요"). */
function onlyPhrases(text, phrases) {
  const list = [...phrases].sort((a, b) => b.length - a.length);
  let rest = text;
  for (let guard = 0; rest && guard < 8; guard++) {
    const p = list.find((x) => rest.startsWith(x));
    if (!p) return false;
    rest = rest.slice(p.length);
  }
  return !rest && text.length > 0;
}

/**
 * What a message means for a brief that waits for the user: approve it, keep the original request,
 * cancel the job, or change it (a build or change request). null: something else (a question, talk).
 * @returns {'approve'|'original'|'cancel'|'edit'|null}
 */
export function briefReply(text, lang = 'en') {
  const original = String(text || '').trim();
  const f = fold(original);
  if (!f || f.includes('?')) return null;
  const words = f.split(' ').filter(Boolean);
  if (CANCEL.test(f) && words.length <= 4) return 'cancel';
  if (ORIGINAL.test(f) && words.length <= 8) return 'original';
  // fold() decomposes Hangul: compare the composed forms.
  const compact = f.normalize('NFC').replace(/\s+/g, '');
  if (onlyPhrases(compact, CONFIRM_CJK)) return 'approve';
  if (words.length <= 8 && words.some((w) => CONFIRM.has(w)) && words.every((w) => CONFIRM.has(w) || FILLER.has(w))) return 'approve';
  if (keywordIntent(original, lang).intent === 'request') return 'edit';
  return null;
}

// "cade a landingpage?", "where is it", "is it ready", "o que falta": the job status, from the engine.
const STATUS = [
  /^(?:e )?(?:cade|kd)\b/, /\bonde (?:esta|ta|fica|estao)\b/, /\bwhere (?:is|s|are)\b/, /^where\b/, /\b(?:esta|ta|ficou|fica) pronto\b/, /\bpronto\s*\?/,
  /\b(?:terminou|acabou|terminaram|acabaram)\b/, /\bo que falta\b/, /\bque falta\b/, /\bfalta muito\b/, /\b(?:status|progresso|andamento|progress)\b/,
  /\bcomo (?:esta|ta|vai) (?:o|a) (?:job|trabalho|site|pagina|projeto|landing|landingpage|tarefa|app)\b/, /\bhow (?:is|s) it going\b/, /\bwhat s left\b/, /\bwhats left\b/,
  /\b(?:is it|are you) (?:done|ready|finished)\b/, /\b(?:done|ready|finished) yet\b/, /\bdonde esta\b/, /\besta listo\b/, /\bou en est\b/, /\bc est pret\b/, /\best ce pret\b/,
  /\bwo ist\b/, /\bist es fertig\b/, /\bwie weit\b/, /\bdov e\b/, /\be pronto\b/, /\ba che punto\b/, /где/, /готово/, /できた/, /進捗/, /どこ/, /진행 ?상황/, /다 ?됐/, /어디/, /进度/, /好了吗/, /在哪/
];

/** True for a question about how the work is going: answered from the engine state, not by the model. */
export function isStatusQuestion(text) {
  const f = fold(text).normalize('NFC');
  if (!f || f.split(' ').length > 12) return false;
  return STATUS.some((re) => re.test(f));
}

// A crew answer must never be a generic assistant disclaimer: the crew writes real files when a job runs.
const REFUSAL = [
  /\b(?:sou|como) (?:um |uma )?(?:assistente|modelo de linguagem|ia|inteligencia artificial)\b/, /\binteligencia artificial\b/, /\bassistente (?:virtual|de ia)\b/,
  /\bas an ai\b/, /\bi (?:am|m) (?:an|just an) (?:ai|language model|assistant)\b/, /\blanguage model\b/, /\bai assistant\b/,
  /\bnao (?:tenho|possuo) (?:a )?(?:capacidade|habilidade|acesso)\b/, /\bnao (?:consigo|posso) (?:criar|gerar|escrever|construir) (?:arquivos|sites|paginas|o site|a pagina)\b/,
  /\bi (?:cannot|can t|can not|am unable to|m unable to|do not have the ability to|don t have the ability to) (?:create|build|make|write|generate) (?:files|websites|sites|a website|web pages)\b/,
  /\bi (?:do not|don t) have (?:the ability|access to your (?:computer|files))\b/, /\bdirectly on your (?:computer|machine)\b/, /\bdiretamente (?:em|no) seu computador\b/,
  /\bcomo (?:modelo|ia)\b/, /языковая модель/, /\bcomme (?:une )?ia\b/, /\bals (?:eine )?ki\b/, /\bcome (?:un )?(?:ia|assistente)\b/, /\bcomo (?:una )?ia\b/
];
// The chat answer cannot start or continue work; a reply that says it does is replaced with the real status.
const CLAIM = [
  /\b(?:vou|vamos|irei|iremos|estou|estamos) (?:comecar|continuar|criar|fazer|preparar|construir|seguir|iniciar|trabalhar|comecando|continuando|criando|fazendo|preparando|construindo|trabalhando)\b/,
  /\bestamos prontos para comecar\b/, /\b(?:i ll|i will|we ll|we will|i am going to|we are going to|i m going to) (?:start|continue|begin|create|build|get started|work on|prepare|make)\b/,
  /\b(?:i m|i am|we re|we are) (?:starting|continuing|creating|building|working on|preparing)\b/, /\blet s get started\b/
];

/** A crew answer that is a generic assistant disclaimer (or says it cannot create files). */
export const isRefusal = (text) => { const f = fold(text); return REFUSAL.some((re) => re.test(f)); };
/** A crew answer that says it starts or continues work, which only a job does. */
export const claimsWork = (text) => { const f = fold(text); return CLAIM.some((re) => re.test(f)); };
