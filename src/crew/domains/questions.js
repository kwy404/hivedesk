// Clarifying questions before the plan: when a request is ambiguous or misses a fact that changes the
// result (platform, data, sign in, scope), Mel asks one card of 1 to 4 questions with 2 to 5 concrete
// options each. The question sets are curated per domain, so even a 3B model asks good questions; a
// bigger model may reword them for the request, and the guards below keep the rules either way:
//   - ask only what changes the plan, never what the request already says or what has a sensible default
//     (the defaults are stated in one line under the card instead);
//   - questions use the request's own words, options are decisions with the tradeoff in the description,
//     short labels (1 to 5 words), the recommended option first with a reason tied to the context;
//   - ordered by impact: platform, then data, then sign in, then scope, then style; at most 4.
import { fold } from '../talk.js';
import { DOMAINS } from './index.js';
import { tr } from './text.js';

export const MAX_QUESTIONS = 4;
export const TOPIC_ORDER = ['platform', 'data', 'auth', 'scope', 'input', 'output', 'controls', 'players', 'reach', 'ui', 'target', 'ci', 'style'];
const GENERIC = /\b(any (other )?(preferences?|requirements?|thoughts|details|questions)|anything else|something else|other details|alguma (outra )?(preferencia|coisa|observacao|duvida)|mais alguma coisa|algo mais|tell me more|conte mais)\b/;

// Words in a request that say it keeps records, and that several people use it.
const DATA_WORDS = /\b(list|lists|lista|listas|tasks?|tarefas?|todo|notes?|notas|anotacoes|recipes?|receitas?|records?|registros?|orders?|pedidos?|products?|produtos?|clients?|clientes|contacts?|contatos|expenses?|gastos|despesas|finance\w*|financ\w*|habits?|habitos|inventory|estoque|bookings?|reservas?|agendamentos?|appointments?|posts?|entries|diary|diario|journal|workouts?|treinos?|students?|alunos|grades|notas|scores?|history|historico|favorites?|favoritos|cadastro|cadastrar|save|salvar|salve|track|tracker|controle|controlar)\b/;
const STORAGE_WORDS = /\b(offline|local ?storage|indexeddb|sqlite|database|banco de dados|banco|server|servidor|backend|cloud|nuvem|sync|sincroniz\w*|api|json file|arquivo json|on the device|no celular|no aparelho|in memory|em memoria|no data|sem dados)\b/;
const MULTI_USER = /\b(users|usuarios|accounts|contas|team|equipe|members|membros|employees|funcionarios|students|alunos|customers|clientes|family|familia|share|shared|compartilh\w*|multi ?user|varias pessoas|several people|everyone|todos podem)\b/;
const LOGIN_WORDS = /\b(login|log in|sign ?in|sign ?up|signup|entrar|cadastro de usuarios|senha|password|auth\w*|autentica\w*|conta de usuario|accounts?)\b/;
const NO_LOGIN = /\b(no login|without login|sem login|sem conta|no account|sem cadastro|anonymous|anonimo)\b/;
const PLATFORMS = ['mobile', 'desktop', 'backend', 'cli', 'extension', 'game'];
const APP_WORDS = /\b(app|apps|aplicativo|aplicacao|application|program|programa|software|tool|ferramenta|sistema|system|plataforma|platform)\b/;

/**
 * The curated sets. Text is English with {subject} (the request's own words); the i18n table
 * (domains.q.<question>.text, domains.q.<question>.<option>.label and .desc) gives the other languages.
 * when(ctx): ask it; infer(ctx): the option the request already picks (then it is not asked).
 */
