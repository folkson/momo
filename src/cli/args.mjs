/**
 * 极简参数解析。
 *
 * 为什么不用 commander / yargs：整个项目坚持**零运行时依赖**（见 README）。
 * 需要的能力只有"子命令 + `--key=value` + 布尔开关"，手写 30 行就够，
 * 没必要为此引入一棵依赖树。
 */

/**
 * 解析后的命令。
 */
export class Command {
  /**
   * @param {string[]} argv 参数（不含 node 与脚本路径）
   */
  constructor(argv) {
    /** @type {string|null} 子命令 */
    this.command = null;
    /** @type {Map<string, string|true>} 选项 */
    this.options = new Map();

    for (const token of argv) {
      if (token.startsWith('--')) {
        const body = token.slice(2);
        const eq = body.indexOf('=');
        if (eq === -1) {
          this.options.set(body, true);
        } else {
          this.options.set(body.slice(0, eq), body.slice(eq + 1));
        }
        continue;
      }
      if (token.startsWith('-') && token.length > 1) {
        // 短选项一律当布尔开关，不做组合解析（用不上）
        this.options.set(token.slice(1), true);
        continue;
      }
      if (this.command === null) this.command = token;
    }
  }

  /**
   * 是否有某个选项（且不为 false 字符串）。
   *
   * @param {string} name 选项名（不带 `--`）
   * @returns {boolean}
   */
  has(name) {
    const value = this.options.get(name);
    if (value === undefined) return false;
    if (value === 'false') return false;
    return true;
  }

  /**
   * 取选项值。
   *
   * @param {string} name 选项名
   * @param {string|null} [fallback] 默认值
   * @returns {string|null}
   */
  value(name, fallback = null) {
    const value = this.options.get(name);
    if (value === undefined || value === true) return fallback;
    return value;
  }
}
