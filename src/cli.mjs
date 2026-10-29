#!/usr/bin/env node
/**
 * 命令行入口：`momo sync`
 *
 * ## 设计取向
 *
 * 这是个**给定时任务跑**的工具，不是交互式 CLI。所以：
 *   · 配置全部走环境变量（便于 Docker / GitHub Actions / cron 注入）
 *   · 用退出码表达结果（0 成功 / 1 出错 / 2 配置问题），不靠人读日志
 *   · 输出既给人看（stderr 的人类可读日志），也给机器读（stdout 的 KEY=VALUE）
 *
 * ## 典型用法
 *
 *     # 试跑，不写 memos
 *     node src/cli.mjs sync --dry-run
 *
 *     # 真跑
 *     node src/cli.mjs sync
 *
 *     # 只看能不能连上两端
 *     node src/cli.mjs check
 */
import { Command } from './cli/args.mjs';
import { loadConfig, ConfigError } from './cli/config.mjs';
import { createProvider } from './request/gitProvider/index.mjs';
import { createMemosClient } from './memos/client.mjs';
import { createSyncRunner } from './memos/sync.mjs';
import { loadState, saveState, sortState } from './state.mjs';
import { renderStats } from './cli/report.mjs';

/** 退出码约定。 */
export const EXIT = Object.freeze({ OK: 0, FAIL: 1, CONFIG: 2 });

/**
 * 人类可读日志（写 stderr，不污染 stdout 的机器可读输出）。
 *
 * @param {string} level 级别
 * @param {string} message 内容
 * @param {object} [extra] 附加字段
 */
function log(level, message, extra) {
  const time = new Date().toISOString().slice(11, 19);
  const tail = extra === undefined || extra === null || Object.keys(extra).length === 0
    ? ''
    : ` ${JSON.stringify(extra)}`;
  process.stderr.write(`${time} ${level.toUpperCase().padEnd(5)} ${message}${tail}\n`);
}

const logger = {
  info: (message, extra) => log('info', message, extra),
  warn: (message, extra) => log('warn', message, extra),
  debug: (message, extra) => {
    if (process.env.NENO_DEBUG === '1') log('debug', message, extra);
  },
};

/**
 * 入口。
 *
 * @param {string[]} argv 命令行参数
 * @returns {Promise<number>} 退出码
 */
async function main(argv) {
  const cli = new Command(argv);
  const command = cli.command ?? 'sync';

  if (cli.has('help') || command === 'help') {
    process.stdout.write(HELP_TEXT);
    return EXIT.OK;
  }

  /** @type {import('./cli/config.mjs').Config} */
  let config;
  try {
    config = loadConfig(cli);
  } catch (error) {
    if (error instanceof ConfigError) {
      log('error', error.message);
      process.stdout.write('ok=false\nreason=config\n');
      return EXIT.CONFIG;
    }
    throw error;
  }

  const provider = createProvider({
    provider: config.git.provider,
    baseUrl: config.git.baseUrl,
    token: config.git.token,
    owner: config.git.owner,
    repo: config.git.repo,
  });

  const client = createMemosClient({
    baseUrl: config.memos.baseUrl,
    username: config.memos.username,
    password: config.memos.password,
    minIntervalMs: config.memos.minIntervalMs,
  });

  // ── check：只验连通性与权限 ──
  if (command === 'check') {
    return runCheck({ config, provider, client, logger });
  }

  // ── sync ──
  const { state, recovered, backupPath } = await loadState(config.statePath);
  if (recovered) {
    logger.warn(`状态文件损坏，已备份并重置`, { backupPath });
  }

  await client.signin();
  logger.info('已登录 memos', { baseUrl: config.memos.baseUrl });

  if (cli.has('dry-run')) {
    // 试跑：只读仓库，不写 memos。用真实的消费者逻辑，但把写操作换成计数。
    const stats = await dryRun({ provider, config });
    process.stdout.write(renderStats(stats, { dryRun: true }));
    return EXIT.OK;
  }

  const runner = createSyncRunner({
    provider,
    client,
    visibility: config.memos.visibility,
    state,
    persist: (next) => saveState(config.statePath, sortState(next)),
    log: logger,
  });

  const stats = await runner.run();
  // 收尾再存一次：确保空跑那轮也把排序结果落盘
  await saveState(config.statePath, sortState(state));

  process.stdout.write(renderStats(stats, { dryRun: false }));
  return stats.errors.length > 0 ? EXIT.FAIL : EXIT.OK;
}

/**
 * 试跑：只读仓库并统计，不写 memos。
 *
 * ⚠️ 这里刻意不复用 `createSyncRunner` —— 那会真的去上传图片。
 * 试跑的价值在于"看看会有什么变化"，一旦有副作用就失去意义了。
 *
 * @param {object} params 参数
 * @param {any} params.provider 代码平台
 * @param {any} params.config 配置
 * @returns {Promise<object>} 统计
 */
