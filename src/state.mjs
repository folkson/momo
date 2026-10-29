/**
 * 同步状态的读写。
 *
 * ## 为什么单独一个文件
 *
 * 状态文件是**幂等的唯一根基**（见 sync.mjs 文件头）。它的读写必须满足两条：
 *
 *   1. **原子写入** —— 中途崩溃不能留下半截 JSON，否则下一轮解析失败，
 *      整轮同步会退化成"全部重新建"，memos 端瞬间翻倍。
 *   2. **能容忍不存在** —— 首次运行没有这个文件是正常的。
 *
 * 用的是「写临时文件 → rename」这个经典做法：`rename` 在同一文件系统内
 * 是原子的，读者要么看到旧的完整内容，要么看到新的完整内容。
 */
import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { dirname, resolve, basename, join } from 'node:path';

/** 状态文件的默认文件名。 */
export const DEFAULT_STATE_FILENAME = '.memos-map.json';

/**
 * 建一个空状态。
 *
 * `version` 用于将来做迁移：老状态没有 `images[].sha` 字段，
 * sync.mjs 会靠"缺失即信任缓存"兼容，不需要改 version。
 *
 * @returns {{version: number, notes: Record<string, any>}}
 */
export function emptyState() {
  return { version: 1, notes: {} };
}

/**
 * 读状态文件。文件不存在或内容坏掉时返回空状态。
 *
 * ⚠️ 内容坏掉时**返回空状态而不是抛错** —— 抛错会让定时任务每天都失败，
 * 而返回空状态最多是浪费一轮（把已有 memo 重新建一遍……这其实很糟）。
 * 所以坏文件先备份再重置，并在返回值里标记，让调用方能提示用户。
 *
 * @param {string} filePath 状态文件路径
 * @returns {Promise<{state: object, recovered: boolean, backupPath: string|null}>}
 */
export async function loadState(filePath) {
  const absolute = resolve(filePath);

  /** @type {string} */
  let text;
  try {
    text = await readFile(absolute, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { state: emptyState(), recovered: false, backupPath: null };
    }
    throw error;
  }

  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 坏文件：先留个备份，再重置。绝不能静默覆盖 —— 里面可能有几百条映射
    const backupPath = `${absolute}.corrupt-${Date.now()}`;
    try {
      await writeFile(backupPath, text, 'utf8');
    } catch {
      // 备份失败也不该阻断流程
    }
    return { state: emptyState(), recovered: true, backupPath };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { state: emptyState(), recovered: true, backupPath: null };
  }
  if (parsed.notes === null || typeof parsed.notes !== 'object' || Array.isArray(parsed.notes)) {
    parsed.notes = {};
  }
  if (Number.isFinite(parsed.version) === false) parsed.version = 1;

  return { state: parsed, recovered: false, backupPath: null };
}

/**
 * 原子地写状态文件。
 *
 * @param {string} filePath 目标路径
 * @param {object} state 状态对象
 * @returns {Promise<void>}
 */
export async function saveState(filePath, state) {
  const absolute = resolve(filePath);
  const dir = dirname(absolute);
  await mkdir(dir, { recursive: true });

  // 临时文件放在同目录 —— 跨文件系统的 rename 不是原子的，会退化成一个复制
  const tempPath = join(dir, `.${basename(absolute)}.tmp-${process.pid}`);
  const text = `${JSON.stringify(state, null, 2)}\n`;

  await writeFile(tempPath, text, 'utf8');
  try {
    await rename(tempPath, absolute);
  } catch (error) {
    // rename 失败时清掉临时文件，避免在仓库里留垃圾
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

/**
 * 把状态整理成「按笔记 id 排序」的形态，便于 diff 阅读。
 *
 * `.memos-map.json` 通常会被提交进仓库，key 顺序稳定能让每次 diff 只
 * 显示真正变化的条目。
 *
 * @param {object} state 状态
 * @returns {object} 排序后的副本
 */
export function sortState(state) {
  /** @type {Record<string, any>} */
  const notes = {};
  for (const id of Object.keys(state.notes ?? {}).sort()) {
    notes[id] = state.notes[id];
  }
  return { ...state, notes };
}
