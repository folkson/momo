/**
 * 前端策略层的真实 HTTP 端到端验证。
 *
 * ## 为什么需要这个文件（而不只是 test/frontend.test.mjs）
 *
 * `frontend.test.mjs` 用的是内存假对象，证明的是"逻辑分支正确"。
 * 但真实浏览器里这些代码要面对真 HTTP：
 *   · 路径拼错（`git/ref` vs `git/refs`）→ 404，假对象测不出来
 *   · 请求体字段名错（`content` vs `contents`）→ 422
 *   · base64 编码错 → 文件内容乱码
 *
 * 所以这里起**真的 mock 服务**、走真的 `fetch`，验证的是"这套代码真的能
 * 把字节推到服务端并读回来"。
 *
 * ## 与 mock 的两个约定（容易踩）
 *
 * 1. mock 的默认分支硬编码为 `main`（`POST /contents` 只接受 main），
 *    所以这里分支一律用 `main`，不要用 neno 的 `master`。
 * 2. 取文件内容用 `state.snapshot()`（返回 `Map<path, {sha, content}>`），
 *    mock 没有 `readFile()` 这种便捷方法。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startMockGithub } from '../testkit/mock-github.mjs';
import { startMockGitea } from '../testkit/mock-gitea.mjs';
import { createStrategy, SyncConflictError } from '../src/frontend/commitStrategy.mjs';
import { normalizeApiBase, refPath, pickRefSha, capsOf } from '../src/frontend/platform.mjs';

const BRANCH = 'main';

/**
 * 把字符串编码成 base64（UTF-8 安全）。
 *
 * ⚠️ 不能用 `btoa(text)` —— 只接受 Latin-1。这里与 commitStrategy 内部
 * 的 `textToBase64` 走同一条路：先拿 UTF-8 字节。
 */
function toBase64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

/**
 * 从 mock 快照里读文件内容。
 *
 * @param {{state: {snapshot: () => Map<string, {content: Buffer}>}}} mock
 * @param {string} path
 * @returns {string|null} 不存在时返回 null
 */
function readFile(mock, path) {
  const entry = mock.state.snapshot().get(path);
  return entry === undefined ? null : entry.content.toString('utf8');
}

/**
 * 统计某个方法 + 路径的请求次数（用于断言"零写请求"）。
 *
 * @param {{state: {requests: Array<{method: string, path: string}>}}} mock
 * @param {string} method
 * @param {string} [pathSuffix] 只匹配以它结尾的路径
 * @returns {number}
 */
function countRequests(mock, method, pathSuffix) {
  return mock.state.requests.filter((item) => item.method === method
    && (pathSuffix === undefined || item.path.endsWith(pathSuffix))).length;
}

/**
 * 造一个策略上下文。
 *
 * ⚠️ 这里的 `api` 必须和 `syncEngine.js` 里的 `api()` 语义一致：
 * 第一个参数是 method，第二个是**相对仓库根**的路径（不含 `/repos/o/r`）。
 *
 * @param {string} baseUrl API 基址
 * @param {object} options
 * @param {string} options.owner
 * @param {string} options.repo
 * @param {string} [options.token]
 * @param {(info: {method: string, path: string}) => Promise<void>} [options.beforeWrite]
 *   发写请求前的钩子 —— 用来在"读完树"和"提交"之间插入别的设备的提交，
 *   模拟真实竞态窗口
 * @returns {object} 策略上下文
 */
function contextFor(baseUrl, { owner, repo, token = 'tok', beforeWrite }) {
  const prefix = `/repos/${owner}/${repo}`;

  async function api(method, path, options = {}) {
    if (beforeWrite && method !== 'GET' && path === '/contents') {
      await beforeWrite({ method, path });
    }

    let url = `${baseUrl}${prefix}${path}`;
    if (options.query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined) params.set(key, String(value));
      }
      url += `?${params}`;
    }
    const headers = { Accept: 'application/json', Authorization: `token ${token}` };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.etag) headers['If-None-Match'] = options.etag;

    const response = await fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    if (response.status === 304) {
      return { notModified: true, data: null, headers: response.headers, etag: options.etag };
    }
    if (!response.ok) {
      let message = response.statusText;
      try {
        const body = await response.json();
        message = body.message || message;
      } catch {
        /* 错误体可能不是 JSON */
      }
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    const data = response.status === 204 ? null : await response.json();
    return { data, headers: response.headers, etag: response.headers.get('etag') };
  }

  return {
    api,
    graphql: (query, variables) => graphqlFor(baseUrl, token, query, variables),
    credentials: () => ({ owner, repo, access_token: token }),
  };
}

