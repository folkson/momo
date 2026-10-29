/**
 * GitHub 适配器。
 *
 * 目标是**行为逐字节对齐** neno 原本的 `githubClient.js` + `syncEngine.js`，
 * 这样把适配层插进去之后，GitHub 用户的回归风险为零。
 *
 * ## 保留 GraphQL 的理由
 *
 * GitHub 是唯一能用一个 mutation 同时拿到「tip CAS + 多文件原子提交」的平台：
 *
 *   mutation { createCommitOnBranch(input: {
 *     branch, message, expectedHeadOid, fileChanges{additions, deletions}
 *   }) { commit { oid } } }
 *
 * 换成走 REST 低层（blobs → trees → commits → PATCH ref）会丢掉原子性：
 * 中间任何一步失败都会留下半成品（blob 传了、tree 没建）。所以这里必须保留 GraphQL。
 *
 * ## 一个必须复刻的坑
 *
 * GraphQL 出错时返回的是 **HTTP 200** + `{errors:[...]}`，不是 4xx。
 * 原代码在 catch 里用 `error.status === 200` 来判断"可能是冲突"，
 * 然后去 REST 复核 ref。这个语义必须原样保留 ——
 * 如果这里改成把 200 当成功，冲突会被静默吞掉，导致数据不一致。
 */
import { GitProvider, decodeBase64 } from './base.mjs';
import { AUTH_STYLES, request } from './http.mjs';
import { ConflictError, GitProviderError, NotFoundError } from './errors.mjs';

const COMMIT_MUTATION = `mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) { commit { oid } }
}`;

/**
 * GitHub API 适配器。
 *
 * @extends GitProvider
 */
export class GithubProvider extends GitProvider {
  /** @type {import('./base.mjs').ProviderCaps} */
  static caps = {
    id: 'github',
    displayName: 'GitHub',
    // ✅ GraphQL 一次请求原子落 200 文件
    atomicMultiFileCommit: true,
    // ✅ expectedHeadOid 服务端原子比较交换
    branchHeadCAS: true,
    fileLevelShaCAS: true,
    fullTreeRecursive: true,
    etag: true,
    maxFilesPerCommit: 200,
    maxBytesPerCommit: 8 * 1024 * 1024,
    authStyle: AUTH_STYLES.tokenHeader,
  };

