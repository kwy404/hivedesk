// Automatic playbook selection: BM25 keyword relevance over the library (title, tags, trigger, id and
// prompt as weighted fields) on the task text, the request, the brief and the file types, then the
// role, room and task kind adjust the score. Portuguese requests are mapped to the English terms of
// the library. The model may re-rank the top candidates (rerank), only for cloud models.
import { getLibrary, roleOf, estimateTokens, renderEntry, SECTION_OVERHEAD } from './index.js';
import { DOMAINS } from '../domains/index.js';

/** Categories that belong to one kind of project: outside it they weigh less, inside it more. */
const DOMAIN_CATEGORIES = new Set(['mobile', 'desktop', 'backend', 'security', 'devops', 'tools', 'games']);

// ------------------------------------------------------------------ text to terms
const STOP = new Set(('a an the and or of to for with in on at by from into is are be been it its this that these those my our your me us i we you he she they ' +
  'make build create write add small tiny simple new please some one using use want need would like can could should get let just also very index ' +
  'all any each every more most other such than then there their them so not no do does did done have has had will shall may might must ' +
  // Portuguese
  'um uma uns umas o os as de da do das dos em no na nos nas por pelo pela para pra pro com sem que e ou se ao aos meu minha meus minhas ' +
  'seu sua seus suas nosso nossa esse essa esses essas este esta isso isto aquele aquela quero queria preciso precisa gostaria pode podes ' +
  'crie criar cria faca fazer faz monte montar gere gerar escreva escrever coloque colocar adicione adicionar me te mim voce ele ela eles ' +
  'favor por-favor tipo bem mais muito pouco algo alguma algum toda todos todas bom boa simples contra sobre aqui ali la ja so tambem agora novo nova').split(/\s+/));

