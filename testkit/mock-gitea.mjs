/**
 * 模拟 Gitea / Forgejo 的 HTTP 服务，用于测试 ForgejoProvider。
 *
 * ## 为什么是真实 HTTP 而不是打桩
 *
 * 这一层的价值全在「协议细节对不对」上：路径是单数还是复数、返回数组还是对象、
 * base64 带不带换行、冲突时返回 409 还是 422。打桩（mock 函数返回值）
 * 只能验证"我预期的形状"，验证不了"真实服务端会这样回"。
 *
 * 所以这里起一个真 HTTP 服务，行为严格按 Gitea 1.22 的 OpenAPI 规范实现。
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

/**
 * 算 git 对象 sha（与真实 git 一致的算法）。
 *
 * 用真实算法而不是随便编一个，是因为 provider 会用 sha 做文件级 CAS 校验 ——
 * 只有真实算法才能验证"改过的文件 sha 会变、没改的不变"。
 *
 * @param {Buffer} content 文件内容
 * @returns {string} 40 位十六进制 sha
 */
export function gitBlobSha(content) {
  const header = Buffer.from(`blob ${content.length}\0`, 'utf8');
  return createHash('sha1').update(Buffer.concat([header, content])).digest('hex');
}

/**
 * 起一个模拟 Gitea 服务。
 *
 * @param {object} [options] 选项
 * @param {string} [options.token] 期望的访问令牌
 * @param {string} [options.owner] 仓库 owner
 * @param {string} [options.repo] 仓库名
 * @returns {Promise<object>} 服务句柄
 */
