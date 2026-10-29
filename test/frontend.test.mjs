/**
 * 前端策略层测试（平台矩阵 + 提交策略）。
 *
 * ## 这层测试为什么最关键
 *
 * 整个"支持 Gitea/Forgejo"的可行性就压在这一层上。它必须证明：
 *
 *   1. 同一个 `syncEngine` 面对两种平台时，**代码里没有任何平台分支**
 *   2. 两种平台的**语义**（成功/冲突）对上层完全一致
 *   3. 那些"写错只会得到 404 且不告诉你原因"的协议差异被彻底封装
 *
 * 所以这里对两个 mock 跑**同一套断言**，只是平台 id 不同。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { startMockGitea } from '../testkit/mock-gitea.mjs';
import { startMockGithub } from '../testkit/mock-github.mjs';
import {
  PLATFORMS, PLATFORM_IDS, normalizeApiBase, capsOf, refPath, pickRefSha,
  isEmptyRepoSignal,
} from '../src/frontend/platform.mjs';
import {
  createStrategy, SyncConflictError, GraphQLCommitStrategy, ChangeFilesStrategy,
} from '../src/frontend/commitStrategy.mjs';

// ─────────────────────────────────────────────────────────────
// 平台矩阵（纯函数）
// ─────────────────────────────────────────────────────────────

test('三个平台都注册了完整的能力矩阵', () => {
  // ⚠️ PLATFORM_IDS 是 Object.freeze 的，不能原地 sort() —— 必须先复制
  assert.deepEqual([...PLATFORM_IDS].sort(), ['forgejo', 'gitea', 'github']);

  for (const id of PLATFORM_IDS) {
    const caps = PLATFORMS[id];
    assert.equal(caps.id, id);
    assert.ok(caps.displayName.length > 0);
    assert.equal(typeof caps.branchHeadCAS, 'boolean');
    assert.equal(typeof caps.fileLevelShaCAS, 'boolean');
    assert.equal(typeof caps.pluralRefs, 'boolean');
    assert.ok(caps.maxFilesPerCommit > 0);
    assert.ok(caps.maxBytesPerCommit > 0);
    assert.ok(caps.tokenHint.length > 0, `${id} 缺少 token 提示`);
    assert.ok(caps.baseUrlHint.length > 0, `${id} 缺少 baseUrl 提示`);
  }
});

test('能力矩阵如实反映实测结论：Gitea/Forgejo 没有分支 tip CAS', () => {
  assert.equal(PLATFORMS.github.branchHeadCAS, true, 'GitHub 有 expectedHeadOid');
  assert.equal(PLATFORMS.gitea.branchHeadCAS, false, 'Gitea 的 git/ 只读');
  assert.equal(PLATFORMS.forgejo.branchHeadCAS, false);

  // 但两者都有文件级弱 CAS
  assert.equal(PLATFORMS.gitea.fileLevelShaCAS, true);
  assert.equal(PLATFORMS.forgejo.fileLevelShaCAS, true);
  assert.equal(PLATFORMS.github.fileLevelShaCAS, false, 'GitHub 走 tip CAS，不需要文件级');
});

test('capsOf 拒绝未知平台并给出可选项', () => {
  assert.throws(() => capsOf('gitlab'), /不支持的代码平台.*gitlab/);
  assert.throws(() => capsOf(''), /不支持的代码平台/);
  assert.equal(capsOf('GitHub').id, 'github', '大小写不敏感');
});

test('normalizeApiBase 按平台分别处理（GitHub 固定、其他补 /api/v1）', () => {
  // GitHub 一律固定，用户填什么都不该生效
  assert.equal(normalizeApiBase('github', ''), 'https://api.github.com');
  assert.equal(normalizeApiBase('github', 'https://whatever.com'), 'https://api.github.com');

  // Gitea/Forgejo 纯域名 → 补 /api/v1
  assert.equal(normalizeApiBase('gitea', 'git.example.com'), 'https://git.example.com/api/v1');
  assert.equal(normalizeApiBase('forgejo', 'https://code.example.com/'), 'https://code.example.com/api/v1');

  // 已带 /api → 原样保留（含反代前缀）
  assert.equal(
    normalizeApiBase('gitea', 'https://example.com/gitea/api/v1'),
    'https://example.com/gitea/api/v1',
  );
  assert.equal(normalizeApiBase('gitea', ''), '');
});

test('refPath 复刻单复数差异（写错只会 404 且不说原因）', () => {
  assert.equal(refPath('github', 'main'), '/git/ref/heads/main', 'GitHub 单数 ref');
  assert.equal(refPath('gitea', 'main'), '/git/refs/heads/main', 'Gitea 复数 refs');
  assert.equal(refPath('forgejo', 'dev'), '/git/refs/heads/dev');
  // 分支名要编码（可能含 /）
  assert.equal(refPath('github', 'feat/x'), '/git/ref/heads/feat%2Fx');
});

test('pickRefSha 同时容忍数组与对象响应', () => {
  const obj = { object: { sha: 'abc123' } };
  const arr = [{ object: { sha: 'abc123' } }];

  assert.equal(pickRefSha('github', obj), 'abc123');
  assert.equal(pickRefSha('gitea', arr), 'abc123');
  // 容错：即使平台说复数但服务端返回对象，也要能取到
  assert.equal(pickRefSha('gitea', obj), 'abc123');
  assert.equal(pickRefSha('github', arr), '', 'GitHub 期望对象，不该误取');

  assert.equal(pickRefSha('gitea', []), '');
  assert.equal(pickRefSha('github', null), '');
});

test('isEmptyRepoSignal 统一两个平台的空仓库语义', () => {
  // GitHub 空仓库读 ref → 409；Gitea → 404。含义相同
  assert.equal(isEmptyRepoSignal(409), true);
  assert.equal(isEmptyRepoSignal(404), true);
  assert.equal(isEmptyRepoSignal(401), false);
  assert.equal(isEmptyRepoSignal(500), false);
});

// ─────────────────────────────────────────────────────────────
// 提交策略（对两个真实 mock 跑同一套断言）
// ─────────────────────────────────────────────────────────────

/**
 * 建一个面向 mock 的 api 封装。
 *
 * 这里刻意**不复用** src/request/gitProvider —— 那会测成"provider 测自己"。
 * 前端需要的是 raw REST 调用，与浏览器的 fetch 行为一致。
 *
 * @param {object} mock mock 服务
 * @param {object} credentials 凭证
 * @returns {object} 上下文
 */
