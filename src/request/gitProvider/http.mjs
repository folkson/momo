/**
 * 三个代码平台共用的 HTTP 客户端。
 *
 * 抽出来是因为它们的差异其实集中在三处：base URL、认证头、错误体结构。
 * 其余（fetch、超时、304、JSON 解析）完全一样，没必要在三个 provider 里各写一遍。
 */
import { fromHttpStatus, GitProviderError } from './errors.mjs';

/**
 * 各平台的认证方式。
 *
 * ⚠️ Gitea / Forgejo 与 GitHub **同语法**（`Authorization: token xxx`），这是
 * 迁移时最省事的一点。GitLab 用 `PRIVATE-TOKEN`，必须单独分支。
 */
export const AUTH_STYLES = Object.freeze({
  /** `Authorization: token <t>` —— GitHub / Gitea / Forgejo */
  tokenHeader: 'token',
  /** `PRIVATE-TOKEN: <t>` —— GitLab */
  privateToken: 'private-token',
  /** `Authorization: Bearer <t>` —— 通用 OAuth2 */
  bearer: 'bearer',
});

/**
 * 构造请求头。
 *
 * @param {string} token 访问令牌
 * @param {string} authStyle AUTH_STYLES 中的值
 * @param {boolean} hasBody 是否有请求体（决定要不要 Content-Type）
 * @returns {Record<string, string>} 请求头
 */
export function buildHeaders(token, authStyle, hasBody) {
  /** @type {Record<string, string>} */
  const headers = { Accept: 'application/json' };
  const value = String(token ?? '').trim();

  if (authStyle === AUTH_STYLES.privateToken) {
    headers['PRIVATE-TOKEN'] = value;
  } else if (authStyle === AUTH_STYLES.bearer) {
    headers.Authorization = `Bearer ${value}`;
  } else {
    headers.Authorization = `token ${value}`;
  }

  if (hasBody) headers['Content-Type'] = 'application/json';
  return headers;
}

/**
 * 从响应里尽量提取可读的错误信息。
 *
 * 三个平台的错误体结构不同：
 *   · GitHub  —— `{message, documentation_url, errors:[...]}`
 *   · Gitea   —— `{message, url, errors?}`
 *   · GitLab  —— `{message}` 或 `{error, error_description}`
 *
 * @param {Response} response fetch 响应
 * @returns {Promise<string>} 错误描述
 */
async function readErrorMessage(response) {
  let text = '';
  try {
    text = await response.text();
  } catch {
    return response.statusText || `HTTP ${response.status}`;
  }
  if (text.trim() === '') return response.statusText || `HTTP ${response.status}`;

  try {
    const body = JSON.parse(text);
    if (typeof body?.message === 'string' && body.message !== '') return body.message;
    if (typeof body?.error_description === 'string' && body.error_description !== '') {
      return body.error_description;
    }
    if (typeof body?.error === 'string' && body.error !== '') return body.error;
    // Gitea 的多文件提交错误有时是 {errors:[...]}
    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      const first = body.errors[0];
      if (typeof first === 'string') return first;
      if (typeof first?.message === 'string') return first.message;
    }
  } catch {
    // 不是 JSON，直接用原始文本（截断，避免把整页 HTML 塞进日志）
  }
  return text.slice(0, 300);
}

/**
 * 发一个 REST 请求。
 *
 * @param {object} options 请求参数
 * @param {string} options.platform 平台名（用于错误信息）
 * @param {string} options.baseUrl API 基址（不带尾斜杠）
 * @param {string} options.token 访问令牌
 * @param {string} options.authStyle 认证方式
 * @param {string} options.method HTTP 方法
 * @param {string} options.path 路径（以 `/` 开头）
 * @param {object} [options.body] 请求体（自动 JSON 序列化）
 * @param {Record<string, unknown>} [options.query] 查询参数
 * @param {string|null} [options.etag] 条件请求用的 ETag
 * @param {number} [options.timeoutMs] 超时（默认 30s）
 * @param {typeof fetch} [options.fetchImpl] 测试注入
 * @returns {Promise<{data: any, headers: Headers, etag: string|null, notModified: boolean}>}
 *   统一响应。`notModified` 为 true 时 `data` 是 null、`etag` 原样返回。
 */
export async function request({
  platform,
  baseUrl,
  token,
  authStyle,
  method,
  path,
  body,
  query = undefined,
  etag = null,
  timeoutMs = 30_000,
  fetchImpl = fetch,
}) {
  const base = String(baseUrl ?? '').replace(/\/+$/, '');
  if (base === '') throw new GitProviderError(`[${platform}] baseUrl 为空`, 0, { platform });

  let url = `${base}${path}`;
  if (query !== undefined && query !== null) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) params.set(key, String(value));
    }
    const qs = params.toString();
    if (qs !== '') url += `?${qs}`;
  }

  const hasBody = body !== undefined;
  /** @type {Record<string, string>} */
  const headers = buildHeaders(token, authStyle, hasBody);
  if (etag) headers['If-None-Match'] = etag;

  /** @type {Response} */
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      body: hasBody ? JSON.stringify(body) : undefined,
      // 同步必须看到最新状态，绝不能用浏览器缓存
      cache: 'no-store',
      signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch (error) {
    // 网络层失败（断网、DNS、超时）：status 0，上层可据此重试
    throw new GitProviderError(
      `[${platform}] 网络请求失败：${error.message}`,
      0,
      { platform, cause: error, url },
    );
  }

  // 304：内容没变，且**不计入**配额。这是 3 秒轮询能跑起来的前提。
  if (response.status === 304) {
    return { data: null, headers: response.headers, etag, notModified: true };
  }

  if (!response.ok) {
    const message = await readErrorMessage(response);
    throw fromHttpStatus(platform, response.status, message, { url, method });
  }

  // 204 No Content（如删除）：没有 body 可解析
  if (response.status === 204) {
    return { data: null, headers: response.headers, etag: response.headers.get('etag'), notModified: false };
  }

  let data = null;
  const text = await response.text();
  if (text.trim() !== '') {
    try {
      data = JSON.parse(text);
    } catch {
      // 少数端点（如 GitLab 的 raw 文件）返回非 JSON，交由调用方自己处理
      data = text;
    }
  }
  return { data, headers: response.headers, etag: response.headers.get('etag'), notModified: false };
}