export const QUESTION_SETS = {
  platform: [{
    id: 'platform', topic: 'platform', multi: false,
    text: 'What should {subject} be: a website, a phone app, a desktop app or an API?',
    options: [
      { id: 'web', label: 'Website', desc: 'Opens in any browser, nothing to install, the easiest to share.', domain: 'web', reason: 'works on every device and needs no extra tools here' },
      { id: 'mobile', label: 'Mobile app', desc: 'Installable PWA plus a Capacitor project; native builds need Android Studio or Xcode.', domain: 'mobile', reason: 'the request talks about phones' },
      { id: 'desktop', label: 'Desktop app', desc: 'Its own window on Windows, macOS and Linux, can read and write local files.', domain: 'desktop', reason: 'the request talks about a program for the computer' },
      { id: 'backend', label: 'Backend API', desc: 'An HTTP API with tests for other apps to call; no screens.', domain: 'backend', reason: 'the request talks about a server or data for other apps' },
      { id: 'cli', label: 'Command line tool', desc: 'A terminal command with flags, good for scripts and automation.', domain: 'cli', reason: 'the request talks about the terminal' },
      { id: 'game', label: 'Browser game', desc: 'A canvas game that runs in the browser with keyboard and touch.', domain: 'game', reason: 'the request talks about playing' },
      { id: 'extension', label: 'Browser extension', desc: 'Adds a button or changes pages in the browser; installed per browser.', domain: 'extension', reason: 'the request talks about the browser' }
    ],
    when: (c) => c.ambiguousPlatform
  }, {
    id: 'any.data', topic: 'data', multi: false, text: 'Should {subject} remember data between uses?',
    options: [
      { id: 'device', label: 'On this device', desc: 'Saved locally: works offline and needs no account, but stays on one device.', reason: 'nothing in the request needs sharing between devices' },
      { id: 'server', label: 'Synced on a server', desc: 'Every device sees the same data; a small API must keep running.', reason: 'the data is shared between people' },
      { id: 'none', label: 'Nothing saved', desc: 'Starts fresh every time; the simplest and most private.', reason: 'it only shows or calculates' }
    ],
    when: (c) => c.data && !c.storage
  }, {
    id: 'any.auth', topic: 'auth', multi: false, text: 'Do people need to sign in to {subject}?',
    options: [
      { id: 'none', label: 'No sign in', desc: 'Opens straight away; each device keeps its own data.', reason: 'nothing is shared, so an account adds steps without a gain' },
      { id: 'accounts', label: 'Accounts with passwords', desc: 'Each person sees their own data; needs a server and careful password storage.', reason: 'several people use it' }
    ],
    when: (c) => c.multiUser && !c.login && !c.noLogin
  }],
  web: [
    {
      id: 'web.data', topic: 'data', multi: false, text: 'Should {subject} remember what people add between visits?',
      options: [
        { id: 'browser', label: 'Saved in this browser', desc: 'localStorage: works offline and needs no server, but stays on one device.', reason: 'nothing in the request needs sharing between devices' },
        { id: 'server', label: 'Saved on a server', desc: 'A small Node API stores it, so every device sees the same data; it must keep running.', reason: 'the data is shared' },
        { id: 'none', label: 'Nothing saved', desc: 'Starts empty on every visit; the simplest and most private.', reason: 'it only shows information' }
      ],
      when: (c) => c.data && !c.storage, infer: (c) => (/\b(server|servidor|backend|api)\b/.test(c.f) ? 'server' : /\b(local ?storage|offline)\b/.test(c.f) ? 'browser' : null)
    },
    {
      id: 'web.scope', topic: 'scope', multi: false, text: 'How much should {subject} include in this first version?',
      options: [
        { id: 'one', label: 'One focused page', desc: 'A single page with the main sections, ready quickly and easy to change.', reason: 'a short request is best answered with one solid page first' },
        { id: 'few', label: 'A few pages', desc: 'Home plus 2 or 3 linked pages with shared navigation; takes longer.', reason: 'the request lists several parts' },
        { id: 'app', label: 'An interactive app', desc: 'One page with real features (forms, lists, filters) written in JavaScript.', reason: 'the request describes actions, not only content' }
      ],
      // One page is the sensible default for a short request: asked only when the request names several parts.
      when: (c) => /(pages|paginas|sections|secoes|blog|shop|loja|store)/.test(c.f) && !c.data && !/(one page|uma pagina|single page|landing)/.test(c.f)
    }
  ],
  mobile: [
    {
      id: 'mobile.data', topic: 'data', multi: false, text: 'Where should {subject} keep its data?',
      options: [
        { id: 'device', label: 'On the phone', desc: 'IndexedDB on the device: works offline, no account, but no sync between phones.', reason: 'it works offline and needs nothing else running' },
        { id: 'server', label: 'Synced through a server', desc: 'Data follows the user to every phone; needs a backend API that keeps running.', reason: 'the data is shared between people' },
        { id: 'none', label: 'Nothing saved', desc: 'A tool or viewer that starts fresh every time; nothing to back up.', reason: 'it only shows or calculates' }
      ],
      when: (c) => c.data && !c.storage, infer: (c) => (/\b(server|servidor|backend|sync|sincroniz\w*|nuvem|cloud)\b/.test(c.f) ? 'server' : /\b(offline|no celular|on the device)\b/.test(c.f) ? 'device' : null)
    },
    {
      id: 'mobile.auth', topic: 'auth', multi: false, text: 'Do people need to sign in to {subject}?',
      options: [
        { id: 'none', label: 'No sign in', desc: 'Opens straight away; each phone has its own data.', reason: 'nothing is shared, so an account adds steps without a gain' },
        { id: 'pin', label: 'Local PIN lock', desc: 'A PIN on this phone hides the data from others; nothing leaves the phone.', reason: 'the data is personal' },
        { id: 'accounts', label: 'Accounts on a server', desc: 'Email and password through your own API; needed when people share data.', reason: 'several people use it' }
      ],
      when: (c) => c.multiUser && !c.login && !c.noLogin
    }
  ],
  desktop: [
    {
      id: 'desktop.data', topic: 'data', multi: false, text: 'Where should {subject} save its data?',
      options: [
        { id: 'json', label: 'File in the app folder', desc: 'One JSON file in the user data folder: simple, easy to back up, one user at a time.', reason: 'it keeps everything on this computer with nothing to install' },
        { id: 'files', label: 'Files the user picks', desc: 'Open and save dialogs, like a document editor; the user decides where files live.', reason: 'the user works with documents' },
        { id: 'sql', label: 'Embedded SQL file', desc: 'Handles thousands of records and searches well; one more dependency to ship.', reason: 'there will be a lot of records' }
      ],
      when: (c) => c.data && !c.storage, infer: (c) => (/\b(sqlite|sql|database|banco de dados)\b/.test(c.f) ? 'sql' : /\b(open|save as|abrir|salvar como|documents?|documentos?)\b/.test(c.f) ? 'files' : null)
    }
  ],
  backend: [
    {
      id: 'backend.data', topic: 'data', multi: false, text: 'Where should {subject} store its data?',
      options: [
        { id: 'sqlfile', label: 'Embedded SQL file', desc: 'One database file, no server to install; best for one machine.', reason: 'it runs on this PC without installing a database server' },
        { id: 'json', label: 'JSON file', desc: 'The simplest to read and edit, fine for small data with one writer.', reason: 'the data is small' },
        { id: 'memory', label: 'In memory', desc: 'Fastest to build; everything resets when the server restarts.', reason: 'this is a prototype' },
        { id: 'server', label: 'SQL database server', desc: 'Scales and is shared by many servers; you install and configure it.', reason: 'the API must scale' }
      ],
      when: (c) => !c.dbWords, infer: (c) => (/\b(sqlite)\b/.test(c.f) ? 'sqlfile' : /\b(postgres\w*|mysql|database server)\b/.test(c.f) ? 'server' : /\b(in memory|em memoria)\b/.test(c.f) ? 'memory' : /\b(json file|arquivo json)\b/.test(c.f) ? 'json' : null)
    },
    {
      id: 'backend.auth', topic: 'auth', multi: false, text: 'Who may call {subject}?',
      options: [
        { id: 'key', label: 'Apps with an API key', desc: 'A secret key in a header; simple and right for one client app.', reason: 'one client app calls it' },
        { id: 'users', label: 'Signed in users', desc: 'Accounts with hashed passwords and session cookies; more code and more to secure.', reason: 'people have their own data' },
        { id: 'open', label: 'Anyone on this network', desc: 'No auth, bound to localhost; only for local tools and prototypes.', reason: 'it only runs locally' }
      ],
      when: (c) => !c.login && !c.noLogin, infer: (c) => (/\b(api key|chave de api|token)\b/.test(c.f) ? 'key' : null)
    }
  ],
  game: [
    {
      id: 'game.controls', topic: 'controls', multi: false, text: 'How do people play {subject}?',
      options: [
        { id: 'both', label: 'Keyboard and touch', desc: 'Arrow keys on a computer and on screen buttons on a phone; a bit more UI work.', reason: 'it runs in the browser on any device' },
        { id: 'keyboard', label: 'Keyboard only', desc: 'Tight controls on a computer; not playable on phones.', reason: 'it is a computer game' },
        { id: 'touch', label: 'Touch only', desc: 'Tap and swipe, made for phones; awkward with a mouse.', reason: 'it is a phone game' }
      ],
      when: () => true, infer: (c) => (/\b(touch|toque|celular|phone|mobile)\b/.test(c.f) && /\b(keyboard|teclado)\b/.test(c.f) ? 'both' : /\b(keyboard|teclado|arrow keys|setas|wasd)\b/.test(c.f) ? 'keyboard' : /\b(touch|toque|swipe|deslizar)\b/.test(c.f) ? 'touch' : null)
    },
    {
      id: 'game.players', topic: 'players', multi: false, text: 'Who plays {subject}?',
      options: [
        { id: 'solo', label: 'One player', desc: 'Score and levels against the game; the simplest to balance.', reason: 'one player games are quick to finish and test' },
        { id: 'cpu', label: 'Player against the computer', desc: 'A simple computer opponent; adds AI logic and difficulty levels.', reason: 'the game needs an opponent' },
        { id: 'hotseat', label: 'Two on one device', desc: 'Two players share the keyboard or screen; no network needed.', reason: 'it is played with a friend' }
      ],
      when: (c) => c.vague, infer: (c) => (/\b(two players|2 players|dois jogadores|2 jogadores|multiplayer|versus|contra um amigo)\b/.test(c.f) ? 'hotseat' : /\b(against the computer|contra o computador|vs cpu|ai opponent)\b/.test(c.f) ? 'cpu' : null)
    }
  ],
  extension: [
    {
      id: 'extension.reach', topic: 'reach', multi: false, text: 'On which sites should {subject} work?',
      options: [
        { id: 'active', label: 'Only when clicked', desc: 'activeTab permission: the extension sees a page only when the user clicks it; asks nothing at install.', reason: 'the fewest permissions pass store review fastest' },
        { id: 'some', label: 'On a few named sites', desc: 'Runs by itself on the sites you list; the install dialog names them.', reason: 'it changes specific sites' },
        { id: 'all', label: 'On every site', desc: 'Broad permission: shows a strong warning at install and gets a stricter review.', reason: 'it must act on every page' }
      ],
      when: () => true, infer: (c) => (/\b(every site|all sites|todos os sites|qualquer site)\b/.test(c.f) ? 'all' : /\b[a-z0-9-]+\.(com|org|net|io|dev|app|br)\b/.test(c.raw) ? 'some' : null)
    }
  ],
  data: [
    {
      id: 'data.input', topic: 'input', multi: false, text: 'What does {subject} read?',
      options: [
        { id: 'csv', label: 'A CSV file', desc: 'One spreadsheet export; the script checks columns and reports bad rows.', reason: 'spreadsheets export CSV' },
        { id: 'json', label: 'A JSON file', desc: 'Structured data from an app or API export.', reason: 'the data comes from an app' },
        { id: 'folder', label: 'A folder of files', desc: 'Many files processed in one run with a summary at the end.', reason: 'there are many files' }
      ],
      when: () => true, infer: (c) => (/\b(csv|planilha|spreadsheet|excel|xlsx)\b/.test(c.f) ? 'csv' : /\bjson\b/.test(c.f) ? 'json' : /\b(folder|pasta|files|arquivos)\b/.test(c.f) ? 'folder' : null)
    },
    {
      id: 'data.output', topic: 'output', multi: true, text: 'What should {subject} produce?',
      options: [
        { id: 'table', label: 'Summary in the terminal', desc: 'Totals and counts printed as a table, nothing written to disk.', reason: 'the quickest way to see the answer' },
        { id: 'csv', label: 'A new CSV file', desc: 'Clean or aggregated rows to open in a spreadsheet.', reason: 'the result goes back to a spreadsheet' },
        { id: 'json', label: 'A JSON report', desc: 'Machine readable totals for another program.', reason: 'another program reads it' },
        { id: 'chart', label: 'An SVG chart', desc: 'A bar or line chart as an image file, no libraries.', reason: 'the result is shown to people' }
      ],
      when: (c) => !/\b(report|relatorio|chart|grafico|summary|resumo|total|export|exportar)\b/.test(c.f)
    }
  ],
  cli: [
    {
      id: 'cli.input', topic: 'input', multi: false, text: 'Where does {subject} get its input?',
      options: [
        { id: 'args', label: 'Files given as arguments', desc: 'cli file1 file2: clear and easy to test.', reason: 'arguments are the most common and the easiest to document' },
        { id: 'stdin', label: 'Standard input', desc: 'Works in pipes (cat data | cli); no file names needed.', reason: 'it is part of a pipeline' },
        { id: 'both', label: 'Both', desc: 'Arguments when given, standard input otherwise; a little more code.', reason: 'it is used both ways' }
      ],
      when: (c) => c.vague, infer: (c) => (/\b(stdin|pipe|pipes)\b/.test(c.f) ? 'stdin' : null)
    }
  ],
  devops: [
    {
      id: 'devops.target', topic: 'target', multi: false, text: 'Where will {subject} run?',
      options: [
        { id: 'container', label: 'In a container', desc: 'A Dockerfile with a pinned base image and a non root user; runs the same everywhere.', reason: 'containers are the most portable' },
        { id: 'server', label: 'On a Linux server', desc: 'A systemd service unit with restart and logs; no container runtime needed.', reason: 'there is one server' },
        { id: 'static', label: 'On a static host', desc: 'Only built files are uploaded; no server code runs.', reason: 'it is a static site' }
      ],
      when: () => true, infer: (c) => (/\b(docker\w*|container\w*|containeriz\w*|imagem)\b/.test(c.f) ? 'container' : /\b(systemd|vps|linux server|servidor linux)\b/.test(c.f) ? 'server' : /\b(static|estatico)\b/.test(c.f) ? 'static' : null)
    },
    {
      id: 'devops.ci', topic: 'ci', multi: false, text: 'Should {subject} also get a CI workflow that runs the tests?',
      options: [
        { id: 'yes', label: 'Yes, on every push', desc: 'A CI YAML with pinned actions runs the tests on each push and pull request.', reason: 'it catches broken changes early' },
        { id: 'no', label: 'No CI for now', desc: 'Only the deploy files; tests stay manual.', reason: 'there are no tests yet' }
      ],
      when: (c) => !/\b(ci|pipeline|workflow|actions)\b/.test(c.f)
    }
  ],
  security: [],
  chat: []
};

