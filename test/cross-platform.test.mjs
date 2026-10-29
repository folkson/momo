/**
 * 跨平台一致性测试。
 *
 * ## 这个文件要证明什么
 *
 * 「换个平台也能用」不能靠"两个 provider 各自单测通过"来保证 ——
 * 那只能证明各自的协议实现对了，不能证明**上层代码不用改**。
 *
 * 所以这里做两件事：
 *   1. **同一份同步逻辑**跑在两个 mock 上，最终仓库内容必须**逐字节相同**
 *   2. 平台差异（CAS 有无、分批上限）被 `caps` 吸收，调用方代码零分支
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { startMockGitea } from '../testkit/mock-gitea.mjs';
import { startMockGithub } from '../testkit/mock-github.mjs';
import {
  createProvider, chunkChanges, commitWithRetry, ConflictError,
} from '../src/request/gitProvider/index.mjs';

/**
 * 把字符串转字节。
 *
 * @param {string} value
 * @returns {Uint8Array}
 */
function bytes(value) {
  return new TextEncoder().encode(value);
}

/**
 * 一份「与平台无关」的同步逻辑。
 *
 * ⚠️ 这个函数里**不出现**任何 `if (platform === 'github')` 之类的分支 ——
 * 这正是抽象层要达到的效果。后面用它跑两个平台，结果必须一致。
 *
 * @param {import('../src/request/gitProvider/base.mjs').GitProvider} provider
 * @param {Array<{path: string, text: string}>} notes 要写进去的文件
 * @param {{deletions?: Array<{path: string}>}} [options]
 * @returns {Promise<{oids: string[]}>}
 */
async function syncOnce(provider, notes, options = {}) {
  const repo = await provider.getRepo();
  const branch = repo.defaultBranch;

  /** @type {string|null} */
  let tip = null;
  try {
    tip = (await provider.getHead(branch)).oid;
  } catch (error) {
    // 空仓库：tip 为 null，由 commitBatch 处理
    if (error.name !== 'NotFoundError') throw error;
  }

  const result = await commitWithRetry(provider, {
    branch,
    expectedHeadOid: tip,
    headline: '[ADD] 同步笔记',
    additions: notes.map((note) => ({ path: note.path, contents: bytes(note.text) })),
    deletions: options.deletions ?? [],
    reload: async () => (await provider.getHead(branch)).oid,
  });

  return { oids: result.oids };
}

/**
 * 把 mock 的快照转换成可比较的普通对象。
 *
 * @param {Map<string, {sha: string, content: Buffer}>} snapshot
 * @returns {Record<string, string>}
 */
function serialize(snapshot) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [path, item] of [...snapshot.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    out[path] = item.content.toString('utf8');
  }
  return out;
}

test('同一份同步逻辑跑在 Gitea 与 GitHub 上，结果逐字节相同', async (t) => {
  const gitea = await startMockGitea();
  const github = await startMockGithub();
  t.after(async () => { await gitea.close(); await github.close(); });

  const giteaProvider = createProvider({
    provider: 'gitea',
    baseUrl: gitea.baseUrl,
    token: gitea.token,
    owner: gitea.owner,
    repo: gitea.repo,
  });
  const githubProvider = createProvider({
    provider: 'github',
    baseUrl: github.baseUrl,
    token: github.token,
    owner: github.owner,
    repo: github.repo,
  });

  const notes = [
    { path: '2026-10-29/a.json', text: '{"id":"a","content":"第一条"}' },
    { path: '2026-10-29/b.json', text: '{"id":"b","content":"第二条"}' },
    { path: 'picData/x.png', text: 'fake-png-bytes' },
  ];

  const giteaResult = await syncOnce(giteaProvider, notes);
  const githubResult = await syncOnce(githubProvider, notes);

  // 内容必须完全一致
  assert.deepEqual(
    serialize(gitea.state.snapshot()),
    serialize(github.state.snapshot()),
    '两个平台的仓库内容必须逐字节相同',
  );

  // 都是一次提交完成（没触发分批）
  assert.equal(giteaResult.oids.length, 1);
  assert.equal(githubResult.oids.length, 1);
});