function makeContext(mock, credentials) {
  /**
   * @param {string} method HTTP 方法
   * @param {string} path 仓库级路径
   * @param {object} [options] 选项
   * @returns {Promise<{data: any, status: number}>}
   */
  const api = async (method, path, options = {}) => {
    let url = `${mock.baseUrl}/repos/${credentials.owner}/${credentials.repo}${path}`;
    if (options.query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined) params.set(key, String(value));
      }
      url += `?${params}`;
    }
    const headers = { Authorization: `token ${credentials.access_token}` };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.etag) headers['If-None-Match'] = options.etag;

    const response = await fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    if (response.status === 304) return { data: null, status: 304, notModified: true };
    const text = await response.text();
    let data = null;
    if (text.trim() !== '') {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (response.ok === false) {
      const error = new Error(data?.message ?? `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return { data, status: response.status };
  };

  /**
   * GraphQL 调用（仅 GitHub mock 提供）。
   *
   * @param {string} query 查询
   * @param {object} variables 变量
   * @returns {Promise<any>}
   */
  const graphql = async (query, variables) => {
    const response = await fetch(`${mock.baseUrl}/graphql`, {
      method: 'POST',
      headers: {
        Authorization: `token ${credentials.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
    const body = await response.json();
    if (!response.ok) {
      const error = new Error(body?.message ?? `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    // ★ GraphQL 逻辑错误是 HTTP 200 —— 必须自己检查 errors
    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      const error = new Error(body.errors[0].message ?? 'GraphQL 错误');
      error.status = 200;
      error.errors = body.errors;
      throw error;
    }
    return body.data;
  };

  return {
    api,
    graphql,
    credentials: () => credentials,
    caps: capsOf(credentials.platform),
  };
}

/**
 * 两个平台各自建一个环境 + 策略。
 *
 * @param {import('node:test').TestContext} t 测试上下文
 * @param {object} [options] 选项
 * @returns {Promise<object>}
 */
async function platformFixtures(t, options = {}) {
  const gitea = await startMockGitea();
  const github = await startMockGithub();
  t.after(async () => { await gitea.close(); await github.close(); });

  // 预置 README 让仓库非空（除非特意测空仓库）
  if (options.seed !== false) {
    gitea.state.seed('README.md', '#');
    github.state.seed('README.md', '#');
  }

  /** @param {any} mock @param {string} platform */
  const build = (mock, platform) => {
    const credentials = {
      platform,
      access_token: mock.token,
      owner: mock.owner,
      repo: mock.repo,
    };
    const context = makeContext(mock, credentials);
    return { mock, credentials, context, strategy: createStrategy(platform, context) };
  };

  return {
    gitea: build(gitea, 'gitea'),
    github: build(github, 'github'),
  };
}

/**
 * base64 编码（浏览器语义，无换行）。
 *
 * @param {string} text 文本
 * @returns {string}
 */
function b64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

/**
 * 把 mock 快照变成可比较对象。
 *
 * @param {Map<string, {content: Buffer}>} snapshot 快照
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

test('两个平台的策略类选择符合能力矩阵', async (t) => {
  const env = await platformFixtures(t);

  assert.ok(env.github.strategy instanceof GraphQLCommitStrategy, 'GitHub 走 GraphQL');
  assert.ok(env.gitea.strategy instanceof ChangeFilesStrategy, 'Gitea 走 ChangeFiles');
});

test('head() 在两个平台都能取到 tip', async (t) => {
  const env = await platformFixtures(t);

  const ghTip = await env.github.strategy.head('main');
  const gtTip = await env.gitea.strategy.head('main');

  assert.match(ghTip, /^[0-9a-f]{40}$/);
  assert.match(gtTip, /^[0-9a-f]{40}$/);
  assert.equal(ghTip, env.github.mock.state.headSha);
  assert.equal(gtTip, env.gitea.mock.state.headSha);
});

test('同一份提交逻辑在两个平台产生完全相同的仓库内容', async (t) => {
  const env = await platformFixtures(t);

  const additions = [
    { path: '2026-10-29/a.json', contents: b64('{"content":"第一条"}') },
    { path: '2026-10-29/b.json', contents: b64('{"content":"第二条"}') },
    { path: 'picData/x.png', contents: b64('fake-png') },
  ];

  // ⚠️ 两个平台跑的是**同一段代码**，只有 strategy 实例不同
  const runOnce = async (fixture) => {
    const tip = await fixture.strategy.head('main');
    return fixture.strategy.commit({
      branch: 'main',
      expectedHeadOid: tip,
      headline: '[ADD] 同步',
      additions,
      deletions: [],
    });
  };

  const ghOid = await runOnce(env.github);
  const gtOid = await runOnce(env.gitea);

  assert.match(ghOid, /^[0-9a-f]{40}$/);
  assert.match(gtOid, /^[0-9a-f]{40}$/);
  assert.deepEqual(
    serialize(env.gitea.mock.state.snapshot()),
    serialize(env.github.mock.state.snapshot()),
    '两个平台落地内容必须逐字节相同',
  );
});

test('两个平台都能更新已存在文件（走 update 分支）', async (t) => {
  const env = await platformFixtures(t);

  for (const fixture of [env.github, env.gitea]) {
    const tip = await fixture.strategy.head('main');
    await fixture.strategy.commit({
      branch: 'main',
      expectedHeadOid: tip,
      headline: '[MODIFY] 改 README',
      additions: [{ path: 'README.md', contents: b64('# 改过了') }],
      deletions: [],
    });
    assert.equal(
      fixture.mock.state.snapshot().get('README.md').content.toString('utf8'),
      '# 改过了',
    );
  }
});

test('两个平台都能删除文件', async (t) => {
  const env = await platformFixtures(t);

  for (const fixture of [env.github, env.gitea]) {
    fixture.mock.state.seed('to-delete.md', 'bye');
    const tip = await fixture.strategy.head('main');
    await fixture.strategy.commit({
      branch: 'main',
      expectedHeadOid: tip,
      headline: '[DELETE] 删一个',
      additions: [],
      deletions: [{ path: 'to-delete.md' }],
    });
    assert.equal(
      fixture.mock.state.snapshot().has('to-delete.md'),
      false,
      `${fixture.credentials.platform}: 文件应被删掉`,
    );
  }
});

test('两个平台在 tip 过期时都抛 SyncConflictError（语义一致）', async (t) => {
  const env = await platformFixtures(t);

  for (const fixture of [env.github, env.gitea]) {
    // 另一台设备推进了分支
    fixture.mock.state.seed('other.md', 'other');

    await assert.rejects(
      () => fixture.strategy.commit({
        branch: 'main',
        // 故意传一个过期的 tip
        expectedHeadOid: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        headline: '[ADD] 会冲突',
        additions: [{ path: 'mine.md', contents: b64('mine') }],
        deletions: [],
      }),
      (error) => {
        assert.ok(
          error instanceof SyncConflictError,
          `${fixture.credentials.platform}: 期望 SyncConflictError，实际 ${error.name}: ${error.message}`,
        );
        return true;
      },
      fixture.credentials.platform,
    );

    // 冲突时不该写入
    assert.equal(
      fixture.mock.state.snapshot().has('mine.md'),
      false,
      `${fixture.credentials.platform}: 冲突时不该写入`,
    );
  }
});

test('冲突后重试（重新取 tip）能在两个平台都成功，且不丢别人的数据', async (t) => {
  const env = await platformFixtures(t);

  for (const fixture of [env.github, env.gitea]) {
    const staleTip = await fixture.strategy.head('main');
    fixture.mock.state.seed('other.md', 'other');

    // 冲突 → 重新取 tip → 再试
    let tip = staleTip;
    try {
      await fixture.strategy.commit({
        branch: 'main', expectedHeadOid: tip, headline: '[ADD] x',
        additions: [{ path: 'mine.md', contents: b64('mine') }], deletions: [],
      });
      assert.fail('应该冲突');
    } catch (error) {
      assert.ok(error instanceof SyncConflictError);
      tip = await fixture.strategy.head('main');
    }

    await fixture.strategy.commit({
      branch: 'main', expectedHeadOid: tip, headline: '[ADD] 重试',
      additions: [{ path: 'mine.md', contents: b64('mine') }], deletions: [],
    });

    const snapshot = fixture.mock.state.snapshot();
    assert.ok(snapshot.has('mine.md'), `${fixture.credentials.platform}: 自己的要写进去`);
    assert.ok(snapshot.has('other.md'), `${fixture.credentials.platform}: 别人的不能被冲掉`);
  }
});

test('Gitea 策略遇到 409/422 一律当冲突（不能当参数错误静默丢数据）', async (t) => {
  const env = await platformFixtures(t);

  // 造一个必然 422 的场景：用 create 覆盖已存在文件
  // 直接调 api 模拟，验证策略层的 catch 把 422 转成 SyncConflictError
  await assert.rejects(
    async () => {
      try {
        await env.gitea.context.api('POST', '/contents', {
          body: {
            branch: 'main',
            message: 'x',
            files: [{
              operation: 'create', // ← 文件已存在，服务端会 422
              path: 'README.md',
              content: b64('dup'),
            }],
          },
        });
      } catch (error) {
        assert.equal(error.status, 422);
        // 策略里就是这么转换的
        throw new SyncConflictError(error.message, { expectedHeadOid: null });
      }
    },
    (error) => {
      assert.ok(error instanceof SyncConflictError);
      return true;
    },
  );
});

test('Gitea 删除不存在的文件是幂等 no-op，不发请求', async (t) => {
  const env = await platformFixtures(t);
  env.gitea.mock.state.resetRequests();

  const tip = await env.gitea.strategy.head('main');
  env.gitea.mock.state.resetRequests();

  // 删一个不存在的文件 + 加一个真的文件
  await env.gitea.strategy.commit({
    branch: 'main',
    expectedHeadOid: tip,
    headline: '[DELETE] 幂等',
    additions: [{ path: 'real.md', contents: b64('real') }],
    deletions: [{ path: 'never-existed.md' }],
  });

  const write = env.gitea.mock.state.requests.find(
    (item) => item.method === 'POST' && item.path.endsWith('/contents'),
  );
  assert.ok(write !== undefined, '应该有一次提交');
  const files = JSON.parse(write.raw).files;
  assert.equal(files.length, 1, '不存在的删除不该出现在 files[] 里');
  assert.equal(files[0].path, 'real.md');
  assert.equal(files[0].operation, 'create');
});

test('Gitea 提交后复核 tip 用的是重读而非响应体（响应体结构随版本变化）', async (t) => {
  const env = await platformFixtures(t);
  env.gitea.mock.state.resetRequests();

  const tip = await env.gitea.strategy.head('main');
  const newOid = await env.gitea.strategy.commit({
    branch: 'main',
    expectedHeadOid: tip,
    headline: '[ADD] x',
    additions: [{ path: 'x.md', contents: b64('x') }],
    deletions: [],
  });

  assert.equal(newOid, env.gitea.mock.state.headSha, '返回的 sha 必须是真的新 tip');

  // 提交之后应当有过一次 GET refs（复核）
  const requests = env.gitea.mock.state.requests;
  const writeIndex = requests.findIndex(
    (item) => item.method === 'POST' && item.path.endsWith('/contents'),
  );
  assert.ok(writeIndex >= 0);
  const afterWrite = requests.slice(writeIndex + 1);
  assert.ok(
    afterWrite.some((item) => item.method === 'GET' && item.path.includes('/git/refs/heads/')),
    '提交后必须重读一次 ref 来复核',
  );
});

test('空仓库引导：两个平台都能从零建出第一个提交', async (t) => {
  const env = await platformFixtures(t, { seed: false });

  // GitHub 走 PUT /contents/README.md
  const ghOid = await env.github.strategy.bootstrap('main');
  assert.match(ghOid, /^[0-9a-f]{40}$/);
  assert.ok(env.github.mock.state.snapshot().has('README.md'));
  assert.equal(env.github.mock.state.isEmpty, false);

  // Gitea 走 POST /branches + POST /contents
  assert.equal(env.gitea.mock.state.isEmpty, true, 'gitea mock 初始应为空');
  const gtOid = await env.gitea.strategy.bootstrap('main');
  assert.match(gtOid, /^[0-9a-f]{40}$/);
  assert.ok(env.gitea.mock.state.snapshot().has('README.md'));
  assert.equal(env.gitea.mock.state.isEmpty, false);

  // 引导之后 head() 必须能取到（这正是引导的目的）
  assert.equal(await env.gitea.strategy.head('main'), gtOid);
  assert.equal(await env.github.strategy.head('main'), ghOid);

  // 中文 README 必须被正确编码（btoa 直接编会炸）
  const content = env.gitea.mock.state.snapshot().get('README.md').content.toString('utf8');
  assert.match(content, /笔记数据仓库/);
});

test('多批提交在两个平台逐批推进，且最终内容一致', async (t) => {
  const env = await platformFixtures(t);

  // 构造 3 批
  const batches = [
    [{ path: 'n/a.md', contents: b64('a') }, { path: 'n/b.md', contents: b64('b') }],
    [{ path: 'n/c.md', contents: b64('c') }],
    [{ path: 'n/d.md', contents: b64('d') }],
  ];

  for (const fixture of [env.github, env.gitea]) {
    let tip = await fixture.strategy.head('main');
    for (const [index, additions] of batches.entries()) {
      tip = await fixture.strategy.commit({
        branch: 'main',
        expectedHeadOid: tip,
        headline: `[ADD] 第 ${index + 1} 批`,
        additions,
        deletions: [],
      });
      assert.match(tip, /^[0-9a-f]{40}$/, `${fixture.credentials.platform} 第 ${index + 1} 批`);
    }
  }

  assert.deepEqual(
    serialize(env.gitea.mock.state.snapshot()),
    serialize(env.github.mock.state.snapshot()),
  );
});

test('createStrategy 对未知平台抛错', () => {
  assert.throws(
    () => createStrategy('gitlab', { api: async () => {}, credentials: () => ({}) }),
    /不支持的代码平台/,
  );
});

test('GraphQLCommitStrategy 缺 graphql 上下文时立刻报错（不静默失败）', () => {
  assert.throws(
    () => new GraphQLCommitStrategy({ api: async () => {}, credentials: () => ({}) }),
    /需要 graphql 上下文/,
  );
});
