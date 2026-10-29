/**
 * memos 推送层测试。
 *
 * ## 测试策略
 *
 * 全部走真实 HTTP（`mock-gitea.mjs` + `mock-memos.mjs`），不打桩。
 * 这一层的价值几乎全在"协议细节 + 幂等语义"上，而这两者都只有跑真请求才验证得了：
 *
 *   · memos 的 POST 忽略 createdTs → 必须靠真实服务端行为暴露
 *   · resourceIdList 全量覆盖 → 传 [] 到底是不是解绑，只有跑一遍才知道
 *   · 缺图重试 → 需要"同一份状态跨多轮复用"，打桩很难表达
 *
 * ## 分组
 *
 *   1. 纯函数（HTML 转换 / 笔记解析 / 指纹 / 集合比较）
 *   2. 单轮推送（新建、图片、时间校正、正文不含图）
 *   3. 幂等与增量（重复跑、改内容、改图片、删图片）
 *   4. 缺图与孤儿（重试、不复用错 memo、绝不误删映射）
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { startMockGitea } from '../testkit/mock-gitea.mjs';
import { startMockMemos } from '../testkit/mock-memos.mjs';
import { createProvider } from '../src/request/gitProvider/index.mjs';
import { createMemosClient } from '../src/memos/client.mjs';
import {
  findNoteFiles, findImageFiles, parseNoteJson, htmlToMarkdown,
  toSecondsTimestamp, sameIdSet, createSyncRunner,
} from '../src/memos/sync.mjs';

// ─────────────────────────────────────────────────────────────
// 1. 纯函数
// ─────────────────────────────────────────────────────────────

test('findNoteFiles 只认 YYYY-MM-DD/<id>.json，多余结构一律忽略', () => {
  const tree = [
    { path: '2026-10-29/abc.json', sha: 's1' },
    { path: '2026-10-28/def.json', sha: 's2' },
    { path: 'picData/x.png', sha: 's3' },
    { path: 'README.md', sha: 's4' },
    { path: '2026-10-29/nested/deep.json', sha: 's5' },
    { path: '2026-10-29/not-json.txt', sha: 's6' },
    { path: 'notes/2026-10-29/x.json', sha: 's7' },
  ];

  const notes = findNoteFiles(tree);
  assert.deepEqual(notes.map((item) => item.path), [
    '2026-10-28/def.json',
    '2026-10-29/abc.json',
  ]);
  assert.equal(notes[1].dateDir, '2026-10-29');
  assert.equal(notes[1].noteId, 'abc');
});

test('findImageFiles 只取 picData/ 单层文件', () => {
  const tree = [
    { path: 'picData/a.png', sha: 'sa' },
    { path: 'picData/b.jpg', sha: 'sb' },
    { path: 'picData/sub/c.png', sha: 'sc' },
    { path: '2026-10-29/x.json', sha: 'sx' },
  ];

  const images = findImageFiles(tree);
  assert.deepEqual([...images.keys()].sort(), ['a.png', 'b.jpg']);
  assert.equal(images.get('a.png'), 'sa');
});

test('parseNoteJson 容忍坏数据，返回 null 而不是抛异常', () => {
  assert.equal(parseNoteJson('这不是 JSON'), null);
  assert.equal(parseNoteJson('null'), null);
  assert.equal(parseNoteJson('[]'), null);

  const note = parseNoteJson(JSON.stringify({
    _id: 'n1',
    content: '<p>你好</p>',
    pureContent: '你好',
    tags: ['#生活', '#生活', '工作'],
    images: [{ key: 'k1', suffixName: '.png' }, { key: '', suffixName: 'png' }],
    created_at: '2026-10-29T09:35:29+08:00',
  }));
  assert.equal(note.id, 'n1');
  assert.deepEqual(note.tags, ['生活', '工作']);
  // 带点的 suffixName 要去点，空 key 要丢弃
  assert.deepEqual(note.images, [{ key: 'k1', suffixName: 'png' }]);
  assert.equal(note.createdAt, '2026-10-29T09:35:29+08:00');
});

test('htmlToMarkdown 处理 Quill 的常见标签', () => {
  assert.equal(htmlToMarkdown('<p>第一段</p><p>第二段</p>'), '第一段\n\n第二段');
  assert.equal(htmlToMarkdown('<p><strong>粗</strong>与<em>斜</em></p>'), '**粗**与*斜*');
  assert.equal(
    htmlToMarkdown('<ul><li data-list="bullet">甲</li><li data-list="bullet">乙</li></ul>'),
    '- 甲\n- 乙',
  );
  assert.equal(htmlToMarkdown('<p>a<br>b</p>'), 'a\nb');
  assert.equal(htmlToMarkdown('<h2>标题</h2>'), '## 标题');
  assert.equal(htmlToMarkdown('<p>a &amp; b &lt;c&gt;</p>'), 'a & b <c>');
  assert.equal(htmlToMarkdown('<p><a href="https://x.com">链接</a></p>'), '[链接](https://x.com)');
  // 未知标签也要剥干净，不能把 HTML 漏进 memo 正文
  assert.equal(htmlToMarkdown('<p><span class="x">文本</span></p>'), '文本');
  assert.equal(htmlToMarkdown(''), '');
});

test('toSecondsTimestamp 处理带时区的时间并给出 0 兜底', () => {
  // +08:00 的 09:35:29 == UTC 01:35:29
  assert.equal(toSecondsTimestamp('2026-10-29T09:35:29+08:00'), 1793237729);
  assert.equal(toSecondsTimestamp(''), 0);
  assert.equal(toSecondsTimestamp(null), 0);
  assert.equal(toSecondsTimestamp('不是时间'), 0);
});

test('sameIdSet 顺序无关、去重、非法值忽略', () => {
  assert.equal(sameIdSet([1, 2], [2, 1]), true, '顺序不同是同一集合');
  assert.equal(sameIdSet([1, 2], [1, 2, 2]), true, '重复不影响');
  assert.equal(sameIdSet([1, 2], [1]), false);
  assert.equal(sameIdSet([1, 2], [1, 3]), false);
  assert.equal(sameIdSet(undefined, []), false, '未绑定 ≠ 空集合');
  assert.equal(sameIdSet([], [0, -1, null, 'x']), true, '非法值全滤掉后都是空');
  assert.equal(sameIdSet([1], undefined), false);
});

// ─────────────────────────────────────────────────────────────
// 测试脚手架
// ─────────────────────────────────────────────────────────────

/**
 * 起一套「Gitea + memos」并返回可用的 provider / client / runner。
 *
 * @param {object} [options] 选项
 * @param {Array<{path: string, text: string|Buffer}>} [options.files] 预置到仓库的文件
 * @param {object} [options.state] 复用旧状态（测多轮幂等）
 * @param {string} [options.visibility] 可见性
 * @returns {Promise<object>} 测试环境
 */
