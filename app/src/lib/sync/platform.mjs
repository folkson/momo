/**
 * neno 前端的代码平台抽象层（浏览器端版本）。
 *
 * ## 为什么前端还需要一套，而不复用 `src/request/gitProvider/`
 *
 * 两个理由：
 *
 * 1. **体积**：`gitProvider` 里的 Node 优化代码（Buffer、完整错误栈）会拖进
 *    前端 bundle。这个文件只做前端真正需要的事。
 * 2. **语义不同**：Node 端的 provider 面向"单向批量推送"，前端却必须做
 *    **双向合并**（拉远端 + 推本地 + 冲突重试）。强把两者塞进一个接口，
 *    会让两边都变难看。
 *
 * ## 但两者共享同一套协议事实
 *
 * 平台差异（路径单复数、返回数组还是对象、有没有 CAS）是客观事实，
 * 这里必须与 `src/request/gitProvider/` 保持一致。改一处务必同步另一处，
 * 两边的测试都会守住。
 *
 * ## 这个文件只负责"读"
 *
 * 写（提交）在 `commitStrategy.js` —— 因为两种平台的写路径差异极大
 * （GitHub 是 GraphQL mutation，Gitea 是 POST /contents），
 * 而读的差异小得多，合并在一起反而更清楚。
 */

/**
 * 平台能力矩阵（前端版）。
 *
 * @typedef {object} PlatformCaps
 * @property {string} id 平台标识
 * @property {string} displayName 展示名
 * @property {boolean} branchHeadCAS 是否支持分支 tip 级 CAS
 * @property {boolean} fileLevelShaCAS 是否支持文件级 sha 校验
 * @property {boolean} etag 是否支持 ETag / 304
 * @property {boolean} pluralRefs `git/refs/heads/x`（复数、数组）还是 `git/ref/heads/x`
 * @property {number} maxFilesPerCommit 单次提交文件数上限
 * @property {number} maxBytesPerCommit 单次提交字节上限
 * @property {string} tokenHint 生成 token 的入口说明
 * @property {string} baseUrlHint baseUrl 该怎么填
 */

/** @type {Record<string, PlatformCaps>} */
export const PLATFORMS = Object.freeze({
  github: {
    id: 'github',
    displayName: 'GitHub',
    branchHeadCAS: true,
    fileLevelShaCAS: false,
    etag: true,
    pluralRefs: false,
    maxFilesPerCommit: 200,
    maxBytesPerCommit: 8 * 1024 * 1024,
    tokenHint: '在 Settings → Developer settings → Personal access tokens 生成，需要 repo 权限',
    baseUrlHint: '无需填写（固定 https://api.github.com）',
  },
  gitea: {
    id: 'gitea',
    displayName: 'Gitea',
    // ❌ Gitea 的 git/ 命名空间只有 GET，没有任何写端点
    branchHeadCAS: false,
    // ✅ 但 POST /contents 的 files[].sha 提供了文件级校验
    fileLevelShaCAS: true,
    etag: true,
    // ⚠️ 复数 refs，且返回数组
    pluralRefs: true,
    maxFilesPerCommit: 100,
    maxBytesPerCommit: 8 * 1024 * 1024,
    tokenHint: '在 设置 → 应用 → 管理访问令牌 生成，需要 write:repository',
    baseUrlHint: '形如 https://你的域名/api/v1',
  },
  forgejo: {
    id: 'forgejo',
    displayName: 'Forgejo',
    branchHeadCAS: false,
    fileLevelShaCAS: true,
    etag: true,
    pluralRefs: true,
    maxFilesPerCommit: 100,
    maxBytesPerCommit: 8 * 1024 * 1024,
    tokenHint: '在 设置 → 应用 → 访问令牌 生成，需要 write:repository',
    baseUrlHint: '形如 https://你的域名/api/v1',
  },
});

/** 支持的平台 id 列表。 */
export const PLATFORM_IDS = Object.freeze(Object.keys(PLATFORMS));

/**
 * 规范化 API 基址。
 *
 * 用户常犯的两个错：粘了 `/api/v1`（Gitea 需要，GitHub 不要）、
 * 或者只粘域名。这里按平台分别处理。
 *
 * @param {string} platform 平台 id
 * @param {string} input 用户输入
 * @returns {string} 规范化后的基址（无尾斜杠）
 */
export function normalizeApiBase(platform, input) {
  const id = String(platform ?? '').toLowerCase();
  let text = String(input ?? '').trim();

  if (id === 'github') return 'https://api.github.com';
  if (text === '') return '';
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
  text = text.replace(/\/+$/, '');

  // 已经带 /api 就不再重复补（可能还带反代前缀）
  if (/\/api(\/|$)/i.test(text)) return text;

  const url = new URL(text);
  if (url.pathname === '' || url.pathname === '/') return `${text}/api/v1`;
  return text;
}

/**
 * 取平台能力矩阵。
 *
 * @param {string} platform 平台 id
 * @returns {PlatformCaps}
 */
export function capsOf(platform) {
  const caps = PLATFORMS[String(platform ?? '').toLowerCase()];
  if (caps === undefined) {
    throw new Error(`不支持的代码平台：${platform || '(空)'}`);
  }
  return caps;
}

/**
 * 分支 ref 的 API 路径。
 *
 * ⚠️ 这是两个平台最容易被忽略的差异：
 *   · GitHub  `git/ref/heads/{b}`  （单数 ref，返回**对象**）
 *   · Gitea   `git/refs/heads/{b}` （复数 refs，返回**数组**）
 *
 * 写错只会得到 404，且错误信息完全不提示原因。
 *
 * @param {string} platform 平台 id
 * @param {string} branch 分支名
 * @returns {string} 相对仓库根的路径
 */
export function refPath(platform, branch) {
  const caps = capsOf(platform);
  const encoded = encodeURIComponent(branch);
  return caps.pluralRefs ? `/git/refs/heads/${encoded}` : `/git/ref/heads/${encoded}`;
}

/**
 * 从 ref 响应里取出 commit sha。
 *
 * @param {string} platform 平台 id
 * @param {any} data 响应体
 * @returns {string} commit sha；取不到时为空串
 */
export function pickRefSha(platform, data) {
  const caps = capsOf(platform);
  // Gitea 返回数组，GitHub 返回对象 —— 两种都兜住，别依赖 caps
  const node = caps.pluralRefs && Array.isArray(data) ? data[0] : data;
  return String(node?.object?.sha ?? '');
}

/**
 * 把 Gitea 的「文件不存在」类错误与 GitHub 的 409 统一成一种语义。
 *
 * 处理空仓库引导时会踩到这个差异：
 *   · GitHub 空仓库读 ref → **409**（Conflict）
 *   · Gitea  空仓库读 ref → **404**（Not Found）
 *
 * 两者含义相同（"还没有任何提交"），所以合并判断。
 *
 * @param {number} status HTTP 状态码
 * @returns {boolean} 是否代表"空仓库 / 分支不存在"
 */
export function isEmptyRepoSignal(status) {
  return status === 404 || status === 409;
}