test('第二轮增量同步：改一条 + 删一条，两边结果仍一致', async (t) => {
  const gitea = await startMockGitea();
  const github = await startMockGithub();
  t.after(async () => { await gitea.close(); await github.close(); });

  const giteaProvider = createProvider({
    provider: 'gitea', baseUrl: gitea.baseUrl, token: gitea.token, owner: gitea.owner, repo: gitea.repo,
  });
  const githubProvider = createProvider({
    provider: 'github', baseUrl: github.baseUrl, token: github.token, owner: github.owner, repo: github.repo,
  });

  const initial = [
    { path: 'n/a.json', text: 'a' },
    { path: 'n/b.json', text: 'b' },
  ];
  await syncOnce(giteaProvider, initial);
  await syncOnce(githubProvider, initial);

  // 第二轮：改 a，删 b
  const updated = [{ path: 'n/a.json', text: 'a-v2' }];
  await syncOnce(giteaProvider, updated, { deletions: [{ path: 'n/b.json' }] });
  await syncOnce(githubProvider, updated, { deletions: [{ path: 'n/b.json' }] });

  assert.deepEqual(
    serialize(gitea.state.snapshot()),
    serialize(github.state.snapshot()),
  );
  const snapshot = serialize(gitea.state.snapshot());
  assert.equal(snapshot['n/a.json'], 'a-v2');
  assert.equal(snapshot['n/b.json'], undefined, '删掉的文件不该还在');
});

test('chunkChanges 按平台上限分批，且不丢文件', () => {
  const additions = Array.from({ length: 250 }, (_, index) => ({
    path: `n/${index}.md`,
    contents: bytes('x'),
  }));

  // GitHub：200 一批 → 250 个应切成 2 批
  const github = chunkChanges({ additions, deletions: [] }, {
    maxFilesPerCommit: 200, maxBytesPerCommit: 8 * 1024 * 1024,
  });
  assert.equal(github.length, 2);
  assert.equal(github[0].additions.length, 200);
  assert.equal(github[1].additions.length, 50);
  assert.equal(
    github.reduce((sum, batch) => sum + batch.additions.length, 0),
    250,
    '不能丢文件',
  );

  // Gitea：100 一批 → 3 批
  const gitea = chunkChanges({ additions, deletions: [] }, {
    maxFilesPerCommit: 100, maxBytesPerCommit: 8 * 1024 * 1024,
  });
  assert.equal(gitea.length, 3);
  assert.deepEqual(gitea.map((batch) => batch.additions.length), [100, 100, 50]);
});

test('单文件超过字节上限时单独成批（否则会死循环）', () => {
  const big = new Uint8Array(20);
  // 上限设得很小，制造"一个文件就超标"的情况
  const batches = chunkChanges(
    {
      additions: [
        { path: 'small.md', contents: new Uint8Array(2) },
        { path: 'big.bin', contents: big },
      ],
      deletions: [],
    },
    { maxFilesPerCommit: 100, maxBytesPerCommit: 10 },
  );

  assert.equal(batches.length, 2, '大文件必须被单独推到新批');
  assert.equal(batches[0].additions[0].path, 'small.md');
  assert.equal(batches[1].additions[0].path, 'big.bin');
});