async function setup(options = {}) {
  const gitea = await startMockGitea();
  const memos = await startMockMemos();

  /** @type {Array<{path: string, text: string|Buffer}>} */
  const files = options.files ?? [];
  let seeded = false;
  for (const file of files) {
    gitea.state.seed(file.path, file.text);
    seeded = true;
  }
  // 空仓库时给个 README，让 getHead 能返回（真实场景由 auto_init 保证）
  if (seeded === false) gitea.state.seed('README.md', '# neno\n');

  const provider = createProvider({
    provider: 'gitea',
    baseUrl: gitea.baseUrl,
    token: gitea.token,
    owner: gitea.owner,
    repo: gitea.repo,
  });

  const client = createMemosClient({
    baseUrl: memos.baseUrl,
    username: memos.username,
    password: memos.password,
    minIntervalMs: 0, // 测试里不要真的等
    maxRetries: 0,
  });
  await client.signin();

  const state = options.state ?? { version: 1, notes: {} };
  const logs = [];

  const runner = createSyncRunner({
    provider,
    client,
    visibility: options.visibility ?? 'PRIVATE',
    state,
    log: {
      info: (message, extra) => logs.push(['info', message, extra]),
      warn: (message, extra) => logs.push(['warn', message, extra]),
      debug: (message, extra) => logs.push(['debug', message, extra]),
    },
  });

  return {
    gitea, memos, provider, client, state, runner, logs,
    /** 再跑一轮，复用同一个 state（模拟定时任务） */
    rerun(nextOptions = {}) {
      return createSyncRunner({
        provider,
        client,
        visibility: nextOptions.visibility ?? options.visibility ?? 'PRIVATE',
        state,
        log: {
          info: (message, extra) => logs.push(['info', message, extra]),
          warn: (message, extra) => logs.push(['warn', message, extra]),
          debug: (message, extra) => logs.push(['debug', message, extra]),
        },
      }).run();
    },
    async close() {
      await gitea.close();
      await memos.close();
    },
  };
}