/** Multi word phrases first (after accents are stripped), mapped to library terms. */
const PHRASES = [
  [/\btic[\s-]*tac[\s-]*toe\b|\bjogo da velha\b|\bnoughts and crosses\b/g, ' tictactoe game '],
  [/\bto[\s-]do\b|\blista de tarefas\b|\blista de afazeres\b/g, ' todo '],
  [/\b(modo|tema) escuro\b|\bdark[\s-]mode\b|\bdark theme\b/g, ' darkmode dark '],
  [/\blista de espera\b|\bwait[\s-]list\b/g, ' waitlist '],
  [/\bperguntas frequentes\b/g, ' faq '],
  [/\bbarra de navegacao\b|\bnav[\s-]bar\b/g, ' navbar '],
  [/\bmensagem de commit\b|\bcommit message\b/g, ' commit message '],
  [/\bpull request\b|\bmerge request\b/g, ' pullrequest pr '],
  [/\blinha de comando\b|\bcommand[\s-]line\b/g, ' cli '],
  [/\bcriterios de aceite\b|\bcriterios de aceitacao\b/g, ' acceptance criteria '],
  [/\bnao funciona\b|\bparou de funcionar\b|\bdoesn'?t work\b|\bnot working\b/g, ' broken bug '],
  [/\bbanco de dados\b/g, ' database '],
  [/\btratamento de erros?\b/g, ' error handling '],
  [/\bfora do ar\b/g, ' outage '],
  [/\bpagina inicial\b|\bhome page\b/g, ' homepage landing '],
  [/\bpagina de vendas\b|\bsales page\b/g, ' landing sales '],
  [/\bjogo da memoria\b|\bmemory game\b/g, ' memory game cards '],
  [/\bpedra,? papel,? tesoura\b|\brock,? paper,? scissors\b/g, ' rockpaperscissors game '],
  [/\bcampo minado\b|\bminesweeper\b/g, ' minesweeper game '],
  [/\bnode:http\b/g, ' node http server '],
  [/\blocal ?storage\b/g, ' localstorage storage '],
  [/\bcaso de teste\b|\btest case\b/g, ' test case '],
  [/\b(add|write|create|adicion[a-z]*|escrev[a-z]*|cri[ae])\s+(some\s+|the\s+|unit\s+|os\s+|uns\s+)?(tests?|testes)\b/g, ' addtests unit test '],
  [/\bplano de testes?\b|\btest plan\b/g, ' testplan test plan '],
  [/\bpontos de historia\b|\bstory points\b/g, ' estimate '],
  [/\bsem internet\b|\boffline\b/g, ' offline '],
  [/\bleia[\s-]?me\b/g, ' readme ']
];

/** Single words (Portuguese and a few English variants) to library terms. */
const SYN = {
  site: ['website', 'site'], sites: ['website', 'site'], website: ['website', 'site'], webpage: ['page', 'website'], pagina: ['page'], paginas: ['page'], homepage: ['landing', 'homepage'],
  padaria: ['bakery'], padarias: ['bakery'], confeitaria: ['bakery', 'pastry', 'cake'], bolo: ['cake'], bolos: ['cake'], pao: ['bread'], paes: ['bread'], doceria: ['bakery', 'pastry'],
  restaurante: ['restaurant'], restaurantes: ['restaurant'], cardapio: ['menu'], lanchonete: ['restaurant', 'cafe'], cafeteria: ['cafe', 'coffee'], cafe: ['cafe', 'coffee'], pizzaria: ['restaurant', 'pizza'], hamburgueria: ['restaurant', 'burger'],
  loja: ['store', 'shop'], lojas: ['store', 'shop'], ecommerce: ['store', 'shop'], produtos: ['product'], produto: ['product'], carrinho: ['cart'], vitrine: ['store', 'product'],
  evento: ['event'], eventos: ['event'], casamento: ['wedding', 'event'], convite: ['invitation', 'event'], conferencia: ['conference', 'event'], show: ['event', 'concert'],
  curriculo: ['resume', 'cv'], portfolio: ['portfolio'], portifolio: ['portfolio'], artigo: ['article', 'blog'], artigos: ['article', 'blog'], noticias: ['news', 'blog'],
  preco: ['price', 'pricing'], precos: ['price', 'pricing'], planos: ['plan', 'pricing'], assinatura: ['subscription', 'pricing'], documentacao: ['docs', 'documentation'], docs: ['docs', 'documentation'],
  erro: ['error', 'bug'], erros: ['error', 'bug'], falha: ['error', 'bug'], excecao: ['exception', 'error'], quebrado: ['broken', 'bug'], quebrou: ['broken', 'bug'], travando: ['crash', 'bug'], crash: ['crash', 'error'], crashes: ['crash', 'error'],
  corrige: ['fix'], corrija: ['fix'], corrigir: ['fix'], conserta: ['fix'], conserte: ['fix'], consertar: ['fix'], arruma: ['fix'], arrume: ['fix'], arrumar: ['fix'], resolve: ['fix'], resolva: ['fix'], debug: ['debug', 'bug'], depurar: ['debug', 'bug'],
  tarefa: ['task', 'todo'], tarefas: ['task', 'todo'], afazeres: ['todo'], notas: ['note'], anotacoes: ['note'], nota: ['note'], kanban: ['kanban', 'board'], quadro: ['board', 'kanban'],
  orcamento: ['budget'], gastos: ['expense', 'budget'], despesas: ['expense', 'budget'], financas: ['finance', 'budget'], financeiro: ['finance', 'budget'], dinheiro: ['money', 'budget'],
  perguntas: ['question'], pergunta: ['question'], questionario: ['quiz', 'survey'], cronometro: ['stopwatch', 'timer'], temporizador: ['timer'], relogio: ['clock'], contagem: ['countdown'], regressiva: ['countdown'],
  painel: ['dashboard'], dashboard: ['dashboard'], grafico: ['chart'], graficos: ['chart'], calculadora: ['calculator'], jogo: ['game'], jogos: ['game'], cobrinha: ['snake'], cobra: ['snake'], memoria: ['memory'], forca: ['hangman'],
  conversa: ['chat'], mensagens: ['message', 'chat'], bate: ['chat'], papo: ['chat'],
  formulario: ['form'], formularios: ['form'], contato: ['contact'], cadastro: ['signup', 'form', 'crud'], inscricao: ['signup', 'form'], login: ['login', 'form'], entrar: ['login'],
  botao: ['button'], botoes: ['button'], rodape: ['footer'], cabecalho: ['header'], navegacao: ['navigation', 'navbar'], abas: ['tabs'], aba: ['tabs'], tabela: ['table'], tabelas: ['table'],
  cartao: ['card'], cartoes: ['card'], galeria: ['gallery'], fotos: ['photo', 'gallery'], imagens: ['image'], carrossel: ['carousel', 'slider'], aviso: ['toast', 'notification'], avisos: ['toast', 'notification'], notificacao: ['toast', 'notification'],
  janela: ['modal', 'dialog'], popup: ['popup', 'modal', 'dialog'], dialogo: ['dialog', 'modal'], acordeao: ['accordion'], sanfona: ['accordion'], paginacao: ['pagination'], busca: ['search'], pesquisa: ['search'], filtro: ['filter'], filtros: ['filter'],
  cores: ['color', 'palette'], cor: ['color'], paleta: ['palette', 'color'], fonte: ['font', 'typography'], fontes: ['font', 'typography'], tipografia: ['typography'], espacamento: ['spacing'], icones: ['icon'], icone: ['icon'],
  animacao: ['animation', 'motion'], animacoes: ['animation', 'motion'], movimento: ['motion'], layout: ['layout'], grade: ['grid'],
  acessibilidade: ['accessibility', 'a11y'], acessivel: ['accessibility', 'a11y'], desempenho: ['performance'], lento: ['slow', 'performance'], lenta: ['slow', 'performance'], rapido: ['performance'], otimizar: ['optimize', 'performance'],
  responsivo: ['responsive', 'mobile'], responsiva: ['responsive', 'mobile'], celular: ['mobile', 'responsive'], mobile: ['mobile', 'responsive'],
  traducao: ['translation', 'i18n'], traduzir: ['translation', 'i18n'], idiomas: ['language', 'i18n'], idioma: ['language', 'i18n'], seguranca: ['security'], seguro: ['security'], vulnerabilidade: ['security', 'vulnerability'],
  testes: ['test'], teste: ['test'], testar: ['test'], tipos: ['types', 'jsdoc'], tipagem: ['types', 'jsdoc'], refatorar: ['refactor'], refatora: ['refactor'], refatore: ['refactor'], limpar: ['cleanup', 'refactor'], organizar: ['refactor', 'cleanup'],
  revisao: ['review'], revisar: ['review'], revise: ['review'], revisa: ['review'], planejar: ['plan'], planejamento: ['plan'], plano: ['plan'], estimativa: ['estimate'], estimar: ['estimate'], prazo: ['estimate', 'deadline'],
  requisitos: ['requirement'], requisito: ['requirement'], duvidas: ['question', 'clarify'], esclarecer: ['clarify'], dividir: ['split', 'task'], quebrar: ['split'],
  dados: ['data'], planilha: ['csv', 'spreadsheet'], importar: ['import', 'parse'], exportar: ['export'], salvar: ['save', 'persist'], persistir: ['persist', 'save'], validacao: ['validation'], validar: ['validation'],
  servidor: ['server'], rota: ['route'], rotas: ['route'], comando: ['cli', 'command'], terminal: ['cli', 'terminal'], registro: ['log', 'logging'], registros: ['log', 'logging'], logs: ['log', 'logging'], log: ['log', 'logging'],
  publicar: ['deploy', 'release'], lancamento: ['release'], versao: ['version', 'release'], mudancas: ['changelog', 'change'], historico: ['changelog', 'history'],
  arquitetura: ['architecture'], arquiteto: ['architect', 'architecture'], desenvolvedor: ['developer'], designer: ['designer', 'design'], escritor: ['writer'], redator: ['writer', 'copy'], texto: ['copy', 'text'], textos: ['copy', 'text'],
  slow: ['slow', 'performance'], fast: ['performance'], faster: ['performance'], speed: ['performance'], broken: ['broken', 'bug'], bugs: ['bug'], issue: ['bug'], website: ['website', 'site'], webshop: ['store', 'shop'], shop: ['shop', 'store'], store: ['store', 'shop'],
  divida: ['split'], divide: ['split'], separe: ['split'], quebre: ['split'], pedido: ['request'], unitario: ['unit'], unitarios: ['unit'], funcao: ['function'], funcoes: ['function'],
  calculo: ['calculation'], calculos: ['calculation'], integracao: ['integration'], mensagem: ['message'], alteracoes: ['change'], contraste: ['contrast'], controlar: ['track'], equipe: ['team'],
  vendas: ['sales'], mes: ['month'], barras: ['bar'], barra: ['bar'], cartas: ['card'], auditoria: ['audit'], projeto: ['project'], hamburguer: ['hamburger', 'menu'], salva: ['save'], salve: ['save'],
  aplicativo: ['app'], aplicativos: ['app'], extensao: ['extension'], extensoes: ['extension'], navegador: ['browser'], implantar: ['deploy'], implantacao: ['deploy'], conteiner: ['container'], container: ['container'],
  jogador: ['player'], fase: ['level'], fases: ['level'], inimigos: ['enemy'], pontuacao: ['score'], janelas: ['window'], instalador: ['installer'], notificacoes: ['notification'],
  imagem: ['image'], video: ['video'], usuario: ['user'], usuarios: ['user'], senha: ['password'], arquivo: ['file'], arquivos: ['file'], pasta: ['folder'], lista: ['list'], codigo: ['code'], tela: ['screen'], telas: ['screen']
};

const LANG_OF_EXT = { '.html': 'html', '.htm': 'html', '.css': 'css', '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.json': 'json', '.py': 'python', '.md': 'markdown', '.csv': 'csv', '.svg': 'svg' };

/** Word forms that mean the same thing for the library, applied to entries and queries alike. */
const CANON = {
  testing: 'test', tested: 'test', logging: 'log', logged: 'log', caching: 'cache', cached: 'cache', routing: 'route', parsing: 'parse', parser: 'parse',
  styling: 'style', styles: 'style', debugging: 'debug', refactoring: 'refactor', refactored: 'refactor', building: 'build', loading: 'load', rendering: 'render',
  sorting: 'sort', filtering: 'filter', validating: 'validation', validate: 'validation', translating: 'translation', translate: 'translation', translations: 'translation',
  deploying: 'deploy', deployment: 'deploy', releasing: 'release', planning: 'plan', estimating: 'estimate', estimation: 'estimate', reviewing: 'review', reviewer: 'review',
  optimizing: 'optimize', optimization: 'optimize', fixing: 'fix', fixed: 'fix', fixes: 'fix', crashing: 'crash', crashed: 'crash', errors: 'error', bugs: 'bug',
  animations: 'animation', animated: 'animation', animate: 'animation', colors: 'color', colour: 'color', colours: 'color', palettes: 'palette', fonts: 'font',
  charts: 'chart', charting: 'chart', graphs: 'chart', graph: 'chart', games: 'game', gaming: 'game', notes: 'note', todos: 'todo', timers: 'timer',
  accessible: 'accessibility', a11y: 'accessibility', i18n: 'i18n', internationalization: 'i18n', localization: 'i18n', l10n: 'i18n', securing: 'security', secure: 'security',
  responsiveness: 'responsive', mobile: 'mobile', phones: 'phone', websites: 'website', webpages: 'page', pages: 'page', sites: 'site', apps: 'app', application: 'app'
};

function stem(w) {
  if (CANON[w]) return CANON[w];
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

/** Lowercase, accent free text with the phrases mapped. */
export function normalize(text) {
  // camelCase words give their parts and the whole word: TypeError -> type error typeerror.
  let s = ` ${String(text || '')} `.replace(/\b[A-Za-z]*[a-z][A-Z][A-Za-z]*\b/g, (w) => `${w.replace(/([a-z])([A-Z])/g, '$1 $2')} ${w}`).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  for (const [re, to] of PHRASES) s = s.replace(re, to);
  return s;
}

/**
 * Terms of a text: stop words dropped, Portuguese mapped, light stemming. Error names like TypeError
 * also give "error". File extensions in the text give the language.
 * Queries also map synonyms (see weighted).
 * @param {string} text
 */
export function terms(text) {
  const raw = String(text || '');
  const s = normalize(raw);
  const out = [];
  for (const m of raw.matchAll(/\.(html?|css|m?js|cjs|json|py|md|csv|svg)\b/gi)) out.push(LANG_OF_EXT[`.${m[1].toLowerCase()}`]);
  for (const w of s.split(/[^a-z0-9]+/)) {
    if (w.length < 2 || STOP.has(w) || (/^\d+$/.test(w) && w.length !== 3)) continue;
    out.push(stem(w));
    if (/^[a-z]+error$/.test(w) && w !== 'error') out.push('error', 'exception');
  }
  return out;
}

// ------------------------------------------------------------------ the index
const FIELDS = { title: 3, tags: 3, when: 2, id: 1, category: 1, prompt: 0.6 };
const K1 = 1.2;
const B = 0.6;
let cache = null;

/** The BM25F index of a library, rebuilt when the library changes. */
export function indexOf(lib = getLibrary()) {
  const key = `${lib.rev}:${lib.size}`;
  if (cache && cache.lib === lib && cache.key === key) return cache;
  const docs = [];
  const df = new Map();
  let total = 0;
  for (const e of lib.all()) {
    const tf = new Map();
    let len = 0;
    const add = (text, w) => { for (const t of terms(text)) { tf.set(t, (tf.get(t) || 0) + w); len += w; } };
    add(e.title, FIELDS.title);
    add((e.tags || []).join(' . '), FIELDS.tags);
    add(e.when, FIELDS.when);
    add(e.id.replace(/-/g, ' '), FIELDS.id);
    add(e.category.replace(/-/g, ' '), FIELDS.category);
    add(e.prompt, FIELDS.prompt);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    // Whole tag phrases ("tic tac toe" -> "tictactoe" after normalize) for an exact phrase bonus.
    const phrases = (e.tags || []).map((t) => terms(t).join(' ')).filter((p) => p.includes(' '));
    docs.push({ entry: e, tf, len, phrases, tagTerms: new Set(terms((e.tags || []).join(' '))), cost: estimateTokens(renderEntry(e)) + 1 });
    total += len;
  }
  const N = docs.length || 1;
  const idf = new Map();
  for (const [t, n] of df) idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
  cache = { lib, key, docs, idf, avg: total / N };
  return cache;
}

// ------------------------------------------------------------------ selection
/** Tokens for the playbook section per model family. */
/** A term that appears in fewer than about one entry in twelve. */
const STRONG_IDF = 2.5;
export const BUDGET = { small: 700, local: 840, cloud: 2000 };
const RELATED = { mel: ['architect'], architect: ['mel'], qa: ['reviewer'], reviewer: ['qa'], dev: [], designer: [], writer: [], ops: ['devops'],
  mobile: ['dev', 'designer'], desktop: ['dev', 'designer'], backend: ['dev', 'architect'], security: ['reviewer', 'qa'], data: ['dev'], devops: ['ops', 'dev'] };
/** Which role works in which Hive City room. */
const ROOM_ROLE = { code: 'dev', design: 'designer', review: 'reviewer', test: 'qa', ops: 'ops', library: 'writer', lobby: 'architect' };
const DOMAIN_TERMS = { mobile: ['mobile', 'phone'], desktop: ['desktop', 'window'], backend: ['api', 'server', 'backend'], cli: ['cli', 'command'], extension: ['extension', 'browser'], game: ['game'], data: ['data', 'csv'], security: ['security'], devops: ['deploy', 'container', 'ci'] };
const KIND_TERMS = { fix: ['fix', 'bug', 'error'], qa: ['review', 'qa', 'check', 'test'], docs: ['docs', 'readme', 'documentation'] };

/** Query terms with weights: a word mapped to two synonyms gives each about two thirds of its weight. */
function weighted(text) {
  const out = [];
  const raw = String(text || '');
  for (const m of raw.matchAll(/\.(html?|css|m?js|cjs|json|py|md|csv|svg)\b/gi)) out.push([LANG_OF_EXT[`.${m[1].toLowerCase()}`], 0.5]);
  for (const w of normalize(raw).split(/[^a-z0-9]+/)) {
    if (w.length < 2 || STOP.has(w) || (/^\d+$/.test(w) && w.length !== 3)) continue;
    const syn = SYN[w];
    if (syn) { for (const x of syn) out.push([stem(x), syn.length > 1 ? 0.7 : 1]); continue; }
    out.push([stem(w), 1]);
    if (/^[a-z]+error$/.test(w) && w !== 'error') out.push(['error', 0.7], ['exception', 0.5]);
  }
  return out;
}

function queryTerms(input) {
  const q = new Map();
  const put = (text, w) => { for (const [t, k] of weighted(text)) q.set(t, Math.min(3, (q.get(t) || 0) + w * k)); };
  put(input.task || input.text || '', 1);
  put(input.request || '', input.task || input.text ? 0.8 : 1);
  put(String(input.brief || '').slice(0, 1200), 0.35);
  for (const f of input.files || []) {
    const m = String(typeof f === 'string' ? f : f.path).toLowerCase().match(/\.[a-z0-9]+$/);
    if (m && LANG_OF_EXT[m[0]]) q.set(LANG_OF_EXT[m[0]], Math.min(3, (q.get(LANG_OF_EXT[m[0]]) || 0) + 0.25));
  }
  for (const t of KIND_TERMS[input.kind] || []) q.set(t, Math.min(3, (q.get(t) || 0) + 0.6));
  // The domain's own words (a popup in an extension job is the extension popup).
  for (const t of DOMAIN_TERMS[input.domain] || []) q.set(t, Math.min(3, (q.get(t) || 0) + 0.8));
  return q;
}

/**
 * Scores every entry for a task and picks the best ones that fit the token budget.
 * @param {{
 *   task?: string, text?: string, request?: string, brief?: string, files?: Array<string | { path: string }>,
 *   role?: string, worker?: any, room?: string, kind?: string, family?: 'small' | 'local' | 'cloud',
 *   budget?: number, limit?: number, pinned?: string[], blocked?: string[], library?: any, min?: number, domain?: string
 * }} input
 * @returns {{ picks: Array<{ id: string, title: string, category: string, score: number, terms: string[], size: number, pinned?: boolean }>, candidates: Array<{ id: string, score: number }>, budget: number, used: number, query: string[] }}
 */
export function selectPlaybooks(input = {}) {
  const lib = input.library || getLibrary();
  const idx = indexOf(lib);
  const q = queryTerms(input);
  const role = input.role || (input.worker ? roleOf(input.worker) : null);
  const roomRole = ROOM_ROLE[input.room] || null;
  const blocked = new Set(input.blocked || []);
  const pinned = new Set(input.pinned || []);
  const domainCats = input.domain && DOMAINS[input.domain] && input.domain !== 'chat' ? DOMAINS[input.domain].categories : null;
  const norm = ` ${[...q.keys()].join(' ')} `;
  const scored = [];
  for (const d of idx.docs) {
    const e = d.entry;
    if (blocked.has(e.id)) continue;
    let s = 0;
    const hit = [];
    for (const [t, w] of q) {
      const tf = d.tf.get(t);
      if (!tf) continue;
      const part = w * (idx.idf.get(t) || 0) * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * d.len) / idx.avg)));
      s += part;
      hit.push([t, part]);
    }
    for (const p of d.phrases) if (norm.includes(` ${p} `)) s += 2;
    // Tag terms the query names directly weigh a bit more than words that only appear in the prompt.
    s += hit.filter(([t]) => d.tagTerms.has(t)).length * 0.4;
    if (!s && !pinned.has(e.id)) continue;
    if (role) {
      if (e.roles.includes(role)) s *= 1.35;
      else if ((RELATED[role] || []).some((r) => e.roles.includes(r))) s *= 1.1;
      else s *= 0.55;
    }
    if (roomRole && e.roles.includes(roomRole)) s *= 1.15;
    // The domain of the job (src/crew/domains/): its own categories first, other domains' playbooks less.
    if (domainCats) {
      if (domainCats.includes(e.category)) s *= 1.4;
      else if (DOMAIN_CATEGORIES.has(e.category)) s *= 0.6;
    }
    if (pinned.has(e.id)) s += 1000;
    scored.push({ e, s, hit, tags: d.tagTerms, cost: d.cost });
  }
  scored.sort((a, b) => b.s - a.s || a.e.id.localeCompare(b.e.id));
  const top = scored.find((x) => !pinned.has(x.e.id))?.s || 0;
  const min = input.min ?? 2.2;
  const budget = input.budget ?? BUDGET[input.family] ?? BUDGET.small;
  const limit = Math.max(1, Math.min(3, input.limit ?? 3));
  const picks = [];
  // The budget covers the whole <playbook> section: its frame plus each rendered entry.
  let used = SECTION_OVERHEAD;
  // After a good entry is left out for the budget, a smaller one only fills its place when it is nearly as relevant.
  let skipped = 0;
  for (const x of scored) {
    if (picks.length >= limit) break;
    const isPinned = pinned.has(x.e.id);
    if (!isPinned && (x.s < min || x.s < top * 0.35 || x.s < skipped * 0.75)) break;
    // A pick must match the query on at least one of its tags, not only on words of its prompt or title.
    if (!isPinned && !x.hit.some(([t]) => x.tags.has(t))) continue;
    const cost = x.cost;
    if (used + cost > budget) { if (!skipped) skipped = x.s; continue; }
    used += cost;
    picks.push({
      id: x.e.id, title: x.e.title, category: x.e.category, score: Math.round((isPinned ? x.s - 1000 : x.s) * 100) / 100,
      terms: x.hit.sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t]) => t), size: x.e.size, ...(isPinned ? { pinned: true } : {}),
      // strong: a rare word of the query is one of its tags (bakery, typeerror), not only html or page.
      strong: x.hit.some(([t]) => x.tags.has(t) && (idx.idf.get(t) || 0) >= STRONG_IDF)
    });
  }
  return { picks, candidates: scored.slice(0, 8).map((x) => ({ id: x.e.id, score: Math.round(x.s * 100) / 100 })), budget, used: picks.length ? used : 0, query: [...q.keys()] };
}

