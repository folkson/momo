/**
 * 代码平台适配层的统一错误类型。
 *
 * ## 为什么要统一错误
 *
 * 三个平台的"并发冲突"信号完全是三种东西：
 *   · GitHub  —— GraphQL 返回 **HTTP 200** + `{errors:[...]}`（不是 4xx！）
 *   · Gitea/Forgejo —— `POST /contents` 返回 **409**（文件 sha 不匹配时）
 *   · GitLab  —— `POST /repository/commits` 返回 **400**，靠 message 文本区分
 *
 * 如果让上层自己判断，每个调用点都要写三套逻辑。所以这里约定：
 * **无论底层是什么，只要"远端已被别人推进"，一律抛 `ConflictError`。**
 * 上层只 catch 这一个类型。
 */

/**
 * 代码平台返回的通用错误。
 *
 * `status` 保留原始 HTTP 状态码，便于排查；但业务逻辑**不应该**依赖它，
 * 而应该依赖具体子类（ConflictError / NotFoundError / AuthError）。
 */
export class GitProviderError extends Error {
  /**
   * @param {string} message 错误描述
   * @param {number} status HTTP 状态码（网络层失败时是 0）
   * @param {object} [extra] 附加字段（platform / body / op 等）
   */
  constructor(message, status, extra = {}) {
    super(message);
    this.name = 'GitProviderError';
    this.status = status;
    Object.assign(this, extra);
  }
}

/**
 * 远端分支已被推进 —— 提交冲突。
 *
 * 语义契约：**所有 provider 在检测到冲突时必须抛这个**，不允许返回 null 或
 * 静默成功。上层收到后会「重新拉取 → 合并 → 在 MAX_ATTEMPTS 内重试」。
 */
export class ConflictError extends GitProviderError {
  /**
   * @param {string} [message] 错误描述
   * @param {object} [extra] 附加字段
   */
  constructor(message = '远端分支已被推进，提交冲突', extra = {}) {
    super(message, 409, extra);
    this.name = 'ConflictError';
  }
}

/** 仓库 / 分支 / 文件不存在。上层通常转成"首次同步"处理。 */
export class NotFoundError extends GitProviderError {
  /**
   * @param {string} [message] 错误描述
   * @param {object} [extra] 附加字段
   */
  constructor(message = '资源不存在', extra = {}) {
    super(message, 404, extra);
    this.name = 'NotFoundError';
  }
}

/** token 无效或权限不足。这类错误**不该重试**，重试只会一直失败并浪费配额。 */
export class AuthError extends GitProviderError {
  /**
   * @param {string} [message] 错误描述
   * @param {object} [extra] 附加字段
   */
  constructor(message = 'token 无效或权限不足', extra = {}) {
    super(message, 401, extra);
    this.name = 'AuthError';
  }
}

/**
 * 把 HTTP 状态码映射成统一错误。
 *
 * @param {string} platform 平台名（写进错误信息，便于排错）
 * @param {number} status HTTP 状态码
 * @param {string} message 后端给的原始信息
 * @param {object} [extra] 附加字段
 * @returns {GitProviderError} 对应类型的错误实例
 */
export function fromHttpStatus(platform, status, message, extra = {}) {
  const text = `[${platform}] ${message}（HTTP ${status}）`;
  if (status === 401 || status === 403) return new AuthError(text, { platform, status, ...extra });
  if (status === 404) return new NotFoundError(text, { platform, status, ...extra });
  if (status === 409 || status === 422) {
    // 422 在 Gitea 上既可能是"文件 sha 不匹配"（冲突），也可能是参数错误。
    // 因为无法从状态码区分，这里**统一当冲突处理** —— 冲突会触发重拉重试，
    // 如果是真的参数错误，重试到上限后仍会失败并报错，代价只是几次多余请求。
    // 反过来（把冲突当参数错误）会导致静默丢数据，那个代价不可接受。
    return new ConflictError(text, { platform, status, ...extra });
  }
  return new GitProviderError(text, status, { platform, status, ...extra });
}
