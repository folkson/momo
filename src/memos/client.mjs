/**
 * memos v1 API 客户端（精简版）。
 *
 * ## 为什么是 v1 而不是 v2
 *
 * 实测 memos v0.18.2：
 *   · v2 的正文上限只有 **8KB**，长笔记直接被拒
 *   · v1 的上限是 1<<30，实际不受限
 *
 * 所以这里固定用 `/api/v1`。
 *
 * ## 三个实测得出的关键事实（每一条都踩过坑）
 *
 * ### 1. `POST /api/v1/memo` **完全忽略 createdTs**
 *
 * 传 `1793156799` 进去，落库的是"此刻"。换 `created_ts` / `displayTs`
 * 等字段名同样无效。
 *
 * **只有 `PATCH /api/v1/memo/{id}` 认这个字段**（0 误差、可重复调用）。
 * 所以建完必须补一次 patch 校正时间。
 *
 * ### 2. JWT 只从 `Set-Cookie` 下发，不响应体
 *
 * 而且 `res.headers.get('set-cookie')` 在多个 cookie 时会出错，
 * 必须用 `getSetCookie()` 拿**数组**。
 *
 * ### 3. 图片有两条渲染通道，只能走附件
 *
 * `resourceIdList` 挂附件会让前端自动渲染；正文再写 `![]()` 就渲染两遍。
 * 详见 content.mjs 的说明。
 */

/** memos 的可见性取值。 */
export const MEMOS_VISIBILITIES = Object.freeze(['PRIVATE', 'PROTECTED', 'PUBLIC']);

/** 默认请求间隔（毫秒）。v1 有中间件限流：每 IP 每秒 30 次、突发 100。 */
export const DEFAULT_MIN_INTERVAL_MS = 150;

/** 默认重试次数。 */
export const DEFAULT_MAX_RETRIES = 3;

/** 重试基础间隔（指数退避：1s → 2s → 4s）。 */
export const RETRY_BASE_DELAY_MS = 1000;

/**
 * memos 相关错误的统一类型。
 */
