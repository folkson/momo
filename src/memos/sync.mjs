/**
 * 代码平台仓库 → memos 的单向同步器。
 *
 * ## 数据流
 *
 *     Gitea/Forgejo/GitHub 仓库
 *       ├─ YYYY-MM-DD/<id>.json   neno 的笔记 JSON
 *       └─ picData/<key>.<ext>     图片
 *             ↓ 读取 + 解析
 *     memo 正文（纯文字，图片走附件）
 *             ↓
 *     memos v1 API
 *
 * ## 为什么是单向
 *
 * neno 是唯一真源。memos 只是"另一个查看端"。双向会形成合并冲突：
 * 用户在 memos 改了内容，回写 neno 后 neno 又同步回来，来回震荡。
 * 所以这里**只读代码平台、只写 memos**，且 memos 端的手动删除不会被重建
 * （单向只读语义，见 `handleMissing` 的说明）。
 *
 * ## 状态文件是幂等的根基
 *
 * 没有 `.memos-map.json`，每轮都会把全部笔记重新灌进 memos，产生成倍的重复记录。
 * 所以这个文件**必须**被提交或被持久化，绝不能只放在临时目录。
 */
import { buildMemoContent, contentFingerprint, normalizeTags } from './content.mjs';
import { MemosError, pickNumericId, buildResourceUrl } from './client.mjs';

/** 单条 memo 正文的安全上限（v1 实际上是 1<<30，这里留个防御性阈值）。 */
export const MAX_CONTENT_BYTES = 4 * 1024 * 1024;

/**
 * 从仓库文件树里找出所有笔记 JSON。
 *
 * 只认 `YYYY-MM-DD/<id>.json` 这一种结构 —— 这是 neno 的固定布局。
 * 放宽匹配会把 `picData/` 之类的东西误当笔记。
 *
 * @param {Array<{path: string, sha: string}>} tree 仓库文件树
 * @returns {Array<{path: string, sha: string, dateDir: string, noteId: string}>}
 */
export function findNoteFiles(tree) {
  /** @type {Array<{path: string, sha: string, dateDir: string, noteId: string}>} */
  const notes = [];
  for (const entry of tree) {
    const match = /^(\d{4}-\d{2}-\d{2})\/([^/]+)\.json$/.exec(entry.path);
    if (match === null) continue;
    notes.push({
      path: entry.path,
      sha: entry.sha,
      dateDir: match[1],
      noteId: match[2],
    });
  }
  // 按日期目录 + 文件名排序，保证每轮顺序一致（日志好读、diff 稳定）
  notes.sort((a, b) => a.path.localeCompare(b.path));
  return notes;
}

/**
 * 从仓库文件树里找出所有图片。
 *
 * @param {Array<{path: string, sha: string}>} tree 仓库文件树
 * @returns {Map<string, string>} 文件名 → sha
 */
export function findImageFiles(tree) {
  /** @type {Map<string, string>} */
  const images = new Map();
  for (const entry of tree) {
    if (!entry.path.startsWith('picData/')) continue;
    const filename = entry.path.slice('picData/'.length);
    // 只取单层文件名，忽略子目录
    if (filename === '' || filename.includes('/')) continue;
    images.set(filename, entry.sha);
  }
  return images;
}

/**
 * 解析 neno 笔记 JSON。
 *
 * @param {string} text JSON 文本
 * @returns {{id: string, content: string, pureContent: string, tags: string[],
 *   images: Array<{key: string, suffixName: string}>, createdAt: string}|null}
 *   解析失败返回 null（坏数据不该让整轮同步崩掉）
 */
export function parseNoteJson(text) {
  /** @type {any} */
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  // ⚠️ `typeof [] === 'object'` —— 数组不是合法的笔记，必须单独排除。
  // 不排除的话会返回一个全字段为空的对象，上层把它当成"空笔记"静默跳过，
  // 反而比直接报错更难查。
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;

  /** @type {Array<{key: string, suffixName: string}>} */
  const images = [];
  if (Array.isArray(raw.images)) {
    for (const item of raw.images) {
      const key = String(item?.key ?? '').trim();
      if (key === '') continue;
      // suffixName 可能带或不带前导点
      const suffix = String(item?.suffixName ?? 'png').trim().replace(/^\./, '');
      images.push({ key, suffixName: suffix === '' ? 'png' : suffix });
    }
  }

  return {
    id: String(raw._id ?? ''),
    content: String(raw.content ?? ''),
    pureContent: String(raw.pureContent ?? ''),
    tags: normalizeTags(raw.tags),
    images,
    createdAt: String(raw.created_at ?? raw.create_at ?? ''),
  };
}