/** Free text search of the library (the Library window): the same scoring without role or budget. */
export function searchLibrary(text, { library, category, role, limit = 40 } = {}) {
  const lib = library || getLibrary();
  const all = lib.all().filter((e) => (!category || e.category === category) && (!role || e.roles.includes(role)));
  if (!String(text || '').trim()) return all.sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title)).slice(0, limit).map((e) => ({ entry: e, score: 0, terms: [] }));
  const allowed = new Set(all.map((e) => e.id));
  const idx = indexOf(lib);
  const q = queryTerms({ text });
  const out = [];
  for (const d of idx.docs) {
    if (!allowed.has(d.entry.id)) continue;
    let s = 0;
    const hit = [];
    for (const [t, w] of q) {
      const tf = d.tf.get(t);
      if (!tf) continue;
      s += w * (idx.idf.get(t) || 0) * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * d.len) / idx.avg)));
      hit.push(t);
    }
    const lower = String(text).toLowerCase();
    if (d.entry.id.includes(lower) || d.entry.title.toLowerCase().includes(lower)) s += 5;
    if (s > 0) out.push({ entry: d.entry, score: Math.round(s * 100) / 100, terms: hit.slice(0, 6) });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

export const RERANK_SCHEMA = {
  type: 'object',
  properties: { order: { type: 'array', items: { type: 'string' }, maxItems: 6, description: 'the ids of the useful playbooks, best first' } },
  required: ['order'],
  additionalProperties: false
};

