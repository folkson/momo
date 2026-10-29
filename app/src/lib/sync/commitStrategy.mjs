/**
 * 提交策略层：把「一次提交」这件事抽象出来。
 *
 * ## 为什么需要这一层（neno 原本只有一种写法）
 *
 * neno 原来假设"提交"就是发一个 GraphQL `createCommitOnBranch` —— 它同时
 * 解决了三件事：
 *
 *   1. 分支 tip 的原子 CAS（`expectedHeadOid`）
 *   2. 多文件原子落地
 *   3. 无中间态
 *
 * Gitea / Forgejo **一样都没有**。它们的 `git/` 命名空间是只读的，
 * 唯一写入口是 `POST /repos/{o}/{r}/contents`，接受一个 `files[]` 数组，
 * 一次一个 commit，并发保护是**文件级 sha**。
 *
 * 所以必须把"提交"变成一个策略：
 *
 *   · `GraphQLCommitStrategy` —— GitHub，强 CAS，冲突直接抛
 *   · `ChangeFilesStrategy`  —— Gitea/Forgejo，文件级弱 CAS + 提交后复核
 *
 * ## 两条路径都必须产出同一种语义
 *
 * 上层（`syncEngine`）只关心「成没成」和「是不是冲突」。所以两个策略的
 * 契约完全一致：
 *   成功 → 返回新 commit sha
 *   冲突 → 抛 `SyncConflictError`
 *   其他 → 原样抛
 */
import { capsOf } from './platform.mjs';

/**
 * UTF-8 安全的文本 → base64。
 *
 * ⚠️ 不能直接用 `btoa(text)` —— `btoa` 只接受 Latin-1，遇到中文会抛
 * `InvalidCharacterError`（浏览器）或直接报错（Node）。
 * 原版 neno 用的是 `bytesToBase64(textToBytes(...))`，这里做等价实现。
 *
 * @param {string} text 文本
 * @returns {string} base64
 */
function textToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * 同步冲突（远端被别的设备动过了）。
 *
 * ⚠️ 这是**正常情况**，不是错误：上层会重新拉取、合并、再推。
 * 因此它必须是独立类型，不能被笼统地当异常吞掉或上报。
 */
export class SyncConflictError extends Error {
  /**
   * @param {string} message 描述
   * @param {object} [extra] 附加信息
   */
  constructor(message, extra = {}) {
    super(message);
    this.name = 'SyncConflictError';
    Object.assign(this, extra);
  }
}

/**
 * 提交策略基类。
 *
 * 所有方法默认 throw，漏实现立刻暴露。
 */
export class CommitStrategy {
  /**
   * @param {object} context 上下文
   * @param {(method: string, path: string, options?: object) => Promise<any>} context.api
   *   仓库级 REST 封装
   * @param {(query: string, variables: object) => Promise<any>} [context.graphql]
   *   GraphQL 调用（仅 GitHub 有）
   * @param {() => {access_token: string, owner: string, repo: string}} context.credentials
   *   取当前凭证
   * @param {PlatformCaps} context.caps 平台能力
   */
  constructor(context) {
    this.context = context;
    this.caps = context.caps;
  }

  /**
   * 取当前分支 tip。
   *
   * @param {string} branch 分支名
   * @returns {Promise<string>} commit sha
   */
  async head() {
    throw new Error(`${this.caps.id}: head 未实现`);
  }

  /**
   * 提交一批变更。
   *
   * @param {object} input 参数
   * @param {string} input.branch 分支
   * @param {string} input.expectedHeadOid 期望的 tip
   * @param {string} input.headline 提交信息首行
   * @param {Array<{path: string, contents: string}>} input.additions base64 内容
   * @param {Array<{path: string}>} input.deletions 要删的路径
   * @returns {Promise<string>} 新 commit sha
   * @throws {SyncConflictError} 冲突时
   */
  async commit() {
    throw new Error(`${this.caps.id}: commit 未实现`);
  }

  /**
   * 空仓库引导（写第一个提交）。
   *
   * @param {string} branch 分支
   * @returns {Promise<string>} commit sha
   */
  async bootstrap(branch) {
    throw new Error(`${this.caps.id}: bootstrap 未实现`);
  }
}

/**
 * GitHub 策略：GraphQL `createCommitOnBranch`。
 *
 * ## 一个非常反直觉的细节
 *
 * GraphQL 的**逻辑错误返回 HTTP 200**，错误信息在 body 的 `errors[]` 里。
 * 所以不能靠 `response.ok` 判断冲突 —— 必须看 `error.status === 200`
 * 再去复核 tip。neno 原实现就是踩了这个坑之后才写对（见 syncEngine.js
 * 的 `createCommit`）。
 */
export class GraphQLCommitStrategy extends CommitStrategy {
  /**
   * @param {object} context
   * @param {(query: string, variables: object) => Promise<any>} context.graphql
   */
  constructor(context) {
    super(context);
    if (typeof context.graphql !== 'function') {
      throw new Error('GraphQLCommitStrategy 需要 graphql 上下文');
    }
  }

