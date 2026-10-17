// File name to editor language, and the small badges the file tree and tabs show.
// Only languages whose highlighting is shipped (scripts/vendor-monaco.mjs LANGS) are used;
// anything else opens as plain text.

const BY_EXT = {
  html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
  json: 'json', webmanifest: 'json', map: 'json',
  md: 'markdown', markdown: 'markdown', py: 'python', xml: 'xml', svg: 'xml',
  yml: 'yaml', yaml: 'yaml', sh: 'shell', bash: 'shell', bat: 'bat', cmd: 'bat', ps1: 'powershell',
  sql: 'sql', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', c: 'cpp', h: 'cpp', cpp: 'cpp', hpp: 'cpp', cc: 'cpp',
  cs: 'csharp', php: 'php', rb: 'ruby', lua: 'lua', swift: 'swift', ini: 'ini', toml: 'ini', cfg: 'ini', env: 'ini',
  graphql: 'graphql', gql: 'graphql', hbs: 'handlebars', handlebars: 'handlebars', pug: 'pug', r: 'r', dart: 'dart',
  pl: 'perl', scala: 'scala',
};

const BY_NAME = { dockerfile: 'dockerfile', makefile: 'shell', '.gitignore': 'ini', '.editorconfig': 'ini' };

export function languageOf(path) {
  const name = String(path).split('/').pop().toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  const ext = name.includes('.') ? name.split('.').pop() : '';
  return BY_EXT[ext] || 'plaintext';
}

const LABELS = {
  html: 'HTML', css: 'CSS', scss: 'SCSS', less: 'Less', javascript: 'JavaScript', typescript: 'TypeScript', json: 'JSON',
  markdown: 'Markdown', python: 'Python', xml: 'XML', yaml: 'YAML', shell: 'Shell', bat: 'Batch', powershell: 'PowerShell',
  sql: 'SQL', go: 'Go', rust: 'Rust', java: 'Java', kotlin: 'Kotlin', cpp: 'C/C++', csharp: 'C#', php: 'PHP', ruby: 'Ruby',
  lua: 'Lua', swift: 'Swift', dockerfile: 'Dockerfile', ini: 'INI', graphql: 'GraphQL', handlebars: 'Handlebars', pug: 'Pug',
  r: 'R', dart: 'Dart', perl: 'Perl', scala: 'Scala', plaintext: 'Plain text',
};

export const languageLabel = (id) => LABELS[id] || id;

/** [short text, color] for a file badge. */
const BADGES = {
  html: ['<>', '#E8804A'], css: ['#', '#6CB6FF'], scss: ['#', '#E98AD8'], less: ['#', '#6C8CFF'], javascript: ['JS', '#E6D36A'],
  typescript: ['TS', '#6CB6FF'], json: ['{}', '#F2A93B'], markdown: ['M', '#CFC4B3'], python: ['Py', '#7FC98F'], xml: ['<>', '#B39CFF'],
  yaml: ['Y', '#EF7D6B'], shell: ['$', '#7FC98F'], bat: ['$', '#CFC4B3'], powershell: ['PS', '#6CB6FF'], sql: ['DB', '#5FD4C8'],
  plaintext: ['Tx', '#8C8172'],
};

export function badgeOf(path) {
  const lang = languageOf(path);
  const name = String(path).toLowerCase();
  if (/\.(png|jpe?g|gif|webp|ico|avif)$/.test(name)) return ['Im', '#B39CFF'];
  if (name.endsWith('.svg')) return ['Sv', '#F2A93B'];
  return BADGES[lang] || [lang.slice(0, 2).toUpperCase(), '#8C8172'];
}

/** Languages whose formatter ships with the editor (their language services are included). */
export const FORMATTABLE = new Set(['html', 'css', 'scss', 'less', 'json']);