/**
 * Optional model re-ranking of the candidates of one task. `ask(messages, schema)` returns { order }.
 * Only the given candidates can come back; on any error the keyword order stays.
 */
export async function rerank(task, selection, ask, { library } = {}) {
  const lib = library || getLibrary();
  const cands = selection.candidates.map((c) => lib.get(c.id)).filter(Boolean).slice(0, 6);
  if (cands.length < 2 || typeof ask !== 'function') return selection;
  try {
    const r = await ask([
      { role: 'system', content: 'You pick expert playbooks for a task. Answer with JSON only: the ids of the playbooks that help with this task, best first. Leave out the ones that do not apply.' },
      { role: 'user', content: `Task: ${String(task).slice(0, 600)}\n\nPlaybooks:\n${cands.map((e) => `- ${e.id}: ${e.title}. ${e.when}`).join('\n')}` }
    ], RERANK_SCHEMA);
    const order = (r?.order || []).filter((id) => cands.some((e) => e.id === id));
    if (!order.length) return selection;
    const byId = new Map(selection.candidates.map((c) => [c.id, c]));
    const pinned = selection.picks.filter((p) => p.pinned);
    const picks = [...pinned];
    const cost = (e) => estimateTokens(renderEntry(e)) + 1;
    let used = pinned.reduce((n, p) => n + cost(lib.get(p.id)), SECTION_OVERHEAD);
    for (const id of order) {
      if (picks.length >= 3 || picks.some((p) => p.id === id)) continue;
      const e = lib.get(id);
      if (used + cost(e) > selection.budget) continue;
      used += cost(e);
      const old = selection.picks.find((p) => p.id === id);
      picks.push(old ? { ...old, reranked: true } : { id, title: e.title, category: e.category, score: byId.get(id)?.score || 0, terms: [], size: e.size, reranked: true });
    }
    return { ...selection, picks: picks.length ? picks : selection.picks, used, reranked: true };
  } catch {
    return selection;
  }
}