export class MemosError extends Error {
  /**
   * @param {string} message 描述
   * @param {object} [options] 附加信息
   * @param {number} [options.status] HTTP 状态码
   * @param {string} [options.code] 分类：network / auth / rate_limit / not_found / config / server
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'MemosError';
    this.status = Number(options.status ?? 0);
    this.code = String(options.code ?? 'unknown');
  }
}

/**
 * 规范化实例地址：去尾斜杠、去尾 `/api/v1`。
 *
 * 用户很容易把 `https://memos.example.com/api/v1` 粘进来，
 * 那样拼出来会变成 `/api/v1/api/v1/...`，报 404 很难查。
 *
 * @param {unknown} input 原始输入
 * @returns {string} 规范化后的基址（不含尾斜杠）
 */
export function normalizeBaseUrl(input) {
  let text = String(input ?? '').trim();
  if (text === '') return '';
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
  text = text.replace(/\/+$/, '');
  text = text.replace(/\/api\/v1$/i, '');
  return text.replace(/\/+$/, '');
}

/**
 * 从登录响应里提取 access token。
 *
 * ⚠️ memos v1 只在 `Set-Cookie` 里给 JWT，响应体是空的。
 * 而且多个 cookie 时 `headers.get('set-cookie')` 会被合并成一个字符串
 * （甚至逗号拼接），必须用 `getSetCookie()` 拿数组。
 *
 * @param {string[]|string|Headers|undefined|null} input cookie 或响应头
 * @returns {string} token（找不到时为空串）
 */
export function extractAccessToken(input) {
  /** @type {string[]} */
  let cookies = [];

  if (Array.isArray(input)) {
    cookies = input.map((item) => String(item));
  } else if (typeof input === 'string') {
    cookies = [input];
  } else if (input !== null && input !== undefined && typeof input.getSetCookie === 'function') {
    cookies = input.getSetCookie();
  } else if (input !== null && input !== undefined && typeof input.get === 'function') {
    const single = input.get('set-cookie');
    if (single !== null) cookies = [single];
  }

  for (const cookie of cookies) {
    // 格式：memos.access-token=xxx; Path=/; HttpOnly; SameSite=Lax
    const match = /(?:^|;\s*)memos\.access-token=([^;]+)/.exec(String(cookie));
    if (match !== null) return decodeURIComponent(match[1]).trim();
  }
  return '';
}

/**
 * 从响应体里挑出数字 id。
 *
 * memos 的 id 有时是数字（`{id: 42}`），有时是资源名（`{name: "memos/42"}`），
 * 两种都要兜住。
 *
 * @param {unknown} payload 响应体
 * @returns {number} 正整数 id；识别不出时返回 0
 */
export function pickNumericId(payload) {
  if (payload === null || payload === undefined) return 0;
  const record = /** @type {Record<string, unknown>} */ (payload);

  for (const key of ['id', 'uid', 'name']) {
    const value = record[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
    if (typeof value === 'string') {
      // "memos/42" / "resources/42" / "42"
      const match = /(\d+)\s*$/.exec(value);
      if (match !== null) {
        const parsed = Number(match[1]);
        if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
      }
    }
  }
  return 0;
}

/**
 * 根据文件名猜 Content-Type。
 *
 * @param {string} filename 文件名
 * @returns {string} MIME 类型
 */
export function guessContentType(filename) {
  const ext = String(filename ?? '').toLowerCase().split('.').pop() ?? '';
  const map = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    avif: 'image/avif',
    bmp: 'image/bmp',
    heic: 'image/heic',
  };
  return map[ext] ?? 'application/octet-stream';
}

/**
 * 构造图片的最终可访问地址。
 *
 * ⚠️ 配了**外部对象存储**的 memos 实例，`/o/r/{id}` 会返回 HTTP 200 但
 * **0 字节**（死链）。这时必须用上传响应里的 `externalLink`。
 *
 * @param {string} baseUrl memos 基址
 * @param {number} [resourceId] 资源 id
 * @param {object} [uploaded] 上传响应（可能含 externalLink / url）
 * @returns {string} 可访问地址；无法构造时为空串
 */
export function buildResourceUrl(baseUrl, resourceId, uploaded = undefined) {
  const direct = resolveResourceLink(baseUrl, uploaded?.externalLink ?? uploaded?.url ?? '');
  if (direct !== '') return direct;

  const id = Number(resourceId);
  if (!Number.isSafeInteger(id) || id <= 0) return '';

  const base = String(baseUrl ?? '').replace(/\/+$/, '');
  if (base === '') return '';
  return `${base}/o/r/${id}`;
}

/**
 * 把可能是相对路径的链接补全成绝对地址。
 *
 * @param {string} baseUrl memos 基址
 * @param {unknown} raw 原始链接
 * @returns {string} 绝对地址；无法解析时为空串
 */
function resolveResourceLink(baseUrl, raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return '';
  if (/^https?:\/\//i.test(text)) return text;
  if (text.startsWith('//')) return `https:${text}`;
  if (text.startsWith('/')) {
    const base = String(baseUrl ?? '').replace(/\/+$/, '');
    return base === '' ? '' : `${base}${text}`;
  }
  return '';
}

/**
 * 建一个 memos 客户端。
 *
 * @param {object} options 配置
 * @param {string} options.baseUrl 实例地址
 * @param {string} options.username 用户名
 * @param {string} options.password 密码
 * @param {number} [options.minIntervalMs] 请求最小间隔
 * @param {number} [options.maxRetries] 最大重试次数
 * @param {typeof fetch} [options.fetchImpl] 测试注入
 * @param {(ms: number) => Promise<void>} [options.sleep] 测试注入
 * @returns {object} 客户端
 */
export function createMemosClient(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const username = String(options.username ?? '');
  const password = String(options.password ?? '');
  const minIntervalMs = Number.isFinite(options.minIntervalMs)
    ? Math.max(0, Number(options.minIntervalMs))
    : DEFAULT_MIN_INTERVAL_MS;
  const maxRetries = Number.isFinite(options.maxRetries)
    ? Math.max(0, Number(options.maxRetries))
    : DEFAULT_MAX_RETRIES;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep
    ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));

