// A vulnerable project for the security audit tests, written into a temporary folder. Secret shaped
// values are built from parts at run time, so the repository itself never holds a string that looks
// like a real key.
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers.js';

const j = (...parts) => parts.join('');
export const SECRETS = {
  aws: j('AKIA', 'Q3EXAMPLE7KEY2AB'),
  github: j('gh', 'p_', 'k3J9xQ2mZ7vB4nL8wR1tY6uP0sD5fG2hA9cE'),
  pem: j('-----BEGIN ', 'RSA PRIVATE KEY-----'),
  token: j('9f8Kq2', 'Lm4Zx7Rt1Vb6Np3Wc'),
  stripe: j('sk_', 'live_', '51HxKq2Lm4Zx7Rt1Vb6Np3Wc')
};

/** file -> text. Line numbers in the tests count from these texts. */
export function vulnerableFiles() {
  return {
    'config.js': [
      "export const region = 'us-east-1';",
      `export const awsKey = '${SECRETS.aws}';`,
      `const apiToken = '${SECRETS.token}';`,
      "export const passwordHint = 'changeme';",
      'export default { apiToken };'
    ].join('\n') + '\n',
    'server.js': [
      "import { exec } from 'node:child_process';",
      "import crypto from 'node:crypto';",
      'export function run(name) {',
      '  exec(`convert ${name} out.png`);',
      '}',
      'export function find(db, id) {',
      "  return db.query(\"SELECT * FROM users WHERE id = '\" + id + \"'\");",
      '}',
      "export const hash = (s) => crypto.createHash('md5').update(s).digest('hex');",
      'export const sessionId = () => Math.random().toString(36).slice(2);',
      'export const agent = { rejectUnauthorized: false };',
      'export const calc = (expr) => eval(expr);'
    ].join('\n') + '\n',
    'public/index.html': [
      '<!doctype html>',
      '<html lang="en">',
      '<head>',
      '  <meta charset="utf-8">',
      '  <title>Shop</title>',
      '</head>',
      '<body>',
      '  <main id="out"></main>',
      '  <script src="app.js"></script>',
      '</body>',
      '</html>'
    ].join('\n') + '\n',
    'public/app.js': [
      "const out = document.getElementById('out');",
      'const name = new URLSearchParams(location.search).get("name");',
      'out.innerHTML = name;',
      "out.innerHTML = '<p>static</p>';"
    ].join('\n') + '\n',
    'tools/load.py': [
      'import yaml, pickle, subprocess',
      'def load(path, data):',
      '    cfg = yaml.load(open(path))',
      '    obj = pickle.loads(data)',
      '    subprocess.run(f"tar xf {path}", shell=True)',
      '    return cfg, obj'
    ].join('\n') + '\n',
    'deploy/key.pem': `${SECRETS.pem}\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\n`,
    '.env': `GITHUB_TOKEN=${SECRETS.github}\nSTRIPE_KEY=${SECRETS.stripe}\n`,
    '.gitignore': 'node_modules\n',
    '.env.example': 'GITHUB_TOKEN=your_token_here\n',
    'package.json': JSON.stringify({ name: 'shop', version: '1.0.0', dependencies: { lodash: '^4.17.15', express: '4.18.2', minimist: '1.2.8' }, devDependencies: { 'node-fetch': '~2.6.0' } }, null, 2),
    'requirements.txt': 'pyyaml==5.1\nrequests>=2.31.0\n',
    'node_modules/evil/index.js': `const k = '${SECRETS.aws}';\n`,
    'README.md': '# Shop\n\nA small shop.\n'
  };
}

export function writeProject(files = vulnerableFiles()) {
  const root = path.join(tmpDir('audit-'), 'project');
  for (const [p, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), text);
  }
  return root;
}

/** Every file of a folder with its modification time and content, to prove the audit wrote nothing. */
export function snapshot(root) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else out[path.relative(root, abs)] = `${fs.statSync(abs).mtimeMs}:${fs.readFileSync(abs, 'utf8')}`;
    }
  };
  walk(root);
  return out;
}