async function dryRun({ provider, config }) {
  const { findNoteFiles, findImageFiles, parseNoteJson, htmlToMarkdown, toSecondsTimestamp } =
    await import('./memos/sync.mjs');
  const { buildMemoContent } = await import('./memos/content.mjs');

  const repo = await provider.getRepo();
  const head = await provider.getHead(repo.defaultBranch);
  const tree = await provider.getTree(head.oid);
  const noteFiles = findNoteFiles(tree);
  const imageShas = findImageFiles(tree);

  const stats = {
    notes: noteFiles.length, created: 0, updated: 0, unchanged: 0,
    skipped: 0, imagesUploaded: 0, timesFixed: 0, imagesPending: 0,
    orphaned: 0, errors: [],
  };

  for (const file of noteFiles) {
    const raw = await provider.getBlob(file.sha);
    const note = parseNoteJson(new TextDecoder().decode(raw));
    if (note === null) {
      stats.errors.push(`解析失败：${file.path}`);
      stats.skipped += 1;
      continue;
    }
    const body = htmlToMarkdown(note.content);
    const content = buildMemoContent({ body, tags: note.tags });
    if (content.trim() === '' && note.images.length === 0) {
      stats.skipped += 1;
      continue;
    }
    // 试跑没法比指纹（没读状态），统一记成"会写"
    stats.created += 1;
    for (const image of note.images) {
      const filename = `${image.key}.${image.suffixName}`;
      if (imageShas.has(filename) === false) {
        stats.imagesPending += 1;
        logger.warn(`图片在仓库里不存在：picData/${filename}`, { noteId: file.noteId });
      }
    }
    logger.info(`将推送：${file.path}`, {
      createdAt: toSecondsTimestamp(note.createdAt),
      bytes: new TextEncoder().encode(content).length,
    });
  }

  logger.info(`仓库 ${repo.fullName}@${repo.defaultBranch} 共 ${noteFiles.length} 条笔记`);
  return stats;
}

/**
 * check 命令：验证两端连通性。
 *
 * @param {object} params 参数
 * @returns {Promise<number>} 退出码
 */
async function runCheck({ config, provider, client, logger: logImpl }) {
  /** @type {string[]} */
  const problems = [];

  // 代码平台
  try {
    const user = await provider.getUser();
    logImpl.info(`代码平台认证成功：${user.login}`, { platform: config.git.provider });
  } catch (error) {
    problems.push(`代码平台：${error.message}`);
    logImpl.warn(`代码平台认证失败：${error.message}`);
  }

  try {
    const repo = await provider.getRepo();
    const head = await provider.getHead(repo.defaultBranch);
    logImpl.info(`仓库可读：${repo.fullName}@${repo.defaultBranch}`, { head: head.oid });
    const tree = await provider.getTree(head.oid);
    logImpl.info(`文件树：${tree.length} 个文件`);
  } catch (error) {
    problems.push(`仓库：${error.message}`);
    logImpl.warn(`仓库读取失败：${error.message}`);
  }

  // memos
  try {
    await client.signin();
    logImpl.info(`memos 认证成功：${config.memos.baseUrl}`);
    const memos = await client.listMemos({ limit: 1 });
    logImpl.info(`memos 可读：${memos.length >= 0 ? 'yes' : 'no'}`);
  } catch (error) {
    problems.push(`memos：${error.message}`);
    logImpl.warn(`memos 连接失败：${error.message}`);
  }

  if (problems.length > 0) {
    process.stdout.write(`ok=false\nproblems=${problems.length}\n`);
    for (const problem of problems) process.stdout.write(`problem=${problem}\n`);
    return EXIT.FAIL;
  }

  process.stdout.write('ok=true\n');
  return EXIT.OK;
}

/** 帮助文本。 */
const HELP_TEXT = `momo —— 把 neno 卡片笔记同步到自建代码平台，并推送到 memos

用法：
  momo <命令> [选项]

命令：
  sync      同步一轮（默认）
  check     只验证两端连通性与权限
  help      显示本帮助

选项：
  --dry-run       试跑：只读仓库并报告将要做什么，不写 memos
  --state=<path>  状态文件路径（默认 ./.memos-map.json）
  --help          显示本帮助

环境变量：
  # 代码平台（三选一：github / gitea / forgejo）
  GIT_PROVIDER=gitea
  GIT_BASE_URL=https://git.example.com/api/v1
  GIT_TOKEN=...
  GIT_OWNER=alice
  GIT_REPO=neno-data

  # memos
  MEMOS_BASE_URL=https://memos.example.com
  MEMOS_USERNAME=alice
  MEMOS_PASSWORD=...
  MEMOS_VISIBILITY=PRIVATE     # PRIVATE / PROTECTED / PUBLIC
  MEMOS_MIN_INTERVAL_MS=150

  # 其他
  NENO_DEBUG=1                 # 打开 debug 日志

退出码：
  0  成功
  1  同步过程中有条目失败（其余已尽力完成）
  2  配置问题
`;

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    log('error', error.stack ?? String(error));
    process.stdout.write(`ok=false\nreason=exception\nmessage=${String(error.message)}\n`);
    process.exitCode = EXIT.FAIL;
  });