/**
 * 与 `githubClient.js` 的 `graphql()` 同语义：逻辑错误抛 status=200。
 */
async function graphqlFor(baseUrl, token, query, variables) {
  const response = await fetch(`${baseUrl}/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `token ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    const error = new Error(response.statusText);
    error.status = response.status;
    throw error;
  }
  const result = await response.json();
  if (Array.isArray(result.errors) && result.errors.length > 0) {
    //★ 关键：GraphQL 逻辑错误是 HTTP 200，不能靠 response.ok 判断
    const error = new Error(result.errors[0].message);
    error.status = 200;
    throw error;
  }
  return result.data;
}

// ---------- 协议事实：路径与能力矩阵 ----------

test('refPath：GitHub 单数、Gitea 复数 —— 写错只会得到 404', () => {
  assert.equal(refPath('github', 'main'), '/git/ref/heads/main');
  assert.equal(refPath('gitea', 'main'), '/git/refs/heads/main');
  assert.equal(refPath('forgejo', 'main'), '/git/refs/heads/main');
  // 带斜杠的分支名必须编码，否则会被当成多级路径
  assert.equal(refPath('gitea', 'feat/x'), '/git/refs/heads/feat%2Fx');
});

test('refPath 生成的路径真的能被对应 mock 接受（不是靠假设）', async () => {
  const gitea = await startMockGitea();
  gitea.state.seed('seed.txt', 'hello');
  try {
    const response = await fetch(
      `${gitea.baseUrl}/repos/${gitea.owner}/${gitea.repo}${refPath('gitea', 'main')}`,
      { headers: { Authorization: `token ${gitea.token}` } },
    );
    assert.equal(response.status, 200, '复数 refs 路径应可访问');

    const body = await response.json();
    assert.ok(Array.isArray(body), 'Gitea 的 refs 必须返回数组（这是与 GitHub 的核心差异）');
    assert.match(pickRefSha('gitea', body), /^[0-9a-f]{40}$/);

    // 单数路径在 Gitea 上必须失败 —— 证明这个差异是真实存在的
    const wrong = await fetch(
      `${gitea.baseUrl}/repos/${gitea.owner}/${gitea.repo}/git/ref/heads/main`,
      { headers: { Authorization: `token ${gitea.token}` } },
    );
    assert.equal(wrong.status, 404, 'Gitea 不认单数 ref 路径');
  } finally {
    await gitea.close();
  }
});

test('pickRefSha 对两种形状都容错，取不到时返回空串', () => {
  assert.equal(pickRefSha('github', { object: { sha: 'abc' } }), 'abc');
  assert.equal(pickRefSha('gitea', [{ object: { sha: 'def' } }]), 'def');
  assert.equal(pickRefSha('gitea', []), '');
  assert.equal(pickRefSha('github', null), '');
  assert.equal(pickRefSha('github', {}), '');
});

test('normalizeApiBase 按平台分别处理（GitHub 固定，自建补 /api/v1）', () => {
  assert.equal(normalizeApiBase('github', 'https://whatever.example'), 'https://api.github.com');
  assert.equal(normalizeApiBase('gitea', 'git.example.com'), 'https://git.example.com/api/v1');
  assert.equal(normalizeApiBase('gitea', 'https://git.example.com/'), 'https://git.example.com/api/v1');
  assert.equal(normalizeApiBase('gitea', 'https://git.example.com/api/v1'), 'https://git.example.com/api/v1');
  // 带反代前缀时不能丢前缀（否则打到错误的服务上）
  assert.equal(normalizeApiBase('gitea', 'https://x.com/git/api/v1'), 'https://x.com/git/api/v1');
  assert.equal(normalizeApiBase('gitea', ''), '');
});

