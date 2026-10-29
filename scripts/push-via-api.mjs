/**
 * 通过 GitHub Git Data API 推送（绕过被阻断的 git:// 与 https:// 通道）。
 *
 * ## 为什么需要这个
 *
 * 本机 `api.github.com` 可达（200），但 `github.com` 被代理拦掉（502），
 * 所以 `git push` 走不通。而 GitHub 的 REST API 提供了完整的一套等价能力：
 *
 *   POST /git/blobs   → 上传文件内容，拿到 blob sha
 *   POST /git/trees   → 组装目录树
 *   POST /git/commits → 建提交
 *   POST /git/refs    → 建分支（空仓库）
 *
 * 顺带一提：这正是 momo 项目里论证过「GitHub 有、Gitea 没有」的那条路径 ——
 * Gitea 的 git/ 命名空间是只读的（PATCH ref → 405），所以那边只能走
 * POST /contents 的文件级弱 CAS。这里反过来用上了 GitHub 的强路径。
 *
 * ## 用法
 *
 *   GITHUB_TOKEN=xxx GITHUB_REPO=folkson/momo node scripts/push-via-api.mjs
 *
 * 脚本会从本地 git 已提交的内容里读文件（不是工作区），所以推到远端的东西
 * 与本地 HEAD 逐字节一致。
 */

import { execFileSync } from 'node:child_process';

const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPO;
const BRANCH = process.env.GITHUB_BRANCH || 'main';

if (!TOKEN) throw new Error('缺少 GITHUB_TOKEN');
if (!REPO) throw new Error('缺少 GITHUB_REPO（形如 owner/repo）');

const API = 'https://api.github.com';

/**
 * 带重试的 API 调用。
 *
 * 上传近百个 blob 时偶发 5xx / 网络抖动很常见，一次失败就整个推送重来
 * 代价太大，所以这里对有意义的错误做有限重试。
 */
