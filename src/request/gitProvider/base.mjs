/**
 * 代码平台适配层的抽象契约。
 *
 * ## 为什么是"契约"而不是 interface
 *
 * 纯 JS 没有 interface。这里用「基类 + 运行时校验 + JSDoc typedef」三件套：
 *   · 基类提供所有方法的默认实现（一律 throw），漏实现会立刻炸，不会静默走错
 *   · `caps` 声明能力矩阵，上层据此选择策略（例如有没有 CAS）
 *   · JSDoc 给出类型，编辑器能补全
 *
 * ## 能力矩阵是分层设计的核心
 *
 * 三个平台最关键的差异**不是** API 路径，而是「能不能原子地做并发保护」：
 *
 * | 能力 | GitHub | Gitea/Forgejo | GitLab |
 * |---|---|---|---|
 * | 单请求多文件原子提交 | ✅ GraphQL | ✅ POST /contents | ⚠️ actions[] |
 * | 分支 tip 级 CAS | ✅ expectedHeadOid | ❌ 只有文件级 sha | ❌ |
 * | 全树递归一次拉 | ✅ | ✅（带 truncated） | ❌ 必须分页 |
 *
 * 上层拿到 `caps` 后再决定：没有 CAS 就退化成「文件级 sha 校验 + 冲突重拉」。
 */

/**
 * @typedef {object} ProviderConfig
 * @property {string} baseUrl API 基址，如 `https://git.example.com/api/v1`
 * @property {string} token 访问令牌
 * @property {string} owner 仓库 owner（GitLab 的 namespace）
 * @property {string} repo 仓库名
 */

/**
 * @typedef {object} ProviderCaps
 * @property {string} id 平台标识（github / gitea / forgejo / gitlab）
 * @property {string} displayName 展示名
 * @property {boolean} atomicMultiFileCommit 单请求多文件是否服务端原子
 * @property {boolean} branchHeadCAS 是否支持 expectedHeadOid 式**分支 tip** 强 CAS
 * @property {boolean} fileLevelShaCAS 是否支持**文件级** sha 校验（弱 CAS，冲突时可重拉）
 * @property {boolean} fullTreeRecursive 是否可一次拉全树（无强制分页）
 * @property {boolean} etag 是否支持 If-None-Match / 304
 * @property {number} maxFilesPerCommit 单次提交最多文件数
 * @property {number} maxBytesPerCommit 单次提交字节上限
 * @property {string} authStyle 认证方式（见 http.mjs 的 AUTH_STYLES）
 */

/**
 * @typedef {object} HeadInfo
 * @property {string} oid 分支 tip 的 commit sha
 * @property {string|null} etag 用于下次条件请求
 * @property {boolean} notModified 是否命中 304
 */

/**
 * @typedef {object} TreeEntry
 * @property {string} path 文件路径（相对仓库根，无前导斜杠）
 * @property {'blob'|'tree'} type 类型
 * @property {string} sha 对象 sha
 * @property {number} [size] 字节数
 */

/**
 * @typedef {object} CommitInput
 * @property {string} branch 目标分支
 * @property {string|null} expectedHeadOid 期望的分支 tip；null 表示不校验
 * @property {string} headline 提交信息第一行（保留 [ADD]/[MODIFY]/[DELETE] 契约）
 * @property {Array<{path: string, contents: Uint8Array}>} additions 新增或覆盖的文件
 * @property {Array<{path: string}>} deletions 要删除的文件
 */

/**
 * 平台适配器基类。
 *
 * ⚠️ 所有方法默认 throw —— 子类漏实现会立刻暴露，不会静默返回错误数据。
 */
export class GitProvider {
  /**
   * 能力矩阵。子类**必须**覆盖。
   * @type {ProviderCaps}
   */
  static caps = {
    id: 'unknown',
    displayName: '未知平台',
    atomicMultiFileCommit: false,
    branchHeadCAS: false,
    fileLevelShaCAS: false,
    fullTreeRecursive: false,
    etag: false,
    maxFilesPerCommit: 100,
    maxBytesPerCommit: 8 * 1024 * 1024,
    authStyle: 'token',
  };