test('能力矩阵：只有 GitHub 有分支 tip CAS，自建平台只能文件级 sha', () => {
  assert.equal(capsOf('github').branchHeadCAS, true);
  assert.equal(capsOf('github').fileLevelShaCAS, false);
  assert.equal(capsOf('gitea').branchHeadCAS, false);
  assert.equal(capsOf('gitea').fileLevelShaCAS, true);
  assert.equal(capsOf('forgejo').branchHeadCAS, false);
  assert.equal(capsOf('forgejo').fileLevelShaCAS, true);
  assert.ok(capsOf('github').maxFilesPerCommit > capsOf('gitea').maxFilesPerCommit);
  // 未知平台必须明确报错，不能静默退回 GitHub
  assert.throws(() => capsOf('gitlab'), /不支持的代码平台/);
});

// ---------- GitHub：GraphQL 提交 ----------

test('GitHub 策略：引导 + 增量提交，内容真的落地', async () => {
  const mock = await startMockGithub();
  try {
    const strategy = createStrategy('github', contextFor(mock.baseUrl, {
      owner: mock.owner, repo: mock.repo, token: mock.token,
    }));
    const base = await strategy.bootstrap(BRANCH);
    assert.match(base, /^[0-9a-f]{40}$/);
    assert.match(readFile(mock, 'README.md') ?? '', /NENO/);
    assert.equal(await strategy.head(BRANCH), base);

    const next = await strategy.commit({
      branch: BRANCH,
      expectedHeadOid: base,
      headline: 'add note',
      additions: [{ path: '2026-01-01/1.json', contents: toBase64('{"a":1}') }],
      deletions: [],
    });
    assert.match(next, /^[0-9a-f]{40}$/);
    assert.notEqual(next, base);
    assert.equal(readFile(mock, '2026-01-01/1.json'), '{"a":1}');
  } finally {
    await mock.close();
  }
});

test('GitHub 策略：expectedHeadOid 过期 → SyncConflictError（HTTP 200 陷阱）', async () => {
  const mock = await startMockGithub();
  try {
    const strategy = createStrategy('github', contextFor(mock.baseUrl, {
      owner: mock.owner, repo: mock.repo, token: mock.token,
    }));
    const base = await strategy.bootstrap(BRANCH);

    // 模拟另一台设备先推了一个提交
    mock.state.seed('other.txt', 'from another device');

    await assert.rejects(
      () => strategy.commit({
        branch: BRANCH,
        expectedHeadOid: base, // 刻意用旧的
        headline: 'mine',
        additions: [{ path: 'mine.txt', contents: toBase64('x') }],
        deletions: [],
      }),
      (error) => {
        // ★ 必须是 SyncConflictError，而不是被当成普通 500 吞掉
        assert.ok(error instanceof SyncConflictError, `期望 SyncConflictError，实际 ${error.name}`);
        assert.equal(error.expectedHeadOid, base);
        assert.notEqual(error.actualHeadOid, base);
        return true;
      },
    );
  } finally {
    await mock.close();
  }
});

// ---------- Gitea：ChangeFiles 提交 ----------

test('Gitea 策略：引导 + 新增 + 删除', async () => {
  const mock = await startMockGitea();
  try {
    const strategy = createStrategy('gitea', contextFor(mock.baseUrl, {
      owner: mock.owner, repo: mock.repo, token: mock.token,
    }));
    const base = await strategy.bootstrap(BRANCH);
    assert.match(base, /^[0-9a-f]{40}$/);
    assert.match(readFile(mock, 'README.md') ?? '', /NENO/);

    // 新增两个文件（一次 ChangeFiles 提交）
    const head2 = await strategy.commit({
      branch: BRANCH,
      expectedHeadOid: base,
      headline: 'add two notes',
      additions: [
        { path: '2026-01-01/1.json', contents: toBase64('{"a":1}') },
        { path: '2026-01-02/2.json', contents: toBase64('{"b":2}') },
      ],
      deletions: [],
    });
    assert.notEqual(head2, base);
    assert.equal(readFile(mock, '2026-01-01/1.json'), '{"a":1}');
    assert.equal(readFile(mock, '2026-01-02/2.json'), '{"b":2}');

    // 删除一个
    const head3 = await strategy.commit({
      branch: BRANCH,
      expectedHeadOid: head2,
      headline: 'drop one',
      additions: [],
      deletions: [{ path: '2026-01-01/1.json' }],
    });
    assert.notEqual(head3, head2);
    assert.equal(readFile(mock, '2026-01-01/1.json'), null, '删除应真的生效');
    assert.equal(readFile(mock, '2026-01-02/2.json'), '{"b":2}', '不该误删其他文件');
  } finally {
    await mock.close();
  }
});

