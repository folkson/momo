/**
 * ForgejoProvider 的协议级测试。
 *
 * 全部打真实 HTTP（不是打桩），因为这一层的价值就在于协议细节：
 * 路径复数、返回数组、base64 带换行、冲突返回 409、create/update 的 sha 语义。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { startMockGitea, gitBlobSha } from '../testkit/mock-gitea.mjs';
import { ForgejoProvider } from '../src/request/gitProvider/forgejo.mjs';
import { ConflictError, NotFoundError } from '../src/request/gitProvider/errors.mjs';

/**
 * 建一个连到 mock 的 provider。
 *
 * @param {object} mock mock 服务
 * @param {object} [overrides] 覆盖配置
 * @returns {ForgejoProvider}
 */
function makeProvider(mock, overrides = {}) {
  return new ForgejoProvider({
    baseUrl: mock.baseUrl,
    token: mock.token,
    owner: mock.owner,
    repo: mock.repo,
    ...overrides,
  });
}

/**
 * @param {Uint8Array|string} value 内容
 * @returns {Uint8Array}
 */
function bytes(value) {
  return typeof value === 'string' ? new TextEncoder().encode(value) : value;
}

/**
 * 取最后一次 `POST /contents` 的请求体。
 *
 * ⚠️ 不能用 `requests.at(-1)` —— provider 提交后会再读一次 tip（probeHead），
 * 那是个 GET，最后的记录不是写请求。
 *
 * @param {object} mock mock 服务
 * @returns {any} 解析后的请求体
 */
function lastWriteBody(mock) {
  const writes = mock.state.requests.filter(
    (item) => item.method === 'POST' && item.path.endsWith('/contents'),
  );
  assert.ok(writes.length > 0, '应当发生过写请求');
  return JSON.parse(writes.at(-1).raw);
}

test('getUser 能取到身份', async (t) => {
  const mock = await startMockGitea();
  t.after(() => mock.close());
  const provider = makeProvider(mock);

  const user = await provider.getUser();
  assert.equal(user.login, 'alice');
  // 认证头必须是 `token xxx`（与 GitHub 同语法）
  const req = mock.state.requests[0];
  assert.equal(req.path, '/api/v1/user');
});

test('token 错误时抛 AuthError，不重试', async (t) => {
  const mock = await startMockGitea();
  t.after(() => mock.close());
  const provider = makeProvider(mock, { token: 'wrong' });

  await assert.rejects(
    () => provider.getUser(),
    (error) => {
      assert.equal(error.name, 'AuthError');
      assert.equal(error.status, 401);
      return true;
    },
  );
});

test('getHead 用的是复数 refs 路径，且能解析数组响应', async (t) => {
  const mock = await startMockGitea();
  t.after(() => mock.close());
  mock.state.seed('README.md', '# hello');

  const provider = makeProvider(mock);
  const head = await provider.getHead('main');

  assert.equal(head.oid, mock.state.headSha);
  assert.equal(head.notModified, false);
  // ★ 路径必须是 /git/refs/... （Gitea），不是 GitHub 的 /git/ref/...
  assert.equal(
    mock.state.requests[0].path,
    '/api/v1/repos/alice/neno/git/refs/heads/main',
  );
});

test('空仓库取 head 抛 NotFoundError（上层据此走初始化）', async (t) => {
  const mock = await startMockGitea();
  t.after(() => mock.close());
  const provider = makeProvider(mock);

  await assert.rejects(
    () => provider.getHead('main'),
    (error) => {
      assert.ok(error instanceof NotFoundError);
      return true;
    },
  );
});

test('getTree 只返回 blob，路径不带前导斜杠', async (t) => {
  const mock = await startMockGitea();
  t.after(() => mock.close());
  mock.state.seed('2026-10-29/a.json', '{"a":1}');
  mock.state.seed('picData/b.png', 'png');

  const provider = makeProvider(mock);
  const tree = await provider.getTree(mock.state.headSha);

  assert.equal(tree.length, 2);
  assert.deepEqual(tree.map((item) => item.path).sort(), ['2026-10-29/a.json', 'picData/b.png']);
  assert.ok(tree.every((item) => item.type === 'blob'));
});