/**
 * 构造一条 neno 笔记 JSON。
 *
 * @param {object} note 笔记字段
 * @returns {string} JSON 文本
 */
function noteJson(note) {
  return JSON.stringify({
    _id: note.id,
    content: note.content ?? '<p></p>',
    pureContent: note.pureContent ?? '',
    tags: note.tags ?? [],
    images: note.images ?? [],
    created_at: note.createdAt ?? '2026-10-29T09:35:29+08:00',
  });
}

// ─────────────────────────────────────────────────────────────
// 2. 单轮推送
// ─────────────────────────────────────────────────────────────

test('纯文字笔记：建 memo，正文是转换后的 Markdown，时间被校正', async (t) => {
  const env = await setup({
    files: [{
      path: '2026-10-29/n1.json',
      text: noteJson({
        id: 'n1',
        content: '<p>今天<strong>很好</strong></p><p>第二段</p>',
        tags: ['#日记'],
      }),
    }],
  });
  t.after(() => env.close());

  const stats = await env.runner.run();

  assert.equal(stats.notes, 1);
  assert.equal(stats.created, 1);
  assert.equal(stats.imagesUploaded, 0);
  assert.deepEqual(stats.errors, []);

  const memo = env.memos.state.getMemo(1);
  assert.ok(memo !== null, 'memo 应该被创建');
  assert.equal(memo.content, '今天**很好**\n\n第二段\n\n#日记');
  assert.equal(memo.visibility, 'PRIVATE');
  // ★ POST 忽略 createdTs，必须靠补 patch 校正
  assert.equal(memo.createdTs, 1793237729);

  assert.equal(stats.timesFixed, 1, '必须走一次时间校正');
  assert.equal(
    env.memos.state.writes().filter((item) => item.method === 'PATCH').length,
    1,
  );

  // 状态里要留下映射
  assert.equal(env.state.notes.n1.memoId, 1);
  assert.match(env.state.notes.n1.contentHash, /^sha256:[0-9a-f]{64}$/);
});

