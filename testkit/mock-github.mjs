/**
 * 模拟 GitHub API（含 GraphQL）。
 *
 * 目的不是"完整复刻 GitHub"，而是精确复刻 **syncEngine 依赖的那几条语义**：
 *   · `git/ref/heads/{branch}` 是**单数** ref，返回**对象**而不是数组
 *   · GraphQL 逻辑错误返回 **HTTP 200** + `{errors:[...]}`
 *   · `createCommitOnBranch` 的 `expectedHeadOid` 不匹配时**也是** 200 + errors
 *   · blob 的 base64 带换行
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

/**
 * @param {Buffer} content
 * @returns {string}
 */
function gitBlobSha(content) {
  const header = Buffer.from(`blob ${content.length}\0`, 'utf8');
  return createHash('sha1').update(Buffer.concat([header, content])).digest('hex');
}

/**
 * 起一个模拟 GitHub 服务。
 *
 * @param {object} [options]
 * @param {string} [options.token]
 * @param {string} [options.owner]
 * @param {string} [options.repo]
 * @returns {Promise<object>}
 */
export async function startMockGithub(options = {}) {
  const expectedToken = options.token ?? 'gh-test-token';
  const owner = options.owner ?? 'alice';
  const repo = options.repo ?? 'neno';

  let headSha = '';
  const commits = new Map();
  const blobs = new Map();
  const requests = [];
  let isEmpty = true;
  /** 记录 GraphQL 收到的 input，供断言 */
  const graphqlInputs = [];

  /**
   * @param {string|null} parent
   * @param {string} message
   * @param {Array<{path: string, sha: string|null}>} entries
   * @returns {string}
   */
  function makeCommitSha(parent, message, entries) {
    return createHash('sha1')
      .update(JSON.stringify({ parent, message, entries }))
      .digest('hex');
  }

  /** @returns {Map<string, {sha: string, content: Buffer}>} */
  function snapshot() {
    if (headSha === '') return new Map();
    return new Map(commits.get(headSha).files);
  }

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://127.0.0.1');
    const { pathname } = url;

    requests.push({ method: req.method, path: pathname, raw: raw.toString('utf8') });

    res.setHeader('Connection', 'close');
    const json = (status, payload, extra = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...extra });
      res.end(JSON.stringify(payload));
    };

    const auth = String(req.headers.authorization ?? '');
    if (auth !== `token ${expectedToken}`) {
      json(401, { message: 'Bad credentials' });
      return;
    }

    // ── /user（带 x-oauth-scopes，这是 GitHub 独有的）──
    if (pathname === '/user' && req.method === 'GET') {
      json(200, { login: owner, name: 'Alice', avatar_url: 'https://example.com/a.png' },
        { 'x-oauth-scopes': 'repo, workflow' });
      return;
    }

    // ── /repos/{o}/{r} ──
    if (pathname === `/repos/${owner}/${repo}` && req.method === 'GET') {
      json(200, { full_name: `${owner}/${repo}`, default_branch: 'main', private: true });
      return;
    }

    // ── /graphql（★ 逻辑错误返回 200）──
    if (pathname === '/graphql' && req.method === 'POST') {
      let payload;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        json(200, { errors: [{ message: 'invalid json' }] });
        return;
      }
      const input = payload?.variables?.input;
      graphqlInputs.push(input);

      if (input === undefined) {
        json(200, { errors: [{ message: 'input 缺失' }] });
        return;
      }

      const expected = input.expectedHeadOid;
      // ★★ 核心语义：tip 不匹配时返回 **HTTP 200** + errors，不是 409
      if (expected !== undefined && expected !== null
        && expected !== (isEmpty ? '' : headSha)) {
        json(200, { errors: [{ message: 'Expected branch to point to a different commit', type: 'STALE_DATA' }] });
        return;
      }

      const current = snapshot();
      /** @type {Map<string, {sha: string, content: Buffer}>} */
      const next = new Map(current);
      /** @type {Array<{path: string, sha: string|null}>} */
      const changed = [];

      for (const addition of input?.fileChanges?.additions ?? []) {
        const content = Buffer.from(String(addition.contents ?? ''), 'base64');
        const sha = gitBlobSha(content);
        blobs.set(sha, content);
        next.set(addition.path, { sha, content });
        changed.push({ path: addition.path, sha });
      }
      for (const deletion of input?.fileChanges?.deletions ?? []) {
        next.delete(deletion.path);
        changed.push({ path: deletion.path, sha: null });
      }

      const sha = makeCommitSha(isEmpty ? null : headSha, String(input?.message?.headline ?? ''), changed);
      commits.set(sha, { parent: isEmpty ? null : headSha, files: next });
      headSha = sha;
      isEmpty = false;

      json(200, { data: { createCommitOnBranch: { commit: { oid: sha } } } });
      return;
    }

    // ── GET /git/ref/heads/{branch}（★ 单数 ref，返回对象）──
    const refMatch = /^\/repos\/([^/]+)\/([^/]+)\/git\/ref\/heads\/(.+)$/.exec(pathname);
    if (refMatch !== null && req.method === 'GET') {
      if (isEmpty || headSha === '') {
        json(404, { message: 'Not Found' });
        return;
      }
      json(200, {
        ref: `refs/heads/${decodeURIComponent(refMatch[3])}`,
        object: { sha: headSha, type: 'commit' },
      }, { ETag: `"${headSha}"` });
      return;
    }

    // ── GET /git/trees/{sha} ──
    const treeMatch = /^\/repos\/([^/]+)\/([^/]+)\/git\/trees\/(.+)$/.exec(pathname);
    if (treeMatch !== null && req.method === 'GET') {
      const sha = decodeURIComponent(treeMatch[3]);
      if (!commits.has(sha)) {
        json(404, { message: 'Not Found' });
        return;
      }
      const files = commits.get(sha).files;
      json(200, {
        sha,
        tree: [...files.entries()].map(([p, item]) => ({
          path: p, mode: '100644', type: 'blob', size: item.content.length, sha: item.sha,
        })),
        truncated: false,
      });
      return;
    }

    // ── GET /git/blobs/{sha} ──
    const blobMatch = /^\/repos\/([^/]+)\/([^/]+)\/git\/blobs\/(.+)$/.exec(pathname);
    if (blobMatch !== null && req.method === 'GET') {
      const content = blobs.get(decodeURIComponent(blobMatch[3]));
      if (content === undefined) {
        json(404, { message: 'Not Found' });
        return;
      }
      // ★ 带换行的 base64
      json(200, {
        content: content.toString('base64').replace(/(.{60})/g, '$1\n'),
        encoding: 'base64',
        size: content.length,
      });
      return;
    }

    // ── PUT /contents/{path}（空仓库引导用；也是 neno 对空仓库的唯一兜底）──
    const putContentsMatch = /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/.exec(pathname);
    if (putContentsMatch !== null && req.method === 'PUT') {
      let payload;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        json(400, { message: 'body 不是合法 JSON' });
        return;
      }
      const filePath = decodeURIComponent(putContentsMatch[3]);
      const content = Buffer.from(String(payload.content ?? ''), 'base64');
      const sha = gitBlobSha(content);
      blobs.set(sha, content);

      const existing = snapshot().get(filePath);
      // 真实 GitHub：更新已存在文件必须带 sha，否则 409
      if (existing !== undefined && String(payload.sha ?? '') !== existing.sha) {
        json(409, { message: `${filePath} does not match ${payload.sha ?? '(missing sha)'}` });
        return;
      }

      const next = snapshot();
      next.set(filePath, { sha, content });
      const commitSha = makeCommitSha(isEmpty ? null : headSha, String(payload.message ?? ''), [
        { path: filePath, sha },
      ]);
      commits.set(commitSha, { parent: isEmpty ? null : headSha, files: next });
      headSha = commitSha;
      isEmpty = false;

      json(201, { content: { path: filePath, sha }, commit: { sha: commitSha } });
      return;
    }

    json(404, { message: `unknown ${req.method} ${pathname}` });
  });

  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    baseUrl,
    owner,
    repo,
    token: expectedToken,
    state: {
      get headSha() { return headSha; },
      get isEmpty() { return isEmpty; },
      requests,
      graphqlInputs,
      snapshot,
      seed(path, content) {
        const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
        const sha = gitBlobSha(buffer);
        blobs.set(sha, buffer);
        const next = snapshot();
        next.set(path, { sha, content: buffer });
        const commitSha = makeCommitSha(isEmpty ? null : headSha, 'seed', [{ path, sha }]);
        commits.set(commitSha, { parent: isEmpty ? null : headSha, files: next });
        headSha = commitSha;
        isEmpty = false;
      },
      resetRequests() { requests.length = 0; graphqlInputs.length = 0; },
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => { server.close(resolve); });
    },
  };
}