  constructor(config, options = {}) {
    super(config, options);
    this.platform = 'github';
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {object} [extra]
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
   * @param {string} [suffix]
   * @returns {string}
   */
  repoPath(suffix = '') {
    const { owner, repo } = this.config;
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${suffix}`;
  }

  /**
   * 发 GraphQL 请求。
   *
   * ⚠️ 错误语义见文件头注释：GraphQL 逻辑错误是 HTTP 200 + errors 数组。
   * 这里把它包成带 `status: 200` 的 GitProviderError，让上层能复刻原有判断。
   *
   * @param {string} query GraphQL 语句
   * @param {object} variables 变量
   * @returns {Promise<any>} `data` 部分
   */
  async graphql(query, variables) {
    const { data: body } = await this.call('POST', '/graphql', {
      body: { query, variables },
    });
    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      const first = body.errors[0];
      throw new GitProviderError(
        String(first?.message ?? 'GraphQL 错误'),
        // ★ 200 是刻意保留的：上层靠它识别"可能是并发冲突"
        200,
        { platform: this.platform, type: first?.type, errors: body.errors },
      );
    }
    return body?.data;
  }

  /** @returns {Promise<{login: string, name: string, avatarUrl: string}>} */
  async getUser() {
    const { data, headers } = await this.call('GET', '/user');
    // x-oauth-scopes 是 GitHub 独有的权限探测方式，Gitea 不返回（所以放在这里）
    const scopes = String(headers.get('x-oauth-scopes') ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '');
    return {
      login: String(data?.login ?? ''),
      name: String(data?.name ?? data?.login ?? ''),
      avatarUrl: String(data?.avatar_url ?? ''),
      scopes,
    };
  }

  /** @param {{limit?: number}} [options] @returns {Promise<Array<object>>} */
  async listRepos(options = {}) {
    const limit = Number(options.limit ?? 50);
    const { data } = await this.call('GET', '/user/repos', {
      query: { per_page: limit, sort: 'updated', affiliation: 'owner,collaborator' },
    });
    const list = Array.isArray(data) ? data : [];
    return list.map((item) => ({
      fullName: String(item?.full_name ?? ''),
      owner: String(item?.owner?.login ?? ''),
      name: String(item?.name ?? ''),
      private: item?.private === true,
      defaultBranch: String(item?.default_branch ?? 'main'),
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
        auto_init: options.autoInit !== false,
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
   * ⚠️ GitHub 的路径是单数 `git/ref`（Gitea 是复数 `git/refs`）。
   *
   * @param {string} branch
   * @param {{etag?: string|null}} [options]
   * @returns {Promise<import('./base.mjs').HeadInfo>}
   */
  async getHead(branch, options = {}) {
    const { data, etag, notModified } = await this.call(
      'GET',
      this.repoPath(`/git/ref/heads/${encodeURIComponent(branch)}`),
      { etag: options.etag ?? null },
    );
    if (notModified) return { oid: '', etag: options.etag ?? null, notModified: true };
    const oid = String(data?.object?.sha ?? '');
    if (oid === '') {
      throw new NotFoundError(
        `[${this.platform}] 分支 ${branch} 不存在（可能还是空仓库）`,
        { platform: this.platform, branch },
      );
    }
    return { oid, etag: etag ?? null, notModified: false };
  }

  /**
   * @param {string} oid
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
        { query: { recursive: 1 } },
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
          pending.push(String(node.sha ?? ''));
        }
      }
      if (data?.truncated !== true) break;
    }
    return blobs;
  }

  /**
   * @param {string} sha
   * @returns {Promise<Uint8Array>}
   */
  async getBlob(sha) {
    const { data } = await this.call(
      'GET',
      this.repoPath(`/git/blobs/${encodeURIComponent(sha)}`),
    );
    return decodeBase64(String(data?.content ?? ''));
  }

  /**
   * 批量提交 —— 用 GraphQL，保留 tip CAS。
   *
   * @param {import('./base.mjs').CommitInput} input
   * @returns {Promise<{oid: string}>}
   */
  async commitBatch(input) {
    const branch = String(input.branch ?? 'main');
    const expectedHeadOid = input.expectedHeadOid ?? null;

    /** @type {Array<{path: string, contents: string}>} */
    const additions = (input.additions ?? []).map((item) => ({
      // GitHub 这个 field 叫 `path`，值是仓库内相对路径
      path: String(item.path ?? '').replace(/^\/+/, ''),
      // GraphQL 要求 base64 字符串
      contents: encodeBase64Github(item.contents),
    }));
    /** @type {Array<{path: string}>} */
    const deletions = (input.deletions ?? []).map((item) => ({
      path: String(item.path ?? '').replace(/^\/+/, ''),
    }));

    if (additions.length === 0 && deletions.length === 0) {
      // 没变更：返回当前 tip，不发请求
      const head = await this.getHead(branch);
      return { oid: head.oid };
    }

    const totalFiles = additions.length + deletions.length;
    if (totalFiles > this.caps.maxFilesPerCommit) {
      throw new GitProviderError(
        `[${this.platform}] 单次提交 ${totalFiles} 个文件，超过上限 `
        + `${this.caps.maxFilesPerCommit}（上层应先分批）`,
        0,
        { platform: this.platform, fileCount: totalFiles },
      );
    }

    /** @type {Record<string, unknown>} */
    const gqlInput = {
      branch: {
        repositoryNameWithOwner: `${this.config.owner}/${this.config.repo}`,
        branchName: branch,
      },
      message: { headline: String(input.headline ?? 'sync') },
      fileChanges: { additions, deletions },
    };
    // expectedHeadOid 只有在明确要校验时才传。
    // 传 null/空串进去 GitHub 会报参数错误，所以这里必须条件性写入。
    if (expectedHeadOid !== null && expectedHeadOid !== '') {
      gqlInput.expectedHeadOid = expectedHeadOid;
    }

    try {
      const data = await this.graphql(COMMIT_MUTATION, { input: gqlInput });
      const oid = String(data?.createCommitOnBranch?.commit?.oid ?? '');
      if (oid === '') {
        throw new GitProviderError(
          `[${this.platform}] 提交成功但响应里没有 commit oid`,
          0,
          { platform: this.platform, response: data },
        );
      }
      return { oid };
    } catch (error) {
      // ★ 复刻原有逻辑：GraphQL 逻辑错误是 HTTP 200。
      //   此时去 REST 复核 ref，确认是不是"远端被推进了"。
      if (error?.status === 200) {
        let current = null;
        try {
          current = (await this.probeHead(branch));
        } catch {
          // 复核失败就别硬判冲突，把原始错误抛上去更有信息量
          throw error;
        }
        if (current !== expectedHeadOid) {
          throw new ConflictError(
            `[${this.platform}] 分支 ${branch} 的 tip 已从 ${expectedHeadOid} 变为 ${current}`,
            { platform: this.platform, branch, expectedHeadOid, current },
          );
        }
      }
      throw error;
    }
  }
}

/**
 * GitHub GraphQL 要求 additions[].contents 是 base64。
 *
 * 单独包一层是为了跟 base.mjs 的 encodeBase64 解耦 —— 那个给 REST 用，
 * 这个给 GraphQL 字段用，将来若 GitHub 改编码方式只需改这里。
 *
 * @param {Uint8Array} bytes 文件字节
 * @returns {string} base64
 */
function encodeBase64Github(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