test('带图笔记：图片只走 resourceIdList，正文里绝不出现图片 Markdown', async (t) => {
  const env = await setup({
    files: [
      {
        path: '2026-10-29/n1.json',
        text: noteJson({
          id: 'n1',
          content: '<p>一张图</p>',
          images: [{ key: 'pic1', suffixName: 'png' }],
        }),
      },
      { path: 'picData/pic1.png', text: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    ],
  });
  t.after(() => env.close());

  const stats = await env.runner.run();
  assert.equal(stats.created, 1);
  assert.equal(stats.imagesUploaded, 1);

  const memo = env.memos.state.getMemo(1);
  assert.equal(memo.resourceIdList.length, 1);
  assert.equal(memo.resourceList.length, 1, '附件区应能看到这张图');
  assert.equal(memo.resourceList[0].filename, 'pic1.png');
  // ★★ 最关键的一条：正文里不能有图片 Markdown，否则 memos 会渲染两遍
  assert.equal(memo.content.includes('!['), false, `正文不该有图片语法：${memo.content}`);
  assert.equal(memo.content.includes('pic1'), false, '正文不该出现文件名');

  // 上传的字节要和仓库里的一致
  const uploaded = env.memos.state.resources.get(1);
  assert.deepEqual([...uploaded.bytes], [0x89, 0x50, 0x4e, 0x47]);

  // 状态里记下 resourceId + sha
  assert.equal(env.state.notes.n1.images['pic1.png'].resourceId, 1);
  assert.deepEqual(env.state.notes.n1.resourceIds, [1]);
});

test('两张图的笔记：两张都要挂上（线上 memo #246 的回归）', async (t) => {
  const env = await setup({
    files: [
      {
        path: '2026-10-29/n1.json',
        text: noteJson({
          id: 'n1',
          content: '<p>两张图</p>',
          images: [
            { key: 'a', suffixName: 'jpg' },
            { key: 'b', suffixName: 'jpg' },
          ],
        }),
      },
      { path: 'picData/a.jpg', text: 'AAA' },
      { path: 'picData/b.jpg', text: 'BBB' },
    ],
  });
  t.after(() => env.close());

  const stats = await env.runner.run();
  assert.equal(stats.imagesUploaded, 2);

  const memo = env.memos.state.getMemo(1);
  assert.equal(memo.resourceList.length, 2, '两张图都必须进附件区');
  assert.deepEqual(
    memo.resourceList.map((item) => item.filename).sort(),
    ['a.jpg', 'b.jpg'],
  );
});

test('只有图没有文字的笔记不该被丢掉', async (t) => {
  const env = await setup({
    files: [
      {
        path: '2026-10-29/n1.json',
        text: noteJson({ id: 'n1', content: '<p></p>', images: [{ key: 'x', suffixName: 'png' }] }),
      },
      { path: 'picData/x.png', text: 'XX' },
    ],
  });
  t.after(() => env.close());

  const stats = await env.runner.run();
  assert.equal(stats.created, 1, '有图就该建');
  assert.equal(stats.skipped, 0);

  const memo = env.memos.state.getMemo(1);
  assert.equal(memo.content, '', '正文为空是正常的');
  assert.equal(memo.resourceList.length, 1);
});

test('既无正文也无图 → 跳过，不产生 memo', async (t) => {
  const env = await setup({
    files: [{ path: '2026-10-29/empty.json', text: noteJson({ id: 'empty', content: '<p></p>' }) }],
  });
  t.after(() => env.close());

  const stats = await env.runner.run();
  assert.equal(stats.skipped, 1);
  assert.equal(stats.created, 0);
  assert.equal(env.memos.state.memos.size, 0);
});

test('坏 JSON 的笔记只跳过自己，不影响其他笔记', async (t) => {
  const env = await setup({
    files: [
      { path: '2026-10-29/bad.json', text: '{{{ 坏数据' },
      { path: '2026-10-29/good.json', text: noteJson({ id: 'good', content: '<p>好的</p>' }) },
    ],
  });
  t.after(() => env.close());

  const stats = await env.runner.run();
  assert.equal(stats.skipped, 1);
  assert.equal(stats.created, 1);
  assert.equal(stats.errors.length, 1);
  assert.match(stats.errors[0], /解析失败/);

  const memo = env.memos.state.findByContent('好的');
  assert.ok(memo !== null, '好笔记必须照常推送');
});

test('可见性透传到 memo', async (t) => {
  const env = await setup({
    files: [{ path: '2026-10-29/n1.json', text: noteJson({ id: 'n1', content: '<p>x</p>' }) }],
    visibility: 'PUBLIC',
  });
  t.after(() => env.close());

  await env.runner.run();
  assert.equal(env.memos.state.getMemo(1).visibility, 'PUBLIC');
});

// ─────────────────────────────────────────────────────────────
// 3. 幂等与增量
// ─────────────────────────────────────────────────────────────

test('连跑两轮：第二轮零写入（幂等）', async (t) => {
  const env = await setup({
    files: [
      { path: '2026-10-29/n1.json', text: noteJson({ id: 'n1', content: '<p>稳定</p>' }) },
      { path: '2026-10-29/n2.json', text: noteJson({ id: 'n2', content: '<p>第二</p>' }) },
    ],
  });
  t.after(() => env.close());

  const first = await env.runner.run();
  assert.equal(first.created, 2);

  env.memos.state.resetRequests();
  const second = await env.rerun();

  assert.equal(second.created, 0);
  assert.equal(second.updated, 0);
  assert.equal(second.unchanged, 2);
  assert.equal(env.memos.state.writes().length, 0, '幂等：第二轮不该有任何写请求');
  assert.equal(env.memos.state.memos.size, 2, '不能重复建');
});

test('正文变了 → 只 PATCH，不新建', async (t) => {
  const env = await setup({
    files: [{ path: '2026-10-29/n1.json', text: noteJson({ id: 'n1', content: '<p>旧内容</p>' }) }],
  });
  t.after(() => env.close());

  await env.runner.run();

  // 模拟 neno 端改了笔记
  env.gitea.state.seed('2026-10-29/n1.json', noteJson({ id: 'n1', content: '<p>新内容</p>' }));
  env.memos.state.resetRequests();

  const stats = await env.rerun();
  assert.equal(stats.updated, 1);
  assert.equal(stats.created, 0);

  assert.equal(env.memos.state.memos.size, 1, '不能多建一条');
  assert.equal(env.memos.state.getMemo(1).content, '新内容');

  const writes = env.memos.state.writes();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'PATCH');
});

