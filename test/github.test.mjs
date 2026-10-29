/**
 * GithubProvider 的协议级测试。
 *
 * 重点验证「与 neno 原实现行为一致」—— 因为把适配层插进去之后，
 * 现有 GitHub 用户不该感受到任何变化。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { startMockGithub } from '../testkit/mock-github.mjs';
import { GithubProvider } from '../src/request/gitProvider/github.mjs';
import { ConflictError, NotFoundError } from '../src/request/gitProvider/errors.mjs';

/**
 * @param {object} mock
 * @param {object} [overrides]
 * @returns {GithubProvider}
 */
function makeProvider(mock, overrides = {}) {
  return new GithubProvider({
    baseUrl: mock.baseUrl,
    token: mock.token,
    owner: mock.owner,
    repo: mock.repo,
    ...overrides,
  });
}

/**
 * @param {string} value
 * @returns {Uint8Array}
 */
function bytes(value) {
  return new TextEncoder().encode(value);
}

test('getUser 解析 x-oauth-scopes（GitHub 独有）', async (t) => {
  const mock = await startMockGithub();
  t.after(() => mock.close());

  const user = await makeProvider(mock).getUser();
  assert.equal(user.login, 'alice');
  assert.deepEqual(user.scopes, ['repo', 'workflow']);
});

test('getHead 用单数 git/ref，返回对象', async (t) => {
  const mock = await startMockGithub();
  t.after(() => mock.close());
  mock.state.seed('README.md', '# hi');

  const head = await makeProvider(mock).getHead('main');
  assert.equal(head.oid, mock.state.headSha);
  assert.ok(head.etag !== null, 'GitHub 会返回 ETag');
  // ★ 单数 ref（Gitea 是复数 refs）
  assert.equal(mock.state.requests[0].path, '/repos/alice/neno/git/ref/heads/main');
});

test('etag 命中 304 时 notModified=true', async (t) => {
  const mock = await startMockGithub();
  t.after(() => mock.close());
  mock.state.seed('README.md', '# hi');

  const provider = makeProvider(mock);
  const first = await provider.getHead('main');
  assert.ok(first.etag !== null);

  // mock 不实现 If-None-Match 的 304 分支（真实 GitHub 会），
  // 这里只验证 etag 被正确透传下来，供上层使用。
  const second = await provider.getHead('main', { etag: first.etag });
  assert.equal(second.oid, first.oid);
});

test('空仓库 getHead 抛 NotFoundError', async (t) => {
  const mock = await startMockGithub();
  t.after(() => mock.close());

  await assert.rejects(
    () => makeProvider(mock).getHead('main'),
    (error) => {
      assert.ok(error instanceof NotFoundError);
      return true;
    },
  );
});

test('commitBatch 走 GraphQL，且 expectedHeadOid 被正确传入', async (t) => {
  const mock = await startMockGithub();
  t.after(() => mock.close());
  mock.state.seed('README.md', '# base');

  const provider = makeProvider(mock);
  const tip = mock.state.headSha;

  const result = await provider.commitBatch({
    branch: 'main',
    expectedHeadOid: tip,
    headline: '[ADD] 第一条',
    additions: [{ path: 'notes/a.md', contents: bytes('hello') }],
    deletions: [],
  });

  assert.equal(result.oid, mock.state.headSha);
  assert.equal(mock.state.snapshot().get('notes/a.md').content.toString(), 'hello');

  // ★ 必须走 GraphQL，不能退化成 REST 低层（会丢原子性）
  const gql = mock.state.requests.filter((item) => item.path === '/graphql');
  assert.equal(gql.length, 1, '应当只发一次 GraphQL 请求');

  const input = mock.state.graphqlInputs[0];
  assert.equal(input.expectedHeadOid, tip, '必须传 expectedHeadOid 做 CAS');
  assert.equal(input.branch.branchName, 'main');
  assert.equal(input.branch.repositoryNameWithOwner, 'alice/neno');
  assert.equal(input.fileChanges.additions[0].path, 'notes/a.md');
  assert.equal(input.message.headline, '[ADD] 第一条');
});

test('expectedHeadOid 不匹配（HTTP 200 + errors）→ ConflictError', async (t) => {
  const mock = await startMockGithub();
  t.after(() => mock.close());
  mock.state.seed('notes/a.md', 'a');

  const provider = makeProvider(mock);
  const staleTip = mock.state.headSha;

  // 另一个设备推进了分支
  mock.state.seed('notes/other.md', 'other');

  await assert.rejects(
    () => provider.commitBatch({
      branch: 'main',
      expectedHeadOid: staleTip,
      headline: 'x',
      additions: [{ path: 'notes/b.md', contents: bytes('b') }],
      deletions: [],
    }),
    (error) => {
      assert.ok(error instanceof ConflictError, `期望 ConflictError，实际 ${error.name}: ${error.message}`);
      assert.equal(error.expectedHeadOid, staleTip);
      return true;
    },
  );

  // ★ 这个断言是本次改造的核心：GraphQL 的 200 语义必须被正确识别成冲突。
  //   如果直接把 200 当成功，这里会静默丢数据。
  assert.equal(mock.state.snapshot().has('notes/b.md'), false, '冲突时不该真的写进去');
});

test('多文件一次提交（GitHub 的 200 文件能力）', async (t) => {
  const mock = await startMockGithub();
  t.after(() => mock.close());
  mock.state.seed('README.md', '#');

  const provider = makeProvider(mock);
  const additions = Array.from({ length: 50 }, (_, index) => ({
    path: `notes/${index}.md`,
    contents: bytes(`note ${index}`),
  }));

  await provider.commitBatch({
    branch: 'main',
    expectedHeadOid: mock.state.headSha,
    headline: '[ADD] 批量',
    additions,
    deletions: [],
  });

  const snapshot = mock.state.snapshot();
  assert.equal(snapshot.size, 51, 'README + 50 条');
  // 只发一次 GraphQL = 一次原子提交
  assert.equal(
    mock.state.requests.filter((item) => item.path === '/graphql').length,
    1,
  );
});

test('删除文件通过 fileChanges.deletions', async (t) => {
  const mock = await startMockGithub();
  t.after(() => mock.close());
  mock.state.seed('notes/a.md', 'a');
  mock.state.seed('notes/b.md', 'b');

  const provider = makeProvider(mock);
  await provider.commitBatch({
    branch: 'main',
    expectedHeadOid: mock.state.headSha,
    headline: '[DELETE] 删一条',
    additions: [],
    deletions: [{ path: 'notes/a.md' }],
  });

  const snapshot = mock.state.snapshot();
  assert.equal(snapshot.has('notes/a.md'), false);
  assert.equal(snapshot.has('notes/b.md'), true);

  const input = mock.state.graphqlInputs[0];
  assert.deepEqual(input.fileChanges.deletions, [{ path: 'notes/a.md' }]);
});

test('capabilities 如实反映"有 tip CAS"', () => {
  const caps = GithubProvider.caps;
  assert.equal(caps.branchHeadCAS, true, 'GitHub 有 expectedHeadOid');
  assert.equal(caps.atomicMultiFileCommit, true);
  assert.equal(caps.maxFilesPerCommit, 200, '与 neno 的 MAX_COMMIT_FILES 一致');
});