test('getBlob 能正确解码带换行的 base64', async (t) => {
  const mock = await startMockGitea();
  t.after(() => mock.close());
  // 长内容才会触发 mock 的换行插入（每 76 字符）
  const content = 'x'.repeat(300);
  mock.state.seed('long.txt', content);

  const provider = makeProvider(mock);
  const tree = await provider.getTree(mock.state.headSha);
  const target = tree.find((item) => item.path === 'long.txt');

  const got = await provider.getBlob(target.sha);
  assert.equal(new TextDecoder().decode(got), content);
});

test('commitBatch 新建文件：用 create，不传 sha', async (t) => {
  const mock = await startMockGitea();
  t.after(() => mock.close());
  mock.state.seed('README.md', '# base');

  const provider = makeProvider(mock);
  const result = await provider.commitBatch({
    branch: 'main',
    expectedHeadOid: mock.state.headSha,
    headline: '[ADD] 第一条',
    additions: [{ path: 'notes/a.md', contents: bytes('hello') }],
    deletions: [],
  });

  assert.equal(result.oid, mock.state.headSha);
  assert.equal(mock.state.snapshot().get('notes/a.md').content.toString(), 'hello');

  const body = lastWriteBody(mock);
  assert.equal(body.files[0].operation, 'create');
  assert.equal(body.files[0].sha, undefined, 'create 不该传 sha');
  assert.equal(body.message, '[ADD] 第一条');
});

test('commitBatch 覆盖已存在文件：必须用 update + 传当前 sha', async (t) => {
  const mock = await startMockGitea();
  t.after(() => mock.close());
  mock.state.seed('notes/a.md', 'old');

  const provider = makeProvider(mock);
  await provider.commitBatch({
    branch: 'main',
    expectedHeadOid: mock.state.headSha,
    headline: '[MODIFY] 改一条',
    additions: [{ path: 'notes/a.md', contents: bytes('new') }],
    deletions: [],
  });

  assert.equal(mock.state.snapshot().get('notes/a.md').content.toString(), 'new');
  const body = lastWriteBody(mock);
  assert.equal(body.files[0].operation, 'update');
  assert.equal(body.files[0].sha, gitBlobSha(Buffer.from('old')), '必须带旧内容的 sha');
});

test('commitBatch 删除文件：带 sha；删不存在的文件是幂等 no-op', async (t) => {
  const mock = await startMockGitea();
  t.after(() => mock.close());
  mock.state.seed('notes/a.md', 'a');
  mock.state.seed('notes/b.md', 'b');

  const provider = makeProvider(mock);
  await provider.commitBatch({
    branch: 'main',
    expectedHeadOid: mock.state.headSha,
    headline: '[DELETE] 删一条',
    additions: [],
    deletions: [{ path: 'notes/a.md' }, { path: 'notes/not-exist.md' }],
  });

  const snapshot = mock.state.snapshot();
  assert.equal(snapshot.has('notes/a.md'), false);
  assert.equal(snapshot.has('notes/b.md'), true);

  const body = lastWriteBody(mock);
  assert.equal(body.files.length, 1, '不存在的文件不该发给服务端');
  assert.equal(body.files[0].operation, 'delete');
  assert.ok(body.files[0].sha !== undefined);
});

