/**
 * 配置、状态、参数与输出层的测试。
 *
 * 这三块都不碰网络，但出错代价很高：
 *   · 配置错没拦住 → 跑到一半才失败，状态没落盘，下一轮全量重推
 *   · 状态文件写坏 → 映射丢失，memos 端翻倍
 *   · 输出格式变 → 定时任务的 grep 全失效
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from '../src/cli/args.mjs';
import { loadConfig, normalizeGitBaseUrl, ConfigError } from '../src/cli/config.mjs';
import { renderStats, renderSummary } from '../src/cli/report.mjs';
import { emptyState, loadState, saveState, sortState } from '../src/state.mjs';

// ─────────────────────────────────────────────────────────────
// 参数解析
// ─────────────────────────────────────────────────────────────

test('Command 解析子命令、--key=value 与布尔开关', () => {
  const cmd = new Command(['sync', '--dry-run', '--state=./x.json', '--verbose=false']);

  assert.equal(cmd.command, 'sync');
  assert.equal(cmd.has('dry-run'), true);
  assert.equal(cmd.value('state'), './x.json');
  // `--verbose=false` 不该算启用
  assert.equal(cmd.has('verbose'), false);
});

test('Command 无子命令时 command 为 null', () => {
  const cmd = new Command(['--dry-run']);
  assert.equal(cmd.command, null);
  assert.equal(cmd.has('dry-run'), true);
});

test('Command 的 value 对纯布尔开关返回 fallback', () => {
  const cmd = new Command(['--dry-run']);
  assert.equal(cmd.value('dry-run'), null);
  assert.equal(cmd.value('dry-run', 'x'), 'x');
});

// ─────────────────────────────────────────────────────────────
// 配置
// ─────────────────────────────────────────────────────────────

/**
 * 一份完整可用的环境变量。
 *
 * @returns {Record<string, string>}
 */
function fullEnv() {
  return {
    GIT_PROVIDER: 'gitea',
    GIT_BASE_URL: 'https://git.example.com/api/v1',
    GIT_TOKEN: 'tok',
    GIT_OWNER: 'alice',
    GIT_REPO: 'neno-data',
    MEMOS_BASE_URL: 'https://memos.example.com',
    MEMOS_USERNAME: 'alice',
    MEMOS_PASSWORD: 'pw',
  };
}

test('normalizeGitBaseUrl 自动补 /api/v1，但不破坏已有路径', () => {
  assert.equal(normalizeGitBaseUrl('https://git.example.com'), 'https://git.example.com/api/v1');
  assert.equal(normalizeGitBaseUrl('https://git.example.com/'), 'https://git.example.com/api/v1');
  assert.equal(
    normalizeGitBaseUrl('https://git.example.com/api/v1'),
    'https://git.example.com/api/v1',
  );
  // 反向代理的自定义前缀必须保留
  assert.equal(
    normalizeGitBaseUrl('https://example.com/gitea/api/v1'),
    'https://example.com/gitea/api/v1',
  );
  // 省略协议时补 https
  assert.equal(normalizeGitBaseUrl('git.example.com'), 'https://git.example.com/api/v1');
  assert.equal(normalizeGitBaseUrl(''), '');
});

test('loadConfig 从环境变量读出完整配置', () => {
  const config = loadConfig(new Command([]), fullEnv());

  assert.equal(config.git.provider, 'gitea');
  assert.equal(config.git.baseUrl, 'https://git.example.com/api/v1');
  assert.equal(config.git.owner, 'alice');
  assert.equal(config.git.repo, 'neno-data');
  assert.equal(config.memos.visibility, 'PRIVATE');
  assert.equal(config.memos.minIntervalMs, 150);
  assert.equal(config.statePath, '.memos-map.json');
});

test('loadConfig 缺关键项时抛 ConfigError（且说清缺哪个）', () => {
  for (const key of ['GIT_TOKEN', 'GIT_OWNER', 'GIT_REPO', 'MEMOS_BASE_URL', 'MEMOS_PASSWORD']) {
    const env = fullEnv();
    delete env[key];
    assert.throws(
      () => loadConfig(new Command([]), env),
      (error) => {
        assert.ok(error instanceof ConfigError, `${key}: 应该是 ConfigError`);
        assert.match(error.message, new RegExp(key === 'GIT_OWNER' ? 'GIT_OWNER' : key));
        return true;
      },
      `缺 ${key} 时必须报错`,
    );
  }
});

test('loadConfig 拒绝非法 provider 与 visibility', () => {
  assert.throws(
    () => loadConfig(new Command([]), { ...fullEnv(), GIT_PROVIDER: 'gitlab' }),
    /github \/ gitea \/ forgejo/,
  );
  assert.throws(
    () => loadConfig(new Command([]), { ...fullEnv(), MEMOS_VISIBILITY: 'SECRET' }),
    /PRIVATE \/ PROTECTED \/ PUBLIC/,
  );
});

test('loadConfig 给 GitHub 兜底 baseUrl，Gitea 不给', () => {
  const env = fullEnv();
  delete env.GIT_BASE_URL;

  // Gitea 没有公共默认实例 → 必须报错
  assert.throws(() => loadConfig(new Command([]), env), /GIT_BASE_URL/);

  // GitHub 有公开 API
  const github = loadConfig(new Command([]), { ...env, GIT_PROVIDER: 'github' });
  assert.equal(github.git.baseUrl, 'https://api.github.com');
});

