/**
 * 模拟 memos v1 API 的 HTTP 服务，用于测试 memos 推送层。
 *
 * ## 为什么必须复刻那三个"反直觉"的行为
 *
 * 如果 mock 写得太"合理"，测试就只是在验证自己的想象。所以这里刻意复刻了
 * 线上实测出来的三个坑（见 src/memos/client.mjs 文件头）：
 *
 * 1. **`POST /api/v1/memo` 忽略 `createdTs`** —— 落库时间永远是"此刻"。
 *    这条不模拟，就测不出"建完必须补 patch"这个关键步骤。
 * 2. **JWT 只从 `Set-Cookie` 下发**，响应体为空。
 * 3. **`resourceIdList` 是全量覆盖语义** —— 传 `[]` 就是解绑所有附件。
 *
 * 另外也复刻了 `resourceList` 的派生：memos 返回 memo 时，`resourceList`
 * 是按 `resourceIdList` 反查出来的完整对象数组，不是用户直接写的。
 */
import { createServer } from 'node:http';

/**
 * 起一个模拟 memos 服务。
 *
 * @param {object} [options] 选项
 * @param {string} [options.username] 用户名
 * @param {string} [options.password] 密码
 * @param {string} [options.token] 下发的 JWT
 * @returns {Promise<object>} 服务句柄
 */