/** What the crew uses when it does not ask, per domain (one line under the card). */
export const DEFAULTS = {
  web: 'plain HTML, CSS and JavaScript; light and dark theme; responsive from 375 px; system fonts',
  mobile: 'Android and iOS from one codebase; works offline; light and dark theme; installable as a PWA',
  desktop: 'Windows, macOS and Linux; a native window; light and dark theme following the system',
  backend: 'JSON over HTTP on the PORT environment variable; node:test tests; no framework',
  cli: 'Node with util.parseArgs; --help; errors on stderr with exit code 1; node:test tests',
  extension: 'Manifest V3; a popup; storage.local; no remote code',
  game: 'canvas 2D; pauses when the tab is hidden; best score saved in this browser',
  data: 'Node script; the input file is never changed; bad rows reported with their line',
  security: 'secrets, risky code and dependencies; read only; every fix waits for your approval',
  devops: 'pinned versions; non root; secrets only from the environment or the CI secret store'
};

const SUBJECT_NOUNS = new Set(['app', 'apps', 'aplicativo', 'aplicacao', 'site', 'website', 'landing', 'landingpage', 'pagina', 'jogo', 'game', 'api', 'cli', 'tool', 'ferramenta', 'extensao', 'extension', 'programa', 'program', 'script', 'sistema', 'system', 'dashboard', 'painel', 'bot', 'plataforma', 'platform', 'loja', 'store', 'blog', 'portfolio', 'backend', 'server', 'servidor', 'service', 'servico']);
const SUBJECT_STOP = new Set(['a', 'an', 'the', 'my', 'our', 'um', 'uma', 'o', 'meu', 'minha', 'nosso', 'nossa', 'seu', 'sua', 'this', 'that', 'esse', 'essa', 'este', 'esta',
  'make', 'build', 'create', 'write', 'want', 'need', 'develop', 'code', 'design', 'crie', 'cria', 'criar', 'faca', 'faz', 'fazer', 'quero', 'queria', 'preciso', 'desenvolva', 'monte', 'gere', 'escreva', 'i', 'eu', 'me', 'please', 'por', 'favor', 'pfv', 'can', 'you', 'could', 'pode', 'voce', 'simple', 'simples', 'new', 'novo', 'nova', 'and', 'e', 'with', 'com']);