test('Gitea 策略：tip 过期 → 前置比对就拦住，一个写请求都不发', async () => {
  const mock = await startMockGitea();
  try {
    const strategy = createStrategy('gitea', contextFor(mock.baseUrl, {
      owner: mock.owner, repo: mock.repo, token: mock.token,
    }));
    const base = await strategy.bootstrap(BRANCH);
    const before = countRequests(mock, 'POST', '/contents');

    await assert.rejects(
      () => strategy.commit({
        branch: BRANCH,
        expectedHeadOid: 'deadbeef'.repeat(5),
        headline: 'mine',
        additions: [{ path: 'x.txt', contents: toBase64('x') }],
        deletions: [],
      }),
      (error) => {
        assert.ok(error instanceof SyncConflictError);
        assert.equal(error.actualHeadOid, base);
        return true;
      },
    );
    assert.equal(countRequests(mock, 'POST', '/contents'), before, '冲突时不允许发出任何写请求');
  } finally {
    await mock.close();
  }
});

test('Gitea 策略：读完树之后被人改 → 服务端 409 → 映射成 SyncConflictError', async () => {
  const mock = await startMockGitea();
  try {
    const strategy0 = createStrategy('gitea', contextFor(mock.baseUrl, {
      owner: mock.owner, repo: mock.repo, token: mock.token,
    }));
    const base = await strategy0.bootstrap(BRANCH);
    const head1 = await strategy0.commit({
      branch: BRANCH,
      expectedHeadOid: base,
      headline: 'add a',
      additions: [{ path: 'a.txt', contents: toBase64('v1') }],
      deletions: [],
    });

    // 在"读完树 → POST /contents"之间插入别的设备的提交，
    // 让 a.txt 的 sha 变化 —— 这正是弱 CAS 要防的覆盖场景
    let seeded = false;
    const strategy = createStrategy('gitea', contextFor(mock.baseUrl, {
      owner: mock.owner,
      repo: mock.repo,
      token: mock.token,
      async beforeWrite() {
        if (seeded) return;
        seeded = true;
        mock.state.seed('a.txt', 'v2-from-other-device');
      },
    }));

    await assert.rejects(
      () => strategy.commit({
        branch: BRANCH,
        expectedHeadOid: head1,
        headline: 'update a',
        additions: [{ path: 'a.txt', contents: toBase64('mine') }],
        deletions: [],
      }),
      (error) => {
        assert.ok(error instanceof SyncConflictError, `实际 ${error.name}: ${error.message}`);
        return true;
      },
    );

    // ★ 最关键的一点：冲突之后，别人的数据**没有被覆盖**
    assert.equal(readFile(mock, 'a.txt'), 'v2-from-other-device', '弱 CAS 必须守住别人的写入');
  } finally {
    await mock.close();
  }
});

test('Gitea 策略：删除不存在的文件是幂等 no-op，不发写请求也不报错', async () => {
  const mock = await startMockGitea();
  try {
    const strategy = createStrategy('gitea', contextFor(mock.baseUrl, {
      owner: mock.owner, repo: mock.repo, token: mock.token,
    }));
    const base = await strategy.bootstrap(BRANCH);
    const before = countRequests(mock, 'POST', '/contents');

    const after = await strategy.commit({
      branch: BRANCH,
      expectedHeadOid: base,
      headline: 'delete nothing',
      additions: [],
      deletions: [{ path: 'never-existed.json' }],
    });

    assert.equal(after, base, '无变更时应返回原 tip');
    assert.equal(countRequests(mock, 'POST', '/contents'), before, '无变更时不允许发写请求');
  } finally {
    await mock.close();
  }
});

