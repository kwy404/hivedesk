// --demo: a scripted job that runs the real loop (planner, task graph, scheduler, tools, QA) with a fake brain.
// No model is involved. Every event is labeled demo: true by the bus.
import { createFakeBrain } from './brain/fake.js';

export const DEMO_REQUEST = 'A tiny landing page for Crumb, a neighborhood bakery: hero, three breads, opening hours and a contact link.';
export const DEMO_NOTICE = 'This is a demo. No model is running; the crew follows a script.';

const STYLE = `:root {
  --bg: #fff8ef;
  --ink: #2b1d12;
  --muted: #7a6450;
  --accent: #d9822b;
  --card: #ffffff;
  --radius: 14px;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  background: var(--bg);
  color: var(--ink);
  line-height: 1.6;
}

header, main, footer { max-width: 960px; margin: 0 auto; padding: 0 20px; }

.hero {
  display: grid;
  grid-template-columns: 1.2fr 1fr;
  gap: 32px;
  align-items: center;
  padding: 64px 0 40px;
}

.hero h1 { font-size: clamp(2rem, 5vw, 3.4rem); line-height: 1.1; margin: 0 0 12px; }
.hero p { color: var(--muted); font-size: 1.1rem; margin: 0 0 24px; }
.hero img { width: 100%; height: auto; }

.button {
  display: inline-block;
  background: var(--accent);
  color: #fff;
  padding: 12px 22px;
  border-radius: 999px;
  text-decoration: none;
  font-weight: 600;
}

.breads { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin: 24px 0 48px; }
.bread { background: var(--card); border-radius: var(--radius); padding: 20px; box-shadow: 0 1px 3px rgba(43, 29, 18, 0.08); }
.bread h3 { margin: 0 0 6px; }
.bread p { margin: 0; color: var(--muted); }

.hours { background: var(--card); border-radius: var(--radius); padding: 24px; margin-bottom: 48px; }
.hours dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 24px; margin: 0; }
.hours dt { font-weight: 600; }

footer { padding: 24px 20px 48px; color: var(--muted); }

@media (max-width: 700px) {
  .hero { grid-template-columns: 1fr; padding-top: 40px; }
  .breads { grid-template-columns: 1fr; }
}
`;

const BREAD_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 220" role="img" aria-label="A loaf of bread">
  <ellipse cx="160" cy="190" rx="130" ry="14" fill="#e9d6bf"/>
  <path d="M40 150c0-60 55-100 120-100s120 40 120 100c0 22-18 34-40 34H80c-22 0-40-12-40-34z" fill="#d9822b"/>
  <path d="M95 95c12 8 18 20 18 34M150 82c12 10 18 24 18 40M205 95c12 8 18 20 18 34" stroke="#f6c58a" stroke-width="10" stroke-linecap="round" fill="none"/>
</svg>
`;

const HTML_FIRST = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Crumb, neighborhood bakery</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <header>
    <section class="hero">
      <div>
        <h1>Bread worth waking up for.</h1>
        <p>Crumb bakes small batches every morning with flour from local mills.</p>
        <a class="button" href="mailto:hello@crumb.example">Order for tomorrow</a>
      </div>
      <img src="bread.svg" alt="A fresh loaf of bread" width="320" height="220">
    </section>
  </header>
  <main>
    <h2>Our breads</h2>
    <div class="breads">
      <article class="bread"><h3>Country sourdough</h3><p>Slow, tangy, a crackling crust.</p></article>
      <article class="bread"><h3>Seeded rye</h3><p>Dense, nutty, keeps for days.</p></article>
      <article class="bread"><h3>Morning brioche</h3><p>Soft and buttery, gone by ten.</p></article>
    </div>
    <section class="hours">
      <h2>Opening hours</h2>
      <dl>
        <dt>Tuesday to Friday</dt><dd>7:00 to 15:00</dd>
        <dt>Saturday and Sunday</dt><dd>8:00 to 13:00</dd>
        <dt>Monday</dt><dd>Closed, the oven rests</dd>
      </dl>
    </section>
  </main>
  <footer>
    <p>Crumb bakery, 12 Mill Street. <span id="year"></span></p>
  </footer>
  <script src="app.js"></script>
</body>
</html>
`;

