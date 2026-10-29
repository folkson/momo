/**
 * 适配层入口：注册表 + 工厂 + 分批提交工具。
 *
 * 上层只 import 这个文件，不直接碰具体平台实现。
 */
import { GitProvider } from './base.mjs';
import { GithubProvider } from './github.mjs';
import { ForgejoProvider } from './forgejo.mjs';
import { ConflictError, GitProviderError } from './errors.mjs';

export { GitProvider, decodeBase64, encodeBase64 } from './base.mjs';
export { GithubProvider } from './github.mjs';
export { ForgejoProvider } from './forgejo.mjs';
export {
  GitProviderError, ConflictError, NotFoundError, AuthError, fromHttpStatus,
} from './errors.mjs';
export { AUTH_STYLES, buildHeaders } from './http.mjs';

/**
 * 已注册的平台。
 *
 * `gitea` 与 `forgejo` 指向同一个实现类 —— 它们的这一块 API 完全一致，
 * 分开注册只是为了让配置里能写自己实际用的那个名字（排错时更直观）。
 */
export const PROVIDERS = Object.freeze({
  github: GithubProvider,
  forgejo: ForgejoProvider,
  gitea: ForgejoProvider,
});

/** 给 UI 用的平台元信息（不含实现）。 */
export const PROVIDER_INFO = Object.freeze([
  {
    id: 'github',
    name: 'GitHub',
    baseUrl: 'https://api.github.com',
    hint: 'token 在 Settings → Developer settings → Personal access tokens 生成，需要 repo 权限',
  },
  {
    id: 'forgejo',
    name: 'Forgejo',
    baseUrl: 'https://codeberg.org/api/v1',
    hint: 'Base URL 形如 https://你的域名/api/v1；token 在 设置 → 应用 → 访问令牌 生成，需要 write:repository',
  },
  {
    id: 'gitea',
    name: 'Gitea',
    baseUrl: 'https://gitea.com/api/v1',
    hint: 'Base URL 形如 https://你的域名/api/v1；token 在 设置 → 应用 → 管理访问令牌 生成，需要 write:repository',
  },
]);

/**
 * 建一个 provider 实例。
 *
 * @param {object} config 配置
 * @param {'github'|'forgejo'|'gitea'} config.provider 平台 id
 * @param {string} [config.baseUrl] API 基址；省略时用平台默认值
 * @param {string} config.token 访问令牌
 * @param {string} config.owner 仓库 owner
 * @param {string} config.repo 仓库名
 * @param {typeof fetch} [config.fetchImpl] 测试注入
 * @returns {GitProvider} provider 实例
 */
export function createProvider(config) {
  const id = String(config?.provider ?? '').toLowerCase();
  const Impl = PROVIDERS[id];
  if (Impl === undefined) {
    throw new GitProviderError(
      `不支持的代码平台：${id || '(空)'}。可选：${Object.keys(PROVIDERS).join(' / ')}`,
      0,
      { platform: id },
    );
  }

  // baseUrl 省略时用平台默认值；Gitea/Forgejo 没有公共默认实例，
  // 所以这里的默认值只是占位，用户必须自己填。
  const fallback = PROVIDER_INFO.find((item) => item.id === id)?.baseUrl ?? '';
  const baseUrl = String(config?.baseUrl ?? '').trim() || fallback;

  const { fetchImpl } = config ?? {};
  const options = fetchImpl === undefined ? {} : { fetchImpl };

  if (id === 'gitea' || id === 'forgejo') {
    return new Impl({ ...config, baseUrl, platform: id }, options);
  }
  return new Impl({ ...config, baseUrl }, options);
}

/**
 * 按平台上限把变更切成多批。
 *
 * ⚠️ 为什么必须分批：GitHub 单次上限 200 文件 / 8MB，Gitea 更保守。
 * 首次全量同步时笔记数可能上千，不分批会直接被服务端拒掉。
 *
 * 分批策略：按文件数 + 累计字节数双阈值。**单个文件超过字节上限时单独成批**
 * （否则会陷入死循环：它永远放不进任何一批）。
 *
 * @param {{additions: Array<{path: string, contents: Uint8Array}>, deletions: Array<{path: string}>}} changes
 * @param {{maxFilesPerCommit: number, maxBytesPerCommit: number}} caps 平台能力
 * @returns {Array<{additions: Array<object>, deletions: Array<object>}>} 分批结果
 */
