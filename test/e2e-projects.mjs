// Real model end to end: the crew builds one project of every kind with the local model on this PC.
// Not part of the unit tests. Usage:
//   npm run e2e:projects -- [--only 1,3] [--model auto|<file.gguf>|<name in the models folder>] [--timeout 25]
//                           [--out <folder>] [--report <file.md>] [--via job|chat]
// Each project runs in its own child process (one engine, one job, one model at a time) with a temp project
// folder and a temp home whose models folder links to the real one (nothing is copied). The child sends the
// request through the same commands the desktop uses (job.create or chat.send in #general), approves the
// brief with brief.approve, answers question cards with "Decide for me" (crew.answer decide), and approves
// writes and runs only when they stay inside the temp workspace. Then the parent checks the result and
// writes report.json and report.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const REAL_HOME = process.env.HIVEDESK_REAL_HOME || path.join(os.homedir(), '.hivedesk');
const MIN_FREE = 3e9;

// ------------------------------------------------------------------ the projects (as a Brazilian user types them)
const SECURITY_FIXTURE = {
  'package.json': JSON.stringify({ name: 'loja-api', version: '1.0.0', type: 'module', scripts: { start: 'node server.js' }, dependencies: {} }, null, 2) + '\n',
  'server.js': [
    "import http from 'node:http';",
    "import { exec } from 'node:child_process';",
    "import crypto from 'node:crypto';",
    "import { query } from './db.js';",
    '',
    "const dbPassword = 'q8Zr2Lm9Vx4Tp7Kw';",
    '',
    'http.createServer((req, res) => {',
    "  const url = new URL(req.url, 'http://localhost');",
    "  if (url.pathname === '/produto') {",
    "    const id = url.searchParams.get('id');",
    "    query(\"SELECT * FROM produtos WHERE id = '\" + id + \"'\", dbPassword).then((rows) => res.end(JSON.stringify(rows)));",
    '    return;',
    '  }',
    "  if (url.pathname === '/arquivo') {",
    "    exec('cat ' + url.searchParams.get('nome'), (err, out) => res.end(out));",
    '    return;',
    '  }',
    "  if (url.pathname === '/hash') {",
    "    res.end(crypto.createHash('md5').update(url.searchParams.get('senha') || '').digest('hex'));",
    '    return;',
    '  }',
    '  res.statusCode = 404;',
    "  res.end('nao encontrado');",
    '}).listen(3000);',
    ''
  ].join('\n'),
  'db.js': "export async function query(sql, password) {\n  return [{ sql, ok: !!password }];\n}\n",
  '.env': 'DB_PASSWORD=q8Zr2Lm9Vx4Tp7Kw\n',
  'README.md': '# loja-api\n\nUma API pequena da loja.\n'
};

export const PROJECTS = [
  { id: 1, slug: 'web', kind: 'web', via: 'chat', request: 'crie uma landing page para uma padaria', expect: ['index.html'], words: /padaria|p[aã]o|p[aã]es|bolo|caf[eé]/i },
  { id: 2, slug: 'mobile', kind: 'mobile', via: 'job', request: 'crie um app de celular de lista de tarefas', expect: ['www/index.html', 'www/manifest.webmanifest', 'www/sw.js', 'capacitor.config.json'], words: /tarefa/i },
  { id: 3, slug: 'desktop', kind: 'desktop', via: 'job', request: 'crie um app desktop de bloco de notas', expect: ['neutralino.config.json', 'resources/index.html'], words: /nota/i },
  { id: 4, slug: 'backend', kind: 'backend', via: 'job', request: 'crie uma API de cadastro de clientes com testes', expect: ['package.json', 'src/server.js', 'src/app.js'], words: /client/i, tests: true },
  { id: 5, slug: 'cli', kind: 'cli', via: 'job', request: 'crie uma ferramenta de linha de comando que renomeia arquivos', expect: ['package.json', 'bin/cli.js', 'src/lib.js'], words: /renome|rename/i, tests: true, help: 'bin/cli.js' },
  { id: 6, slug: 'extension', kind: 'extension', via: 'job', request: 'crie uma extensao do navegador que conta palavras da pagina', expect: ['manifest.json'], words: /palavra|word/i },
  { id: 7, slug: 'game', kind: 'game', via: 'chat', request: 'crie um jogo da cobrinha', expect: ['index.html', 'src/game.js'], words: /cobr|snake/i },
  { id: 8, slug: 'security', kind: 'security', via: 'job', request: 'faca uma auditoria de seguranca deste projeto', fixture: SECURITY_FIXTURE, expect: ['server.js'], findings: ['secret.assignment', 'code.sql-concat', 'code.shell-input'] }
];