  /** @type {string} */
  let token = '';
  /** 上次请求的时间戳，用于节流 */
  let lastRequestAt = 0;

  /**
   * 节流：保证两次请求之间至少间隔 minIntervalMs。
   *
   * @returns {Promise<void>}
   */
  async function throttle() {
    if (minIntervalMs <= 0) return;
    const wait = lastRequestAt + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
  }

  /**
   * 判断某个状态码是否值得重试。
   *
   * ⚠️ memos v1 的限流中间件**同时**用 429 和 403 —— 403 不一定是没权限。
   * 所以这两个都要重试。
   *
   * @param {number} status HTTP 状态码
   * @returns {boolean} 是否重试
   */
  function isRetryable(status) {
    return status === 429 || status === 403 || status === 500 || status === 502
      || status === 503 || status === 504;
  }

  /**
   * 发一个请求（含节流与重试）。
   *
   * @param {object} params 参数
   * @param {string} params.method HTTP 方法
   * @param {string} params.path API 路径
   * @param {object} [params.body] 请求体
   * @param {boolean} [params.auth] 是否需要认证头
   * @param {FormData} [params.form] multipart 体
   * @returns {Promise<{data: any, headers: Headers, response: Response}>}
   */
  async function request({ method, path, body, auth = true, form = undefined }) {
    const url = `${baseUrl}${path}`;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      await throttle();

      /** @type {Record<string, string>} */
      const headers = {};
      if (auth && token !== '') headers.Authorization = `Bearer ${token}`;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      // ⚠️ FormData 时不能手写 Content-Type，必须让 fetch 自己带 boundary

      /** @type {Response} */
      let response;
      try {
        response = await fetchImpl(url, {
          method,
          headers,
          body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
        });
      } catch (error) {
        if (attempt >= maxRetries) {
          throw new MemosError(`网络请求失败：${error.message}`, { code: 'network' });
        }
        await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
        continue;
      }

      if (response.ok) {
        const text = await response.text();
        let data = null;
        if (text.trim() !== '') {
          try {
            data = JSON.parse(text);
          } catch {
            data = text;
          }
        }
        return { data, headers: response.headers, response };
      }

      if (response.status === 401) {
        throw new MemosError('认证失败（用户名或密码错误）', { status: 401, code: 'auth' });
      }
      if (response.status === 404) {
        throw new MemosError(`资源不存在：${path}`, { status: 404, code: 'not_found' });
      }
      if (isRetryable(response.status) && attempt < maxRetries) {
        await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
        continue;
      }

      const text = await response.text().catch(() => '');
      throw new MemosError(
        `${method} ${path} 失败（HTTP ${response.status}）：${text.slice(0, 200)}`,
        {
          status: response.status,
          code: isRetryable(response.status) ? 'rate_limit' : 'server',
        },
      );
    }

