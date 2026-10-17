// SEO Check: runs in the hivedesk sandbox and reads the workspace through api.workspace.
import { checkPage } from './rules.js';

export const tools = {
  async audit(args, api) {
    const files = await api.workspace.list();
    const pages = files.map((f) => f.path).filter((p) => /\.html?$/i.test(p) && (!args.path || p === args.path));
    if (!pages.length) return { score: 0, pages: [], summary: args.path ? `${args.path} is not an HTML page in the workspace` : 'No HTML pages in the workspace yet' };
    const results = [];
    for (const path of pages.slice(0, 40)) {
      const html = await api.workspace.read(path);
      results.push({ path, ...checkPage(html) });
    }
    const score = Math.round(results.reduce((n, r) => n + r.score, 0) / results.length);
    const issues = results.reduce((n, r) => n + r.issues.length, 0);
    const report = { score, pages: results, summary: `${results.length} page${results.length === 1 ? '' : 's'}, score ${score} of 100, ${issues} issue${issues === 1 ? '' : 's'}`, checkedAt: new Date().toISOString() };
    await api.storage.set('last', report);
    return report;
  }
};