const APP_JS = `// Small touch: keep the footer year current.
const year = document.getElementById('year');
if (year) year.textContent = 'Since 2019, still baking in ' + new Date().getFullYear() + '.';
`;

const README = `# Crumb

A one page site for Crumb, a neighborhood bakery.

## Files

* \`index.html\`: hero, the three breads, opening hours and a contact link
* \`style.css\`: warm colors, a grid that stacks on phones
* \`bread.svg\`: the hero picture
* \`app.js\`: keeps the footer year current

## Run it

Open \`index.html\` in a browser. There is no build step.
`;

const PLAN = {
  summary: 'A small one page site: Designer sets the look, Dev builds the page, Writer adds a README, QA checks it.',
  tasks: [
    { title: 'Set the look', detail: 'Write style.css (warm bakery colors, a hero grid, cards for the breads, a layout that stacks on phones) and bread.svg for the hero.', assignee: 'designer', dependsOn: [] },
    { title: 'Build the page', detail: 'Write index.html with the hero, the three breads, opening hours and a contact link, using style.css. Add app.js for the footer year.', assignee: 'dev', dependsOn: [1] },
    { title: 'Write the README', detail: 'Write README.md: what the site is, the files, how to open it.', assignee: 'writer', dependsOn: [2] },
    { title: 'Check the page', detail: 'Run the checks and look at index.html, style.css and app.js.', assignee: 'qa', dependsOn: [2, 3] }
  ]
};

/** The Hive City demo task (src/city/demo.js): Design, Code, Review, Test, done. */
export const DEMO_CITY_TASK = {
  title: 'Add a weekly specials section',
  detail: 'Show the three specials of this week on the bakery page, between the breads and the opening hours.'
};

const SPECIALS = `    <section class="specials">
      <h2>This week</h2>
      <ul>
        <li>Pumpkin loaf, on Tuesday</li>
        <li>Fig and walnut rye, on Thursday</li>
        <li>Cardamom buns, on Saturday</li>
      </ul>
    </section>
    <section class="hours">`;

const DESIGN = {
  spec: 'In index.html, add a section with class "specials" right before the opening hours: an h2 "This week" and a list of three specials, each with its day. Reuse the existing card look; no new files.',
  criteria: ['index.html has a "This week" section before the opening hours', 'The section lists three specials, each with a day', 'The page still passes the static checks']
};

const SCRIPTS = {
  [DEMO_CITY_TASK.title]: [
    { tool: 'read_file', args: { path: 'index.html' } },
    { tool: 'edit_file', args: { path: 'index.html', search: '    <section class="hours">', replace: SPECIALS } },
    { tool: 'done', args: { summary: 'Added the weekly specials section before the opening hours.' } }
  ],
  'Set the look': [
    { tool: 'say', args: { text: 'Going for warm crust colors and a lot of air around the text.' } },
    { tool: 'write_file', args: { path: 'style.css', content: STYLE } },
    { tool: 'write_file', args: { path: 'bread.svg', content: BREAD_SVG } },
    { tool: 'done', args: { summary: 'style.css and bread.svg are ready.' } }
  ],
  'Build the page': [
    { tool: 'read_file', args: { path: 'style.css' } },
    { tool: 'write_file', args: { path: 'index.html', content: HTML_FIRST } },
    { tool: 'write_file', args: { path: 'app.js', content: APP_JS } },
    { tool: 'done', args: { summary: 'index.html and app.js are written, using the styles from Designer.' } }
  ],
  'Write the README': [
    { tool: 'list_files', args: {} },
    { tool: 'write_file', args: { path: 'README.md', content: README } },
    { tool: 'done', args: { summary: 'README.md explains the files and how to open the page.' } }
  ],
  'Check the page': [
    { tool: 'check', args: {} },
    { tool: 'run', args: { command: 'node --check app.js' } },
    { tool: 'report', args: { passed: false, issues: ['index.html: the footer has no way to reach the bakery. Fix: add the email link hello@crumb.example to the footer.'] } }
  ],
  'Fix the QA issues (round 1)': [
    { tool: 'read_file', args: { path: 'index.html' } },
    { tool: 'edit_file', args: { path: 'index.html', search: 'Crumb bakery, 12 Mill Street.', replace: 'Crumb bakery, 12 Mill Street. Write to <a href="mailto:hello@crumb.example">hello@crumb.example</a>.' } },
    { tool: 'done', args: { summary: 'Added the email link to the footer.' } }
  ],
  'Check the fixes': [
    { tool: 'check', args: {} },
    { tool: 'report', args: { passed: true, issues: [] } }
  ]
};