const SUBJECT_LINK = new Set(['de', 'do', 'da', 'dos', 'das', 'for', 'to', 'para', 'pra', 'pro', 'that', 'que', 'of', 'about', 'sobre']);
const SUBJECT_CUT = new Set(['with', 'com', 'and', 'e', 'using', 'usando', 'in', 'em', 'no', 'na', 'on', 'please', 'por', 'simples', 'simple', 'para', 'for']);

/** The request's own name for the thing ("the recipe app", "app de receitas"). */
export function subjectOf(text, lang = 'en') {
  const tokens = String(text || '').replace(/[,.;:!?()]+/g, ' | ').split(/\s+/).filter(Boolean);
  const plain = (w) => fold(w);
  const i = tokens.findIndex((w) => SUBJECT_NOUNS.has(plain(w)));
  let subject = '';
  if (i !== -1) {
    let start = i;
    while (start > 0 && i - start < 2 && !SUBJECT_STOP.has(plain(tokens[start - 1])) && tokens[start - 1] !== '|') start--;
    let end = i + 1;
    if (end < tokens.length && SUBJECT_LINK.has(plain(tokens[end]))) {
      let k = end + 1;
      while (k < tokens.length && k - end <= 3 && tokens[k] !== '|' && !SUBJECT_CUT.has(plain(tokens[k]))) k++;
      while (k > end + 1 && (SUBJECT_LINK.has(plain(tokens[k - 1])) || SUBJECT_STOP.has(plain(tokens[k - 1])))) k--;
      if (k > end + 1) end = k;
    }
    subject = tokens.slice(start, end).join(' ');
  }
  if (!subject || subject.length < 3) return tr(lang, 'domains.subject.default', {}, 'the project');
  if (/^en/.test(lang)) return /^(the|a|an|my)\s/i.test(subject) ? subject.replace(/^(a|an)\s/i, 'the ') : `the ${subject}`;
  return subject;
}

