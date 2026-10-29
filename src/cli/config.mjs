/**
 * 配置加载与校验。
 *
 * ## 为什么全部要在启动时就校验完
 *
 * 这是个跑在定时任务里的工具。如果不在这里拦，典型的失败长这样：
 *
 *   · 跑到第 847 条笔记才发现 baseUrl 写错了 → 前 846 条已经推完，
 *     状态文件却因为中途抛错没落盘 → 下一轮全部重推 → memos 里翻倍
 *
 * 所以配置错误必须**在发出第一个请求之前**就炸掉，而且退出码要能区分
 * 「配置错」（2）和「运行错」（1），好让监控能自动区分。
 *
 * ## 一个容易搞错的地方
 *
 * Gitea/Forgejo 的 API 基址必须带 `/api/v1`，而用户经常只粘域名。
 * 这里自动补上 —— 但只在**没带任何路径**时补，避免把反向代理的自定义前缀搞坏。
 */
import { DEFAULT_STATE_FILENAME } from '../state.mjs';
import { MEMOS_VISIBILITIES, DEFAULT_MIN_INTERVAL_MS } from '../memos/client.mjs';

/**
 * 配置错误。
 */
export class ConfigError extends Error {
  /**
   * @param {string} message 描述
   */
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * @typedef {object} Config
 * @property {{provider: string, baseUrl: string, token: string, owner: string, repo: string}} git
 * @property {{baseUrl: string, username: string, password: string, visibility: string,
 *   minIntervalMs: number}} memos
 * @property {string} statePath
 */

/**
 * 自动补 `/api/v1`。
 *
 * @param {string} input 用户输入
 * @returns {string} 规范化后的基址
 */
export function normalizeGitBaseUrl(input) {
  let text = String(input ?? '').trim();
  if (text === '') return '';
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
  text = text.replace(/\/+$/, '');
  // 已经带路径（含 /api）就原样保留 —— 可能是反代前缀
  if (/\/api(\/|$)/i.test(text)) return text;
  const url = new URL(text);
  // 纯域名 → 补 /api/v1
  if (url.pathname === '' || url.pathname === '/') return `${text}/api/v1`;
  return text;
}

/**
 * 从环境变量 + 命令行选项加载配置。
 *
 * @param {import('./args.mjs').Command} cli 命令行
 * @param {NodeJS.ProcessEnv} [env] 环境变量（测试注入）
 * @returns {Config}
 */
export function loadConfig(cli, env = process.env) {
  /** 取值的优先级：命令行 > 环境变量 > 默认值 */
  const pick = (cliName, envName, fallback = undefined) => {
    if (cliName !== null && cliName !== undefined) {
      const fromCli = cli?.value(cliName, null);
      if (fromCli !== null && fromCli !== '') return fromCli;
    }
    const fromEnv = env[envName];
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
    return fallback;
  };

  const provider = String(pick(null, 'GIT_PROVIDER', 'gitea')).toLowerCase();
  if (['github', 'gitea', 'forgejo'].includes(provider) === false) {
    throw new ConfigError(
      `GIT_PROVIDER 只能是 github / gitea / forgejo，收到「${provider}」`,
    );
  }

  const gitBaseUrlRaw = pick(null, 'GIT_BASE_URL', '');
  // GitHub 有公开默认值；Gitea/Forgejo 没有，必须显式提供
  const gitBaseUrl = provider === 'github' && gitBaseUrlRaw === ''
    ? 'https://api.github.com'
    : normalizeGitBaseUrl(gitBaseUrlRaw);

  if (gitBaseUrl === '') {
    throw new ConfigError(
      `未配置 GIT_BASE_URL。${provider === 'github' ? '' : 'Gitea/Forgejo 必须填写，形如 https://git.example.com/api/v1'}`,
    );
  }

  const gitToken = pick(null, 'GIT_TOKEN', '');
  if (gitToken === '') throw new ConfigError('未配置 GIT_TOKEN');

  const owner = pick('owner', 'GIT_OWNER', '');
  if (owner === '') throw new ConfigError('未配置 GIT_OWNER（仓库所有者）');

  const repo = pick('repo', 'GIT_REPO', '');
  if (repo === '') throw new ConfigError('未配置 GIT_REPO（仓库名）');

  const memosBaseUrl = pick(null, 'MEMOS_BASE_URL', '');
  if (memosBaseUrl === '') throw new ConfigError('未配置 MEMOS_BASE_URL');

  const username = pick(null, 'MEMOS_USERNAME', '');
  const password = pick(null, 'MEMOS_PASSWORD', '');
  if (username === '' || password === '') {
    throw new ConfigError('未配置 MEMOS_USERNAME / MEMOS_PASSWORD');
  }

  const visibility = String(pick(null, 'MEMOS_VISIBILITY', 'PRIVATE')).toUpperCase();
  if (MEMOS_VISIBILITIES.includes(visibility) === false) {
    throw new ConfigError(
      `MEMOS_VISIBILITY 只能是 ${MEMOS_VISIBILITIES.join(' / ')}，收到「${visibility}」`,
    );
  }

  const intervalRaw = pick(null, 'MEMOS_MIN_INTERVAL_MS', '');
  const minIntervalMs = intervalRaw === ''
    ? DEFAULT_MIN_INTERVAL_MS
    : Number(intervalRaw);
  if (Number.isFinite(minIntervalMs) === false || minIntervalMs < 0) {
    throw new ConfigError(`MEMOS_MIN_INTERVAL_MS 必须是非负数，收到「${intervalRaw}」`);
  }

  const statePath = pick('state', 'NENO_STATE_PATH', DEFAULT_STATE_FILENAME);

  return {
    git: { provider, baseUrl: gitBaseUrl, token: gitToken, owner, repo },
    memos: { baseUrl: memosBaseUrl, username, password, visibility, minIntervalMs },
    statePath,
  };
}