// ------------------------------------------------------------------ small helpers
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gb = (b) => (b / 1e9).toFixed(1);

/** A model given as auto, a path, or a file name in the real models folder. */
export function resolveModel(spec, modelsDir = path.join(REAL_HOME, 'models')) {
  if (!spec || spec === 'auto') return null;
  if (fs.existsSync(spec)) return path.resolve(spec);
  const inDir = path.join(modelsDir, spec);
  if (fs.existsSync(inDir)) return inDir;
  const hit = fs.existsSync(modelsDir) ? fs.readdirSync(modelsDir).find((f) => f.toLowerCase().includes(String(spec).toLowerCase())) : null;
  if (hit) return path.join(modelsDir, hit);
  throw new Error(`model not found: ${spec}`);
}

/** Every file of a folder as { path, text } (posix paths), without .hivedesk and node_modules. */
export function readTree(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.hivedesk' || e.name === 'node_modules' || e.name === '.git') continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) {
        const rel = path.relative(root, abs).split(path.sep).join('/');
        let text = '';
        try { text = fs.readFileSync(abs, 'utf8'); } catch { /* binary or locked */ }
        out.push({ path: rel, text, bytes: fs.statSync(abs).size });
      }
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-pid, 'SIGKILL');
  } catch { /* already gone */ }
}

// ------------------------------------------------------------------ the checks (run by the parent, no model loaded)
async function loadCheckers() {
  const { CHECKS, jsSyntax } = await import('../src/crew/library/checks.js');
  const { DOMAINS } = await import('../src/crew/domains/index.js');
  const { templateFiles } = await import('../src/crew/domains/skeletons.js');
  const { checkHtml } = await import('../src/tools/check.js');
  const { npmCli } = await import('../src/brain/runtime.js');
  return { CHECKS, jsSyntax, DOMAINS, templateFiles, checkHtml, npmCli };
}

function runNode(args, cwd, timeout = 120_000) {
  const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout, windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' } });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  return { ok: r.status === 0 && !r.error, status: r.status, out: out.slice(-1500), error: r.error ? String(r.error.message) : undefined };
}

/**
 * The checks of one finished project: files, HTML basics, node --check, the domain's own checks,
 * the skeleton's tests (npm test), and the kind specific bits. Each check: { id, ok, required, detail }.
 */