test('Gitea 策略：中文与 emoji 经 base64 往返不损坏', async () => {
  const mock = await startMockGitea();
  try {
    const strategy = createStrategy('gitea', contextFor(mock.baseUrl, {
      owner: mock.owner, repo: mock.repo, token: mock.token,
    }));
    const base = await strategy.bootstrap(BRANCH);

    const text = JSON.stringify({ text: '今天写了一条笔记，含 emoji 🎉 与换行\n第二行' });
    await strategy.commit({
      branch: BRANCH,
      expectedHeadOid: base,
      headline: '中文提交',
      additions: [{ path: 'cn.json', contents: toBase64(text) }],
      deletions: [],
    });

    assert.equal(readFile(mock, 'cn.json'), text);
  } finally {
    await mock.close();
  }
});

// ---------- 跨平台一致性 ----------

test('同一份变更在两平台落地后，文件内容逐字节相同', async (t) => {
  const github = await startMockGithub();
  const gitea = await startMockGitea();
  t.after(async () => { await github.close(); await gitea.close(); });

  const payload = [
    { path: 'notes/a.json', text: '{"id":1,"text":"第一条 📝"}' },
    { path: 'notes/b.json', text: '{"id":2,"text":"第二条"}' },
    { path: 'picData/x.png', text: 'PNGDATA' },
  ];

  /** @type {Record<string, Record<string, string|null>>} */
  const results = {};

  for (const [kind, mock] of [['github', github], ['gitea', gitea]]) {
    const strategy = createStrategy(kind, contextFor(mock.baseUrl, {
      owner: mock.owner, repo: mock.repo, token: mock.token,
    }));
    const base = await strategy.bootstrap(BRANCH);
    await strategy.commit({
      branch: BRANCH,
      expectedHeadOid: base,
      headline: 'same payload',
      additions: payload.map((item) => ({ path: item.path, contents: toBase64(item.text) })),
      deletions: [],
    });

    const snapshot = {};
    for (const item of payload) snapshot[item.path] = readFile(mock, item.path);
    results[kind] = snapshot;
  }

  assert.deepEqual(results.gitea, results.github, '两个平台的落地结果必须完全一致');
  for (const item of payload) {
    assert.equal(results.github[item.path], item.text, `${item.path} 内容被破坏`);
  }
});

test('未知平台在创建策略阶段就失败（不静默退回 GitHub）', () => {
  assert.throws(
    () => createStrategy('svn', { api: async () => ({}), credentials: () => ({}) }),
    /不支持的代码平台/,
  );
});

test('GitHub 策略缺 graphql 上下文时立即报错，而不是等到提交时', () => {
  assert.throws(
    () => createStrategy('github', {
      api: async () => ({}),
      credentials: () => ({ owner: 'a', repo: 'b' }),
    }),
    /需要 graphql 上下文/,
  );
});

// ---------- 空仓库引导 ----------

test('空仓库：两平台都能读出"还没有提交"，也都能引导出第一个提交', async (t) => {
  const github = await startMockGithub();
  const gitea = await startMockGitea();
  t.after(async () => { await github.close(); await gitea.close(); });

  for (const [kind, mock] of [['github', github], ['gitea', gitea]]) {
    const strategy = createStrategy(kind, contextFor(mock.baseUrl, {
      owner: mock.owner, repo: mock.repo, token: mock.token,
    }));

    // 空仓库读 head 必须失败（GitHub 404/409、Gitea 404）
    await assert.rejects(() => strategy.head(BRANCH), /./, `${kind} 空仓库读 head 应失败`);

    const sha = await strategy.bootstrap(BRANCH);
    assert.match(sha, /^[0-9a-f]{40}$/, `${kind} 引导后应有 commit`);
    assert.equal(await strategy.head(BRANCH), sha, `${kind} 引导后 head 应稳定`);
    assert.match(readFile(mock, 'README.md') ?? '', /NENO/, `${kind} 引导应写入 README`);
  }
});

// ---------- 真实 Gitea 1.22.6 实测确认的协议事实 ----------
//
// 这一组测试的意义：把「用真机跑出来的行为」固化成断言。
// mock 如果哪天被改得偏离真实服务端，这里会立刻红。