export async function startMockGitea(options = {}) {
  const expectedToken = options.token ?? 'test-token';
  const owner = options.owner ?? 'alice';
  const repo = options.repo ?? 'neno';

  /** 当前分支 tip 的 commit sha */
  let headSha = '';
  /** commit sha → {parent, files: Map<path, {sha, content}>} */
  const commits = new Map();
  /** 所有 blob：sha → Buffer */
  const blobs = new Map();
  /** 记录所有请求，供断言 */
  const requests = [];
  /** 仓库是否为空 */
  let isEmpty = true;

  /**
   * 生成一个确定性的 commit sha。
   *
   * @param {string|null} parent 父 commit
   * @param {string} message 提交信息
   * @param {Array<{path: string, sha: string|null}>} entries 文件变更
   * @returns {string} 40 位 sha
   */
  function makeCommitSha(parent, message, entries) {
    const text = JSON.stringify({ parent, message, entries });
    return createHash('sha1').update(text).digest('hex');
  }

  /**
   * 取当前 tip 的文件快照。
   *
   * @returns {Map<string, {sha: string, content: Buffer}>} 路径 → 文件
   */
  function snapshot() {
    if (headSha === '') return new Map();
    const commit = commits.get(headSha);
    return new Map(commit.files);
  }

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://127.0.0.1');
    const { pathname, searchParams } = url;

    requests.push({ method: req.method, path: pathname, raw: raw.toString('utf8') });

    res.setHeader('Connection', 'close');
    // 模拟 Gitea 的错误体结构
    const json = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    // ── 认证 ──
    const auth = String(req.headers.authorization ?? '');
    if (auth !== `token ${expectedToken}`) {
      json(401, { message: 'token 无效' });
      return;
    }

    // ── GET /user ──
    if (pathname === '/api/v1/user' && req.method === 'GET') {
      json(200, { login: owner, full_name: 'Alice', avatar_url: 'https://example.com/a.png' });
      return;
    }

    // ── GET /repos/{o}/{r} ──
    if (pathname === `/api/v1/repos/${owner}/${repo}` && req.method === 'GET') {
      json(200, { full_name: `${owner}/${repo}`, default_branch: 'main', private: true });
      return;
    }

    // ── GET /git/refs/heads/{branch}（⚠️ 复数，返回数组）──
    const refMatch = /^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/git\/refs\/heads\/(.+)$/.exec(pathname);
    if (refMatch !== null && req.method === 'GET') {
      if (isEmpty || headSha === '') {
        json(404, { message: 'ref does not exist' });
        return;
      }
      // ★ 关键细节：真实 Gitea 返回**数组**
      json(200, [{
        ref: `refs/heads/${decodeURIComponent(refMatch[3])}`,
        object: { sha: headSha, type: 'commit' },
      }]);
      return;
    }

    // ── GET /git/trees/{sha} ──
    const treeMatch = /^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/git\/trees\/(.+)$/.exec(pathname);
    if (treeMatch !== null && req.method === 'GET') {
      const sha = decodeURIComponent(treeMatch[3]);
      if (sha !== headSha || !commits.has(sha)) {
        json(404, { message: 'tree not found' });
        return;
      }
      const files = commits.get(sha).files;
      const tree = [...files.entries()].map(([p, item]) => ({
        path: p, mode: '100644', type: 'blob', size: item.content.length, sha: item.sha,
      }));
      json(200, { sha, tree, truncated: false, total_count: tree.length });
      return;
    }

    // ── GET /git/blobs/{sha} ──
    const blobMatch = /^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/git\/blobs\/(.+)$/.exec(pathname);
    if (blobMatch !== null && req.method === 'GET') {
      const sha = decodeURIComponent(blobMatch[3]);
      const content = blobs.get(sha);
      if (content === undefined) {
        json(404, { message: 'blob not found' });
        return;
      }
      // ★ 真实 Gitea 返回的 base64 **带换行**
      const encoded = content.toString('base64').replace(/(.{76})/g, '$1\n');
      json(200, { sha, size: content.length, content: encoded, encoding: 'base64' });
      return;
    }

    // ── POST /branches（★ 真实 Gitea 在空仓库上返回 404，不是 201）──
    //
    // 1.22.6 实测：
    //   · 空仓库 + old_branch_name 为空 → 404 "Git Repository is empty."
    //     （它要基于已有提交建分支，所以空仓库根本建不出来）
    //   · 分支已存在 → 409 "The branch already exists."
    //
    // 这也是为什么 bootstrap 不应该走这条路 —— 直接 POST /contents 就能
    // 在空仓库上建出分支和第一个提交。
    if (pathname === `/api/v1/repos/${owner}/${repo}/branches` && req.method === 'POST') {
      let payload;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        json(400, { message: 'body 不是合法 JSON' });
        return;
      }
      const newBranch = String(payload.new_branch_name ?? '');
      if (newBranch === '') {
        json(422, { message: 'new_branch_name 不能为空' });
        return;
      }
      // ★ 空仓库：真实 Gitea 返回 404
      if (isEmpty || headSha === '') {
        json(404, { message: 'Git Repository is empty.' });
        return;
      }
      if (newBranch === 'main') {
        json(409, { message: 'The branch already exists.' });
        return;
      }
      json(201, { name: newBranch });
      return;
    }

    // ── POST /contents（唯一写入口，ChangeFiles）──
    if (pathname === `/api/v1/repos/${owner}/${repo}/contents` && req.method === 'POST') {
      let payload;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        json(400, { message: 'body 不是合法 JSON' });
        return;
      }
      // ★ 真实 Gitea 1.22.6 实测的两条行为，缺一不可：
      //
      //   1. 空仓库：branch 填**任意名字**（含非默认分支）都能直接建出
      //      该分支和第一个提交 → 201。所以空仓库要放行，不能因分支名
      //      不等于 main 就 404。
      //   2. 已有提交的仓库：确实只接受已存在的分支。这里简化为 main。
      const branchName = String(payload.branch ?? 'main');
      const repoIsEmpty = isEmpty || headSha === '';
      if (!repoIsEmpty && branchName !== 'main') {
        json(404, { message: `branch ${branchName} not found` });
        return;
      }
      const files = Array.isArray(payload.files) ? payload.files : [];
      if (files.length === 0) {
        json(422, { message: 'files 不能为空' });
        return;
      }

      const current = snapshot();
      /** @type {Map<string, {sha: string, content: Buffer}>} */
      const next = new Map(current);
      /** @type {Array<{path: string, sha: string|null}>} */
      const changed = [];

      for (const op of files) {
        const path = String(op.path ?? '');
        const operation = String(op.operation ?? '');
        const existing = current.get(path);

        if (operation === 'create') {
          if (existing !== undefined) {
            // 真实 Gitea：对已存在文件用 create 会 422
            json(422, { message: `file ${path} already exists` });
            return;
          }
          const content = Buffer.from(String(op.content ?? ''), 'base64');
          const sha = gitBlobSha(content);
          blobs.set(sha, content);
          next.set(path, { sha, content });
          changed.push({ path, sha });
          continue;
        }

        if (operation === 'update') {
          if (existing === undefined) {
            // ★ 真实 Gitea 1.22.6 实测：update 一个不存在的文件返回 **500**，
            //   而不是 422。响应体是 `object does not exist [id: , rel_path: x]`。
            //   这个不一致很重要 —— 客户端必须把 500 也当冲突处理。
            json(500, { message: `object does not exist [id: , rel_path: ${path}]` });
            return;
          }
          // ★★ 核心：文件级 CAS —— sha 必须与当前一致
          if (String(op.sha ?? '') !== existing.sha) {
            json(409, { message: `sha mismatch for ${path}` });
            return;
          }
          const content = Buffer.from(String(op.content ?? ''), 'base64');
          const sha = gitBlobSha(content);
          blobs.set(sha, content);
          next.set(path, { sha, content });
          changed.push({ path, sha });
          continue;
        }

        if (operation === 'delete') {
          if (existing === undefined) {
            // 同 update：删不存在的文件也是 500（真实 Gitea 行为）
            json(500, { message: `object does not exist [id: , rel_path: ${path}]` });
            return;
          }
          if (String(op.sha ?? '') !== existing.sha) {
            json(409, { message: `sha mismatch for ${path}` });
            return;
          }
          next.delete(path);
          changed.push({ path, sha: null });
          continue;
        }

        json(422, { message: `unknown operation ${operation}` });
        return;
      }

      const sha = makeCommitSha(isEmpty ? null : headSha, String(payload.message ?? ''), changed);
      commits.set(sha, { parent: isEmpty ? null : headSha, files: next });
      headSha = sha;
      isEmpty = false;

      // 真实 ChangeFiles 返回的 commit 结构因版本而异，这里模拟"没有 commit 字段"的版本
      // —— 强制 provider 走 probeHead 兜底，这正是它该有的健壮性
      json(201, { files: changed.map((item) => ({ path: item.path, sha: item.sha })) });
      return;
    }

    json(404, { message: `unknown endpoint ${req.method} ${pathname}` });
  });

  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;

  return {
    baseUrl,
    owner,
    repo,
    token: expectedToken,
    state: {
      get headSha() { return headSha; },
      get isEmpty() { return isEmpty; },
      requests,
      snapshot,
      /** 直接注入文件（模拟别的设备已推过内容） */
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
      resetRequests() { requests.length = 0; },
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => { server.close(resolve); });
    },
  };
}