export async function checkProject(project, ws, result, ck) {
  const files = readTree(ws);
  const byPath = new Map(files.map((f) => [f.path, f]));
  const checks = [];
  const add = (id, ok, detail = '', required = true) => checks.push({ id, ok: !!ok, required, ...(detail ? { detail: String(detail).slice(0, 600) } : {}) });

  add('job.ended', result.status === 'done', result.status === 'done' ? result.summary : `${result.status}: ${result.error || result.summary || result.stuck || ''}`);
  if (project.via === 'chat') add('chat.started-job', !!result.jobId, result.jobId ? `job ${result.jobId} from the chat` : `no job: ${(result.chatReplies || []).join(' / ')}`);

  if (project.kind === 'security') {
    const rep = result.security;
    add('security.report', !!rep, rep ? `${rep.findings.length} findings, ${JSON.stringify(rep.counts)}` : 'no security.report event');
    const ids = new Set((rep?.findings || []).map((f) => f.id));
    for (const id of project.findings) add(`security.finds.${id}`, ids.has(id));
    add('security.fixes-asked', (result.approvals || 0) > 0, `${result.approvals || 0} approvals asked`, false);
    add('security.no-secret-in-events', !result.secretLeak, result.secretLeak || '');
    for (const f of files.filter((x) => /\.m?js$/.test(x.path))) {
      const r = runNode(['--check', path.join(ws, f.path)], ws, 15000);
      add(`node.check ${f.path}`, r.ok, r.ok ? '' : r.out);
    }
    return { checks, files: files.map((f) => ({ path: f.path, bytes: f.bytes })) };
  }

  // 1. The files the kind needs.
  for (const p of project.expect) add(`file ${p}`, byPath.has(p) && byPath.get(p).text.trim().length > 0, byPath.has(p) ? `${byPath.get(p).bytes} B` : 'missing');
  const empty = files.filter((f) => !f.text.trim() && !/\.(png|ico|jpg)$/i.test(f.path));
  add('no empty files', !empty.length, empty.map((f) => f.path).join(', '));

  // 2. HTML basics, links and JS syntax with node --check.
  for (const f of files.filter((x) => /\.html?$/i.test(x.path))) {
    const issues = ck.checkHtml(f.path, f.text, (rel) => byPath.has(rel)).map((i) => i.replace(`${f.path}: `, ''));
    if (!/<meta[^>]+charset=/i.test(f.text)) issues.push('no charset meta');
    add(`html ${f.path}`, !issues.length, issues.join('; '));
  }
  for (const f of files.filter((x) => /\.(m?js|cjs)$/.test(x.path))) {
    const r = runNode(['--check', path.join(ws, f.path)], ws, 15000);
    add(`node.check ${f.path}`, r.ok, r.ok ? '' : r.out.split('\n').filter((l) => l.trim()).slice(0, 4).join(' '));
  }
  for (const f of files.filter((x) => /\.(json|webmanifest)$/.test(x.path))) {
    let ok = true;
    let detail = '';
    try { JSON.parse(f.text); } catch (e) { ok = false; detail = e.message; }
    add(`json ${f.path}`, ok, detail);
  }

  // 3. The domain's own checks (the ones QA runs for this kind), errors only.
  const domain = ck.DOMAINS[project.kind];
  for (const id of domain?.checks || []) {
    const c = ck.CHECKS[id];
    if (!c || c.level !== 'error') continue;
    const relevant = files.filter((f) => c.types.some((t) => f.path.toLowerCase().endsWith(t)));
    if (!relevant.length) { add(`domain ${id}`, false, `no ${c.types.join(' or ')} file to check`); continue; }
    let issues = [];
    try { issues = (await c.run(relevant.map((f) => ({ path: f.path, text: f.text })), { root: ws })) || []; } catch (e) { issues = [`check crashed: ${e.message}`]; }
    add(`domain ${id}`, !issues.length, issues.slice(0, 4).join('; '));
  }

  // 4. Kind specific: the PWA manifest and service worker, the Neutralino config, the extension manifest.
  if (project.kind === 'mobile') {
    let man = null;
    try { man = JSON.parse(byPath.get('www/manifest.webmanifest')?.text || ''); } catch { /* reported above */ }
    add('pwa manifest fields', man && man.name && man.start_url && man.display && Array.isArray(man.icons) && man.icons.length, man ? `name=${man.name} display=${man.display} icons=${man.icons?.length || 0}` : 'no manifest');
    const html = byPath.get('www/index.html')?.text || '';
    const js = files.filter((f) => f.path.startsWith('www/') && /\.js$/.test(f.path)).map((f) => f.text).join('\n');
    add('pwa manifest linked', /<link[^>]+rel=["']manifest["']/i.test(html), '');
    add('pwa service worker registered', /serviceWorker\.register\(/.test(html + js), '');
    let cap = null;
    try { cap = JSON.parse(byPath.get('capacitor.config.json')?.text || ''); } catch { /* reported above */ }
    add('capacitor config', cap && cap.appId && cap.appName && cap.webDir === 'www', cap ? `appId=${cap.appId} webDir=${cap.webDir}` : 'missing');
  }
  if (project.kind === 'desktop') {
    let cfg = null;
    try { cfg = JSON.parse(byPath.get('neutralino.config.json')?.text || ''); } catch { /* reported above */ }
    const url = cfg?.modes?.window ? cfg.url || cfg.documentRoot : null;
    add('neutralino config', cfg && cfg.applicationId && cfg.defaultMode && cfg.modes?.window && Array.isArray(cfg.nativeAllowList), cfg ? `id=${cfg.applicationId} url=${url} allow=${(cfg.nativeAllowList || []).join(',')}` : 'missing');
    add('neutralino no execCommand', !(cfg?.nativeAllowList || []).some((x) => /execCommand|os\.\*/.test(x)), (cfg?.nativeAllowList || []).join(','));
  }
  if (project.kind === 'extension') {
    let man = null;
    try { man = JSON.parse(byPath.get('manifest.json')?.text || ''); } catch { /* reported above */ }
    const refs = [man?.background?.service_worker, man?.action?.default_popup, ...((man?.content_scripts || []).flatMap((c) => c.js || []))].filter(Boolean);
    const missing = refs.filter((r) => !byPath.has(r));
    add('extension manifest v3', man && man.manifest_version === 3 && man.name && man.version, man ? `mv=${man.manifest_version} name=${man.name}` : 'missing');
    add('extension files exist', refs.length && !missing.length, missing.length ? `missing: ${missing.join(', ')}` : refs.join(', '));
  }

  // 5. The project's own tests (the skeleton brings them): npm test when package.json has a test script.
  let pkg = null;
  try { pkg = JSON.parse(byPath.get('package.json')?.text || 'null'); } catch { /* reported above */ }
  if (pkg?.scripts?.test) {
    const cli = ck.npmCli();
    const r = cli ? spawnSync(cli.node, [cli.script, 'test', '--silent'], { cwd: ws, encoding: 'utf8', timeout: 180_000, windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' } }) : null;
    const out = r ? `${r.stdout || ''}${r.stderr || ''}` : 'no npm found';
    const pass = out.match(/# pass (\d+)/)?.[1];
    const fail = out.match(/# fail (\d+)/)?.[1];
    add('npm test', r && r.status === 0, r ? `exit ${r.status}${pass ? `, ${pass} passed, ${fail} failed` : ''}${r.status !== 0 ? `: ${out.split('\n').filter((l) => /not ok|Error|error/.test(l)).slice(0, 5).join(' | ')}` : ''}` : out);
  } else if (project.tests) add('npm test', false, 'no test script in package.json');
  if (project.help && byPath.has(project.help)) {
    const r = runNode([path.join(ws, project.help), '--help'], ws, 20000);
    add('cli --help', r.ok && r.out.trim().length > 0, r.out.split('\n').slice(0, 3).join(' '));
  }

  // 6. It is about the request: the subject shows up in the files, and the work changed the skeleton.
  const text = files.filter((f) => /\.(html?|m?js|json|webmanifest|md|css)$/.test(f.path)).map((f) => f.text).join('\n');
  add('about the request', project.words.test(text), String(text.match(project.words)?.[0] || 'the subject is not in the files'));
  if (domain?.template) {
    const tpl = new Map(ck.templateFiles(domain.template).map((f) => [f.path, f.text]));
    const changed = files.filter((f) => !tpl.has(f.path) || tpl.get(f.path) !== f.text).map((f) => f.path);
    add('skeleton shaped for the request', changed.length > 0, changed.length ? `changed or added: ${changed.slice(0, 8).join(', ')}` : 'the skeleton was left as it was');
  }
  const pt = files.filter((f) => /\.html?$/.test(f.path)).some((f) => /<html\b[^>]*\blang=["']?pt/i.test(f.text));
  if (files.some((f) => /\.html?$/.test(f.path))) add('page in Portuguese (lang pt)', pt, '', false);
  return { checks, files: files.map((f) => ({ path: f.path, bytes: f.bytes })) };
}

// ------------------------------------------------------------------ the child: one engine, one job
async function child() {
  const project = PROJECTS.find((p) => p.id === Number(arg('child')));
  const work = path.resolve(arg('work'));
  const timeoutMs = Number(arg('timeout', '25')) * 60_000;
  const modelPath = arg('model-path') || null;
  const via = arg('via') || project.via;
  const dir = path.join(work, 'project');
  const home = path.join(work, 'home');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const t0 = Date.now();
  const secs = () => Math.round((Date.now() - t0) / 100) / 10;
  const logFile = fs.createWriteStream(path.join(work, 'run.log'));
  const log = (l) => { const line = `[${secs()}s] ${l}`; logFile.write(line + '\n'); if (!arg('quiet')) console.log(line); };

  const { startHive } = await import('../src/index.js');
  const result = { id: project.id, slug: project.slug, kind: project.kind, via, request: project.request, status: 'not started', timeline: {}, turns: 0, turnErrors: [], tokens: { prompt: 0, completion: 0 }, genMs: 0, tools: { calls: 0, errors: [] }, approvals: 0, approvalsRefused: [], chatReplies: [], qa: [], tasks: [], models: {}, events: {} };
  const save = () => fs.writeFileSync(path.join(work, 'result.json'), JSON.stringify(result, null, 2));
  const mark = (k) => { if (result.timeline[k] === undefined) result.timeline[k] = secs(); };

  if (project.fixture) {
    const wsDir = path.join(dir, '.hivedesk', 'workspace');
    for (const [p, text] of Object.entries(project.fixture)) { fs.mkdirSync(path.dirname(path.join(wsDir, p)), { recursive: true }); fs.writeFileSync(path.join(wsDir, p), text); }
  }

  const app = await startHive({ dir, home, memoryHome: home, port: 0, log, flags: { noDownload: true, ...(modelPath ? { model: modelPath } : {}) } });
  const ws = app.toolbox.ws.root;
  result.workspace = ws;
  const cmd = (type, data) => app.server.runCommand(type, data, null);
  const inside = (p) => { if (typeof p !== 'string' || !p) return false; const abs = path.resolve(ws, p); return abs === ws || abs.startsWith(ws + path.sep); };
  let jobId = null;
  let ended = null;
  let lastEvent = { type: 'start', at: 0 };
  let chatMsgId = null;
  const secret = project.fixture ? 'q8Zr2Lm9Vx4Tp7Kw' : null;

  app.bus.on((e) => {
    const d = e.data || {};
    result.events[e.type] = (result.events[e.type] || 0) + 1;
    lastEvent = { type: e.type, at: secs() };
    if (secret && JSON.stringify(d).includes(secret)) result.secretLeak = `${e.type} carried the secret`;
    if (jobId && e.jobId && e.jobId !== jobId && e.type === 'job.created') log(`another job started: ${e.jobId}`);
    switch (e.type) {
      case 'brain.status':
        log(`brain ${d.state} ${d.model || ''} ${d.detail || ''}`);
        if (d.state === 'ready') { result.model = d.model; result.modelDetail = d.detail; result.ctx = d.ctx; mark('modelReady'); }
        break;
      case 'job.created':
        if (!jobId) { jobId = e.jobId; result.jobId = jobId; mark('jobCreated'); log(`job ${jobId} created`); }
        break;
      case 'job.domain': if (e.jobId === jobId) { result.domain = d.domain; result.domainSource = d.source; mark('domain'); log(`domain ${d.domain} (${d.confidence}, ${d.source})`); } break;
      case 'crew.question':
        if (e.jobId !== jobId && jobId) break;
        mark('question');
        result.questions = (d.questions || []).map((q) => q.text);
        log(`question card ${d.id}: ${(d.questions || []).map((q) => q.text).join(' | ')} (Decide for me)`);
        setTimeout(() => cmd('crew.answer', { questionId: d.id, decide: true }).catch((err) => log(`crew.answer failed: ${err.message}`)), 300);
        break;
      case 'brief.proposed':
        mark('brief');
        result.brief = d.brief?.text;
        log(`brief proposed:\n${String(d.brief?.text || '').split('\n').map((l) => `    ${l}`).join('\n')}`);
        setTimeout(() => cmd('brief.approve', { jobId: e.jobId, use: 'refined' }).catch((err) => log(`brief.approve failed: ${err.message}`)), 300);
        break;
      case 'brief.approved': mark('briefApproved'); break;
      case 'job.planned':
        mark('planned');
        result.plan = (d.tasks || []).map((t) => `${t.assignee}: ${t.title}`);
        log(`plan:\n${result.plan.map((l) => `    ${l}`).join('\n')}`);
        break;
      case 'approval.requested': {
        const a = d.approval;
        const ok = a.tool === 'run' ? true : inside(a.args?.path);
        result.approvals++;
        if (!ok) result.approvalsRefused.push(`${a.tool} ${a.args?.path || a.args?.command || ''}`);
        log(`approval ${a.tool} ${a.args?.path || a.args?.command || ''}: ${ok ? 'approve' : 'refuse (outside the workspace)'}`);
        setTimeout(() => cmd('approval.resolve', { approvalId: a.id, approved: ok, note: 'e2e harness' }).catch((err) => log(`approval.resolve failed: ${err.message}`)), 100);
        break;
      }
      case 'turn.ended':
        result.turns++;
        result.tokens.prompt += d.promptTokens || 0;
        result.tokens.completion += d.completionTokens || 0;
        if (!d.error) result.genMs += d.ms || 0;
        if (d.error) result.turnErrors.push(`${d.workerId}: ${String(d.error).slice(0, 200)}`);
        log(`turn ${d.workerId} ${d.promptTokens}+${d.completionTokens} tok ${(d.ms / 1000).toFixed(1)}s ${d.tps} tok/s${d.error ? ' ERROR ' + d.error : ''}`);
        break;
      case 'tool.called':
        result.tools.calls++;
        if (d.tool === 'write_file' || d.tool === 'edit_file') mark('firstWrite');
        log(`  ${d.workerId} -> ${d.tool} ${d.args?.path || d.args?.command || ''}`);
        break;
      case 'tool.result': if (!d.ok) { result.tools.errors.push(String(d.error).slice(0, 200)); log(`  tool error: ${d.error}`); } break;
      case 'task.status': log(`task ${d.taskId} ${d.status}${d.note ? ': ' + d.note : ''}`); break;
      case 'qa.report': result.qa.push({ passed: d.passed, issues: d.issues }); log(`QA ${d.passed ? 'passed' : 'failed'}: ${d.issues.join(' | ')}`); break;
      case 'security.report': result.security = { scanned: d.scanned, counts: d.counts, findings: (d.findings || []).map((f) => ({ id: f.id, severity: f.severity, file: f.file, line: f.line })) }; break;
      case 'models.routed': case 'brain.route': case 'brain.fallback': log(`${e.type} ${JSON.stringify(d).slice(0, 200)}`); break;
      case 'chat.message':
        if (d.from === 'user') break;
        if (d.replyTo && d.replyTo === chatMsgId) {
          result.chatReplies.push(`${d.from}: ${String(d.text).slice(0, 300)}`);
          // "Start as a task or just talk?": the harness picks the task, as a user who wants the project.
          if (Array.isArray(d.choices) && d.choices.some((c) => c.id === 'task')) {
            log('chat offered a choice: start as a task');
            setTimeout(() => cmd('chat.choose', { messageId: chatMsgId, choice: 'task', lang: 'pt-BR' }).catch((err) => log(`chat.choose failed: ${err.message}`)), 300);
          }
        }
        log(`chat ${d.from}: ${String(d.text).replace(/\n/g, ' / ').slice(0, 240)}`);
        break;
      case 'job.done': case 'job.failed': case 'job.cancelled':
        if (e.jobId === jobId) { ended = { type: e.type, data: d }; mark('ended'); }
        break;
      default:
        if (e.type.startsWith('brain.') || e.type.startsWith('models.')) log(`${e.type} ${JSON.stringify(d).slice(0, 160)}`);
    }
  });

  const finish = async (status, extra = {}) => {
    Object.assign(result, { status, ...extra });
    const s = app.bus.state;
    const job = jobId ? s.jobs.find((j) => j.id === jobId) : null;
    if (job) result.tasks = job.taskIds.map((id) => s.tasks[id]).filter(Boolean).map((t) => ({ title: t.title, assignee: t.assignee, kind: t.kind, status: t.status, note: t.note }));
    result.lastEvent = lastEvent;
    result.files = app.toolbox.ws.list().map((f) => ({ path: f.path, bytes: f.bytes }));
    result.seconds = secs();
    result.jobSeconds = result.timeline.jobCreated !== undefined ? Math.round((secs() - result.timeline.jobCreated) * 10) / 10 : null;
    result.tps = result.genMs ? Math.round((result.tokens.completion / (result.genMs / 1000)) * 10) / 10 : 0;
    save();
    log(`result: ${status} ${result.summary || result.error || ''}`);
    const closing = app.close().catch((err) => log(`close failed: ${err.message}`));
    await Promise.race([closing, sleep(60_000)]);
    logFile.end();
    process.exit(0);
  };

  // The model first.
  const loadDeadline = Date.now() + 10 * 60_000;
  while (!['ready', 'error', 'needs_download'].includes(app.bus.state.brain?.state) && Date.now() < loadDeadline) await sleep(500);
  if (app.bus.state.brain?.state !== 'ready') return finish('no model', { error: `${app.bus.state.brain?.state}: ${app.bus.state.brain?.detail || ''}` });
  result.loadSeconds = secs();

  // The request, the way the desktop sends it.
  const started = Date.now();
  try {
    if (via === 'chat') {
      const r = await cmd('chat.send', { channel: 'general', text: project.request, lang: 'pt-BR', jobs: true });
      chatMsgId = r.id;
      log(`chat.send ${r.id}: ${project.request}`);
    } else {
      const r = await cmd('job.create', { request: project.request, lang: 'pt-BR' });
      jobId = r.jobId;
      result.jobId = jobId;
      log(`job.create ${r.jobId}: ${project.request}`);
    }
  } catch (err) {
    return finish('command failed', { error: String(err.message || err) });
  }

  while (!ended && Date.now() - started < timeoutMs) {
    await sleep(1000);
    // The chat answered without a job: give it a few minutes, then stop.
    if (via === 'chat' && !jobId && Date.now() - started > 6 * 60_000 && !app.hive.talks.size) return finish('no job', { error: 'the chat message did not start a job', stuck: lastEvent.type });
  }
  if (!ended) {
    const stage = Object.keys(result.timeline).pop();
    if (jobId) { try { await cmd('job.cancel', { jobId }); } catch { /* ended meanwhile */ } }
    return finish('timeout', { error: `no end after ${Math.round(timeoutMs / 60000)} minutes; last step ${stage}, last event ${lastEvent.type} at ${lastEvent.at}s` });
  }
  const st = { 'job.done': 'done', 'job.failed': 'failed', 'job.cancelled': 'cancelled' }[ended.type];
  // Wait for the end of job report turn (it runs after job.done) so the engine closes cleanly.
  const rep = Date.now();
  while (app.hive.active.size && Date.now() - rep < 5 * 60_000) await sleep(500);
  return finish(st, { summary: ended.data.summary, error: ended.data.error });
}

// ------------------------------------------------------------------ the parent
function waitForRam(log) {
  return (async () => {
    for (let i = 0; i < 60; i++) {
      if (os.freemem() >= MIN_FREE) return true;
      if (i === 0) log(`only ${gb(os.freemem())} GB of RAM free, waiting for ${gb(MIN_FREE)} GB`);
      await sleep(10_000);
    }
    return false;
  })();
}

function markdown(report) {
  const lines = [`# hivedesk ${report.version}: real model projects`, '', `Run ${report.startedAt}, model ${report.model || 'auto'}, ${report.machine}.`, ''];
  lines.push('| # | Project | Via | Result | Time | Turns | tok/s | Files | Checks |', '|---|---|---|---|---|---|---|---|---|');
  for (const p of report.projects) {
    const req = p.checks.filter((c) => c.required);
    const ok = req.filter((c) => c.ok).length;
    lines.push(`| ${p.id} | ${p.slug}: ${p.request} | ${p.via} | ${p.pass ? 'PASS' : 'FAIL'} (${p.status}) | ${p.jobSeconds != null ? `${Math.round(p.jobSeconds / 6) / 10} min` : '-'} | ${p.turns} | ${p.tps} | ${p.files.length} | ${ok}/${req.length} |`);
  }
  lines.push('', `${report.projects.filter((p) => p.pass).length} of ${report.projects.length} passed, ${Math.round(report.seconds / 60)} minutes in all.`, '');
  for (const p of report.projects) {
    lines.push(`## ${p.id}. ${p.slug} (${p.pass ? 'PASS' : 'FAIL'})`, '', `Request: "${p.request}" via ${p.via}. Model ${p.model || '?'} (${p.modelDetail || ''}), loaded in ${p.loadSeconds ?? '?'} s.`);
    lines.push(`Domain ${p.domain || '?'}; job ${p.status} in ${p.jobSeconds ?? '?'} s; ${p.turns} turns, ${p.tokens.prompt} prompt and ${p.tokens.completion} completion tokens, ${p.tps} tok/s; ${p.tools.calls} tool calls (${p.tools.errors.length} errors).`);
    const tl = Object.entries(p.timeline).map(([k, v]) => `${k} ${v}s`).join(', ');
    if (tl) lines.push(`Steps: ${tl}.`);
    if (p.plan?.length) lines.push(`Plan: ${p.plan.join('; ')}.`);
    if (p.qa?.length) lines.push(`QA: ${p.qa.map((q) => (q.passed ? 'passed' : `${q.issues.length} issues`)).join(', ')}.`);
    if (p.error) lines.push(`Error: ${p.error}`);
    const failed = p.checks.filter((c) => !c.ok);
    lines.push(`Files: ${p.files.map((f) => f.path).join(', ') || 'none'}.`);
    if (failed.length) { lines.push('', 'Failed checks:'); for (const c of failed) lines.push(`- ${c.required ? '' : '(info) '}${c.id}${c.detail ? `: ${c.detail}` : ''}`); }
    if (p.turnErrors?.length) lines.push('', `Turn errors: ${p.turnErrors.slice(0, 5).join(' | ')}`);
    lines.push('');
  }
  return lines.join('\n');
}

async function parent() {
  const only = arg('only') ? String(arg('only')).split(',').map(Number) : null;
  const timeoutMin = Number(arg('timeout', '25'));
  const modelPath = resolveModel(arg('model', 'auto'));
  const out = path.resolve(arg('out') || path.join(os.tmpdir(), 'hivedesk-e2e-projects', new Date().toISOString().replace(/[:.]/g, '-')));
  fs.mkdirSync(out, { recursive: true });
  const log = (l) => { console.log(l); fs.appendFileSync(path.join(out, 'harness.log'), l + '\n'); };
  const realModels = path.join(REAL_HOME, 'models');
  if (!fs.existsSync(realModels)) { log(`no models folder at ${realModels}`); process.exit(2); }
  const runtime = process.env.HIVEDESK_LLAMA_RUNTIME || path.join(REAL_HOME, 'runtime', 'node_modules');
  const ck = await loadCheckers();
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const report = { version, startedAt: new Date().toISOString(), model: modelPath ? path.basename(modelPath) : 'auto', machine: `${os.cpus()[0]?.model}, ${gb(os.totalmem())} GB RAM`, out, projects: [] };
  const t0 = Date.now();
  log(`hivedesk ${version} real model projects, out ${out}, model ${report.model}`);
  for (const project of PROJECTS.filter((p) => !only || only.includes(p.id))) {
    const work = path.join(out, `${project.id}-${project.slug}`);
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(path.join(work, 'home'), { recursive: true });
    // The temp home: the real models folder linked (not copied) and the hardware probe of this PC.
    fs.symlinkSync(realModels, path.join(work, 'home', 'models'), 'junction');
    for (const f of ['hardware.json']) { try { fs.copyFileSync(path.join(REAL_HOME, f), path.join(work, 'home', f)); } catch { /* probed again */ } }
    log(`\n== ${project.id}. ${project.slug}: "${project.request}" (${arg('via') || project.via}), free RAM ${gb(os.freemem())} GB`);
    let result;
    if (!(await waitForRam(log))) {
      result = { id: project.id, status: 'skipped', error: `less than ${gb(MIN_FREE)} GB of RAM free` };
    } else {
      const args = [fileURLToPath(import.meta.url), '--child', String(project.id), '--work', work, '--timeout', String(timeoutMin), ...(modelPath ? ['--model-path', modelPath] : []), ...(arg('via') ? ['--via', arg('via')] : []), '--quiet', '1'];
      const env = { ...process.env, HIVEDESK_HOME: path.join(work, 'home'), HIVEDESK_LLAMA_RUNTIME: runtime };
      const started = Date.now();
      const kid = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      kid.stdout.on('data', (b) => fs.appendFileSync(path.join(work, 'child.out'), b));
      kid.stderr.on('data', (b) => fs.appendFileSync(path.join(work, 'child.out'), b));
      const hard = setTimeout(() => { log('child over its time, killing it'); killTree(kid.pid); }, (timeoutMin + 15) * 60_000);
      const code = await new Promise((r) => kid.on('exit', r));
      clearTimeout(hard);
      killTree(kid.pid);
      try { result = JSON.parse(fs.readFileSync(path.join(work, 'result.json'), 'utf8')); } catch { result = { id: project.id, status: 'crashed', error: `the child exited with ${code}: ${fs.existsSync(path.join(work, 'child.out')) ? fs.readFileSync(path.join(work, 'child.out'), 'utf8').slice(-800) : ''}` }; }
      result.wallSeconds = Math.round((Date.now() - started) / 1000);
    }
    const ws = path.join(work, 'project', '.hivedesk', 'workspace');
    const checked = result.status === 'skipped' ? { checks: [{ id: 'ran', ok: false, required: true, detail: result.error }], files: [] } : await checkProject(project, ws, result, ck);
    const entry = { slug: project.slug, request: project.request, via: arg('via') || project.via, turns: 0, tps: 0, tokens: { prompt: 0, completion: 0 }, tools: { calls: 0, errors: [] }, timeline: {}, ...result, ...checked, workspace: ws };
    entry.pass = entry.checks.filter((c) => c.required).every((c) => c.ok);
    report.projects.push(entry);
    log(`   ${entry.pass ? 'PASS' : 'FAIL'} ${entry.status} in ${entry.jobSeconds ?? '?'} s, ${entry.turns} turns, ${entry.tps} tok/s, ${entry.files.length} files`);
    for (const c of entry.checks.filter((x) => !x.ok)) log(`   - ${c.required ? 'FAIL' : 'info'} ${c.id}${c.detail ? `: ${c.detail.slice(0, 200)}` : ''}`);
    report.seconds = Math.round((Date.now() - t0) / 1000);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(out, 'report.md'), markdown(report));
  }
  report.seconds = Math.round((Date.now() - t0) / 1000);
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  const md = markdown(report);
  fs.writeFileSync(path.join(out, 'report.md'), md);
  if (arg('report')) { fs.mkdirSync(path.dirname(path.resolve(arg('report'))), { recursive: true }); fs.writeFileSync(path.resolve(arg('report')), md); }
  log(`\n${report.projects.filter((p) => p.pass).length} of ${report.projects.length} passed. Report: ${path.join(out, 'report.md')}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (arg('child')) await child().catch((err) => { console.error(err); process.exit(1); });
  else await parent();
}