/** Facts about a request that decide which questions are worth asking. */
export function contextOf(text, cls = {}, extra = {}) {
  const f = ` ${fold(text).replace(/\?/g, ' ')} `;
  const words = f.trim().split(' ').filter(Boolean);
  const platformWords = ['mobile', 'desktop', 'backend', 'cli', 'extension', 'game'].some((d) => (cls.scores?.[d] || 0) >= 3);
  return {
    f,
    raw: String(text || '').toLowerCase(),
    data: DATA_WORDS.test(f),
    storage: STORAGE_WORDS.test(f),
    dbWords: /\b(sqlite|database|banco de dados|postgres\w*|mysql|mongo\w*|json file|arquivo json|in memory|em memoria|redis)\b/.test(f),
    multiUser: MULTI_USER.test(f),
    login: LOGIN_WORDS.test(f) && !NO_LOGIN.test(f),
    noLogin: NO_LOGIN.test(f),
    vague: words.length <= 8,
    ambiguousPlatform: cls.domain !== 'chat' && cls.domain !== 'security' && cls.confidence === 'low' && !/\b(site|sites|website|pagina|paginas|page|pages|webpage|homepage|landing|html|css)\b/.test(f) &&
      ((APP_WORDS.test(f) && !platformWords) || PLATFORMS.filter((d) => (cls.scores?.[d] || 0) >= 3).length >= 2),
    memory: extra.memories || [],
    hardware: extra.hardware || null
  };
}

function render(lang, q, subject) {
  const base = `domains.q.${q.id}`;
  return {
    id: q.id, topic: q.topic, multi: !!q.multi,
    text: tr(lang, `${base}.text`, { subject }, q.text.replace('{subject}', subject)),
    options: q.options.map((o) => ({
      id: o.id, label: tr(lang, `${base}.${o.id}.label`, {}, o.label), description: tr(lang, `${base}.${o.id}.desc`, {}, o.desc),
      ...(o.domain ? { domain: o.domain } : {})
    }))
  };
}

