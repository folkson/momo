/**
 * 用真实 Gitea 1.22.6 验证前端策略层（不是 mock）。
 *
 * 环境变量：
 *   GITEA_BASE  API 基址（含 /api/v1）
 *   GITEA_TOKEN 访问令牌
 *   GITEA_OWNER / GITEA_REPO
 */
import { createStrategy, SyncConflictError } from '../src/frontend/commitStrategy.mjs';

const BASE = process.env.GITEA_BASE;
const TOKEN = process.env.GITEA_TOKEN;
const OWNER = process.env.GITEA_OWNER;
const REPO = process.env.GITEA_REPO;

function contextFor() {
  const prefix = `/repos/${OWNER}/${REPO}`;
  async function api(method, path, options = {}) {
    let url = `${BASE}${prefix}${path}`;
    if (options.query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(options.query)) if (v !== undefined) params.set(k, String(v));
      url += `?${params}`;
    }
    const headers = { Accept: 'application/json', Authorization: `token ${TOKEN}` };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.etag) headers['If-None-Match'] = options.etag;

    const response = await fetch(url, {
      method, headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (response.status === 304) return { notModified: true, data: null, headers: response.headers, etag: options.etag };
    if (!response.ok) {
      let message = response.statusText;
      try { const b = await response.json(); message = b.message || message; } catch {}
      const e = new Error(message); e.status = response.status; throw e;
    }
    const data = response.status === 204 ? null : await response.json();
    return { data, headers: response.headers, etag: response.headers.get('etag') };
  }
  return { api, credentials: () => ({ owner: OWNER, repo: REPO, access_token: TOKEN }) };
}

const b64 = (t) => Buffer.from(t, 'utf8').toString('base64');
const log = (...a) => console.log(...a);

const strategy = createStrategy('gitea', contextFor());

log('--- 1. 空仓库读 head 应失败 ---');
try {
  await strategy.head('main');
  log('✗ 居然成功了？');
} catch (e) {
  log(`✓ 失败: ${e.status} ${e.message}`);
}

log('--- 2. bootstrap ---');
const base = await strategy.bootstrap('main');
log(`✓ base=${base}`);

log('--- 3. 增量提交 ---');
const head1 = await strategy.head('main');
const next = await strategy.commit({
  branch: 'main',
  expectedHeadOid: head1,
  headline: 'from strategy layer',
  additions: [
    { path: '2026-01-01/n1.json', contents: b64('{"id":"n1","中文":"内容"}') },
    { path: 'picData/p.png', contents: b64('PNGDATA') },
  ],
  deletions: [],
});
log(`✓ next=${next} (changed: ${next !== head1})`);

log('--- 4. 读回内容 ---');
const r = await strategy.context.api('GET', '/contents/2026-01-01/n1.json', { query: { ref: 'main' } });
const got = Buffer.from(r.data.content, 'base64').toString('utf8');
log(`✓ 内容=${got}`);
log(got === '{"id":"n1","中文":"内容"}' ? '✓ 中文往返正确' : '✗ 内容损坏');

log('--- 5. tip 冲突 → SyncConflictError ---');
try {
  await strategy.commit({
    branch: 'main', expectedHeadOid: 'deadbeef'.repeat(5),
    headline: 'should conflict',
    additions: [{ path: 'x.txt', contents: b64('x') }],
    deletions: [],
  });
  log('✗ 应该冲突');
} catch (e) {
  log(e instanceof SyncConflictError ? `✓ SyncConflictError: ${e.message}` : `✗ 错误类型 ${e.name}: ${e.message}`);
}

log('--- 6. 删除 ---');
const h2 = await strategy.head('main');
await strategy.commit({
  branch: 'main', expectedHeadOid: h2, headline: 'delete png',
  additions: [], deletions: [{ path: 'picData/p.png' }],
});
const after = await strategy.context.api('GET', '/contents/2026-01-01/n1.json', { query: { ref: 'main' } });
log(`✓ n1.json 还在: ${after.data !== null}`);
try {
  await strategy.context.api('GET', '/contents/picData/p.png', { query: { ref: 'main' } });
  log('✗ p.png 应该已删除');
} catch (e) {
  log(e.status === 404 ? '✓ p.png 已删除' : `? ${e.status}`);
}
