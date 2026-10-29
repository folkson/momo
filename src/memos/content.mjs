/**
 * 笔记内容 → memos memo 正文的构造规则。
 *
 * 这个文件是从 neno-obsidian-sync 里已经跑通线上、有 357 个测试背书的实现
 * 提炼出来的**纯函数部分**。抽出来的原因是：那些结论（尤其"图片不能写进正文"）
 * 每一条都是踩过坑换来的，重写一遍必然重踩。
 *
 * ## 三条不可动摇的规则
 *
 * ### 1. 图片**绝不**写进正文
 *
 * memos 有两条独立的图片渲染通道：
 *   · `resourceIdList` / `resourceList` —— 附件区，前端自动渲染
 *   · 正文里的 `![](url)` —— 按 Markdown 渲染
 *
 * 两边都做 = 同一张图显示两遍。线上实测用户手工发的 11 条带图笔记，
 * `resourceList` 有 1~5 个附件，正文内 `![]()` 数量**全部为 0**。
 * 这是 memos 自己的标准做法。
 *
 * ### 2. 标签只补正文里没有的
 *
 * neno 的 `tags` 字段通常和正文里的 `#标签` 重复（标签本来就是从正文抽的）。
 * 无条件追加会让同一条 memo 里出现两遍同样的标签。
 *
 * ### 3. 空正文 + 无图 = 跳过
 *
 * 但判据必须是「已上传成功的图片数」，**不是**正文内容 ——
 * 因为图片只走附件通道，正文永远为空。用正文判断会把"只有图没写字"的
 * 笔记整条丢掉。
 */

/**
 * 规范化标签：去掉前导 `#`、去空、去重（大小写不敏感）。
 *
 * @param {unknown} tags 原始标签（可能是数组、字符串或 null）
 * @returns {string[]} 规范化后的标签（不带 `#`）
 */
export function normalizeTags(tags) {
  /** @type {unknown[]} */
  let list;
  if (Array.isArray(tags)) {
    list = tags;
  } else if (typeof tags === 'string') {
    // 兼容 "a, b  c" 这种写法
    list = tags.split(/[,，\s]+/);
  } else {
    return [];
  }

  /** @type {string[]} */
  const result = [];
  /** @type {Set<string>} */
  const seen = new Set();

  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    // 去掉所有前导 # 和首尾空白
    const text = raw.replace(/^#+/, '').trim();
    if (text === '') continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }

  return result;
}

/**
 * 构造 memo 正文。
 *
 * @param {object} params 参数
 * @param {string} params.body 正文 Markdown
 * @param {string[]|string} [params.tags] 标签
 * @returns {string} 完整的 memo 正文
 */
export function buildMemoContent({ body, tags = [] } = {}) {
  const text = String(body ?? '').trim();
  /** @type {string[]} */
  const sections = [];
  if (text !== '') sections.push(text);

  const cleanTags = normalizeTags(tags);
  if (cleanTags.length > 0) {
    // 只补正文里没出现过的，避免一条 memo 里同一标签出现两遍
    const missing = cleanTags.filter((tag) => !text.includes(`#${tag}`));
    if (missing.length > 0) sections.push(missing.map((tag) => `#${tag}`).join(' '));
  }

  // 收敛连续空行：HTML 转 Markdown 常留 3+ 换行
  return sections.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 正文内容指纹，用于判断"是否真的变了"。
 *
 * `visibility` 也参与计算：可见性从 PRIVATE 改成 PUBLIC 时正文没变，
 * 但 memos 里必须真的更新，所以它必须影响指纹。
 *
 * @param {string} content memo 正文
 * @param {string} visibility 可见性
 * @returns {string} `sha256:<hex>`
 */
export function contentFingerprint(content, visibility) {
  // 用同步的字符串哈希，避免引入 node:crypto（浏览器端也要能跑）
  const text = `${String(visibility ?? '')}\n${String(content ?? '')}`;
  return `sha256:${sha256Hex(text)}`;
}

/**
 * 纯 JS 的 SHA-256（不依赖 node:crypto）。
 *
 * 为什么自己写：这个模块要能在浏览器和 Node 里都跑（neno 本身是前端应用）。
 * 引入 node:crypto 会让浏览器端必须打 polyfill，得不偿失。
 *
 * @param {string} text UTF-8 文本
 * @returns {string} 64 位十六进制
 */
function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  let H = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];

  // 补位：0x80 + 若干 0x00，末尾 8 字节放原始比特长度（大端）
  const bitLength = bytes.length * 8;
  const withPadding = new Uint8Array(
    (((bytes.length + 8) >> 6) + 1) << 6,
  );
  withPadding.set(bytes);
  withPadding[bytes.length] = 0x80;
  // 长度写进最后 8 字节（这里只支持 < 2^32 bit，笔记内容远超不了）
  const view = new DataView(withPadding.buffer);
  view.setUint32(withPadding.length - 4, bitLength >>> 0, false);
  view.setUint32(withPadding.length - 8, Math.floor(bitLength / 0x100000000), false);

  const w = new Uint32Array(64);

  for (let offset = 0; offset < withPadding.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = H;

    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g; g = f; f = e;
      e = (d + temp1) >>> 0;
      d = c; c = b; b = a;
      a = (temp1 + temp2) >>> 0;
    }

    H = [
      (H[0] + a) >>> 0, (H[1] + b) >>> 0, (H[2] + c) >>> 0, (H[3] + d) >>> 0,
      (H[4] + e) >>> 0, (H[5] + f) >>> 0, (H[6] + g) >>> 0, (H[7] + h) >>> 0,
    ];
  }

  return H.map((value) => value.toString(16).padStart(8, '0')).join('');
}

/**
 * 32 位右旋。
 *
 * @param {number} value 输入
 * @param {number} bits 位数
 * @returns {number} 结果
 */
function rotr(value, bits) {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}
