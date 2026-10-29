/**
 * 端到端测试：真的把 `src/cli.mjs` 跑起来。
 *
 * ## 为什么需要这一层
 *
 * 前面所有测试都是 import 函数直接调。但真正交付给用户的是**那条命令**，
 * 中间还隔着一层：环境变量解析、状态文件落盘、退出码、stdout 格式。
 * 这些任何一处出错，用户看到的就是"跑完了但什么都没同步"。
 *
 * 所以这里 spawn 真进程，只通过环境变量和退出码交互 —— 跟用户的用法一致。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startMockGitea } from '../testkit/mock-gitea.mjs';
import { startMockMemos } from '../testkit/mock-memos.mjs';

/** CLI 脚本绝对路径。 */
const CLI_PATH = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

/**
 * 跑一次 CLI。
 *
 * @param {string[]} argv 参数
 * @param {Record<string, string>} env 额外环境变量
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function runCli(argv, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...argv], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * 从 KEY=VALUE 输出里取值。
 *
 * @param {string} stdout 输出
 * @param {string} key 键
 * @returns {string|null}
 */
function readKey(stdout, key) {
  const match = new RegExp(`^${key}=(.*)$`, 'm').exec(stdout);
  return match === null ? null : match[1];
}

/**
 * 起一套完整环境。
 *
 * @param {import('node:test').TestContext} t 测试上下文
 * @param {object} [options] 选项
 * @returns {Promise<object>}
 */
async function setup(t, options = {}) {
  const gitea = await startMockGitea();
  const memos = await startMockMemos();
  const dir = await mkdtemp(join(tmpdir(), 'momo-e2e-'));

  t.after(async () => {
    await gitea.close();
    await memos.close();
    await rm(dir, { recursive: true, force: true });
  });

  const files = options.files ?? [];
  let seeded = false;
  for (const file of files) {
    gitea.state.seed(file.path, file.text);
    seeded = true;
  }
  if (seeded === false) gitea.state.seed('README.md', '#');

  const statePath = join(dir, 'map.json');

  /** @type {Record<string, string>} */
  const env = {
    GIT_PROVIDER: 'gitea',
    GIT_BASE_URL: gitea.baseUrl,
    GIT_TOKEN: gitea.token,
    GIT_OWNER: gitea.owner,
    GIT_REPO: gitea.repo,
    MEMOS_BASE_URL: memos.baseUrl,
    MEMOS_USERNAME: memos.username,
    MEMOS_PASSWORD: memos.password,
    MEMOS_MIN_INTERVAL_MS: '0',
    NENO_STATE_PATH: statePath,
  };

  return { gitea, memos, dir, statePath, env };
}

/**
 * 构造 neno 笔记 JSON。
 *
 * @param {object} note 字段
 * @returns {string}
 */
function noteJson(note) {
  return JSON.stringify({
    _id: note.id,
    content: note.content ?? '<p></p>',
    tags: note.tags ?? [],
    images: note.images ?? [],
    created_at: note.createdAt ?? '2026-10-29T09:35:29+08:00',
  });
}

// ─────────────────────────────────────────────────────────────
// 测试
// ─────────────────────────────────────────────────────────────

test('CLI 首次同步：建 memo、落状态文件、退出码 0', async (t) => {
  const env = await setup(t, {
    files: [
      { path: '2026-10-29/n1.json', text: noteJson({ id: 'n1', content: '<p>端到端</p>' }) },
      {
        path: '2026-10-29/n2.json',
        text: noteJson({
          id: 'n2',
          content: '<p>带图</p>',
          images: [{ key: 'pic', suffixName: 'png' }],
        }),
      },
      { path: 'picData/pic.png', text: 'PNGDATA' },
    ],
  });

  const result = await runCli(['sync'], env.env);

  assert.equal(result.code, 0, `stderr: ${result.stderr}`);
  assert.equal(readKey(result.stdout, 'ok'), 'true');
  assert.equal(readKey(result.stdout, 'notes'), '2');
  assert.equal(readKey(result.stdout, 'created'), '2');
  assert.equal(readKey(result.stdout, 'images_uploaded'), '1');
  assert.equal(readKey(result.stdout, 'errors'), '0');

  // memos 上真的有两条
  assert.equal(env.memos.state.memos.size, 2);

  // 状态文件已落盘，且内容正确
  const stateText = await readFile(env.statePath, 'utf8');
  const state = JSON.parse(stateText);
  assert.ok(state.notes.n1 !== undefined);
  assert.equal(state.notes.n1.memoId, 1);
  assert.equal(state.notes.n2.images['pic.png'].resourceId, 1);
  // 文件要以换行结尾（便于 git 协作）
  assert.equal(stateText.endsWith('\n'), true);
});

test('CLI 连跑两次：第二次 unchanged，零写请求', async (t) => {
  const env = await setup(t, {
    files: [{ path: '2026-10-29/n1.json', text: noteJson({ id: 'n1', content: '<p>稳定</p>' }) }],
  });

  const first = await runCli(['sync'], env.env);
  assert.equal(first.code, 0, first.stderr);

  env.memos.state.resetRequests();
  const second = await runCli(['sync'], env.env);

  assert.equal(second.code, 0, second.stderr);
  assert.equal(readKey(second.stdout, 'created'), '0');
  assert.equal(readKey(second.stdout, 'updated'), '0');
  assert.equal(readKey(second.stdout, 'unchanged'), '1');
  assert.equal(env.memos.state.writes().length, 0, '第二轮不该写 memos');
  assert.equal(env.memos.state.memos.size, 1, '不能重复建');
});