/** Puts the recommended option first, marked, with a reason from the context. */
function recommend(q, curated, ctx, cls, lang) {
  let pick = curated.options[0];
  if (q.id === 'platform') {
    const ranked = curated.options.filter((o) => o.domain).sort((a, b) => (cls.scores?.[b.domain] || 0) - (cls.scores?.[a.domain] || 0));
    if ((cls.scores?.[ranked[0].domain] || 0) > 0) pick = ranked[0];
  }
  if (q.id === 'mobile.data' && ctx.multiUser) pick = curated.options.find((o) => o.id === 'server');
  if (q.id === 'mobile.auth' && ctx.multiUser && /\b(share|shared|compartilh\w*|team|equipe)\b/.test(ctx.f)) pick = curated.options.find((o) => o.id === 'accounts');
  if (q.id === 'backend.auth' && ctx.multiUser) pick = curated.options.find((o) => o.id === 'users');
  if ((q.id === 'web.data' || q.id === 'any.data') && ctx.multiUser) pick = curated.options.find((o) => o.id === 'server');
  if (q.id === 'any.auth' && ctx.multiUser) pick = curated.options.find((o) => o.id === 'accounts');
  if (q.id === 'game.controls' && /\b(phone|celular|mobile|touch)\b/.test(ctx.f)) pick = curated.options.find((o) => o.id === 'touch');
  if (q.id === 'backend.data' && ctx.hardware?.lowMemory) pick = curated.options.find((o) => o.id === 'sqlfile');
  const remembered = ctx.memory.find((m) => q.options.some((o) => o.id !== pick.id && new RegExp(`\\b${o.label.toLowerCase()}\\b`).test(fold(m))));
  // Platform options: keep only the likely ones (at most 5), the pick first.
  let options = q.options;
  if (q.id === 'platform') {
    const keep = new Set(['web', 'mobile', 'desktop', 'backend']);
    for (const o of q.options) if ((cls.scores?.[o.domain] || 0) > 0) keep.add(o.id);
    options = q.options.filter((o) => keep.has(o.id)).slice(0, 5);
    if (!options.includes(pick)) options = [pick, ...options.slice(0, 4)];
  }
  const ordered = [pick, ...options.filter((o) => o !== pick)];
  const reason = tr(lang, `domains.q.${q.id}.${pick.id}.reason`, {}, pick.reason);
  return { ordered, reason: remembered ? `${reason}; ${tr(lang, 'domains.reason.memory', {}, 'you used this before')}` : reason };
}

/**
 * The question card for a request, or null when nothing needs asking.
 * @param {{ text: string, cls: any, lang?: string, memories?: string[], hardware?: any, maxQuestions?: number }} input
 * @returns {null | { questions: any[], defaults: string, inferred: Array<{ question: string, option: string }>, subject: string, domain: string }}
 */
export function buildQuestions({ text, cls, lang = 'en', memories = [], hardware = null, maxQuestions = MAX_QUESTIONS }) {
  if (!cls || cls.domain === 'chat') return null;
  const ctx = contextOf(text, cls, { memories, hardware });
  const subject = subjectOf(text, lang);
  const sets = [];
  if (ctx.ambiguousPlatform) sets.push(...QUESTION_SETS.platform);
  else sets.push(...(QUESTION_SETS[cls.domain] || []));
  const questions = [];
  const inferred = [];
  for (const q of sets) {
    const pre = q.infer?.(ctx);
    if (pre) { inferred.push({ question: q.id, option: pre }); continue; }
    if (!q.when(ctx)) continue;
    const curated = render(lang, q, subject);
    const { ordered, reason } = recommend(q, q, ctx, cls, lang);
    const byId = new Map(curated.options.map((o) => [o.id, o]));
    questions.push({
      ...curated,
      options: ordered.map((o, i) => ({ ...byId.get(o.id), ...(i === 0 ? { recommended: true, reason } : {}) }))
    });
  }
  questions.sort((a, b) => TOPIC_ORDER.indexOf(a.topic) - TOPIC_ORDER.indexOf(b.topic));
  const kept = questions.slice(0, Math.max(1, Math.min(MAX_QUESTIONS, maxQuestions)));
  const domain = cls.domain;
  const defaults = tr(lang, `domains.defaults.${domain}`, {}, DEFAULTS[domain] || DEFAULTS.web);
  if (!kept.length) return { questions: [], defaults, inferred, subject, domain };
  return { questions: kept, defaults, inferred, subject, domain };
}

/**
 * The rules for a card (curated or reworded by a model). Returns the problems, empty when it is fine.
 * @param {{ questions: any[] }} card
 * @param {string} [request] the request, for "uses its own words"
 */