    throw new MemosError('请求重试次数用尽', { code: 'network' });
  }

  return {
    baseUrl,

    /** @returns {boolean} 是否已登录 */
    get isSignedIn() {
      return token !== '';
    },

    /**
     * 登录并保存 token。
     *
     * @returns {Promise<void>}
     */
    async signin() {
      if (baseUrl === '') throw new MemosError('未配置 memos 实例地址', { code: 'config' });
      if (username === '' || password === '') {
        throw new MemosError('未配置 memos 用户名或密码', { code: 'config' });
      }

      const { headers } = await request({
        method: 'POST',
        path: '/api/v1/auth/signin',
        body: { username, password, neverExpire: true },
        auth: false,
      });

      // ★ 必须用 getSetCookie() 拿数组
      token = extractAccessToken(headers);
      if (token === '') {
        throw new MemosError('登录响应里没有 access token（Set-Cookie 缺失）', { code: 'auth' });
      }
    },

    /**
     * 拉 memo 列表。
     *
     * @param {{limit?: number, offset?: number}} [params] 分页
     * @returns {Promise<Array<any>>}
     */
    async listMemos({ limit = 100, offset = 0 } = {}) {
      const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      const { data } = await request({ method: 'GET', path: `/api/v1/memo?${query}` });
      return Array.isArray(data) ? data : [];
    },

    /**
     * 建一条 memo。
     *
     * ⚠️ `createdTs` 会被服务端**忽略**，必须建完再 patch（见文件头）。
     *
     * @param {object} payload 内容
     * @returns {Promise<any>} 创建的 memo
     */
    async createMemo({ content, visibility = 'PRIVATE', createdTs, resourceIdList } = {}) {
      /** @type {Record<string, unknown>} */
      const body = { content: String(content ?? ''), visibility };
      if (Number.isFinite(createdTs)) body.createdTs = createdTs;
      if (Array.isArray(resourceIdList) && resourceIdList.length > 0) {
        body.resourceIdList = resourceIdList;
      }
      const { data } = await request({ method: 'POST', path: '/api/v1/memo', body });
      return data;
    },

    /**
     * 更新 memo。
     *
     * ✅ 与 POST 不同，PATCH **认** `createdTs`（实测 0 误差）。
     *
     * @param {number} id memo id
     * @param {object} payload 要改的字段
     * @returns {Promise<any>}
     */
    async patchMemo(id, payload = {}) {
      const memoId = Number(id);
      if (!Number.isSafeInteger(memoId) || memoId <= 0) {
        throw new MemosError(`patchMemo: 非法 id（${id}）`, { code: 'config' });
      }
      /** @type {Record<string, unknown>} */
      const body = {};
      if (typeof payload.content === 'string') body.content = payload.content;
      if (typeof payload.visibility === 'string') body.visibility = payload.visibility;
      if (Number.isFinite(payload.createdTs)) body.createdTs = payload.createdTs;
      if (Array.isArray(payload.resourceIdList)) body.resourceIdList = payload.resourceIdList;

      const { data } = await request({
        method: 'PATCH', path: `/api/v1/memo/${memoId}`, body,
      });
      return data;
    },

    /**
     * 删除 memo。
     *
     * @param {number} id memo id
     * @returns {Promise<void>}
     */
    async deleteMemo(id) {
      await request({ method: 'DELETE', path: `/api/v1/memo/${Number(id)}` });
    },

    /**
     * 上传附件。
     *
     * ⚠️ multipart 字段名必须是 `file` —— 后端是 `c.FormFile("file")`，
     * 名字不一致只会得到难懂的 400。
     *
     * @param {{filename: string, bytes: Uint8Array, contentType?: string}} file 文件
     * @returns {Promise<any>} 上传响应（含 id 与 externalLink）
     */
    async uploadResource({ filename, bytes, contentType }) {
      if (!(bytes instanceof Uint8Array)) {
        throw new MemosError('uploadResource: bytes 必须是 Uint8Array', { code: 'config' });
      }
      const name = String(filename ?? 'blob');
      const form = new FormData();
      form.append(
        'file',
        new Blob([bytes], { type: String(contentType ?? guessContentType(name)) }),
        name,
      );
      const { data } = await request({
        method: 'POST', path: '/api/v1/resource/blob', form,
      });
      return data;
    },

    /**
     * 拉资源列表（用于把 `/o/r/` 死链换成真实地址）。
     *
     * @param {{limit?: number, offset?: number}} [params] 分页
     * @returns {Promise<Array<any>>}
     */
    async listResources({ limit = 200, offset = 0 } = {}) {
      const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      const { data } = await request({ method: 'GET', path: `/api/v1/resource?${query}` });
      return Array.isArray(data) ? data : [];
    },
  };
}