test('CLI 配置缺失 → 退出码 2，且 stdout 标明原因', async (t) => {
  const env = await setup(t);
  const broken = { ...env.env };
  delete broken.GIT_TOKEN;

  const result = await runCli(['sync'], broken);

  assert.equal(result.code, 2, '配置问题必须是 2，便于监控区分');
  assert.equal(readKey(result.stdout, 'ok'), 'false');
  assert.equal(readKey(result.stdout, 'reason'), 'config');
  assert.match(result.stderr, /GIT_TOKEN/);
  // 一条 memo 都不该建
  assert.equal(env.memos.state.memos.size, 0);
});

test('CLI check 命令验证两端连通性', async (t) => {
  const env = await setup(t);
  const result = await runCli(['check'], env.env);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(readKey(result.stdout, 'ok'), 'true');
  assert.match(result.stderr, /代码平台认证成功/);
  assert.match(result.stderr, /memos 认证成功/);
  // check 不该建 memo
  assert.equal(env.memos.state.memos.size, 0);
});

test('CLI check 在 token 错时报失败', async (t) => {
  const env = await setup(t);
  const result = await runCli(['check'], { ...env.env, GIT_TOKEN: 'wrong' });

  assert.equal(result.code, 1);
  assert.equal(readKey(result.stdout, 'ok'), 'false');
  assert.match(result.stdout, /problem=/);
});

test('CLI --dry-run 只读仓库，不产生任何写入', async (t) => {
  const env = await setup(t, {
    files: [
      { path: '2026-10-29/n1.json', text: noteJson({ id: 'n1', content: '<p>试跑</p>' }) },
      {
        path: '2026-10-29/n2.json',
        text: noteJson({
          id: 'n2', content: '<p>缺图</p>', images: [{ key: 'gone', suffixName: 'jpg' }],
        }),
      },
    ],
  });

  const result = await runCli(['sync', '--dry-run'], env.env);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(readKey(result.stdout, 'dry_run'), 'true');
  assert.equal(readKey(result.stdout, 'notes'), '2');
  assert.equal(readKey(result.stdout, 'images_pending'), '1', '缺图要在试跑阶段就报出来');

  // ★ 核心：不写 memos、不落状态文件
  assert.equal(env.memos.state.memos.size, 0, '试跑不能建 memo');
  assert.equal(env.memos.state.writes().length, 0);
  const stateExists = await readFile(env.statePath, 'utf8').then(() => true).catch(() => false);
  assert.equal(stateExists, false, '试跑不该写状态文件');
});

test('CLI 状态文件损坏 → 备份并继续跑，不崩', async (t) => {
  const env = await setup(t, {
    files: [{ path: '2026-10-29/n1.json', text: noteJson({ id: 'n1', content: '<p>x</p>' }) }],
  });
  await writeFile(env.statePath, '{坏掉的 JSON', 'utf8');

  const result = await runCli(['sync'], env.env);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /状态文件损坏/);
  assert.equal(env.memos.state.memos.size, 1, '仍应正常同步');
});

test('CLI --state 覆盖状态文件路径', async (t) => {
  const env = await setup(t, {
    files: [{ path: '2026-10-29/n1.json', text: noteJson({ id: 'n1', content: '<p>x</p>' }) }],
  });
  const custom = join(env.dir, 'custom-state.json');

  const result = await runCli(['sync', `--state=${custom}`], env.env);
  assert.equal(result.code, 0, result.stderr);

  const state = JSON.parse(await readFile(custom, 'utf8'));
  assert.ok(state.notes.n1 !== undefined);
});

test('CLI 图片上传失败 → 仍有 exit 0，但 images_pending 记上', async (t) => {
  const env = await setup(t, {
    files: [
      {
        path: '2026-10-29/n1.json',
        text: noteJson({
          id: 'n1', content: '<p>缺图</p>', images: [{ key: 'lost', suffixName: 'png' }],
        }),
      },
    ],
  });

  const result = await runCli(['sync'], env.env);

  assert.equal(result.code, 0, '缺图不算致命错误（下轮会重试）');
  assert.equal(readKey(result.stdout, 'images_pending'), '1');

  const state = JSON.parse(await readFile(env.statePath, 'utf8'));
  assert.equal(state.notes.n1.missingImages['lost.png'], 'not_in_repo');
});

test('CLI 输出不含密码等敏感信息', async (t) => {
  const env = await setup(t, {
    files: [{ path: '2026-10-29/n1.json', text: noteJson({ id: 'n1', content: '<p>x</p>' }) }],
  });

  const result = await runCli(['sync'], env.env);
  const combined = `${result.stdout}${result.stderr}`;

  assert.equal(combined.includes(env.env.MEMOS_PASSWORD), false, '日志里不能出现 memos 密码');
  assert.equal(combined.includes(env.env.GIT_TOKEN), false, '日志里不能出现 git token');
});