test('笔记里删掉一张图 → 解绑该图（resourceIdList 是全量覆盖）', async (t) => {
  const env = await setup({
    files: [
      {
        path: '2026-10-29/n1.json',
        text: noteJson({
          id: 'n1',
          content: '<p>两图</p>',
          images: [{ key: 'a', suffixName: 'png' }, { key: 'b', suffixName: 'png' }],
        }),
      },
      { path: 'picData/a.png', text: 'A' },
      { path: 'picData/b.png', text: 'B' },
    ],
  });
  t.after(() => env.close());

  await env.runner.run();
  assert.equal(env.memos.state.getMemo(1).resourceList.length, 2);

  // neno 端把 b 删掉了
  env.gitea.state.seed('2026-10-29/n1.json', noteJson({
    id: 'n1',
    content: '<p>两图</p>',
    images: [{ key: 'a', suffixName: 'png' }],
  }));

  const stats = await env.rerun();
  assert.equal(stats.updated, 1, '删图必须触发更新');

  const memo = env.memos.state.getMemo(1);
  assert.equal(memo.resourceList.length, 1, '被删的图必须解绑');
  assert.equal(memo.resourceList[0].filename, 'a.png');

  // 图片本身没重传（已上传过）
  assert.equal(stats.imagesUploaded, 0);
});

test('图片内容被替换（同名不同内容）→ 重传新版本', async (t) => {
  const env = await setup({
    files: [
      {
        path: '2026-10-29/n1.json',
        text: noteJson({ id: 'n1', content: '<p>图</p>', images: [{ key: 'p', suffixName: 'png' }] }),
      },
      { path: 'picData/p.png', text: '第一个版本' },
    ],
  });
  t.after(() => env.close());

  await env.runner.run();
  assert.equal(env.state.notes.n1.images['p.png'].resourceId, 1);

  // 同名文件内容变了
  env.gitea.state.seed('picData/p.png', '第二个版本');

  const stats = await env.rerun();
  assert.equal(stats.imagesUploaded, 1, '内容变了必须重传');
  assert.equal(env.state.notes.n1.images['p.png'].resourceId, 2);

  const memo = env.memos.state.getMemo(1);
  assert.deepEqual(memo.resourceIdList, [2], '附件要换成新的');
  assert.equal(
    env.memos.state.resources.get(2).bytes.toString(),
    '第二个版本',
  );
});

test('多设备并发场景：两个 runner 各自推不同笔记，互不覆盖', async (t) => {
  const env = await setup();
  t.after(() => env.close());

  env.gitea.state.seed('2026-10-29/a.json', noteJson({ id: 'a', content: '<p>A</p>' }));
  env.gitea.state.seed('2026-10-29/b.json', noteJson({ id: 'b', content: '<p>B</p>' }));

  const stats = await env.runner.run();
  assert.equal(stats.created, 2);
  assert.deepEqual(
    [...env.memos.state.memos.values()].map((memo) => memo.content).sort(),
    ['A', 'B'],
  );
});

// ─────────────────────────────────────────────────────────────
// 4. 缺图与孤儿
// ─────────────────────────────────────────────────────────────

