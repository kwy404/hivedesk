// A small GitHub REST client on fetch. The base URLs can be pointed at a local stub (tests).

export class GitHubError extends Error {
  constructor(code, message, status, hint) {
    super(message);
    this.code = code;
    if (status) this.status = status;
    if (hint) this.hint = hint;
  }
}

export const TOKEN_PAGE = 'https://github.com/settings/personal-access-tokens/new';

/** The fine-grained token settings the UI shows, in order. */
export const TOKEN_PERMISSIONS = [
  { id: 'access', label: 'Repository access: All repositories (or only the ones hivedesk should use)' },
  { id: 'contents', label: 'Contents: Read and write (clone, commit, push)' },
  { id: 'pulls', label: 'Pull requests: Read and write (open pull requests)' },
  { id: 'statuses', label: 'Commit statuses: Read-only (CI status)' },
  { id: 'actions', label: 'Actions: Read-only (CI status of workflows)' },
  { id: 'admin', label: 'Administration: Read and write (only to create new repositories)' },
  { id: 'metadata', label: 'Metadata: Read-only (GitHub adds it by itself)' }
];

/**
 * @param {{ token?: string | (() => Promise<string>), apiBase?: string, webBase?: string, fetch?: typeof fetch, timeoutMs?: number }} opts
 */
export function createApi(opts = {}) {
  const apiBase = (opts.apiBase || 'https://api.github.com').replace(/\/+$/, '');
  const webBase = (opts.webBase || 'https://github.com').replace(/\/+$/, '');
  const doFetch = opts.fetch || globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  async function tokenValue() {
    return typeof opts.token === 'function' ? opts.token() : opts.token;
  }

  async function call(method, p, body, { base = apiBase, auth = true, form = false } = {}) {
    const headers = { accept: 'application/vnd.github+json', 'user-agent': 'hivedesk', 'x-github-api-version': '2022-11-28' };
    if (auth) {
      const t = await tokenValue();
      if (!t) throw new GitHubError('not_connected', 'GitHub is not connected yet.');
      headers.authorization = `Bearer ${t}`;
    }
    if (form) headers.accept = 'application/json';
    let payload;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await doFetch(base + p, { method, headers, body: payload, signal: ctrl.signal });
    } catch (err) {
      throw new GitHubError('no_network', `Could not reach GitHub: ${err.name === 'AbortError' ? 'it did not answer in time' : err.cause?.code || err.message}.`, 0, 'Check the internet connection, then try again.');
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    if (res.ok) return { json, headers: res.headers, status: res.status };
    throw toError(res, json);
  }

  const enc = encodeURIComponent;

  return {
    apiBase,
    webBase,
    call,
    async user() {
      const { json } = await call('GET', '/user');
      return { login: json.login, name: json.name || null, id: json.id, avatarUrl: json.avatar_url || null, htmlUrl: json.html_url || `${webBase}/${json.login}` };
    },
    /** The user's repositories, most recently pushed first, filtered by `query` (name or description). */
    async repos({ query = '', max = 300 } = {}) {
      const out = [];
      for (let page = 1; page <= 10 && out.length < max; page++) {
        const { json } = await call('GET', `/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member&page=${page}`);
        if (!Array.isArray(json) || !json.length) break;
        out.push(...json.map(repoView));
        if (json.length < 100) break;
      }
      const q = String(query).trim().toLowerCase();
      return q ? out.filter((r) => r.fullName.toLowerCase().includes(q) || (r.description || '').toLowerCase().includes(q)) : out;
    },
    async repo(owner, name) {
      const { json } = await call('GET', `/repos/${enc(owner)}/${enc(name)}`);
      return repoView(json);
    },
    async createRepo({ name, private: priv, description }) {
      const { json } = await call('POST', '/user/repos', { name, private: !!priv, description: description || undefined, auto_init: false });
      return repoView(json);
    },
    async createPull(owner, name, { title, head, base, body, draft }) {
      const { json } = await call('POST', `/repos/${enc(owner)}/${enc(name)}/pulls`, { title, head, base, body, draft: !!draft });
      return pullView(json);
    },
    async pull(owner, name, number) {
      const { json } = await call('GET', `/repos/${enc(owner)}/${enc(name)}/pulls/${Number(number)}`);
      return pullView(json);
    },
    /** CI for a commit: check runs, then commit statuses. Missing permissions give "unknown", not an error. */
    async ci(owner, name, sha) {
      const checks = [];
      let readable = false;
      try {
        const { json } = await call('GET', `/repos/${enc(owner)}/${enc(name)}/commits/${enc(sha)}/check-runs?per_page=100`);
        readable = true;
        for (const c of json?.check_runs || []) checks.push({ name: c.name, status: c.status, conclusion: c.conclusion || null, url: c.html_url || null });
      } catch (err) { if (!['github_forbidden', 'not_found'].includes(err.code)) throw err; }
      try {
        const { json } = await call('GET', `/repos/${enc(owner)}/${enc(name)}/commits/${enc(sha)}/status`);
        readable = true;
        for (const s of json?.statuses || []) checks.push({ name: s.context, status: s.state === 'pending' ? 'in_progress' : 'completed', conclusion: s.state === 'pending' ? null : s.state, url: s.target_url || null });
      } catch (err) { if (!['github_forbidden', 'not_found'].includes(err.code)) throw err; }
      return { state: readable ? ciState(checks) : 'unknown', checks };
    },
    /** Device flow step 1 (no token needed). */
    async deviceStart(clientId, scope = 'repo') {
      const { json } = await call('POST', '/login/device/code', { client_id: clientId, scope }, { base: webBase, auth: false, form: true });
      if (!json?.device_code) throw new GitHubError('github_invalid', 'GitHub did not start the device sign in. Check the client id in config.json.');
      return { deviceCode: json.device_code, userCode: json.user_code, verificationUri: json.verification_uri, expiresIn: json.expires_in, interval: json.interval || 5 };
    },
    /** Device flow step 2: one poll. Returns { token } or { pending, slowDown }. */
    async devicePoll(clientId, deviceCode) {
      const { json } = await call('POST', '/login/oauth/access_token', { client_id: clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }, { base: webBase, auth: false, form: true });
      if (json?.access_token) return { token: json.access_token };
      if (json?.error === 'authorization_pending') return { pending: true };
      if (json?.error === 'slow_down') return { pending: true, slowDown: true };
      if (json?.error === 'expired_token') throw new GitHubError('expired', 'The code expired before it was entered. Start again.');
      if (json?.error === 'access_denied') throw new GitHubError('denied', 'The sign in was cancelled on GitHub.');
      throw new GitHubError('github_invalid', `GitHub refused the device sign in: ${json?.error_description || json?.error || 'unknown error'}.`);
    }
  };
}