export function validateCard(card, request = '') {
  const p = [];
  const qs = card?.questions;
  if (!Array.isArray(qs) || qs.length < 1 || qs.length > MAX_QUESTIONS) return [`1 to ${MAX_QUESTIONS} questions`];
  const reqWords = new Set(fold(request).replace(/[?？]/g, ' ').split(' ').filter((w) => w.length >= 3));
  let lastTopic = -1;
  const ids = new Set();
  for (const q of qs) {
    const where = q?.id || '?';
    if (!q || typeof q.id !== 'string' || ids.has(q.id)) { p.push(`${where}: a unique id`); continue; }
    ids.add(q.id);
    const text = String(q.text || '');
    if (text.length < 10 || text.length > 170 || !/[?？]\s*$/.test(text)) p.push(`${where}: the question is 10 to 170 characters and ends with a question mark`);
    if (GENERIC.test(fold(text))) p.push(`${where}: a generic question`);
    if (reqWords.size && !(card.subject && text.includes(card.subject)) && !fold(text).replace(/[?？]/g, ' ').split(' ').some((w) => reqWords.has(w))) p.push(`${where}: the question does not use the request's words`);
    const topic = TOPIC_ORDER.indexOf(q.topic);
    if (topic === -1) p.push(`${where}: unknown topic ${q.topic}`);
    else if (topic < lastTopic) p.push(`${where}: questions are ordered by impact (platform, data, auth, scope, style)`);
    lastTopic = Math.max(lastTopic, topic);
    const opts = Array.isArray(q.options) ? q.options : [];
    if (opts.length < 2 || opts.length > 5) p.push(`${where}: 2 to 5 options`);
    const labels = new Set();
    opts.forEach((o, i) => {
      const label = String(o?.label || '').trim();
      const n = label.split(/\s+/).filter(Boolean).length;
      if (!o?.id || n < 1 || n > 5 || label.length > 40) p.push(`${where}.${o?.id}: a label of 1 to 5 words`);
      if (labels.has(fold(label))) p.push(`${where}.${o?.id}: labels are unique`);
      labels.add(fold(label));
      const d = String(o?.description || '');
      if (d.length < 12 || d.length > 160) p.push(`${where}.${o?.id}: a description of 12 to 160 characters with the tradeoff`);
      if (GENERIC.test(fold(`${label} ${d}`))) p.push(`${where}.${o?.id}: a generic option`);
      if (i === 0 && !(o.recommended && String(o.reason || '').length >= 6)) p.push(`${where}: the first option is the recommended one, with a reason`);
      if (i > 0 && o.recommended) p.push(`${where}: only the first option is recommended`);
    });
  }
  return p;
}

export const REWORD_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array', maxItems: MAX_QUESTIONS,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' }, text: { type: 'string' },
          options: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, description: { type: 'string' } }, required: ['id', 'description'], additionalProperties: false } }
        },
        required: ['id', 'text', 'options'], additionalProperties: false
      }
    }
  },
  required: ['questions'], additionalProperties: false
};

export function rewordMessages(card, request, language) {
  return [
    { role: 'system', content: `You are a senior engineer and product lead. Reword these clarifying questions for the request so they sound natural and use the request's own words. Keep every id, keep the meaning of each option, keep the tradeoff in each description (at most 140 characters), each question at most 140 characters ending with "?". Write in ${language}. Never add generic questions. Answer with one JSON object.` },
    { role: 'user', content: `Request: ${String(request).slice(0, 800)}\n\nQuestions:\n${JSON.stringify(card.questions.map((q) => ({ id: q.id, text: q.text, options: q.options.map((o) => ({ id: o.id, label: o.label, description: o.description })) })))}` }
  ];
}

/** Applies a model's rewording piece by piece; a piece that breaks a rule keeps the curated text. */
export function applyReword(card, reworded, request) {
  if (!reworded?.questions?.length) return card;
  const questions = card.questions.map((q) => {
    const r = reworded.questions.find((x) => x.id === q.id);
    if (!r) return q;
    let next = { ...q, text: String(r.text || '').trim() || q.text };
    if (validateCard({ questions: [next] }, request).length) next = q;
    const options = next.options.map((o) => {
      const ro = (r.options || []).find((x) => x.id === o.id);
      if (!ro) return o;
      const cand = { ...o, description: String(ro.description || '').trim().slice(0, 160) };
      return validateCard({ questions: [{ ...next, options: next.options.map((x) => (x.id === o.id ? cand : x)) }] }, request).length ? o : cand;
    });
    return { ...next, options };
  });
  return { ...card, questions, reworded: true };
}

/**
 * Checks and normalizes the user's answers.
 * @param {{ questions: any[] }} card
 * @param {Record<string, { options?: string[], other?: string } | string | string[]>} answers
 * @returns {{ answers: Record<string, { options: string[], other?: string }>, problems: string[] }}
 */
