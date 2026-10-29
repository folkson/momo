/**
 * 内容构造层的测试（`src/memos/content.mjs`）。
 *
 * ## 这个文件守的是什么
 *
 * 三条规则每一条都对应一次线上事故：
 *
 *   1. 图片不进正文 → 否则 memos 显示两张（已发生过）
 *   2. 标签不重复追加 → 否则同一条 memo 里标签出现两遍
 *   3. 指纹必须包含 visibility → 否则改了可见性永远同步不过去
 *
 * 另外还有一个隐蔽的风险点：`sha256Hex` 是**手写**的纯 JS 实现
 * （为了不依赖 node:crypto，让浏览器端能跑）。手写哈希最容易犯的错是
 * 只在自己测过的那个长度上正确。所以这里用 node:crypto 做逐位对拍，
 * 覆盖各种边界长度（0/1/55/56/63/64/65/127/128 字节都是 SHA-256 的补位边界）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { normalizeTags, buildMemoContent, contentFingerprint } from '../src/memos/content.mjs';

/**
 * 用 node:crypto 算参考值。
 *
 * @param {string} text 输入
 * @returns {string} 十六进制
 */
function referenceSha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

test('sha256 与 node:crypto 在各补位边界上逐位一致', () => {
  // 这些长度正好落在 SHA-256 补位算法的分界上：
  // 0 字节、1 字节、55/56（是否要额外一块）、63/64/65（跨块）、127/128/129
  const lengths = [0, 1, 2, 3, 55, 56, 57, 63, 64, 65, 119, 127, 128, 129, 1000];

  for (const length of lengths) {
    // 用可打印字符构造，避免多字节字符干扰"字节长度"的判断
    const text = 'a'.repeat(length);
    const actual = contentFingerprint(text, 'x').slice('sha256:'.length);
    assert.equal(
      actual,
      referenceSha256(`x\n${text}`),
      `长度 ${length} 的输入哈希不一致`,
    );
  }
});

test('sha256 正确处理多字节字符（UTF-8 而非 UTF-16）', () => {
  const text = '中文 emoji 🎉 café';
  const actual = contentFingerprint(text, 'x').slice('sha256:'.length);
  assert.equal(actual, referenceSha256(`x\n${text}`));
});

test('normalizeTags 去 #、去空、去重（大小写不敏感）', () => {
  assert.deepEqual(normalizeTags(['#生活', '生活', '##工作', '', '  ']), ['生活', '工作']);
  assert.deepEqual(normalizeTags(['Work', 'work', 'WORK']), ['Work'], '大小写不同算重复');
  assert.deepEqual(normalizeTags('a, b  c，d'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(normalizeTags(null), []);
  assert.deepEqual(normalizeTags(undefined), []);
  assert.deepEqual(normalizeTags(123), []);
  assert.deepEqual(normalizeTags([null, 42, 'ok']), ['ok']);
});

test('buildMemoContent 把正文与标签拼起来', () => {
  assert.equal(buildMemoContent({ body: '正文', tags: ['生活'] }), '正文\n\n#生活');
  assert.equal(buildMemoContent({ body: '正文' }), '正文');
  assert.equal(buildMemoContent({ body: '正文', tags: [] }), '正文');
});

test('buildMemoContent 不重复追加正文里已有的标签', () => {
  // 正文已经有 #生活，就不该再追加一遍
  const content = buildMemoContent({ body: '今天很开心 #生活', tags: ['生活'] });
  assert.equal(content, '今天很开心 #生活');
  assert.equal(content.match(/#生活/g).length, 1);

  // 只有缺失的那个才补
  assert.equal(
    buildMemoContent({ body: '正文 #生活', tags: ['生活', '随手记'] }),
    '正文 #生活\n\n#随手记',
  );
});

test('buildMemoContent 收敛连续空行（HTML 转换常留 3+ 换行）', () => {
  assert.equal(buildMemoContent({ body: 'a\n\n\n\n\nb' }), 'a\n\nb');
});

test('contentFingerprint 让 visibility 参与计算', () => {
  const a = contentFingerprint('同样的正文', 'PRIVATE');
  const b = contentFingerprint('同样的正文', 'PUBLIC');

  assert.notEqual(a, b, '可见性变了，指纹必须变，否则永远同步不过去');
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
  // 同样输入必须稳定
  assert.equal(a, contentFingerprint('同样的正文', 'PRIVATE'));
});

test('contentFingerprint 对 visibility 与正文的边界不会混淆', () => {
  // 如果把两者直接拼接，("ab","c") 和 ("a","bc") 会算出同一个哈希 —— 必须避免
  const a = contentFingerprint('c', 'ab');
  const b = contentFingerprint('bc', 'a');
  assert.notEqual(a, b, '不能用裸拼接，必须用分隔符隔离字段');
});