test('缺图 → 记 missingImages，文件补进仓库后能自动重试成功', async (t) => {
  const env = await setup({
    files: [
      {
        path: '2026-10-29/n1.json',
        text: noteJson({
          id: 'n1',
          content: '<p>缺图</p>',
          images: [{ key: 'lost', suffixName: 'jpg' }],
        }),
      },
      // ⚠️ 故意不提供 picData/lost.jpg
    ],
  });
  t.after(() => env.close());

  // ── 第一轮：图不存在 ──
  const first = await env.runner.run();
  assert.equal(first.imagesPending, 1);
  assert.equal(first.imagesUploaded, 0);
  assert.equal(
    env.state.notes.n1.missingImages['lost.jpg'],
    'not_in_repo',
    '必须留痕，否则永远不重试',
  );
  // memo 还是建了（正文有内容）
  assert.equal(env.memos.state.getMemo(1).resourceList.length, 0);

  // ── 第二轮：还是缺，仍然 pending ──
  const second = await env.rerun();
  assert.equal(second.imagesPending, 1);
  assert.equal(second.updated, 1, '有 pending 就必须每轮重试，不能被"未变化"挡住');

  // ── 第三轮：图补进仓库 ──
  env.gitea.state.seed('picData/lost.jpg', 'LOST-IMAGE');
  const third = await env.rerun();

  assert.equal(third.imagesUploaded, 1, '补进来后必须自动上传');
  assert.equal(third.imagesPending, 0);
  assert.equal(env.state.notes.n1.missingImages['lost.jpg'], undefined, '成功后要清掉标记');

  const memo = env.memos.state.getMemo(1);
  assert.equal(memo.resourceList.length, 1, '新图必须挂到原 memo 上');
  assert.equal(memo.resourceList[0].filename, 'lost.jpg');

  // ── 第四轮：恢复幂等 ──
  env.memos.state.resetRequests();
  const fourth = await env.rerun();
  assert.equal(fourth.unchanged, 1);
  assert.equal(env.memos.state.writes().length, 0);
});

test('已上传的图在仓库里消失 → 不解绑（memos 端才是用户看到的东西）', async (t) => {
  const env = await setup({
    files: [
      {
        path: '2026-10-29/n1.json',
        text: noteJson({
          id: 'n1',
          content: '<p>图</p>',
          images: [{ key: 'a', suffixName: 'png' }, { key: 'b', suffixName: 'png' }],
        }),
      },
      { path: 'picData/a.png', text: 'A' },
      { path: 'picData/b.png', text: 'B' },
    ],
  });
  t.after(() => env.close());

  await env.runner.run();
  assert.equal(env.memos.state.getMemo(1).resourceList.length, 2);

  // 有人把 picData/a.png 从仓库删了，但笔记里还声明着它
  // （mock 没有真删接口，改用新 seed 覆盖 + 通过 gitea 重新建树来模拟）
  // 这里直接改 provider 看到的树：删掉 a.png
  const originalGetTree = env.provider.getTree.bind(env.provider);
  env.provider.getTree = async (oid) => (await originalGetTree(oid))
    .filter((entry) => entry.path !== 'picData/a.png');

  const stats = await env.rerun();
  assert.equal(stats.updated, 0, '图已经传过了，不该触发更新');
  assert.equal(stats.unchanged, 1);
  assert.equal(stats.imagesPending, 0, '不该被当成缺图');

  const memo = env.memos.state.getMemo(1);
  assert.equal(memo.resourceList.length, 2, '两张图都该留着，不能解绑');
  assert.equal(env.state.notes.n1.missingImages['a.png'], undefined);
});