/**
 * HTML → 纯文本 Markdown。
 *
 * ⚠️ 这是一个**刻意简化**的实现，不是完整的 HTML 转换器。
 * neno 的 `content` 是 Quill 生成的受限 HTML（只有 p / strong / em / u / s /
 * ol / ul / li / blockquote / pre / a / h1-h3），处理这几个标签足够。
 *
 * 为什么不复用 neno-obsidian-sync 里那套 902 行的转换器：那套还处理了
 * 图片占位、复杂嵌套表格等 Obsidian 特有需求，对 memos 是多余的。
 * 若将来发现转换质量不够，再把它搬过来即可 —— 接口已经隔离在这个函数里。
 *
 * @param {string} html 原始 HTML
 * @returns {string} Markdown 文本
 */
export function htmlToMarkdown(html) {
  let text = String(html ?? '');

  // 段落 → 双换行
  text = text.replace(/<\/p>\s*<p[^>]*>/gi, '\n\n');
  text = text.replace(/<p[^>]*>/gi, '');
  text = text.replace(/<\/p>/gi, '\n\n');

  // 换行标签
  text = text.replace(/<br\s*\/?>/gi, '\n');

  // 标题
  text = text.replace(/<h1[^>]*>(.*?)<\/h1>/gi, '\n# $1\n');
  text = text.replace(/<h2[^>]*>(.*?)<\/h2>/gi, '\n## $1\n');
  text = text.replace(/<h3[^>]*>(.*?)<\/h3>/gi, '\n### $1\n');

  // 行内样式
  text = text.replace(/<(strong|b)[^>]*>(.*?)<\/\1>/gi, '**$2**');
  text = text.replace(/<(em|i)[^>]*>(.*?)<\/\1>/gi, '*$2*');
  text = text.replace(/<(s|del|strike)[^>]*>(.*?)<\/\1>/gi, '~~$2~~');
  text = text.replace(/<u[^>]*>(.*?)<\/u>/gi, '$1');
  text = text.replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`');

  // 链接
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)');

  // 列表（Quill 的 li 带 data-list 属性）
  text = text.replace(/<li[^>]*data-list="bullet"[^>]*>/gi, '- ');
  text = text.replace(/<li[^>]*data-list="ordered"[^>]*>/gi, '1. ');
  text = text.replace(/<li[^>]*>/gi, '- ');
  text = text.replace(/<\/li>/gi, '\n');
  text = text.replace(/<\/?(ul|ol)[^>]*>/gi, '\n');

  // 引用与代码块
  text = text.replace(/<blockquote[^>]*>(.*?)<\/blockquote>/gis, (_, inner) => (
    String(inner).trim().split('\n').map((line) => `> ${line}`).join('\n')
  ));
  text = text.replace(/<pre[^>]*>(.*?)<\/pre>/gis, (_, inner) => `\n\`\`\`\n${String(inner).trim()}\n\`\`\`\n`);

  // 兜底：剥掉所有剩余标签
  text = text.replace(/<[^>]+>/g, '');

  // 解 HTML 实体（只处理最常见的几个，够用）
  const entities = {
    '&nbsp;': ' ',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&amp;': '&',
  };
  for (const [entity, char] of Object.entries(entities)) {
    text = text.split(entity).join(char);
  }

  // 收敛空行 + 去行尾空格
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 判断两个 resourceId 列表是否是同一个集合（顺序无关）。
 *
 * 为什么不用 `JSON.stringify` 比较：资源顺序由笔记里的图片顺序决定，
 * 用户调整图片顺序不该触发一次无意义的 PATCH；而集合相同就意味着附件区
 * 内容完全一致，不需要动。
 *
 * @param {unknown} left 旧列表
 * @param {unknown} right 新列表
 * @returns {boolean} 是否相同
 */
export function sameIdSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  /** @type {Set<number>} */
  const a = new Set(left.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0));
  /** @type {Set<number>} */
  const b = new Set(right.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0));
  if (a.size !== b.size) return false;
  for (const id of a) if (b.has(id) === false) return false;
  return true;
}

