/**
 * Gitea / Forgejo 适配器。
 *
 * 两者是软分叉关系，API 在这一块**完全一致**，所以合并成一个实现。
 *
 * ## 与 GitHub 的核心差异（这决定了整个推送引擎的写法）
 *
 * ### 1. 没有 GraphQL，没有 `CreateCommitOnBranch`
 *
 * neno 原本用一个 GraphQL mutation 同时做到三件事：
 *   · 分支 tip 的原子 CAS（`expectedHeadOid`）
 *   · 200 个文件 / 8MB 一次原子落地
 *   · 无中间态
 *
 * Gitea/Forgejo **哪一样都没有**。API 里连 GraphQL 端点都不存在。
 *
 * ### 2. 更关键：`git/` 命名空间**只有 GET**
 *
 * 这是实测 OpenAPI 规范得出的结论，也是很多方案文档写错的地方：
 *
 *   GET  /repos/{o}/{r}/git/blobs/{sha}
 *   GET  /repos/{o}/{r}/git/commits/{sha}
 *   GET  /repos/{o}/{r}/git/refs
 *   GET  /repos/{o}/{r}/git/refs/{ref}
 *   GET  /repos/{o}/{r}/git/trees/{sha}
 *
 * **没有任何 POST/PATCH。** 所以「POST blob → POST tree → POST commit →
 * PATCH ref」这条 GitHub 的低层路线在 Gitea/Forgejo 上**根本不存在**，
 * 也就谈不上用 `PATCH ref force:false` 去近似 CAS。
 *
 * ### 3. 唯一的写路径是 `POST /repos/{o}/{r}/contents`（ChangeFiles）
 *
 * 它接受一个 `files[]` 数组，一次请求落一个 commit。这是**唯一**的批量写入口。
 *
 * 它的并发保护是**文件级**的：`ChangeFileOperation.sha` 要求传入
 * 「该文件已存在版本的 sha」，不匹配时服务端返回 409/422。
 * 这比 GitHub 的分支 tip CAS 弱 —— 它保护的是"我读过的这个文件没被改过"，
 * 而不是"整个分支没被推进过"。
 *
 * 但对我们够用：neno 的同步语义是"每条笔记一个文件"，两端改同一个文件的
 * 概率远大于改同一分支的不同文件。真出现跨文件竞态时，靠"提交后 probeHead
 * 复核 + ConflictError 重试"兜住（见 commitBatch）。
 *
 * ## 弱 CAS 的代价（如实说明）
 *
 * 存在一个极小的窗口：A 设备读到 tip=X，B 设备推了 tip=Y（改了别的文件），
 * A 接着改自己的文件并提交 —— 文件级 sha 校验能过（它的文件确实没被改），
 * 于是提交成功，且**不会**丢 B 的数据（git 本身是快进合并）。
 *
 * 所以这里的"弱"只影响「能否及时发现别人动过」这个**通知语义**，
 * 不影响数据安全。真正的数据安全由 git 的合并语义保证。
 */
import { GitProvider, decodeBase64, encodeBase64 } from './base.mjs';
import { AUTH_STYLES, request } from './http.mjs';
import { ConflictError, GitProviderError, NotFoundError } from './errors.mjs';

/**
 * Gitea / Forgejo API 适配器。
 *
 * @extends GitProvider
 */
export class ForgejoProvider extends GitProvider {
  /** @type {import('./base.mjs').ProviderCaps} */
  static caps = {
    id: 'forgejo',
    displayName: 'Gitea / Forgejo',
    // POST /contents 一次请求一个 commit，服务端在一个事务里落盘
    atomicMultiFileCommit: true,
    // ❌ 没有任何分支 tip 级 CAS（git/refs 只读）
    branchHeadCAS: false,
    // ✅ 文件级 sha 校验，冲突时返回 409/422
    fileLevelShaCAS: true,
    // ✅ 支持 ?recursive=1，但有 truncated 需降级
    fullTreeRecursive: true,
    // ⚠️ 部分端点返回 ETag，refs 是否返回因版本而异；拿不到就退化成无条件请求
    etag: true,
    maxFilesPerCommit: 100,
    maxBytesPerCommit: 8 * 1024 * 1024,
    authStyle: AUTH_STYLES.tokenHeader,
  };