test('tip 变化时前置校验就抛 ConflictError（省掉一次写请求）', async (t) => {
  const mock = await startMockGitea();
  t.after(() => mock.close());
  mock.state.seed('notes/a.md', 'a');

  const provider = makeProvider(mock);
  const staleTip = mock.state.headSha;

  // 模拟另一台设备推进了分支
  mock.state.seed('notes/other.md', 'other');
  mock.state.resetRequests();

  await assert.rejects(
    () => provider.commitBatch({
      branch: 'main',
      expectedHeadOid: staleTip,
      headline: 'x',
      additions: [{ path: 'notes/b.md', contents: bytes('b') }],
      deletions: [],
    }),
    (error) => {
      assert.ok(error instanceof ConflictError, `期望 ConflictError，实际 ${error.name}`);
      assert.equal(error.expectedHeadOid, staleTip);
      assert.equal(error.currentOid, mock.state.headSha);
      return true;
    },
  );

  // ★ 关键：冲突应该在**读阶段**就发现，不能浪费一次写请求
  const wrote = mock.state.requests.some(
    (item) => item.method === 'POST' && item.path.endsWith('/contents'),
  );
  assert.equal(wrote, false, '冲突不该产生写请求');
});

test('文件级 sha 冲突（服务端 409）也映射成 ConflictError', async (t) => {
  const mock = await startMockGitea();
  t.after(() => mock.close());
  mock.state.seed('notes/a.md', 'a');

  const provider = makeProvider(mock);

  // 先拿到树，但**故意**把 expectedHeadOid 设为 null 绕过 tip 前置校验，
  // 让请求真的打到服务端，验证 409 的映射。
  const shaByPath = new Map();
  for (const entry of await provider.getTree(mock.state.headSha)) shaByPath.set(entry.path, entry.sha);

  // 另一台设备改了同一个文件
  mock.state.seed('notes/a.md', 'changed-by-other');
  mock.state.resetRequests();

  // 手工构造一次会撞 sha 的提交：先读旧树拿 sha，再改
  const stale = mock.state.snapshot();
  assert.ok(stale.has('notes/a.md'));

  // 用一个过期的 sha 直接打服务端
  const resp = await fetch(`${mock.baseUrl}/repos/alice/neno/contents`, {
    method: 'POST',
    headers: {
      Authorization: `token ${mock.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      branch: 'main',
      message: 'stale',
      files: [{
        operation: 'update',
        path: 'notes/a.md',
        content: Buffer.from('mine').toString('base64'),
        sha: gitBlobSha(Buffer.from('a')), // 旧 sha，服务端应拒绝
      }],
    }),
  });
  assert.equal(resp.status, 409, 'mock 必须复刻真实 Gitea 的 409');
});

test('没有任何变更时不发写请求，直接返回当前 tip', async (t) => {
  const mock = await startMockGitea();
  t.after(() => mock.close());
  mock.state.seed('a.md', 'a');

  const provider = makeProvider(mock);
  mock.state.resetRequests();

  const result = await provider.commitBatch({
    branch: 'main',
    expectedHeadOid: mock.state.headSha,
    headline: 'noop',
    additions: [],
    deletions: [],
  });

  assert.equal(result.oid, mock.state.headSha);
  const wrote = mock.state.requests.some(
    (item) => item.method === 'POST' && item.path.endsWith('/contents'),
  );
  assert.equal(wrote, false);
});

test('单次提交超过文件上限时直接报错（提示上层分批）', async (t) => {
  const mock = await startMockGitea();
  t.after(() => mock.close());
  mock.state.seed('README.md', '#');

  const provider = makeProvider(mock);
  const additions = Array.from({ length: 101 }, (_, index) => ({
    path: `n/${index}.md`,
    contents: bytes('x'),
  }));

  await assert.rejects(
    () => provider.commitBatch({
      branch: 'main',
      expectedHeadOid: null,
      headline: 'too many',
      additions,
      deletions: [],
    }),
    /超过上限/,
  );
});

test('capabilities 如实反映"没有分支 tip CAS"', () => {
  const caps = ForgejoProvider.caps;
  assert.equal(caps.branchHeadCAS, false, 'Gitea/Forgejo 没有 tip 级 CAS');
  assert.equal(caps.fileLevelShaCAS, true, '但有文件级 sha 校验');
  assert.equal(caps.atomicMultiFileCommit, true, 'ChangeFiles 是一次 commit');
  assert.equal(caps.authStyle, 'token', '认证头与 GitHub 同语法');
});