test('loadConfig 命令行选项优先于环境变量', () => {
  const cli = new Command(['sync', '--repo=from-cli']);
  const config = loadConfig(cli, fullEnv());
  assert.equal(config.git.repo, 'from-cli');
});

// ─────────────────────────────────────────────────────────────
// 状态文件
// ─────────────────────────────────────────────────────────────

/**
 * 建一个临时目录并在结束时清掉。
 *
 * @param {import('node:test').TestContext} t 测试上下文
 * @returns {Promise<string>} 目录路径
 */
async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'momo-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('状态文件不存在 → 返回空状态，不报错', async (t) => {
  const dir = await tempDir(t);
  const { state, recovered } = await loadState(join(dir, 'nope.json'));

  assert.deepEqual(state, emptyState());
  assert.equal(recovered, false);
});

test('状态文件往返读写一致', async (t) => {
  const dir = await tempDir(t);
  const path = join(dir, 'map.json');

  const state = emptyState();
  state.notes.n1 = { memoId: 7, contentHash: 'sha256:abc', resourceIds: [1, 2] };
  await saveState(path, state);

  const { state: loaded, recovered } = await loadState(path);
  assert.equal(recovered, false);
  assert.deepEqual(loaded.notes.n1, state.notes.n1);
  assert.equal(loaded.version, 1);
});

test('原子写入：不会留下临时文件', async (t) => {
  const dir = await tempDir(t);
  const path = join(dir, 'map.json');

  await saveState(path, emptyState());
  await saveState(path, emptyState());

  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(dir);
  assert.deepEqual(entries, ['map.json'], `不该残留临时文件，实际：${entries.join(', ')}`);
});

test('状态文件损坏 → 备份原文件并重置（绝不静默覆盖）', async (t) => {
  const dir = await tempDir(t);
  const path = join(dir, 'map.json');
  await writeFile(path, '{ 这不是 JSON', 'utf8');

  const { state, recovered, backupPath } = await loadState(path);

  assert.equal(recovered, true, '要标记成"恢复过"，让调用方能提示用户');
  assert.deepEqual(state, emptyState());
  assert.ok(backupPath !== null);
  // 原始内容必须保留在备份里
  const backup = await readFile(backupPath, 'utf8');
  assert.equal(backup, '{ 这不是 JSON');
});

test('状态文件是数组 / notes 类型错 → 自动修正而不是崩', async (t) => {
  const dir = await tempDir(t);

  const arrayPath = join(dir, 'a.json');
  await writeFile(arrayPath, '[]', 'utf8');
  const a = await loadState(arrayPath);
  assert.equal(a.recovered, true);
  assert.deepEqual(a.state.notes, {});

  const badNotesPath = join(dir, 'b.json');
  await writeFile(badNotesPath, '{"version":1,"notes":"oops"}', 'utf8');
  const b = await loadState(badNotesPath);
  assert.deepEqual(b.state.notes, {});
});

test('sortState 按笔记 id 排序，让 diff 稳定', () => {
  const state = {
    version: 1,
    notes: {
      zzz: { memoId: 3 },
      aaa: { memoId: 1 },
      mmm: { memoId: 2 },
    },
  };
  const sorted = sortState(state);
  assert.deepEqual(Object.keys(sorted.notes), ['aaa', 'mmm', 'zzz']);
  // 原对象不被修改
  assert.deepEqual(Object.keys(state.notes), ['zzz', 'aaa', 'mmm']);
});

// ─────────────────────────────────────────────────────────────
// 输出
// ─────────────────────────────────────────────────────────────

test('renderStats 输出 KEY=VALUE，能被脚本直接消费', () => {
  const out = renderStats({
    notes: 10, created: 2, updated: 3, unchanged: 5, skipped: 0,
    imagesUploaded: 4, imagesPending: 1, timesFixed: 2, orphaned: 0,
    errors: [],
  });

  assert.match(out, /^ok=true$/m);
  assert.match(out, /^notes=10$/m);
  assert.match(out, /^created=2$/m);
  assert.match(out, /^images_pending=1$/m);
  assert.match(out, /^orphaned=0$/m);
  assert.match(out, /^errors=0$/m);
  assert.equal(out.endsWith('\n'), true);
});

test('renderStats 把错误铺成多条 error= 行且压掉换行', () => {
  const out = renderStats({ errors: ['a：第一行\n第二行', 'b：出错了'] });

  assert.match(out, /^errors=2$/m);
  const errorLines = out.split('\n').filter((line) => line.startsWith('error='));
  assert.equal(errorLines.length, 2);
  assert.equal(errorLines[0], 'error=a：第一行 第二行', '换行必须压成空格，否则会破坏一行一条');
});

test('renderStats 在 dry-run 时带上标记', () => {
  assert.match(renderStats({}, { dryRun: true }), /^dry_run=true$/m);
  assert.equal(/dry_run/.test(renderStats({})), false);
});

test('renderSummary 只显示非零项，缺图会明说', () => {
  const text = renderSummary({
    notes: 5, created: 1, updated: 0, unchanged: 4, imagesPending: 2,
  });
  assert.match(text, /笔记 5/);
  assert.match(text, /缺图待重试 2/);
  assert.equal(text.includes('孤儿'), false, '零值项不该出现');
});