export function chunkChanges(changes, caps) {
  const maxFiles = Math.max(1, Number(caps?.maxFilesPerCommit ?? 100));
  const maxBytes = Math.max(1, Number(caps?.maxBytesPerCommit ?? 8 * 1024 * 1024));

  /** @type {Array<{additions: Array<object>, deletions: Array<object>}>} */
  const batches = [];

  /** @type {{additions: Array<object>, deletions: Array<object>, bytes: number}} */
  let current = { additions: [], deletions: [], bytes: 0 };

  /**
   * 把当前批推出（如果不为空）。
   */
  function flush() {
    if (current.additions.length > 0 || current.deletions.length > 0) {
      batches.push({ additions: current.additions, deletions: current.deletions });
    }
    current = { additions: [], deletions: [], bytes: 0 };
  }

  for (const addition of changes.additions ?? []) {
    const size = addition.contents?.byteLength ?? addition.contents?.length ?? 0;
    const fileCount = current.additions.length + current.deletions.length;
    const wouldExceedFiles = fileCount >= maxFiles;
    const wouldExceedBytes = current.bytes + size > maxBytes && fileCount > 0;

    if (wouldExceedFiles || wouldExceedBytes) flush();

    current.additions.push(addition);
    current.bytes += size;
  }

  for (const deletion of changes.deletions ?? []) {
    const fileCount = current.additions.length + current.deletions.length;
    if (fileCount >= maxFiles) flush();
    // 删除不占字节，只受文件数约束
    current.deletions.push(deletion);
  }

  flush();
  return batches;
}

/**
 * 带冲突重试的批量提交。
 *
 * ## 为什么会冲突
 *
 * 无 CAS 平台（Gitea/Forgejo）的竞态窗口更大：读树 → 组 files → 提交 之间
 * 可能被另一台设备插入。有 CAS 的 GitHub 也一样可能撞上（只是概率更低）。
 *
 * ## 重试语义
 *
 * 冲突**不是错误**，是"该重新读一遍再试"。所以：
 *   · 捕获 ConflictError → 调用 `reload()` 重新拉取状态 → 重试
 *   · 其他错误直接抛出（重试也没用）
 *   · 超过 attempts 次仍冲突，抛 ConflictError 让上层决定
 *
 * @param {GitProvider} provider 平台适配器
 * @param {object} options 参数
 * @param {string} options.branch 分支
 * @param {Array<{path: string, contents: Uint8Array}>} options.additions 新增/覆盖
 * @param {Array<{path: string}>} options.deletions 删除
 * @param {string} options.headline 提交信息
 * @param {() => Promise<string|null>} [options.reload] 冲突时重新取 tip；返回新 tip
 * @param {number} [options.attempts] 最大尝试次数（默认 3）
 * @returns {Promise<{oids: string[], batches: number}>} 每批产生的 commit sha
 */
export async function commitWithRetry(provider, options) {
  const attempts = Math.max(1, Number(options.attempts ?? 3));
  const headline = String(options.headline ?? 'sync');
  const branch = String(options.branch ?? 'main');

  /** @type {string[]} */
  const oids = [];
  const batches = chunkChanges(
    { additions: options.additions ?? [], deletions: options.deletions ?? [] },
    provider.caps,
  );

  /** @type {string|null} */
  let expected = options.expectedHeadOid ?? null;

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    // 多批时给每批加序号，便于在 git log 里看出是一次同步拆出来的
    const message = batches.length === 1 ? headline : `${headline} (${index + 1}/${batches.length})`;

    /** @type {Error|null} */
    let lastError = null;
    let done = false;

    for (let attempt = 1; attempt <= attempts && done === false; attempt += 1) {
      try {
        const result = await provider.commitBatch({
          branch,
          expectedHeadOid: expected,
          headline: message,
          additions: batch.additions,
          deletions: batch.deletions,
        });
        oids.push(result.oid);
        // 下一批必须基于这一批的新 tip，否则会立刻冲突
        expected = result.oid;
        done = true;
      } catch (error) {
        lastError = error;
        if (!(error instanceof ConflictError)) throw error;
        if (attempt >= attempts) break;
        // 冲突 → 重新读远端状态，再试
        if (typeof options.reload === 'function') {
          const reloaded = await options.reload();
          if (typeof reloaded === 'string' && reloaded !== '') expected = reloaded;
        }
      }
    }

    if (done === false) {
      throw lastError ?? new ConflictError(
        `[${provider.caps.id}] 分批提交第 ${index + 1} 批失败`,
        { platform: provider.caps.id },
      );
    }
  }

  return { oids, batches: batches.length };
}