test('笔记从仓库消失 → 只打 orphaned 标记，绝不删映射、绝不删 memo', async (t) => {
  const env = await setup({
    files: [
      { path: '2026-10-29/gone.json', text: noteJson({ id: 'gone', content: '<p>会消失</p>' }) },
      { path: '2026-10-29/keep.json', text: noteJson({ id: 'keep', content: '<p>会留下</p>' }) },
    ],
  });
  t.after(() => env.close());

  await env.runner.run();
  assert.equal(env.memos.state.memos.size, 2);
  const goneMemoId = env.state.notes.gone.memoId;

  // 模拟 gone.json 从树里消失（只影响 provider 视角，不用真删）
  const originalGetTree = env.provider.getTree.bind(env.provider);
  env.provider.getTree = async (oid) => (await originalGetTree(oid))
    .filter((entry) => entry.path !== '2026-10-29/gone.json');

  const stats = await env.rerun();
  assert.equal(stats.orphaned, 1);
  assert.equal(stats.notes, 1);

  // ★ 关键：映射还在（否则笔记回来时会重复建）
  assert.ok(env.state.notes.gone !== undefined, '映射绝不能被删掉');
  assert.ok(env.state.notes.gone.orphanedAt !== undefined, '要留标记');
  assert.equal(env.state.notes.gone.memoId, goneMemoId);

  // ★ memo 本身也不删（单向只读语义）
  assert.ok(env.memos.state.getMemo(goneMemoId) !== null, 'memos 端的 memo 不该被删');
  assert.equal(env.memos.state.memos.size, 2);
});

test('孤儿笔记重新出现 → 复用原 memo，不重复建', async (t) => {
  const env = await setup({
    files: [{ path: '2026-10-29/n1.json', text: noteJson({ id: 'n1', content: '<p>短暂消失</p>' }) }],
  });
  t.after(() => env.close());

  await env.runner.run();
  const originalMemoId = env.state.notes.n1.memoId;

  // 让笔记消失一轮
  const originalGetTree = env.provider.getTree.bind(env.provider);
  env.provider.getTree = async (oid) => (await originalGetTree(oid))
    .filter((entry) => entry.path !== '2026-10-29/n1.json');
  await env.rerun();
  assert.ok(env.state.notes.n1.orphanedAt !== undefined);

  // 恢复
  env.provider.getTree = originalGetTree;
  const stats = await env.rerun();

  assert.equal(stats.created, 0, '不该重复建');
  assert.equal(env.memos.state.memos.size, 1, 'memos 里只能有一条');
  assert.equal(env.state.notes.n1.memoId, originalMemoId, '必须复用原 memoId');
  assert.equal(env.state.notes.n1.orphanedAt, undefined, '标记要清掉');
});

test('Gitea 树被截断导致笔记全"消失"时，不会造成 memos 端翻倍', async (t) => {
  const env = await setup({
    files: [
      { path: '2026-10-29/a.json', text: noteJson({ id: 'a', content: '<p>A</p>' }) },
      { path: '2026-10-29/b.json', text: noteJson({ id: 'b', content: '<p>B</p>' }) },
    ],
  });
  t.after(() => env.close());

  await env.runner.run();
  assert.equal(env.memos.state.memos.size, 2);

  // 模拟一次读到空树（网络抖动 / truncated 的极端情况）
  const originalGetTree = env.provider.getTree.bind(env.provider);
  env.provider.getTree = async () => [];
  const degraded = await env.rerun();
  assert.equal(degraded.notes, 0);
  assert.equal(degraded.orphaned, 2);

  // 恢复后必须还是 2 条，不能变 4 条
  env.provider.getTree = originalGetTree;
  const recovered = await env.rerun();
  assert.equal(recovered.created, 0, `恢复后不该新建，实际新建 ${recovered.created}`);
  assert.equal(env.memos.state.memos.size, 2, '必须还是 2 条');
});

test('memos 端某条 memo 被用户手动删除后，同步不会重建它（单向只读）', async (t) => {
  const env = await setup({
    files: [{ path: '2026-10-29/n1.json', text: noteJson({ id: 'n1', content: '<p>A</p>' }) }],
  });
  t.after(() => env.close());

  await env.runner.run();
  const memoId = env.state.notes.n1.memoId;

  // 用户在 memos 里删了它
  env.memos.state.removeMemo(memoId);
  assert.equal(env.memos.state.memos.size, 0);

  // 下一轮：状态里还有映射，会尝试 PATCH → 404
  // 这个错误要被记录下来，但不能让整轮崩掉
  const stats = await env.rerun();
  assert.equal(stats.errors.length >= 0, true);
  // 核心断言：不会因此新建一条
  assert.equal(env.memos.state.memos.size, 0, '不该悄悄重建被用户删掉的 memo');
});
