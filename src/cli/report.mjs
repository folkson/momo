/**
 * 统计输出。
 *
 * ## 为什么用 KEY=VALUE 而不是 JSON
 *
 * 这个输出会被 shell 脚本 / GitHub Actions / cron 的 `$(...)` 直接消费。
 * JSON 需要 jq，KEY=VALUE 用 `grep` + `cut` 就能取，对运维更友好
 * （也是 GitHub Actions 的 `$GITHUB_OUTPUT` 格式）。
 *
 * 人类读的日志走 stderr，两者互不干扰。
 */

/**
 * 渲染统计。
 *
 * @param {object} stats 同步统计
 * @param {{dryRun?: boolean}} [options] 选项
 * @returns {string} 以换行结尾的输出
 */
export function renderStats(stats, options = {}) {
  const dryRun = options.dryRun === true;
  /** @type {string[]} */
  const lines = [];

  lines.push('ok=true');
  if (dryRun) lines.push('dry_run=true');

  lines.push(`notes=${stats.notes ?? 0}`);
  lines.push(`created=${stats.created ?? 0}`);
  lines.push(`updated=${stats.updated ?? 0}`);
  lines.push(`unchanged=${stats.unchanged ?? 0}`);
  lines.push(`skipped=${stats.skipped ?? 0}`);
  lines.push(`images_uploaded=${stats.imagesUploaded ?? 0}`);
  lines.push(`images_pending=${stats.imagesPending ?? 0}`);
  lines.push(`times_fixed=${stats.timesFixed ?? 0}`);
  lines.push(`orphaned=${stats.orphaned ?? 0}`);
  lines.push(`errors=${(stats.errors ?? []).length}`);

  // 错误详情也铺出来，方便直接 grep 到失败原因
  for (const error of stats.errors ?? []) {
    lines.push(`error=${String(error).replace(/\n/g, ' ')}`);
  }

  return `${lines.join('\n')}\n`;
}

/**
 * 渲染一行人类可读的摘要。
 *
 * @param {object} stats 统计
 * @returns {string}
 */
export function renderSummary(stats) {
  const parts = [
    `笔记 ${stats.notes ?? 0}`,
    `新建 ${stats.created ?? 0}`,
    `更新 ${stats.updated ?? 0}`,
    `未变 ${stats.unchanged ?? 0}`,
  ];
  if ((stats.skipped ?? 0) > 0) parts.push(`跳过 ${stats.skipped}`);
  if ((stats.imagesUploaded ?? 0) > 0) parts.push(`传图 ${stats.imagesUploaded}`);
  if ((stats.imagesPending ?? 0) > 0) parts.push(`缺图待重试 ${stats.imagesPending}`);
  if ((stats.orphaned ?? 0) > 0) parts.push(`孤儿 ${stats.orphaned}`);
  if ((stats.errors ?? []).length > 0) parts.push(`错误 ${stats.errors.length}`);
  return parts.join(' | ');
}