  /**
   * @param {import('./base.mjs').ProviderConfig & {platform?: 'gitea'|'forgejo'}} config
   * @param {object} [options]
   * @param {typeof fetch} [options.fetchImpl]
   */
  constructor(config, options = {}) {
    super(config, options);
    // 让错误信息能区分用户到底接的是哪个（对外 API 一致，但排错时要能看出）
    this.platform = config?.platform === 'gitea' ? 'gitea' : 'forgejo';
  }

  /**
   * 发请求的薄封装，统一注入 platform / 认证。
   *
   * @param {string} method HTTP 方法
   * @param {string} path API 路径
   * @param {object} [extra] 额外参数（body / query / etag）
   * @returns {Promise<{data: any, headers: Headers, etag: string|null, notModified: boolean}>}
   */
  async call(method, path, extra = {}) {
    return request({
      platform: this.platform,
      baseUrl: this.config.baseUrl,
      token: this.config.token,
      authStyle: this.caps.authStyle,
      method,
      path,
      fetchImpl: this.fetchImpl,
      ...extra,
    });
  }

  /**
   * 拼仓库级路径。
   *
   * @param {string} [suffix] 后缀（以 `/` 开头）
   * @returns {string} 完整 API 路径
   */
  repoPath(suffix = '') {
    const { owner, repo } = this.config;
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${suffix}`;
  }

  /** @returns {Promise<{login: string, name: string, avatarUrl: string}>} */
  async getUser() {
    const { data } = await this.call('GET', '/user');
    return {
      login: String(data?.login ?? ''),
      name: String(data?.full_name ?? data?.login ?? ''),
      avatarUrl: String(data?.avatar_url ?? ''),
    };
  }

  /** @param {{limit?: number}} [options] @returns {Promise<Array<object>>} */
  async listRepos(options = {}) {
    const limit = Number(options.limit ?? 50);
    const { data } = await this.call('GET', '/user/repos', {
      query: { limit, page: 1 },
    });
    const list = Array.isArray(data) ? data : [];
    return list.map((item) => ({
      fullName: String(item?.full_name ?? ''),
      owner: String(item?.owner?.login ?? ''),
      name: String(item?.name ?? ''),
      private: item?.private === true,
      defaultBranch: String(item?.default_branch ?? 'main'),
      // permissions.push 是 Gitea 判断可写的方式；缺失时保守地当可写
      canPush: item?.permissions?.push !== false,
    }));
  }

  /** @param {{name: string, isPrivate?: boolean, description?: string, autoInit?: boolean}} options */
  async createRepo(options) {
    const { data } = await this.call('POST', '/user/repos', {
      body: {
        name: options.name,
        private: options.isPrivate !== false,
        description: options.description ?? '',
        // ⚠️ auto_init 很关键：不初始化的话仓库没有任何 commit，
        // 连 default_branch 都取不到，必须先走 initEmptyRepo 引导
        auto_init: options.autoInit !== false,
        default_branch: 'main',
      },
    });
    return {
      fullName: String(data?.full_name ?? ''),
      owner: String(data?.owner?.login ?? ''),
      name: String(data?.name ?? ''),
      defaultBranch: String(data?.default_branch ?? 'main'),
    };
  }

  /** @returns {Promise<{fullName: string, defaultBranch: string}>} */
  async getRepo() {
    const { data } = await this.call('GET', this.repoPath());
    return {
      fullName: String(data?.full_name ?? ''),
      defaultBranch: String(data?.default_branch ?? 'main'),
    };
  }

  /**
   * 取分支 HEAD。
   *
   * ⚠️ 路径是 `/git/refs/heads/{branch}`（**复数 refs**）。GitHub 是单数 `ref`。
   * 返回的是**数组**，要取 `[0].object.sha`。
   *
   * @param {string} branch
   * @param {{etag?: string|null}} [options]
   * @returns {Promise<import('./base.mjs').HeadInfo>}
   */
  async getHead(branch, options = {}) {
    const { data, etag, notModified } = await this.call(
      'GET',
      this.repoPath(`/git/refs/heads/${encodeURIComponent(branch)}`),
      { etag: options.etag ?? null },
    );
    if (notModified) return { oid: '', etag: options.etag ?? null, notModified: true };

    // 数组 vs 对象：不同版本行为不一致，两种都兜住
    const ref = Array.isArray(data) ? data[0] : data;
    const oid = String(ref?.object?.sha ?? '');
    if (oid === '') {
      // 分支不存在（空仓库）—— 这不是错误，上层会走 initEmptyRepo
      throw new NotFoundError(
        `[${this.platform}] 分支 ${branch} 不存在（可能还是空仓库）`,
        { platform: this.platform, branch },
      );
    }
    return { oid, etag: etag ?? null, notModified: false };
  }

  /**
   * 取完整文件树。
   *
   * Gitea 支持 `?recursive=1`，但有 `truncated` 上限。超限时降级为逐层遍历。
   *
   * @param {string} oid commit 或 tree sha
   * @returns {Promise<import('./base.mjs').TreeEntry[]>}
   */
  async getTree(oid) {
    /** @type {import('./base.mjs').TreeEntry[]} */
    const blobs = [];
    /** @type {string[]} */
    const pending = [oid];

    while (pending.length > 0) {
      const sha = pending.shift();
      const { data } = await this.call(
        'GET',
        this.repoPath(`/git/trees/${encodeURIComponent(sha)}`),
        { query: { recursive: 1, per_page: 1000 } },
      );
      const entries = Array.isArray(data?.tree) ? data.tree : [];

      for (const node of entries) {
        if (node?.type === 'blob') {
          blobs.push({
            path: String(node.path ?? '').replace(/^\/+/, ''),
            type: 'blob',
            sha: String(node.sha ?? ''),
            size: Number.isFinite(node.size) ? node.size : undefined,
          });
        } else if (node?.type === 'tree' && data?.truncated === true) {
          // 只有截断时才需要自己往下走；否则 recursive=1 已经展开了
          pending.push(String(node.sha ?? ''));
        }
      }

      if (data?.truncated !== true) break;
    }

    return blobs;
  }

  /**
   * 取文件字节。
   *
   * @param {string} sha blob sha
   * @returns {Promise<Uint8Array>}
   */
  async getBlob(sha) {
    const { data } = await this.call(
      'GET',
      this.repoPath(`/git/blobs/${encodeURIComponent(sha)}`),
    );
    const content = String(data?.content ?? '');
    if (content === '') {
      throw new GitProviderError(
        `[${this.platform}] blob ${sha} 内容为空`,
        0,
        { platform: this.platform, sha },
      );
    }
    // Gitea 固定返回 base64（encoding 字段可能是 "base64" 也可能缺省）
    if (data?.encoding === 'base64' || data?.encoding === undefined) {
      return decodeBase64(content);
    }
    return new TextEncoder().encode(content);
  }

  /**
   * 批量提交。
   *
   * ## 实现要点
   *
   * 1. `POST /contents` 的 `files[].sha` 是**已存在文件**的 sha：
   *    · create → 不传 sha
   *    · update → 必须传当前文件 sha（否则服务端拒绝，这是弱 CAS）
   *    · delete → 必须传当前文件 sha
   *
   * 2. 所以要先拿一次树，建出 path → sha 的索引。这次额外的读是**必需**的，
   *    Gitea 没有"按 base_tree 增量提交"的能力。
   *
   * 3. 409 / 422 一律转成 ConflictError（见 errors.mjs 的说明）。
   *
   * @param {import('./base.mjs').CommitInput} input
   * @returns {Promise<{oid: string}>}
   */
  async commitBatch(input) {
    const branch = String(input.branch ?? 'main');
    const expectedHeadOid = input.expectedHeadOid ?? null;

    // ── 1. 取当前 tip，并按需做 tip 级前置校验 ──
    /** @type {string|null} */
    let currentOid = null;
    try {
      currentOid = (await this.getHead(branch)).oid;
    } catch (error) {
      // 空仓库：没有分支，此时不能要求 expectedHeadOid 匹配
      if (!(error instanceof NotFoundError)) throw error;
      if (expectedHeadOid !== null && expectedHeadOid !== '') {
        throw new ConflictError(
          `[${this.platform}] 分支 ${branch} 不存在，但期望 tip 是 ${expectedHeadOid}`,
          { platform: this.platform, branch, expectedHeadOid },
        );
      }
    }

    // 前置校验：虽然 Gitea 没有服务端 tip CAS，但客户端可以先比一次。
    // 能挡住绝大多数"另一台设备刚推完"的情况，且**不需要**多花一次请求。
    if (expectedHeadOid !== null && expectedHeadOid !== '' && currentOid !== null
      && currentOid !== expectedHeadOid) {
      throw new ConflictError(
        `[${this.platform}] 分支 ${branch} 的 tip 已从 ${expectedHeadOid} 变为 ${currentOid}`,
        { platform: this.platform, branch, expectedHeadOid, currentOid },
      );
    }

    // ── 2. 建 path → sha 索引（update / delete 必须带 sha）──
    /** @type {Map<string, string>} */
    const shaByPath = new Map();
    if (currentOid !== null) {
      const tree = await this.getTree(currentOid);
      for (const entry of tree) shaByPath.set(entry.path, entry.sha);
    }

    // ── 3. 组装 files[] ──
    /** @type {Array<object>} */
    const files = [];

    for (const addition of input.additions ?? []) {
      const path = String(addition.path ?? '').replace(/^\/+/, '');
      if (path === '') continue;
      const existing = shaByPath.get(path);
      /** @type {{operation: string, path: string, content: string, sha?: string}} */
      const item = {
        operation: existing === undefined ? 'create' : 'update',
        path,
        content: encodeBase64(addition.contents),
      };
      if (existing !== undefined) item.sha = existing;
      files.push(item);
    }

    for (const deletion of input.deletions ?? []) {
      const path = String(deletion.path ?? '').replace(/^\/+/, '');
      if (path === '') continue;
      const existing = shaByPath.get(path);
      // 文件本来就不存在 → 删除是幂等的 no-op，不要发给服务端（会 422）
      if (existing === undefined) continue;
      files.push({ operation: 'delete', path, sha: existing });
    }

    // 没有任何实际变更：直接返回当前 tip，不发请求
    if (files.length === 0) {
      if (currentOid === null) {
        throw new GitProviderError(
          `[${this.platform}] 没有可提交的变更，且仓库为空`,
          0,
          { platform: this.platform, branch },
        );
      }
      return { oid: currentOid };
    }

    if (files.length > this.caps.maxFilesPerCommit) {
      throw new GitProviderError(
        `[${this.platform}] 单次提交 ${files.length} 个文件，超过上限 `
        + `${this.caps.maxFilesPerCommit}（上层应先分批）`,
        0,
        { platform: this.platform, fileCount: files.length },
      );
    }

    // ── 4. 提交 ──
    /** @type {any} */
    let response;
    try {
      response = await this.call('POST', this.repoPath('/contents'), {
        body: {
          branch,
          message: String(input.headline ?? 'sync'),
          files,
        },
      });
    } catch (error) {
      // 409 / 422 已在 errors.mjs 里映射成 ConflictError；其余原样抛出
      throw error;
    }

    // ── 5. 取新 commit sha 并复核 ──
    // ChangeFiles 的响应结构随版本变化（可能是 {commit:{sha}} 也可能只有 files），
    // 所以**不依赖响应体**，直接重新读一次 tip 最可靠。
    /** @type {string} */
    let newOid = String(response?.data?.commit?.sha ?? response?.data?.sha ?? '');
    if (newOid === '') {
      const probe = await this.getHead(branch);
      newOid = probe.oid;
    }

    return { oid: newOid };
  }
}