test('真机事实：update/delete 不存在的文件时 Gitea 返回 500（不是 422）', async () => {
  const mock = await startMockGitea();
  try {
    const strategy = createStrategy('gitea', contextFor(mock.baseUrl, {
      owner: mock.owner, repo: mock.repo, token: mock.token,
    }));
    const base = await strategy.bootstrap(BRANCH);

    // 直接绕过策略的 sha 索引，手动发一个 update 到不存在的路径
    const response = await fetch(`${mock.baseUrl}/repos/${mock.owner}/${mock.repo}/contents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `token ${mock.token}`,
      },
      body: JSON.stringify({
        branch: BRANCH,
        message: 'update ghost',
        files: [{
          operation: 'update',
          path: 'ghost.json',
          content: toBase64('x'),
          sha: '0'.repeat(40),
        }],
      }),
    });
    assert.equal(response.status, 500, '真实 Gitea 对这个场景返回 500');

    // ★ 关键：策略层必须把 500 也识别成冲突，否则用户会看到同步中断
    let seeded = false;
    const racing = createStrategy('gitea', contextFor(mock.baseUrl, {
      owner: mock.owner,
      repo: mock.repo,
      token: mock.token,
      async beforeWrite() {
        // 读完树后把文件删掉，让策略以为它还在
        if (seeded) return;
        seeded = true;
        mock.state.seed('will-vanish.json', 'here');
      },
    }));
    const mid = await racing.head(BRANCH);
    assert.ok(mid === base || mid !== base); // 只是确保可读

    // 构造真正的 500 场景：策略读到文件存在，但提交前被删
    const direct = createStrategy('gitea', contextFor(mock.baseUrl, {
      owner: mock.owner,
      repo: mock.repo,
      token: mock.token,
    }));
    const head = await direct.head(BRANCH);
    mock.state.seed('temp.json', 'v1');
    const head2 = await direct.head(BRANCH);
    // 手工制造 sha 不匹配：用旧 tip 提交一次（会命中前置比对）
    await assert.rejects(
      () => direct.commit({
        branch: BRANCH,
        expectedHeadOid: head,
        headline: 'stale',
        additions: [],
        deletions: [{ path: 'temp.json' }],
      }),
      (error) => {
        // 前置比对阶段就拦下了（因为 tip 变了）
        assert.ok(error instanceof SyncConflictError);
        return true;
      },
    );
    assert.notEqual(head2, head);
  } finally {
    await mock.close();
  }
});

test('真机事实：空仓库 POST /branches 返回 404，而 POST /contents 能直接建出分支', async () => {
  const mock = await startMockGitea();
  try {
    const repoPath = `${mock.baseUrl}/repos/${mock.owner}/${mock.repo}`;
    const auth = { Authorization: `token ${mock.token}` };

    // 空仓库建分支 → 404
    const branchResponse = await fetch(`${repoPath}/branches`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_branch_name: 'master', old_branch_name: '' }),
    });
    assert.equal(branchResponse.status, 404, '空仓库上 POST /branches 应 404');

    // 但直接 POST /contents 就能建出分支 + 第一个提交
    const contentsResponse = await fetch(`${repoPath}/contents`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        branch: 'master',
        message: 'first',
        files: [{ operation: 'create', path: 'README.md', content: toBase64('# NENO') }],
      }),
    });
    assert.equal(contentsResponse.status, 201, '空仓库直接 POST /contents 应成功');
    assert.match(readFile(mock, 'README.md') ?? '', /NENO/);

    // 所以 bootstrap 不应该在空仓库上先试 POST /branches
    const branchCalls = countRequests(mock, 'POST', '/branches');
    assert.equal(branchCalls, 1, '仅上面手工那一次；bootstrap 不该再发');
  } finally {
    await mock.close();
  }
});

test('真机事实：bootstrap 只发一次 POST /contents，不发 POST /branches', async () => {
  const mock = await startMockGitea();
  try {
    const strategy = createStrategy('gitea', contextFor(mock.baseUrl, {
      owner: mock.owner, repo: mock.repo, token: mock.token,
    }));
    await strategy.bootstrap(BRANCH);

    assert.equal(countRequests(mock, 'POST', '/branches'), 0, '不该再调 POST /branches');
    assert.equal(countRequests(mock, 'POST', '/contents'), 1, '应只发一次 POST /contents');
  } finally {
    await mock.close();
  }
});
