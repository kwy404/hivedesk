// A local stand-in for the GitHub API (127.0.0.1 only). New repositories are local bare
// repositories, so the whole flow runs with no network and no real account.
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function bareRepo(dir) {
  execFileSync('git', ['init', '-q', '--bare', dir], { windowsHide: true });
  execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: dir, windowsHide: true });
  return dir;
}

/**
 * @param {{ token: string, login?: string, reposDir: string, deviceToken?: string }} opts
 */
export async function startStub(opts) {
  const login = opts.login || 'octo-tester';
  const repos = new Map(); // fullName -> repo json
  const pulls = [];
  const seenAuth = [];
  const requests = [];
  let devicePolls = 0;
  const repoJson = (name, priv, cloneUrl) => ({
    id: repos.size + 1, name, full_name: `${login}/${name}`, owner: { login }, private: priv, description: '', default_branch: 'main',
    html_url: `https://github.example/${login}/${name}`, clone_url: cloneUrl, pushed_at: new Date().toISOString(), fork: false, archived: false
  });
  repos.set(`${login}/existing`, repoJson('existing', false, bareRepo(path.join(opts.reposDir, 'existing.git'))));

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const p = url.pathname;
      requests.push({ method: req.method, path: p, body });
      const send = (status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
      const auth = req.headers.authorization || '';
      if (auth) seenAuth.push(auth);
      if (p === '/login/device/code' && req.method === 'POST') return send(200, { device_code: 'dev-code', user_code: 'ABCD-1234', verification_uri: 'https://github.example/login/device', expires_in: 900, interval: 1 });
      if (p === '/login/oauth/access_token' && req.method === 'POST') {
        devicePolls++;
        return send(200, devicePolls < 2 ? { error: 'authorization_pending' } : { access_token: opts.deviceToken || opts.token, token_type: 'bearer' });
      }
      const okAuth = auth === `Bearer ${opts.token}` || (opts.deviceToken && auth === `Bearer ${opts.deviceToken}`);
      if (!okAuth) return send(401, { message: 'Bad credentials' });
      if (p === '/user' && req.method === 'GET') return send(200, { login, id: 4242, name: 'Octo Tester', avatar_url: 'https://github.example/a.png', html_url: `https://github.example/${login}` });
      if (p === '/user/repos' && req.method === 'GET') return send(200, url.searchParams.get('page') === '1' ? [...repos.values()] : []);
      if (p === '/user/repos' && req.method === 'POST') {
        const d = JSON.parse(body || '{}');
        if (repos.has(`${login}/${d.name}`)) return send(422, { message: 'Repository creation failed.', errors: [{ message: 'name already exists on this account' }] });
        const r = repoJson(d.name, !!d.private, bareRepo(path.join(opts.reposDir, `${d.name}.git`)));
        repos.set(r.full_name, r);
        return send(201, r);
      }
      let m = /^\/repos\/([^/]+)\/([^/]+)$/.exec(p);
      if (m && req.method === 'GET') {
        const r = repos.get(`${m[1]}/${m[2]}`);
        return r ? send(200, r) : send(404, { message: 'Not Found' });
      }
      m = /^\/repos\/([^/]+)\/([^/]+)\/pulls$/.exec(p);
      if (m && req.method === 'POST') {
        const d = JSON.parse(body || '{}');
        const pr = { number: pulls.length + 1, title: d.title, body: d.body, state: 'open', html_url: `https://github.example/${m[1]}/${m[2]}/pull/${pulls.length + 1}`, head: { ref: d.head, sha: 'abc123' }, base: { ref: d.base }, draft: false, merged_at: null, repo: `${m[1]}/${m[2]}` };
        pulls.push(pr);
        return send(201, pr);
      }
      m = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/.exec(p);
      if (m) {
        const pr = pulls[Number(m[3]) - 1];
        return pr ? send(200, pr) : send(404, { message: 'Not Found' });
      }
      if (/\/commits\/[^/]+\/check-runs$/.test(p)) return send(200, { total_count: 2, check_runs: [{ name: 'test (20)', status: 'completed', conclusion: 'success', html_url: 'https://github.example/run/1' }, { name: 'lint', status: 'in_progress', conclusion: null, html_url: 'https://github.example/run/2' }] });
      if (/\/commits\/[^/]+\/status$/.test(p)) return send(200, { state: 'pending', statuses: [] });
      send(404, { message: `no stub for ${req.method} ${p}` });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, login, repos, pulls, seenAuth, requests, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