  /**
   * @param {ProviderConfig} config 连接配置
   * @param {object} [options] 可选项
   * @param {typeof fetch} [options.fetchImpl] 测试注入的 fetch
   */
  constructor(config, options = {}) {
    /** @type {ProviderConfig} */
    this.config = {
      baseUrl: String(config?.baseUrl ?? '').replace(/\/+$/, ''),
      token: String(config?.token ?? ''),
      owner: String(config?.owner ?? ''),
      repo: String(config?.repo ?? ''),
    };
    /** @type {ProviderCaps} */
    this.caps = /** @type {any} */ (this.constructor).caps;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * 校验 token 并取当前用户身份。
   *
   * 这个方法同时是「连通性 + 认证」的自检：配置错时能第一时间报出来，
   * 而不是等到第一次推送才失败。
   *
   * @returns {Promise<{login: string, name: string, avatarUrl: string}>}
   */
  async getUser() {
    throw new Error(`${this.caps.id}: getUser 未实现`);
  }

  /**
   * 列出当前用户可写的仓库。
   *
   * @param {{limit?: number}} [options] 分页
   * @returns {Promise<Array<{fullName: string, owner: string, name: string,
   *   private: boolean, defaultBranch: string, canPush: boolean}>>}
   */
  async listRepos() {
    throw new Error(`${this.caps.id}: listRepos 未实现`);
  }

  /**
   * 创建私有仓库。
   *
   * @param {{name: string, isPrivate?: boolean, description?: string,
   *   autoInit?: boolean}} options 仓库参数
   * @returns {Promise<{fullName: string, owner: string, name: string, defaultBranch: string}>}
   */
  async createRepo() {
    throw new Error(`${this.caps.id}: createRepo 未实现`);
  }

  /**
   * 取仓库元信息（主要是 defaultBranch）。
   *
   * @returns {Promise<{fullName: string, defaultBranch: string}>}
   */
  async getRepo() {
    throw new Error(`${this.caps.id}: getRepo 未实现`);
  }

  /**
   * 取分支 HEAD。
   *
   * ⚠️ 这是轮询热路径（默认 3 秒一次）。必须支持 etag，命中 304 时不消耗配额。
   *
   * @param {string} branch 分支名
   * @param {{etag?: string|null}} [options] 上次的 ETag
   * @returns {Promise<HeadInfo>}
   */
  async getHead() {
    throw new Error(`${this.caps.id}: getHead 未实现`);
  }

  /**
   * 取完整文件树。
   *
   * 内部自行处理分页 / truncated，调用方拿到的永远是完整列表。
   *
   * @param {string} oid 目标 commit / tree sha
   * @returns {Promise<TreeEntry[]>} 只含 blob 类型的条目（目录对同步无意义）
   */
  async getTree() {
    throw new Error(`${this.caps.id}: getTree 未实现`);
  }

  /**
   * 取文件原始字节。
   *
   * 内部处理 base64 解码（GitHub/Gitea 返回 base64，GitLab raw 直接是字节）。
   *
   * @param {string} sha blob sha
   * @returns {Promise<Uint8Array>}
   */
  async getBlob() {
    throw new Error(`${this.caps.id}: getBlob 未实现`);
  }

  /**
   * 批量提交。**冲突时必须抛 ConflictError。**
   *
   * @param {CommitInput} input 提交内容
   * @returns {Promise<{oid: string}>} 新 commit 的 sha
   */
  async commitBatch() {
    throw new Error(`${this.caps.id}: commitBatch 未实现`);
  }

  /**
   * 空仓库引导：写第一个 README。
   *
   * 只在新仓库（没有任何 commit）时需要 —— 那时候连分支都不存在，
   * 必须先落一个 commit 才能拿到 HEAD。
   *
   * @param {{branch?: string, path?: string, content?: Uint8Array}} [options] 参数
   * @returns {Promise<{oid: string}>}
   */
  async initEmptyRepo(options = {}) {
    const branch = options.branch ?? 'main';
    const filePath = options.path ?? 'README.md';
    const content = options.content ?? new TextEncoder().encode('# neno\n');
    return this.commitBatch({
      branch,
      expectedHeadOid: null,
      headline: 'chore: 初始化仓库',
      additions: [{ path: filePath, contents: content }],
      deletions: [],
    });
  }

  /**
   * 只读探测当前 tip（提交后复核用）。
   *
   * 无原生 CAS 的平台靠「提交后再读一次」来发现竞态。
   *
   * @param {string} branch 分支名
   * @returns {Promise<string>} commit sha
   */
  async probeHead(branch) {
    const head = await this.getHead(branch);
    return head.oid;
  }
}

/**
 * 把 base64 字符串解成字节。
 *
 * Node 与浏览器环境都能跑：优先用 Buffer（Node），退回 atob（浏览器/Deno）。
 *
 * @param {string} text base64 文本（可能含换行，需先清理）
 * @returns {Uint8Array} 解码结果
 */
export function decodeBase64(text) {
  // API 返回的 base64 常带换行（每 60/76 字符一个），必须去掉，否则解码会出错
  const clean = String(text ?? '').replace(/\s+/g, '');
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(clean, 'base64'));
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * 把字节编码成 base64。
 *
 * @param {Uint8Array} bytes 原始字节
 * @returns {string} base64 文本（无换行）
 */
export function encodeBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  const chunk = 0x8000; // 分块，避免超长数组撑爆 apply 的参数上限
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
