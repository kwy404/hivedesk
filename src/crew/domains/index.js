// The kinds of work the crew does. Each domain names its stack, the specialist who leads it, the
// offline skeleton it starts from (templates/<id>/), the library categories its playbooks come from
// and the checks QA runs on it. The planner classifies every request into one (classify.js).

/**
 * @typedef {{
 *   id: string, label: string, stack: string, specialist: string | null, helpers: string[],
 *   template: string | null, categories: string[], checks: string[], build: boolean, guidance: string[], honest?: string
 * }} Domain
 */

/** @type {Record<string, Domain>} */
export const DOMAINS = {
  web: {
    id: 'web', label: 'Website', stack: 'static HTML, CSS and JavaScript, no build step', specialist: null, helpers: ['designer'],
    template: null, categories: ['web-pages', 'ui-components', 'design', 'app-types'], checks: [], build: true,
    guidance: ['Plain HTML, CSS and JavaScript files that open in a browser, no build step.']
  },
  mobile: {
    id: 'mobile', label: 'Mobile app', stack: 'an installable PWA with a Capacitor config for Android and iOS', specialist: 'mobile', helpers: ['designer'],
    template: 'mobile', categories: ['mobile'], checks: ['pwa.manifest', 'pwa.service-worker', 'capacitor.config', 'html.viewport', 'js.syntax', 'json.valid'], build: true,
    guidance: [
      'The app is a PWA in www/ (index.html, app.js, style.css, manifest.webmanifest, sw.js) plus capacitor.config.json at the root.',
      'Design for phones first: tap targets of at least 44 px, safe area insets, no hover only actions.',
      'Everything works offline; data stays on the device (localStorage or IndexedDB) unless the user asked for a server.'
    ],
    honest: 'Native Android and iOS builds need Android Studio or Xcode on this computer (npx cap add android, npx cap open android); the PWA installs from the browser without them.'
  },
  desktop: {
    id: 'desktop', label: 'Desktop app', stack: 'a Neutralinojs app (HTML, CSS and JavaScript in a native window)', specialist: 'desktop', helpers: ['designer'],
    template: 'desktop', categories: ['desktop'], checks: ['neu.config', 'js.syntax', 'json.valid', 'html.lang'], build: true,
    guidance: [
      'The UI lives in resources/ (index.html, js/main.js, styles.css); neutralino.config.json lists only the native calls the app uses in nativeAllowList.',
      'Logic that does not touch the window goes in plain modules that node:test can import.',
      'Never allow os.execCommand unless the user asked for running programs.'
    ],
    honest: 'Running and packaging it needs the Neutralinojs binaries (npx @neutralinojs/neu update, then neu run or neu build); installers and code signing are separate steps per OS.'
  },
  backend: {
    id: 'backend', label: 'Backend API', stack: 'a Node HTTP API (node:http, no framework) with node:test tests', specialist: 'backend', helpers: [],
    template: 'backend', categories: ['backend', 'stacks'], checks: ['node.http-status', 'node.json-content-type', 'node.body-limit', 'node.test-runner', 'js.syntax', 'pkg.scripts', 'sec.sql-params', 'sec.no-secrets'], build: true,
    guidance: [
      'src/server.js creates the server and routes, src/app.js holds the handlers as plain functions, test/api.test.js starts the server on port 0 and calls it with fetch.',
      'JSON in and out with application/json, a body size limit, 400 for bad input, 404 for unknown routes, never a stack trace in a response.',
      'Configuration and secrets come from environment variables, never from the code.'
    ]
  },
  cli: {
    id: 'cli', label: 'Command line tool', stack: 'a Node CLI with util.parseArgs and node:test tests', specialist: null, helpers: [],
    template: 'cli', categories: ['tools'], checks: ['node.shebang', 'node.exit-code', 'cli.help', 'node.test-runner', 'js.syntax', 'pkg.scripts'], build: true,
    guidance: [
      'bin/cli.js parses flags with util.parseArgs (strict), prints --help, writes results to stdout and errors to stderr with a non zero exit code.',
      'The work itself is in src/lib.js as pure functions so test/cli.test.js can test it and also spawn the CLI.'
    ]
  },
  extension: {
    id: 'extension', label: 'Browser extension', stack: 'a Manifest V3 extension (service worker, popup, content script)', specialist: null, helpers: ['designer'],
    template: 'extension', categories: ['tools'], checks: ['ext.manifest-v3', 'ext.no-remote-code', 'js.syntax', 'json.valid', 'js.safe-dom'], build: true,
    guidance: [
      'manifest.json is Manifest V3 with background.service_worker, the fewest permissions (activeTab before host permissions) and no remote code.',
      'Popup and content script talk to the service worker with chrome.runtime.sendMessage; state goes to chrome.storage.local.'
    ],
    honest: 'Load it with "Load unpacked" on the extensions page in developer mode; publishing needs a developer account in the browser\'s store.'
  },
  game: {
    id: 'game', label: 'Game', stack: 'a canvas game (requestAnimationFrame loop, keyboard and touch input)', specialist: null, helpers: ['designer'],
    template: 'game', categories: ['games', 'app-types'], checks: ['game.loop', 'js.syntax', 'html.viewport', 'js.storage-guarded'], build: true,
    guidance: [
      'index.html with one canvas, src/game.js with the rules as pure functions (testable), src/main.js with the loop, input and drawing.',
      'The loop uses requestAnimationFrame with a delta time, pauses when the tab is hidden, and the game works with keyboard and touch.'
    ]
  },
  data: {
    id: 'data', label: 'Data script', stack: 'a Node data script (CSV in, report out) with node:test tests', specialist: 'data', helpers: [],
    template: 'data', categories: ['data'], checks: ['js.syntax', 'node.test-runner', 'csv.consistent', 'node.exit-code'], build: true,
    guidance: [
      'src/csv.js parses CSV (quotes, commas inside quotes, empty lines), src/report.js computes the numbers, bin/run.js reads the input and writes the output.',
      'Validate every row, report bad rows with their line number instead of crashing, and keep the input file unchanged.'
    ]
  },
  security: {
    id: 'security', label: 'Security audit', stack: 'a read only audit of the project (secrets, risky code, dependencies)', specialist: 'security', helpers: [],
    template: null, categories: ['security'], checks: ['sec.no-secrets', 'sec.no-shell-input', 'sec.sql-params', 'sec.weak-crypto'], build: false,
    guidance: ['Read only: report findings with severity, file, line and a fix; change nothing until the user approves a fix.']
  },
  devops: {
    id: 'devops', label: 'DevOps', stack: 'container, CI and deploy files (Dockerfile, CI YAML, service units)', specialist: 'devops', helpers: [],
    template: null, categories: ['devops'], checks: ['container.nonroot', 'container.pinned', 'ci.workflow', 'sec.no-secrets'], build: true,
    guidance: [
      'Pin every base image and action version, run containers as a non root user, keep secrets in the CI secret store, and make every step repeatable on a clean machine.',
      'Write the files; never run deploys or touch remote servers.'
    ]
  },
  chat: {
    id: 'chat', label: 'Question', stack: 'an answer in the chat, no build', specialist: null, helpers: [],
    template: null, categories: [], checks: [], build: false, guidance: []
  }
};

export const DOMAIN_IDS = Object.freeze(Object.keys(DOMAINS));
/** The domains a job can build (chat answers and audits do not plan files). */
export const BUILD_DOMAINS = Object.freeze(DOMAIN_IDS.filter((id) => DOMAINS[id].build));

export function domainOf(id) {
  return DOMAINS[id] || DOMAINS.web;
}

/** Planner notes for a domain: the stack, the skeleton files and the rules of the domain. */
export function domainNotes(id, { skeleton = [] } = {}) {
  const d = domainOf(id);
  if (d.id === 'web' && !skeleton.length) return [];
  const out = [`This is a ${d.label.toLowerCase()} job: build ${d.stack}.`, ...d.guidance];
  if (skeleton.length) out.push(`The workspace starts from the ${d.label.toLowerCase()} skeleton (${skeleton.join(', ')}): edit these files for the request instead of starting over, keep the tests passing.`);
  if (d.specialist) out.push(`Give the main build task to ${d.specialist}, the ${d.label.toLowerCase()} specialist.`);
  return out;
}