  /** GraphQL mutation，与 neno 原有实现逐字一致。 */
  static MUTATION = `mutation($input: CreateCommitOnBranchInput!) {
    createCommitOnBranch(input: $input) { commit { oid } }
}`;

  /**
   * @param {string} branch 分支
   * @returns {Promise<string>}
   */
  async head(branch) {
    const { data } = await this.context.api(
      'GET',
      `/git/ref/heads/${encodeURIComponent(branch)}`,
    );
    return String(data?.object?.sha ?? '');
  }

  /**
   * @param {object} input 见基类
   * @returns {Promise<string>}
   */
  async commit(input) {
    const { credentials } = this.context;
    const store = credentials();
    const repositoryNameWithOwner = `${store.owner}/${store.repo}`;

    try {
      const data = await this.context.graphql(GraphQLCommitStrategy.MUTATION, {
        input: {
          branch: { repositoryNameWithOwner, branchName: input.branch },
          message: { headline: input.headline },
          expectedHeadOid: input.expectedHeadOid,
          fileChanges: {
            additions: input.additions,
            deletions: input.deletions,
          },
        },
      });
      return String(data?.createCommitOnBranch?.commit?.oid ?? '');
    } catch (error) {
      // ★ GraphQL 逻辑错误是 HTTP 200 —— 只有这个状态码才可能是冲突
      if (error?.status === 200) {
        const current = await this.head(input.branch);
        if (current !== input.expectedHeadOid) {
          throw new SyncConflictError(error.message, {
            expectedHeadOid: input.expectedHeadOid,
            actualHeadOid: current,
          });
        }
      }
      throw error;
    }
  }

  /**
   * 空仓库引导：走 `PUT /contents/README.md`。
   *
   * @param {string} branch 分支
   * @returns {Promise<string>}
   */
  async bootstrap(branch) {
    await this.context.api('PUT', '/contents/README.md', {
      body: {
        message: 'init neno',
        content: textToBase64('# NENO\n\nNENO 笔记数据仓库\n'),
        branch,
      },
    });
    return this.head(branch);
  }
}

/**
 * Gitea / Forgejo 策略：`POST /contents`（ChangeFiles）。
 *
 * ## 与 GitHub 的三个硬差异
 *
 * ### 1. 没有分支 tip CAS
 *
 * `expectedHeadOid` 只能**在客户端先比一次**。这挡住绝大多数情况，
 * 但存在一个理论窗口（读完 tip 到提交之间别人推了）。
 *
 * ### 2. `files[].sha` 是文件级校验，且 update/delete 必填
 *
 * 所以提交前必须**再拉一次树**建 `path → sha` 索引 —— 这次额外的读是
 * 无法省略的（Gitea 不支持 base_tree 增量提交）。
 *
 * ### 3. 返回体里未必有 commit sha
 *
 * `ChangeFiles` 的响应结构随版本变化。所以提交后要重新读一次 tip
 * （`probeHead`），这同时也复核了"这次提交真的是我推的"。
 *
 * ## 弱 CAS 的数据安全性
 *
 * 别被"弱"字吓到：git 本身是快进合并，即使两个设备同时提交**不同文件**，
 * 后一个提交也会包含前一个的内容，不会丢数据。文件级 sha 校验保护的是
 * "我读过的这个文件没被改过"，而这正是真正会造成覆盖的场景。
 */
export class ChangeFilesStrategy extends CommitStrategy {
  /**
   * @param {string} branch 分支
   * @returns {Promise<string>}
   */
  async head(branch) {
    const { data } = await this.context.api(
      'GET',
      `/git/refs/heads/${encodeURIComponent(branch)}`,
    );
    // ⚠️ Gitea 返回**数组**
    const node = Array.isArray(data) ? data[0] : data;
    return String(node?.object?.sha ?? '');
  }