export function normalizeAnswers(card, answers = {}) {
  const out = {};
  const problems = [];
  for (const q of card.questions) {
    let a = answers?.[q.id];
    if (a == null) { problems.push(`${q.id}: no answer`); continue; }
    if (typeof a === 'string') a = { options: [a] };
    else if (Array.isArray(a)) a = { options: a };
    const valid = new Set(q.options.map((o) => o.id));
    const options = [...new Set((a.options || []).map(String))].filter((id) => valid.has(id));
    const unknown = (a.options || []).filter((id) => !valid.has(String(id)));
    const other = typeof a.other === 'string' ? a.other.trim().slice(0, 300) : '';
    if (unknown.length) problems.push(`${q.id}: unknown option ${unknown.join(', ')}`);
    if (!options.length && !other) problems.push(`${q.id}: pick an option or write one`);
    if (!q.multi && options.length > 1) problems.push(`${q.id}: only one option`);
    out[q.id] = { options: q.multi ? options : options.slice(0, 1), ...(other ? { other } : {}) };
  }
  return { answers: out, problems };
}

/** "Decide for me": the recommended option of every question. */
export function decideForMe(card) {
  return Object.fromEntries(card.questions.map((q) => [q.id, { options: [q.options.find((o) => o.recommended)?.id || q.options[0].id] }]));
}

/** The domain the answers choose (the platform question), or null. */
export function domainFromAnswers(card, answers) {
  const q = card.questions.find((x) => x.id === 'platform');
  const id = q && answers[q.id]?.options?.[0];
  return q?.options.find((o) => o.id === id)?.domain || null;
}

/** One short line of the decisions, in the user's language (shown before the work starts). */
export function decisionsLine(card, answers) {
  return card.questions.map((q) => {
    const a = answers[q.id] || { options: [] };
    const labels = a.options.map((id) => q.options.find((o) => o.id === id)?.label).filter(Boolean);
    if (a.other) labels.push(`"${a.other}"`);
    return labels.join(' + ');
  }).filter(Boolean).join('; ');
}

/** The decisions as text for the brief, the planner and the improved prompt (English, for the model). */
export function decisionsText(card, answers) {
  const lines = card.questions.map((q) => {
    const a = answers[q.id] || { options: [] };
    const curated = Object.values(QUESTION_SETS).flat().find((x) => x.id === q.id);
    const picked = a.options.map((id) => {
      const o = curated?.options.find((x) => x.id === id);
      return o ? `${o.label} (${o.desc})` : id;
    });
    if (a.other) picked.push(`the user wrote: ${a.other}`);
    return `- ${curated ? curated.text.replace('{subject}', 'it') : q.text} ${picked.join('; ')}`;
  });
  const inferred = (card.inferred || []).map((x) => {
    const q = Object.values(QUESTION_SETS).flat().find((y) => y.id === x.question);
    const o = q?.options.find((y) => y.id === x.option);
    return o ? `- ${q.text.replace('{subject}', 'it')} ${o.label} (from the request)` : null;
  }).filter(Boolean);
  return ['Decisions made with the user:', ...lines, ...inferred, `Defaults: ${DEFAULTS[card.domain] || DEFAULTS.web}.`].join('\n');
}

const ORDINALS = [
  ['first', 'primeiro', 'primeira', '1', '1st', 'primero', 'premier', 'erste', 'primo'],
  ['second', 'segundo', 'segunda', 'two', 'dois', 'duas', '2', '2nd', 'deuxieme', 'zweite', 'secondo'],
  ['third', 'terceiro', 'terceira', 'three', 'tres', '3', '3rd', 'tercero', 'troisieme', 'dritte', 'terzo'],
  ['fourth', 'quarto', 'quarta', 'four', 'quatro', '4', '4th', 'cuarto', 'quatrieme', 'vierte'],
  ['fifth', 'quinto', 'quinta', 'five', 'cinco', '5', '5th', 'cinquieme', 'funfte']
];
const DECIDE = /\b(decide for me|you decide|you choose|whatever|any is fine|decida (voce|vc|por mim)|voce decide|vc decide|tanto faz|pode escolher|escolhe (voce|vc)|o recomendado|recommended|the recommended)\b/;

/**
 * What a spoken or typed answer picks for one question: "the second one", "segunda", "1", or a label.
 * @returns {{ options: string[], decide?: boolean } | null}
 */
export function matchSpoken(question, utterance) {
  const f = ` ${fold(utterance)} `;
  if (DECIDE.test(f)) return { options: [question.options.find((o) => o.recommended)?.id || question.options[0].id], decide: true };
  const picked = [];
  question.options.forEach((o, i) => {
    const label = fold(o.label);
    if (label && f.includes(` ${label} `)) picked.push(o.id);
  });
  if (!picked.length) {
    const words = f.trim().split(' ');
    ORDINALS.forEach((list, i) => {
      if (i < question.options.length && words.some((w) => list.includes(w))) picked.push(question.options[i].id);
    });
  }
  if (!picked.length) {
    // A distinctive word of a label ("phone", "server").
    question.options.forEach((o) => {
      const own = fold(o.label).split(' ').filter((w) => w.length >= 4 && !question.options.some((x) => x !== o && fold(x.label).includes(w)));
      if (own.some((w) => f.includes(` ${w} `))) picked.push(o.id);
    });
  }
  if (!picked.length) return null;
  return { options: question.multi ? [...new Set(picked)] : [picked[0]] };
}