function taskTitle(messages) {
  const first = messages.find((m) => m.role === 'user')?.content || '';
  const m = first.match(/Your task: ([^\n]+)/);
  return m ? m[1].trim() : '';
}

const BRIEF = {
  goal: 'A one page site for Crumb, a neighborhood bakery, so neighbors know what is baked and when the shop is open.',
  build: ['index.html: a hero with a call to order, the three breads, opening hours and a contact link', 'style.css: warm bakery colors, cards for the breads, a layout that stacks on phones', 'bread.svg: a simple picture for the hero', 'README.md: what the site is and how to open it'],
  constraints: ['Plain HTML and CSS, a tiny app.js at most', 'No network access, no build step', 'Readable text with good contrast'],
  acceptance: ['index.html shows the bakery name, three breads, the opening hours and a way to contact the bakery', 'The page passes the static checks (doctype, lang, viewport, title, alt text, links)', 'The layout works at 375 px wide', 'README.md lists the files'],
  questions: [{ question: 'Online orders?', answer: 'No, an email link is enough' }, { question: 'Photos?', answer: 'One drawn bread picture, no photos' }]
};

const REPORT = {
  improvedPrompt: 'Build a one page site for Crumb, a neighborhood bakery, in plain HTML and CSS with no build step and no network. Files: index.html (hero with "Order for tomorrow", three bread cards: country sourdough, seeded rye, morning brioche; opening hours Tuesday to Sunday; footer with the email hello@crumb.example), style.css (warm colors, cards, stacks under 700 px), bread.svg (a drawn loaf with alt text), app.js (current year in the footer) and README.md (files and how to open). Check: doctype, lang, viewport, title, alt text, every local link exists, works at 375 px.',
  nextPrompts: ['Add a dark mode that follows the system setting.', 'Add a small weekly specials section that reads from a specials.json file.', 'Add a test that checks every local link and image in index.html.']
};

/** The demo responder: the brief and the plan for Mel, a fixed list of actions per task, then the report. */
export function demoRespond(messages, options) {
  if (options.schema?.properties?.spec) return DESIGN;
  if (options.schema?.properties?.approved) return { approved: true, issues: [] };
  if (options.schema?.properties?.goal) return BRIEF;
  if (options.schema?.properties?.improvedPrompt) return REPORT;
  if (options.schema?.properties?.tasks) return PLAN;
  const title = taskTitle(messages);
  const step = messages.filter((m) => m.role === 'assistant').length;
  const script = SCRIPTS[title];
  const isQa = !!options.schema?.oneOf?.some((o) => o.properties?.tool?.const === 'report');
  if (!script) return isQa ? { tool: 'report', args: { passed: true, issues: [] } } : { tool: 'done', args: { summary: 'Done.' } };
  return script[Math.min(step, script.length - 1)];
}

export function createDemoBrain(opts = {}) {
  return createFakeBrain({
    id: opts.id || 'demo',
    label: opts.label || 'Demo script (no model)',
    model: 'demo script',
    respond: demoRespond,
    delayMs: opts.delayMs ?? 400,
    tokenDelayMs: opts.tokenDelayMs ?? 20
  });
}