export function repoView(r) {
  return {
    id: r.id, name: r.name, fullName: r.full_name, owner: r.owner?.login, private: !!r.private,
    description: r.description || '', defaultBranch: r.default_branch || 'main', htmlUrl: r.html_url, cloneUrl: r.clone_url,
    pushedAt: r.pushed_at || null, fork: !!r.fork, archived: !!r.archived
  };
}

export function pullView(p) {
  return {
    number: p.number, title: p.title, state: p.merged_at ? 'merged' : p.state, url: p.html_url,
    head: p.head?.ref, headSha: p.head?.sha, base: p.base?.ref, draft: !!p.draft
  };
}

export function ciState(checks) {
  if (!checks.length) return 'none';
  if (checks.some((c) => c.status !== 'completed')) return 'pending';
  if (checks.some((c) => ['failure', 'error', 'timed_out', 'cancelled', 'action_required'].includes(c.conclusion))) return 'failure';
  return 'success';
}

function toError(res, json) {
  const msg = json?.message || res.statusText || 'error';
  const detail = Array.isArray(json?.errors) && json.errors.length ? json.errors.map((e) => e.message || e.code).filter(Boolean).join('; ') : '';
  if (res.status === 401) return new GitHubError('github_unauthorized', 'GitHub refused the token (401). It may be expired or revoked.', 401, 'Connect GitHub again.');
  if ((res.status === 403 || res.status === 429) && (res.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(msg))) {
    const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
    const when = reset ? ` Try again after ${new Date(reset).toLocaleTimeString()}.` : '';
    return new GitHubError('rate_limited', `GitHub rate limit reached.${when}`, res.status);
  }
  if (res.status === 403) return new GitHubError('github_forbidden', `GitHub said no (403): ${msg}.`, 403, 'The token may lack a permission for this. Check the list of permissions in the GitHub window.');
  if (res.status === 404) return new GitHubError('not_found', `GitHub could not find it (404): ${msg}. With a fine-grained token, a repository the token cannot see also looks like this.`, 404);
  if (res.status === 422) return new GitHubError('github_invalid', `GitHub refused the request: ${detail || msg}.`, 422);
  return new GitHubError('github_error', `GitHub answered ${res.status}: ${msg}.`, res.status);
}