export async function startMockMemos(options = {}) {
  const username = options.username ?? 'alice';
  const password = options.password ?? 'secret';
  const token = options.token ?? 'mock-jwt-token';

  /** memo id 自增游标 */
  let nextMemoId = 1;
  /** resource id 自增游标 */
  let nextResourceId = 1;

  /** @type {Map<number, any>} memo id → memo */
  const memos = new Map();
  /** @type {Map<number, any>} resource id → resource */
  const resources = new Map();
  /** 记录所有请求，供断言 */
  const requests = [];

  /**
   * 把 memo 的 `resourceIdList` 展开成 `resourceList`。
   *
   * 真实 memos 就是这么返回的 —— 前端附件区渲染的是 `resourceList`，
   * 所以测试断言它比断言 `resourceIdList` 更接近"用户看到什么"。
   *
   * @param {any} memo 内部存储的 memo
   * @returns {any} 对外返回的 memo
   */
  function project(memo) {
    const ids = Array.isArray(memo.resourceIdList) ? memo.resourceIdList : [];
    return {
      id: memo.id,
      name: `memos/${memo.id}`,
      content: memo.content,
      visibility: memo.visibility,
      createdTs: memo.createdTs,
      updatedTs: memo.updatedTs,
      resourceIdList: [...ids],
      resourceList: ids
        .map((id) => resources.get(Number(id)))
        .filter((item) => item !== undefined)
        .map((item) => ({ ...item })),
    };
  }

  /**
   * 解析 multipart/form-data，取出所有文件字段。
   *
   * 只需支持单文件字段 `file`（memos 的 `c.FormFile("file")`），
   * 所以实现得比较直接：按边界切段，读 Content-Disposition 里的 filename，
   * 然后取头部之后的原始字节。
   *
   * @param {Buffer} body 原始请求体
   * @param {string} contentType Content-Type 头（含 boundary）
   * @returns {Array<{field: string, filename: string, contentType: string, bytes: Buffer}>}
   */
  function parseMultipart(body, contentType) {
    const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
    if (boundaryMatch === null) return [];
    const boundary = `--${(boundaryMatch[1] ?? boundaryMatch[2]).trim()}`;
    const delimiter = Buffer.from(`\r\n${boundary}`);

    /** @type {Array<{field: string, filename: string, contentType: string, bytes: Buffer}>} */
    const parts = [];

    // 首段之前可能有一个 \r\n，统一在前面补一个，让所有分隔符形态一致
    const padded = Buffer.concat([Buffer.from('\r\n'), body]);
    let cursor = 0;

    while (cursor < padded.length) {
      const start = padded.indexOf(delimiter, cursor);
      if (start === -1) break;
      // `--boundary--` 是结束标记
      if (padded[start + delimiter.length] === 0x2d
        && padded[start + delimiter.length + 1] === 0x2d) break;

      const headerStart = start + delimiter.length + 2; // 跳过 \r\n
      const headerEnd = padded.indexOf('\r\n\r\n', headerStart);
      if (headerEnd === -1) break;

      const headerText = padded.subarray(headerStart, headerEnd).toString('utf8');
      const dataStart = headerEnd + 4;
      const nextBoundary = padded.indexOf(delimiter, dataStart);
      if (nextBoundary === -1) break;

      const fieldMatch = /name="([^"]*)"/i.exec(headerText);
      const filenameMatch = /filename="([^"]*)"/i.exec(headerText);
      const typeMatch = /content-type:\s*([^\r\n]+)/i.exec(headerText);

      parts.push({
        field: fieldMatch?.[1] ?? '',
        filename: filenameMatch?.[1] ?? '',
        contentType: typeMatch?.[1] ?? 'application/octet-stream',
        bytes: padded.subarray(dataStart, nextBoundary),
      });

      cursor = nextBoundary;
    }

    return parts;
  }

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://127.0.0.1');
    const { pathname, searchParams } = url;

    requests.push({
      method: req.method,
      path: pathname,
      query: searchParams.toString(),
      raw: raw.toString('utf8'),
      bytes: raw,
      contentType: String(req.headers['content-type'] ?? ''),
    });

    res.setHeader('Connection', 'close');
    const json = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    // ── 登录（JWT 只走 Set-Cookie，响应体为空）──
    if (pathname === '/api/v1/auth/signin' && req.method === 'POST') {
      let payload = {};
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        json(400, { message: 'body 不是合法 JSON' });
        return;
      }
      if (payload.username !== username || payload.password !== password) {
        json(401, { message: '用户名或密码错误' });
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        // ★ 关键：真实 memos 同时下发多个 cookie，必须靠 getSetCookie() 拿数组
        'Set-Cookie': [
          `memos.access-token=${token}; Path=/; HttpOnly; SameSite=Lax`,
          'memos.refresh-token=refresh; Path=/; HttpOnly; SameSite=Lax',
        ],
      });
      res.end('');
      return;
    }

    // ── 认证校验 ──
    const auth = String(req.headers.authorization ?? '');
    if (auth !== `Bearer ${token}`) {
      json(401, { message: '未认证' });
      return;
    }

    // ── GET /api/v1/memo ──
    if (pathname === '/api/v1/memo' && req.method === 'GET') {
      const limit = Number(searchParams.get('limit') ?? 100);
      const offset = Number(searchParams.get('offset') ?? 0);
      const list = [...memos.values()]
        .sort((a, b) => b.id - a.id)
        .slice(offset, offset + limit)
        .map(project);
      json(200, list);
      return;
    }

    // ── POST /api/v1/memo ──
    if (pathname === '/api/v1/memo' && req.method === 'POST') {
      let payload = {};
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        json(400, { message: 'body 不是合法 JSON' });
        return;
      }

      const id = nextMemoId;
      nextMemoId += 1;

      // ★★ 核心复刻：**完全忽略** payload.createdTs，落库时间永远是"此刻"
      const now = Math.floor(Date.now() / 1000);
      const memo = {
        id,
        content: String(payload.content ?? ''),
        visibility: String(payload.visibility ?? 'PRIVATE'),
        createdTs: now,
        updatedTs: now,
        resourceIdList: Array.isArray(payload.resourceIdList)
          ? payload.resourceIdList.map(Number)
          : [],
      };
      memos.set(id, memo);
      json(200, project(memo));
      return;
    }

    // ── PATCH /api/v1/memo/{id} ──
    const patchMatch = /^\/api\/v1\/memo\/(\d+)$/.exec(pathname);
    if (patchMatch !== null && req.method === 'PATCH') {
      const id = Number(patchMatch[1]);
      const memo = memos.get(id);
      if (memo === undefined) {
        json(404, { message: `memo ${id} 不存在` });
        return;
      }
      let payload = {};
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        json(400, { message: 'body 不是合法 JSON' });
        return;
      }

      if (typeof payload.content === 'string') memo.content = payload.content;
      if (typeof payload.visibility === 'string') memo.visibility = payload.visibility;
      // ✅ 与 POST 不同，PATCH **认** createdTs
      if (Number.isFinite(payload.createdTs)) memo.createdTs = Number(payload.createdTs);
      // 全量覆盖语义：传了就是替换，没传才保持不变
      if (Array.isArray(payload.resourceIdList)) {
        memo.resourceIdList = payload.resourceIdList.map(Number);
      }
      memo.updatedTs = Math.floor(Date.now() / 1000);

      json(200, project(memo));
      return;
    }

    // ── DELETE /api/v1/memo/{id} ──
    if (patchMatch !== null && req.method === 'DELETE') {
      const id = Number(patchMatch[1]);
      if (!memos.has(id)) {
        json(404, { message: `memo ${id} 不存在` });
        return;
      }
      memos.delete(id);
      json(200, {});
      return;
    }

    // ── POST /api/v1/resource/blob（multipart，字段名必须是 file）──
    if (pathname === '/api/v1/resource/blob' && req.method === 'POST') {
      const parts = parseMultipart(raw, String(req.headers['content-type'] ?? ''));
      const file = parts.find((item) => item.field === 'file');
      if (file === undefined) {
        json(400, { message: '缺少 file 字段' });
        return;
      }

      const id = nextResourceId;
      nextResourceId += 1;
      const resource = {
        id,
        name: `resources/${id}`,
        filename: file.filename,
        type: file.contentType,
        size: file.bytes.length,
        // 故意留空，验证 buildResourceUrl 会退化成 /o/r/{id}
        externalLink: '',
      };
      // 同时记下内容，方便测试断言"上传的字节是对的"
      resources.set(id, { ...resource, bytes: file.bytes });
      json(200, resource);
      return;
    }

    // ── GET /api/v1/resource ──
    if (pathname === '/api/v1/resource' && req.method === 'GET') {
      json(200, [...resources.values()].map(({ bytes, ...rest }) => rest));
      return;
    }

    json(404, { message: `unknown endpoint ${req.method} ${pathname}` });
  });

  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    username,
    password,
    token,
    state: {
      memos,
      resources,
      requests,
      /** 取某条 memo 的对外投影 */
      getMemo(id) {
        const memo = memos.get(Number(id));
        return memo === undefined ? null : project(memo);
      },
      /** 按正文内容找 memo（测试里拿不到 id 时用） */
      findByContent(needle) {
        for (const memo of memos.values()) {
          if (memo.content.includes(needle)) return project(memo);
        }
        return null;
      },
      /** 清空请求记录 */
      resetRequests() { requests.length = 0; },
      /**
       * 只保留**数据写入**请求（POST / PATCH / DELETE），排除登录与读请求。
       *
       * ⚠️ 两个坑：
       *   1. 不能简单取 `requests.at(-1)` —— 读请求和写请求交错，
       *      最后一次未必是写。
       *   2. 登录 `POST /auth/signin` 也是 POST，但它是认证不是数据操作。
       *      把它算进来会让"第二轮零写入"这类断言永远失败。
       *
       * @returns {Array<any>}
       */
      writes() {
        return requests.filter((item) => item.method !== 'GET'
          && item.path !== '/api/v1/auth/signin');
      },
      /** 用户在 memos 端手动删掉一条 memo（模拟） */
      removeMemo(id) { memos.delete(Number(id)); },
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => { server.close(resolve); });
    },
  };
}