  /**
   * 提交一批变更。
   *
   * @param {object} input 见基类
   * @returns {Promise<string>} 新 commit sha
   */
  async commit(input) {
    const branch = input.branch;

    // ── 1. 前置 tip 比对（能省一次写请求，也挡住大部分竞态）──
    /** @type {string} */
    let currentOid = '';
    try {
      currentOid = await this.head(branch);
    } catch (error) {
      // 空仓库没有分支。有 expectedHeadOid 就说明本地以为有内容 → 冲突
      if (error?.status === 404 || error?.status === 409) {
        if (input.expectedHeadOid) {
          throw new SyncConflictError(
            `分支 ${branch} 不存在，但期望 tip 是 ${input.expectedHeadOid}`,
            { expectedHeadOid: input.expectedHeadOid },
          );
        }
      } else {
        throw error;
      }
    }

    if (input.expectedHeadOid && currentOid && currentOid !== input.expectedHeadOid) {
      throw new SyncConflictError(
        `分支 ${branch} 的 tip 已从 ${input.expectedHeadOid} 变为 ${currentOid}`,
        { expectedHeadOid: input.expectedHeadOid, actualHeadOid: currentOid },
      );
    }

    // ── 2. 建 path → sha 索引（update/delete 必填 sha）──
    //
    // ⚠️ `recursive=1` 的返回里**同时有 tree 和 blob 两种条目**（真实 Gitea
    // 1.22.6 实测）：目录本身也会作为 `type: "tree"` 出现。所以必须按
    // `type === 'blob'` 过滤 —— 否则会把目录的 sha 当成文件的 sha 发给
    // 服务端，得到 "sha does not match"。
    /** @type {Record<string, string>} */
    const shaByPath = {};
    if (currentOid !== '') {
      const tree = await this.context.api('GET', `/git/trees/${encodeURIComponent(currentOid)}`, {
        query: { recursive: 1, per_page: 1000 },
      });
      const entries = Array.isArray(tree?.data?.tree) ? tree.data.tree : [];
      for (const node of entries) {
        if (node?.type === 'blob') shaByPath[String(node.path ?? '')] = String(node.sha ?? '');
      }
    }

    // ── 3. 组装 files[] ──
    /** @type {Array<object>} */
    const files = [];

    for (const addition of input.additions ?? []) {
      const path = String(addition.path ?? '').replace(/^\/+/, '');
      if (path === '') continue;
      const existing = shaByPath[path];
      const item = {
        operation: existing === undefined ? 'create' : 'update',
        path,
        content: String(addition.contents ?? ''),
      };
      if (existing !== undefined) item.sha = existing;
      files.push(item);
    }

    for (const deletion of input.deletions ?? []) {
      const path = String(deletion.path ?? '').replace(/^\/+/, '');
      if (path === '') continue;
      const existing = shaByPath[path];
      // 本来就不存在 → 幂等 no-op，不能发给服务端（会 422）
      if (existing === undefined) continue;
      files.push({ operation: 'delete', path, sha: existing });
    }

    if (files.length === 0) return currentOid;

    // ── 4. 提交 ──
    try {
      await this.context.api('POST', '/contents', {
        body: { branch, message: input.headline, files },
      });
    } catch (error) {
      // ── 冲突的错误码在 Gitea 上比文档写的更杂（1.22.6 实测）──
      //
      //   409  delete/update 时 sha 不匹配
      //   422  create 一个已存在的文件（"repository file already exists"）
      //   422  update 时 sha 不匹配（"sha does not match [given: x, expected: y]"）
      //   500  update/delete 一个**不存在**的文件
      //        （"object does not exist [id: , rel_path: x]"）
      //
      // 500 归到冲突里是有意的：这个 500 的成因是「我以为存在的文件在
      // 服务端没了」，正是典型的树漂移。继续往下走只会把脏数据写进去，
      // 交给上层重新拉取更安全。
      //
      // 反过来说，**绝不能把 409/422 当普通参数错误直接失败** —— 那会让
      // 一次正常的并发冲突变成用户可见的同步中断。
      if (error?.status === 409 || error?.status === 422 || error?.status === 500) {
        throw new SyncConflictError(
          `提交被拒绝（HTTP ${error.status}）：${error.message}`,
          { expectedHeadOid: input.expectedHeadOid },
        );
      }
      throw error;
    }

    // ── 5. 复核：读取新 tip ──
    // 不依赖响应体（结构随版本变化），重读最可靠；
    // 顺带验证"这次提交真的落地了"。
    return this.head(branch);
  }

  /**
   * 空仓库引导：直接 `POST /contents`，不需要先建分支。
   *
   * ## 为什么要改掉「先 POST /branches」的写法
   *
   * 我最初以为必须显式建分支，否则 `POST /contents` 会 404 —— 这个假设
   * 在 **Gitea 1.22.6 实测中被推翻**：
   *
   *   · 空仓库直接 `POST /contents`（branch 填任意名字，包括非默认分支）
   *     → **201**，自动建出该分支和第一个提交。
   *   · 反而 `POST /branches`（old_branch_name 为空）在空仓库上
   *     → **404 "Git Repository is empty."**，因为它要基于已有提交建分支。
   *
   * 也就是说原来那一步不仅多余，还会稳定返回一个错误，白白多一次
   * 往返 + 一条误导性的日志。
   *
   * @param {string} branch 分支
   * @returns {Promise<string>}
   */
  async bootstrap(branch) {
    try {
      await this.context.api('POST', '/contents', {
        body: {
          branch,
          message: 'init neno',
          files: [{
            operation: 'create',
            path: 'README.md',
            content: textToBase64('# NENO\n\nNENO 笔记数据仓库\n'),
          }],
        },
      });
    } catch (error) {
      // 竞态：另一个设备已经建好了 README。这不是错误，继续读 tip 即可。
      if (error?.status !== 409 && error?.status !== 422) throw error;
    }
    return this.head(branch);
  }
}

/**
 * 按平台建策略。
 *
 * @param {string} platform 平台 id
 * @param {object} context 上下文
 * @returns {CommitStrategy}
 */
export function createStrategy(platform, context) {
  const caps = capsOf(platform);
  if (caps.branchHeadCAS) return new GraphQLCommitStrategy({ ...context, caps });
  return new ChangeFilesStrategy({ ...context, caps });
}