test('分批提交在多批时给提交信息加序号', async (t) => {
  const gitea = await startMockGitea();
  t.after(() => gitea.close());
  gitea.state.seed('README.md', '#');

  const provider = createProvider({
    provider: 'gitea', baseUrl: gitea.baseUrl, token: gitea.token, owner: gitea.owner, repo: gitea.repo,
  });

  // 150 个文件 > 100 上限 → 2 批
  const additions = Array.from({ length: 150 }, (_, index) => ({
    path: `n/${index}.md`,
    contents: bytes('x'),
  }));

  const result = await commitWithRetry(provider, {
    branch: 'main',
    expectedHeadOid: gitea.state.headSha,
    headline: '[ADD] 大批量',
    additions,
    deletions: [],
  });

  assert.equal(result.batches, 2);
  assert.equal(result.oids.length, 2);

  const messages = gitea.state.requests
    .filter((item) => item.method === 'POST' && item.path.endsWith('/contents'))
    .map((item) => JSON.parse(item.raw).message);
  assert.deepEqual(messages, ['[ADD] 大批量 (1/2)', '[ADD] 大批量 (2/2)']);

  // 150 个文件都在
  assert.equal(gitea.state.snapshot().size, 151);
});

test('冲突后重试能成功（reload 拿到新 tip）', async (t) => {
  const gitea = await startMockGitea();
  t.after(() => gitea.close());
  gitea.state.seed('README.md', '#');

  const provider = createProvider({
    provider: 'gitea', baseUrl: gitea.baseUrl, token: gitea.token, owner: gitea.owner, repo: gitea.repo,
  });

  const staleTip = gitea.state.headSha;
  // 另一个设备推进了分支
  gitea.state.seed('other.md', 'other');

  let reloadCount = 0;
  const result = await commitWithRetry(provider, {
    branch: 'main',
    expectedHeadOid: staleTip,
    headline: '[ADD] 重试',
    additions: [{ path: 'mine.md', contents: bytes('mine') }],
    deletions: [],
    reload: async () => {
      reloadCount += 1;
      return (await provider.getHead('main')).oid;
    },
  });

  assert.equal(reloadCount, 1, '应当重试一次');
  assert.equal(result.oids.length, 1);
  const snapshot = gitea.state.snapshot();
  assert.ok(snapshot.has('mine.md'), '自己的文件要写进去');
  assert.ok(snapshot.has('other.md'), '别人的文件不能被冲掉');
});

test('重试上限用尽后抛 ConflictError（不静默吞掉）', async (t) => {
  const gitea = await startMockGitea();
  t.after(() => gitea.close());
  gitea.state.seed('README.md', '#');

  const provider = createProvider({
    provider: 'gitea', baseUrl: gitea.baseUrl, token: gitea.token, owner: gitea.owner, repo: gitea.repo,
  });

  await assert.rejects(
    () => commitWithRetry(provider, {
      branch: 'main',
      // 永远对不上的 tip，且 reload 也修不好
      expectedHeadOid: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      headline: 'x',
      additions: [{ path: 'a.md', contents: bytes('a') }],
      deletions: [],
      attempts: 2,
      reload: async () => 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    }),
    (error) => {
      assert.ok(error instanceof ConflictError, `期望 ConflictError，实际 ${error.name}`);
      return true;
    },
  );

  assert.equal(gitea.state.snapshot().has('a.md'), false, '失败时不该写入');
});

test('createProvider 未知平台明确报错', () => {
  assert.throws(
    () => createProvider({ provider: 'gitlab', token: 'x', owner: 'a', repo: 'b' }),
    /不支持的代码平台/,
  );
});

test('createProvider 把 gitea 与 forgejo 都映射到同一实现', () => {
  const gitea = createProvider({
    provider: 'gitea', baseUrl: 'https://g.example.com/api/v1', token: 't', owner: 'a', repo: 'b',
  });
  const forgejo = createProvider({
    provider: 'forgejo', baseUrl: 'https://f.example.com/api/v1', token: 't', owner: 'a', repo: 'b',
  });

  assert.equal(gitea.caps.id, 'forgejo', '共用同一能力矩阵');
  assert.equal(forgejo.caps.id, 'forgejo');
  // 但 platform 字段能区分，便于排错
  assert.equal(gitea.platform, 'gitea');
  assert.equal(forgejo.platform, 'forgejo');
});