/**
 * 从 neno 的 `created_at` 取出 Unix 秒。
 *
 * neno 的格式是 `2026-10-29T09:35:29+08:00`（带时区），
 * 直接用 `Date.parse` 能正确处理。
 *
 * @param {string} value 时间字符串
 * @returns {number} Unix 秒；解析失败返回 0
 */
export function toSecondsTimestamp(value) {
  const text = String(value ?? '').trim();
  if (text === '') return 0;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return 0;
  return Math.floor(ms / 1000);
}

/**
 * 建一个同步器。
 *
 * @param {object} options 配置
 * @param {import('../request/gitProvider/base.mjs').GitProvider} options.provider 代码平台
 * @param {ReturnType<import('./client.mjs').createMemosClient>} options.client memos 客户端
 * @param {string} options.visibility memo 可见性
 * @param {object} options.state 状态（会被就地修改）
 * @param {(state: object) => Promise<void>} [options.persist] 状态落盘
 * @param {object} [options.log] 日志器
 * @returns {object} 同步器
 */
export function createSyncRunner({
  provider, client, visibility = 'PRIVATE', state, persist, log,
}) {
  /** 简易日志器（外部可替换） */
  const logger = log ?? {
    info: (message, extra) => console.log(`[sync] ${message}`, extra ?? ''),
    warn: (message, extra) => console.warn(`[sync] ${message}`, extra ?? ''),
    debug: () => {},
  };

  /**
   * 拿状态里的笔记条目（不存在就建一个）。
   *
   * @param {string} nenoId 笔记 id
   * @returns {any}
   */
  function entryOf(nenoId) {
    if (state.notes === undefined || state.notes === null) state.notes = {};
    if (state.notes[nenoId] === undefined) state.notes[nenoId] = {};
    return state.notes[nenoId];
  }

  /**
   * 确保一张图片已经上传到 memos，返回它的 resourceId。
   *
   * ## 缓存命中规则（三条，都有踩坑背景）
   *
   * 1. **有缓存 + extra 的 sha 与仓库一致** → 直接复用，不重传
   * 2. **有缓存 + 仓库里的 sha 变了** → 图被换过，必须重传
   * 3. **有缓存 + 仓库里根本没这个文件** → 仍然复用缓存
   *
   * 第 3 条容易被误认为 bug，其实是必需的：图已经躺在 memos 上了，
   * 本地源文件被人删掉不该导致 memo 掉图（memos 端才是用户实际看到的东西）。
   * 只有**从没上传成功过**的图才记 `missingImages`。
   *
   * 第 2 条里有个迁移细节：老状态文件没有 `sha` 字段。这时**信任缓存**，
   * 否则升级一次会把所有已上传的图全部重传一遍，既慢又在 memos 端留下垃圾。
   *
   * ## 失败必须留痕
   *
   * 不留痕的话，下一轮会因为"正文没变"而跳过整条笔记，
   * 等文件补进仓库也永远不会重传 —— 线上 memo #246 就是这么少了一张图。
   *
   * @param {string} nenoId 笔记 id
   * @param {{key: string, suffixName: string}} image 图片声明
   * @param {Map<string, string>} imageShas picData 文件名 → sha
   * @param {any} entry 映射条目
   * @returns {Promise<{resourceId: number, uploaded: boolean}>} 结果
   */
  async function ensureImage(nenoId, image, imageShas, entry) {
    const filename = `${image.key}.${image.suffixName}`;

    entry.images = entry.images !== null && typeof entry.images === 'object'
      && !Array.isArray(entry.images)
      ? entry.images
      : {};
    entry.missingImages = entry.missingImages !== null
      && typeof entry.missingImages === 'object'
      && !Array.isArray(entry.missingImages)
      ? entry.missingImages
      : {};

    const sha = imageShas.get(filename);
    const cached = entry.images[filename];

    if (cached !== undefined && Number.isSafeInteger(cached?.resourceId)) {
      const cachedSha = cached?.sha;
      const stillValid = cachedSha === undefined // 老状态文件：信任缓存
        || sha === undefined // 源文件已不在仓库：图已经在 memos 上，保留
        || cachedSha === sha;
      if (stillValid) {
        delete entry.missingImages[filename];
        return { resourceId: Number(cached.resourceId), uploaded: false };
      }
      // sha 变了 → 图被替换过，落到下面重传
      logger.debug?.(`图片内容已变，重传：${filename}`, { nenoId });
    }

    if (sha === undefined) {
      // 笔记声明了这张图，但 picData 里没有，且从没上传过 → 记下来，下轮继续试
      entry.missingImages[filename] = 'not_in_repo';
      logger.warn(`图片在仓库里不存在：picData/${filename}`, { nenoId });
      return { resourceId: 0, uploaded: false };
    }

    try {
      const bytes = await provider.getBlob(sha);
      const uploadedResponse = await client.uploadResource({
        filename,
        bytes,
        contentType: undefined,
      });
      const resourceId = pickNumericId(uploadedResponse);
      if (resourceId === 0) throw new MemosError('上传响应里没有 resource id', { code: 'server' });

      entry.images[filename] = {
        resourceId,
        sha,
        url: buildResourceUrl(client.baseUrl, resourceId, uploadedResponse),
      };
      delete entry.missingImages[filename];
      return { resourceId, uploaded: true };
    } catch (error) {
      entry.missingImages[filename] = `upload_failed:${error.message}`;
      logger.warn(`图片上传失败：${filename}（${error.message}）`, { nenoId });
      return { resourceId: 0, uploaded: false };
    }
  }

  return {
    /**
     * 跑一轮同步。
     *
     * @returns {Promise<object>} 统计
     */
    async run() {
      const stats = {
        notes: 0, created: 0, updated: 0, unchanged: 0,
        skipped: 0, imagesUploaded: 0, timesFixed: 0,
        imagesPending: 0, orphaned: 0, errors: [],
      };

      // ── 1. 读仓库 ──
      const repo = await provider.getRepo();
      const branch = repo.defaultBranch;
      const head = await provider.getHead(branch);
      const tree = await provider.getTree(head.oid);
      const noteFiles = findNoteFiles(tree);
      const imageShas = findImageFiles(tree);
      const aliveIds = new Set(noteFiles.map((item) => item.noteId));

      stats.notes = noteFiles.length;
      logger.info(`发现 ${noteFiles.length} 条笔记、${imageShas.size} 张图片`, { branch });

      // ── 2. 逐条推送 ──
      for (const file of noteFiles) {
        try {
          const raw = await provider.getBlob(file.sha);
          const note = parseNoteJson(new TextDecoder().decode(raw));
          if (note === null) {
            stats.errors.push(`笔记 JSON 解析失败：${file.path}`);
            logger.warn(`笔记 JSON 解析失败，跳过：${file.path}`);
            stats.skipped += 1;
            continue;
          }

          const entry = entryOf(file.noteId);
          // ⚠️ 必须在循环**之前**采样：ensureImage 成功后会把 missingImages 清空，
          // 若放在之后采样，这一轮就会被判成"未变化"而跳过 patch，
          // 导致刚补上的图片挂不进 resourceIdList（曾真实踩过）。
          const hadMissingImages = Object.keys(entry.missingImages ?? {}).length > 0;

          // 图片（幂等）
          /** @type {number[]} */
          const resourceIdList = [];
          for (const image of note.images) {
            const result = await ensureImage(file.noteId, image, imageShas, entry);
            if (result.resourceId > 0) resourceIdList.push(result.resourceId);
            if (result.uploaded) stats.imagesUploaded += 1;
          }

          // 正文：图片绝不写进去（见 content.mjs）
          const body = htmlToMarkdown(note.content);
          const content = buildMemoContent({ body, tags: note.tags });
          const createdTs = toSecondsTimestamp(note.createdAt);
          const fingerprint = contentFingerprint(content, visibility);

          // 空正文且无图 → 没有意义，跳过
          if (content.trim() === '' && resourceIdList.length === 0) {
            stats.skipped += 1;
            continue;
          }

          const bytes = new TextEncoder().encode(content).length;
          if (bytes > MAX_CONTENT_BYTES) {
            stats.errors.push(`笔记内容过大（${bytes} 字节）：${file.path}`);
            stats.skipped += 1;
            continue;
          }

          // ── 决定是否要写 ──
          const memoId = Number(entry?.memoId ?? 0);
          const declaredFilenames = new Set(note.images.map((img) => `${img.key}.${img.suffixName}`));
          // 全量覆盖语义：仍被声明的图用缓存 sha 兜住，删掉的图不传（实现解绑）
          const fullResourceIds = [...new Set([
            ...resourceIdList,
            ...Object.entries(entry.images ?? {})
              .filter(([filename]) => declaredFilenames.has(filename))
              .map(([, cached]) => Number(cached?.resourceId))
              .filter((id) => Number.isSafeInteger(id) && id > 0),
          ])];

          // ⚠️ 必须比较**集合**，不能只判 `!Array.isArray(entry.resourceIds)`。
          // 否则「笔记里删掉一张图」这种变化（[1,2] → [1]）永远检测不到，
          // 附件区会一直挂着一张已经不该存在的图。
          const sameResourceSet = sameIdSet(entry.resourceIds, fullResourceIds);
          const unchanged = Number.isSafeInteger(memoId) && memoId > 0
            && entry.contentHash === fingerprint
            && sameResourceSet === true
            && hadMissingImages === false
            && entry.orphanedAt === undefined;

          if (unchanged) {
            stats.unchanged += 1;
            continue;
          }

          // 曾因源文件短暂消失被标记为孤儿、现在又回来了 → 复用原 memo，不新建
          if (entry.orphanedAt !== undefined) {
            delete entry.orphanedAt;
            logger.info('笔记重新出现，复用原 memo', { nenoId: file.noteId, memoId });
          }

          if (Number.isSafeInteger(memoId) && memoId > 0) {
            // ── 更新 ──
            await client.patchMemo(memoId, {
              content,
              visibility,
              createdTs,
              resourceIdList: fullResourceIds,
            });
            entry.contentHash = fingerprint;
            entry.createdTs = createdTs;
            entry.resourceIds = fullResourceIds;
            entry.updatedAt = new Date().toISOString();
            stats.updated += 1;
            logger.info('memo 已更新', { memoId });
          } else {
            // ── 新建 ──
            const created = await client.createMemo({
              content,
              visibility,
              createdTs,
              resourceIdList: fullResourceIds,
            });
            const newMemoId = pickNumericId(created);
            if (newMemoId === 0) {
              stats.errors.push(`创建成功但解析不出 id：${file.path}`);
              continue;
            }

            // ★ 必须补 patch：POST 忽略 createdTs（见 client.mjs 文件头）
            const actualTs = Number(created?.createdTs ?? 0);
            if (createdTs > 0 && actualTs !== createdTs) {
              try {
                await client.patchMemo(newMemoId, { createdTs });
                stats.timesFixed += 1;
              } catch (error) {
                stats.errors.push(`时间校正失败（memo ${newMemoId}）：${error.message}`);
              }
            }

            entry.memoId = newMemoId;
            entry.contentHash = fingerprint;
            entry.createdTs = createdTs;
            entry.resourceIds = fullResourceIds;
            entry.updatedAt = new Date().toISOString();
            stats.created += 1;
            logger.info('memo 已创建', { memoId: newMemoId });
          }

          if (typeof persist === 'function') await persist(state);
        } catch (error) {
          stats.errors.push(`${file.path}：${error.message}`);
          logger.warn(`笔记同步失败：${file.path}（${error.message}）`);
        }
      }

      // ── 3. 笔记从代码平台消失：标记孤儿，但绝不删映射 ──
      //
      // ⚠️ 这里**不能** `delete state.notes[nenoId]`。理由有两个：
      //
      //   1. 单向只读语义：memo 已经推到 memos 了，用户可能还在看它。
      //      我们只管"增改"，删不删由用户在 memos 决定。
      //   2. 更危险的是**重复建**：万一某次 getTree 拿到的是不完整的树
      //      （Gitea 的 truncated、网络抖动），所有笔记都会被误判成"已删除"，
      //      映射一清，下一轮就会把每一条都重新建一遍，memos 里瞬间翻倍。
      //
      // 所以只打标记。笔记若重新出现，靠 memoId 复用原 memo（见上面的处理）。
      for (const nenoId of Object.keys(state.notes ?? {})) {
        if (aliveIds.has(nenoId)) continue;
        const entry = state.notes[nenoId];
        if (entry === null || typeof entry !== 'object') continue;
        if (entry.orphanedAt !== undefined) continue;

        entry.orphanedAt = new Date().toISOString();
        stats.orphaned += 1;
        logger.info('笔记已从代码平台移除，memos 端保持不动（单向只读）', {
          nenoId, memoId: Number(entry.memoId ?? 0),
        });
        if (typeof persist === 'function') await persist(state);
      }

      // ── 4. 统计仍缺图的条数 ──
      stats.imagesPending = Object.values(state.notes ?? {}).filter((entry) => {
        const missing = entry?.missingImages;
        return missing !== null && typeof missing === 'object'
          && Object.keys(missing).length > 0;
      }).length;

      return stats;
    },
  };
}