async function api(method, path, body, { retries = 3 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(`${API}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `token ${TOKEN}`,
          'Content-Type': 'application/json',
          'User-Agent': 'momo-push',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      if (response.status === 204) return null;

      const text = await response.text();
      let data;
      try {
        data = text === '' ? null : JSON.parse(text);
      } catch {
        data = { raw: text };
      }

      if (!response.ok) {
        const error = new Error(`${method} ${path} → ${response.status} ${data?.message ?? ''}`);
        error.status = response.status;
        error.data = data;
        // 4xx（除 429）重试没意义
        if (response.status < 500 && response.status !== 429) throw error;
        lastError = error;
      } else {
        return data;
      }
    } catch (error) {
      if (error.status !== undefined && error.status < 500) throw error;
      lastError = error;
    }
    // 指数退避
    await new Promise((resolve) => setTimeout(resolve, 400 * attempt ** 2));
  }
  throw lastError;
}

/**
 * 从本地 git 仓库读出 HEAD 的全部 blob。
 *
 * ⚠️ 用 `git ls-tree` + `git cat-file`，不要读工作区 —— 工作区可能有未提交
 * 改动或 CRLF 转换，推上去就和本地 HEAD 不一致了。
 *
 * @returns {Array<{path: string, mode: string, sha: string, content: Buffer}>}
 */
function readGitHead() {
  const listing = execFileSync('git', ['ls-tree', '-r', '-z', '--full-tree', 'HEAD'], {
    cwd: process.cwd(),
    maxBuffer: 64 * 1024 * 1024,
  });

  const entries = [];
  for (const record of listing.toString('utf8').split('\0')) {
    if (record === '') continue;
    // 格式：<mode> SP <type> SP <sha> TAB <path>
    const tab = record.indexOf('\t');
    const meta = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    const [mode, type, sha] = meta;
    if (type !== 'blob') continue;
    entries.push({ mode, sha, path });
  }

  for (const entry of entries) {
    entry.content = execFileSync('git', ['cat-file', 'blob', entry.sha], {
      cwd: process.cwd(),
      maxBuffer: 64 * 1024 * 1024,
    });
  }
  return entries;
}

/** 限并发地跑一批任务（GitHub 对二级速率有限制，别开太大）。 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runner() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

async function main() {
  const files = readGitHead();
  const totalBytes = files.reduce((sum, file) => sum + file.content.length, 0);
  console.log(`本地 HEAD 共 ${files.length} 个文件，${(totalBytes / 1024 / 1024).toFixed(2)} MB`);

  // ── 0. 空仓库引导 ──
  //
  // ⚠️ GitHub 的 `POST /git/blobs` 在**完全空的仓库**上会返回
  //   409 "Git Repository is empty." —— 必须先有一个提交，git 对象库才可用。
  //
  // 这个坑和本项目里 Gitea 的引导问题是同一类：空仓库那个"什么都没有"的
  // 状态，各家的处理方式都不一样。
  //
  // 用 `PUT /contents/README.md` 造第一个提交。README.md 本来就在要推的
  // 文件列表里，所以最终内容不会多出来。
  let baseSha = '';
  try {
    const existing = await api('GET', `/repos/${REPO}/git/ref/heads/${BRANCH}`);
    baseSha = String(existing?.object?.sha ?? '');
    console.log(`仓库已有内容，基于 ${baseSha} 追加`);
  } catch (error) {
    if (error.status !== 404 && error.status !== 409) throw error;
    console.log('空仓库，先引导第一个提交…');
    const seed = await api('PUT', `/repos/${REPO}/contents/README.md`, {
      message: 'chore: init',
      content: Buffer.from('# momo\n').toString('base64'),
      branch: BRANCH,
    });
    baseSha = seed.commit.sha;
    console.log(`  引导提交: ${baseSha}`);
  }

  // ── 1. 逐个上传 blob ──
  let done = 0;
  const uploaded = await mapLimit(files, 6, async (file) => {
    const result = await api('POST', `/repos/${REPO}/git/blobs`, {
      content: file.content.toString('base64'),
      encoding: 'base64',
    });
    done += 1;
    if (done % 20 === 0 || done === files.length) {
      process.stdout.write(`  已上传 ${done}/${files.length}\n`);
    }
    // ★ 校验：GitHub 返回的 sha 应与本地 git 的 blob sha 完全一致
    //   （同一套 SHA-1 of "blob <len>\0<content>" 算法）
    if (result.sha !== file.sha) {
      console.warn(`  ⚠ sha 不一致: ${file.path} 本地=${file.sha} 远端=${result.sha}`);
    }
    return { path: file.path, mode: file.mode, sha: result.sha, type: 'blob' };
  });

  // ── 2. 组装 tree ──
  const tree = await api('POST', `/repos/${REPO}/git/trees`, { tree: uploaded });
  console.log(`tree: ${tree.sha}`);

  // ── 3. 建提交 ──
  // 基于引导提交往上叠，这样远端历史是线性的，且不会丢掉那个初始提交
  const message = execFileSync('git', ['log', '-1', '--pretty=%B', 'HEAD'], {
    cwd: process.cwd(),
  }).toString('utf8');

  const commit = await api('POST', `/repos/${REPO}/git/commits`, {
    message,
    tree: tree.sha,
    parents: baseSha === '' ? [] : [baseSha],
  });
  console.log(`commit: ${commit.sha}`);

  // ── 4. 推进分支 ──
  if (baseSha === '') {
    await api('POST', `/repos/${REPO}/git/refs`, {
      ref: `refs/heads/${BRANCH}`,
      sha: commit.sha,
    });
  } else {
    await api('PATCH', `/repos/${REPO}/git/refs/heads/${BRANCH}`, {
      sha: commit.sha,
      force: false,
    });
  }
  console.log(`✓ 已推送 ${REPO} 的 ${BRANCH} 分支`);
}

main().catch((error) => {
  console.error('推送失败:', error.message);
  if (error.data) console.error(JSON.stringify(error.data, null, 2).slice(0, 800));
  process.exitCode = 1;
});
