# momo

让 [neno](https://github.com/openneno/neno) 卡片笔记的同步后端支持 **自建代码平台（Gitea / Forgejo）**，并能把笔记**单向推送到 memos 实例**。

原版 neno 是纯前端 PWA，笔记数据存在你自己的 Git 仓库里，但同步层**硬编码 GitHub**（`api.github.com` + GraphQL）。本项目做了两件事：

1. **改造 neno 前端**，把"代码平台"抽象成可替换的策略层，从而支持 Gitea / Forgejo
2. **提供一套独立的同步工具**，把仓库里的笔记推送到 memos（Node.js CLI，零依赖）

---

## 目录结构

```
momo/
├── app/                      改造后的 neno 前端（Svelte 5 + Vite）
│   └── src/
│       ├── lib/sync/
│       │   ├── platform.mjs        平台能力矩阵（新增）
│       │   ├── commitStrategy.mjs  提交策略：GraphQL vs ChangeFiles（新增）
│       │   └── syncEngine.js       同步引擎（改造：去掉 GitHub 硬编码）
│       └── request/
│           ├── githubClient.js     API 客户端（改造：base URL 运行时可配）
│           └── gitAccountApi.js    账号/仓库接口（改造：按平台分流）
│
├── src/                      独立的 Node 同步工具
│   ├── request/gitProvider/   平台 adapter（读+写，Node 侧）
│   ├── memos/                 memos 客户端 + 内容构造 + 推送引擎
│   ├── frontend/              与 app/ 共享的策略层（测试基准）
│   ├── cli.mjs                命令行入口
│   └── state.mjs              同步状态（幂等的根基）
│
├── test/                     133 个测试
├── scripts/                  真机验证脚本（对着真实 Gitea 跑）
└── testkit/                  真实 HTTP mock（Gitea / GitHub / memos）
```

---

## 第一部分：neno 前端改造

### 核心发现：GitHub 耦合其实很小

实测 neno 源码（52 个文件 / 466KB），真正与平台绑定的只有 **7 处 REST 调用 + 1 处 GraphQL**，全部集中在两个文件：

| 文件 | 耦合内容 | 改造量 |
|---|---|---|
| `lib/sync/syncEngine.js` | 1 个 GraphQL mutation、6 处 REST 路径、单数 `ref` | 中 |
| `request/gitAccountApi.js` | `repoUrl`、`permissions.push` 判断、Gitee 拒绝逻辑 | 小 |
| `request/githubClient.js` | `GITHUB_API` 常量（生产构建被 `DEV` 守卫锁死） | 小 |

**所以定向改造比从零重写可靠得多。** 本项目选择 fork + 打补丁。

### 改造一：API 基址运行时可配

原版：

```js
const DEV_API = import.meta.env.DEV ? ... : null;
export const GITHUB_API = DEV_API || "https://api.github.com";
```

生产构建里 `DEV_API` 恒为 `null`，`GITHUB_API` 被锁死。**运行时没有任何入口能改它** —— 这也是为什么纯反代方案（A4）在原版上不成立。

改造后：

```js
export function configureApi({ platform, baseUrl }) { ... }
export const GITHUB_API = new Proxy({}, { get: ... });   // 保持原有 import 可用
```

`App.svelte` 在 `onMount` 里注入一次，并订阅 `githubStore` 变化 —— 用户改配置后无需刷新即生效。

### 改造二：平台能力矩阵

`app/src/lib/sync/platform.mjs` 把三个平台的关键差异集中成数据：

```js
export const PLATFORMS = {
  github:  { branchHeadCAS: true,  fileLevelShaCAS: false, pluralRefs: false, maxFilesPerCommit: 200 },
  gitea:   { branchHeadCAS: false, fileLevelShaCAS: true,  pluralRefs: true,  maxFilesPerCommit: 100 },
  forgejo: { branchHeadCAS: false, fileLevelShaCAS: true,  pluralRefs: true,  maxFilesPerCommit: 100 },
};
```

封装掉三个"写错只会得到 404 且不告诉你原因"的差异：

| 差异 | GitHub | Gitea / Forgejo |
|---|---|---|
| 分支 ref 路径 | `/git/ref/heads/x`（**单数**） | `/git/refs/heads/x`（**复数**） |
| ref 响应形状 | **对象** `{object:{sha}}` | **数组** `[{object:{sha}}]` |
| 空仓库信号 | HTTP **409** | HTTP **404** |
| 单次提交上限 | 200 文件 | 100 文件 |

> 这几条每一条都是实测出来的。第 1 条尤其容易踩：路径写成 `ref` 会得到 404，而错误体里只有 `{"message":"..."}`，完全看不出是路径问题。

### 改造三：提交策略层

这是整个方案的支点。原版第 3 步推送写死 GraphQL：

```js
// 改造前
const COMMIT_MUTATION = `mutation($input: CreateCommitOnBranchInput!) { ... }`;
async function createCommit(branch, expectedHeadOid, headline, additions, deletions) {
    const data = await graphql(config().access_token, COMMIT_MUTATION, { ... });
}
```

改造后只做参数翻译，平台差异全在策略里：

```js
// 改造后
async function createCommit(branch, expectedHeadOid, headline, additions, deletions) {
    try {
        return await strategy().commit({ branch, expectedHeadOid, headline, additions, deletions });
    } catch (error) {
        if (error && error.name === "SyncConflictError") throw new ConflictError(error.message);
        throw error;
    }
}
```

两个策略：

- **`GraphQLCommitStrategy`**（GitHub）：`createCommitOnBranch` + `expectedHeadOid` 强 CAS
- **`ChangeFilesStrategy`**（Gitea/Forgejo）：`POST /contents` 的 `files[]` + 文件级 sha 弱 CAS

上层（合并、分批、重试）**一行没改** —— 冲突语义统一成 `SyncConflictError`，再由引擎转成它原本就认识的 `ConflictError`，`syncWithRetry` 完全不用动。

### 为什么 Gitea 只能做"弱 CAS"（重要，推翻了既有假设）

网上（以及本项目早期文档）有个常见设想：**用 `POST blob → POST tree → POST commit → `PATCH ref force:false`` 去近似 GitHub 的 CAS**。

**实测结论：这条路在 Gitea / Forgejo 上根本不存在。**

我先按文档推断出了这个结论，后来又**下载真实的 Gitea 1.22.6 跑了一遍**来确认 —— 因为这条假设一旦错了，整个方案的架构都要重做。下面是真机返回：

```
POST   /repos/u/r/git/blobs    → 404 page not found
POST   /repos/u/r/git/trees    → 404 page not found
POST   /repos/u/r/git/commits  → 404 page not found
PATCH  /repos/u/r/git/refs/heads/main → 405 Method Not Allowed
```

注意最后一行：**不是 404，是 405**。这说明路由存在、只是不注册 PATCH —— 也就是说 Gitea 明确地拒绝了这个方法，而不是"没实现这个路径"。这比 404 更有说服力。

`git/` 命名空间**只有 GET**：

```
GET  /repos/{o}/{r}/git/blobs/{sha}
GET  /repos/{o}/{r}/git/commits/{sha}
GET  /repos/{o}/{r}/git/refs
GET  /repos/{o}/{r}/git/refs/{ref}
GET  /repos/{o}/{r}/git/trees/{sha}
```

**没有任何 POST / PATCH / PUT。** Forgejo 同样（`git/` 下唯一的写端点是 `notes` 和 `hooks`）。

唯一的写路径是 `POST /repos/{o}/{r}/contents`（`ChangeFiles`），它接受 `files[]` 数组，一次一个 commit，并发保护是**文件级 sha**（`ChangeFileOperation.sha` 在 update/delete 时必填）。

所以能力对照是：

| 能力 | GitHub | Gitea / Forgejo |
|---|---|---|
| 单请求多文件原子提交 | ✅ GraphQL | ✅ ChangeFiles |
| **分支 tip 级 CAS** | ✅ `expectedHeadOid` | ❌ **不存在**（PATCH ref → 405） |
| 文件级 sha 校验 | ❌ | ✅（弱 CAS） |
| GraphQL | ✅ | ❌ **没有这个端点** |
| 提交响应含新 commit sha | ✅ | ✅ 1.22.6 实测**有** `commit.sha` |

**弱 CAS 会不会丢数据？不会。** git 本身是快进合并：A 设备读到 tip=X，B 推了 tip=Y（改了别的文件），A 再提交自己的文件 —— 文件级 sha 能过，提交成功，且**包含** B 的内容。真正的覆盖风险是"两端改同一个文件"，而这恰好被文件级 sha 挡住了。

所以"弱"只影响**能否及时发现别人动过**（通知语义），不影响数据安全。

这条结论有测试守着：`test/frontend-e2e.test.mjs` 里有一个用例专门在"读完树之后、提交之前"插入别的设备的写入，断言提交被拒**且别人的内容没被覆盖**。

### 真机验证发现的 4 个「文档没写」的差异

跑真实 Gitea 1.22.6 的过程里，有 4 处行为和我的 mock / 文档假设不一致。它们不会导致崩溃，但会让行为偏离预期，全部已修正：

| # | 场景 | 我的假设 | 真机实际 | 影响 |
|---|---|---|---|---|
| 1 | 空仓库 `POST /branches` | 201，建出分支 | **404** `Git Repository is empty.` | 原 bootstrap 白跑一次必失败的请求 |
| 2 | 空仓库 `POST /contents` | 需先有分支 | **201**，直接建出分支+首提交（非默认分支名也行） | bootstrap 可以只发一次请求 |
| 3 | update **不存在**的文件 | 422 | **500** `object does not exist` | 若不把 500 当冲突，会把竞态误报成故障 |
| 4 | `git/trees?recursive=1` 的条目 | 只有 blob | **同时有 `tree` 和 `blob`** | 不过滤会把目录 sha 当文件 sha 发出去 |

第 3 条最隐蔽：`500` 一般意味着"服务端炸了"，但在这里它其实是**树漂移**的信号 —— 客户端以为存在的文件在服务端没了。所以 `ChangeFilesStrategy` 把 409 / 422 / **500** 都映射成 `SyncConflictError`，交给上层重新拉取。

第 1、2 两条合起来说明：`bootstrap` 的正确写法就是**直接 `POST /contents`**，不要先建分支。现在的实现只发一次请求，且有测试断言"不发 POST /branches"。

### 真机验证怎么做

`scripts/real-gitea-check.mjs` 会对着一个真实 Gitea 实例跑完整链路（引导 → 多文件提交 → 中文往返 → 冲突 → 删除）：

```bash
GITEA_BASE=http://127.0.0.1:3000/api/v1 \
GITEA_TOKEN=<你的 token> \
GITEA_OWNER=<owner> GITEA_REPO=<repo> \
node scripts/real-gitea-check.mjs
```

> ⚠️ 在 Windows 上跑本地 Gitea 时，每次写请求会莫名慢 ~28 秒。原因不是代码：Gitea 要派生 `git` 子进程做 attr-check，被沙箱拦掉后等到超时。Linux / Docker 下没有这个现象。

### 改完代码怎么发布

`scripts/push-via-api.mjs` 走 **GitHub Git Data API** 推送，用在你连不上 `github.com`（`git push` 报 `CONNECT tunnel failed`）但 `api.github.com` 可达的环境：

```bash
GITHUB_TOKEN=<你的 token> GITHUB_REPO=<owner>/<repo> node scripts/push-via-api.mjs
```

它读的是**本地 git HEAD**（不是工作区），所以推上去的内容与本地提交逐字节一致，并会逐个校验 `POST /git/blobs` 返回的 sha 是否与本地 blob sha 相同。

> 这里有个和 Gitea 对称的坑：GitHub 的空仓库上 `POST /git/blobs` 会返回 **409 "Git Repository is empty."** —— git 对象库得先有提交才可用。所以脚本会先用 `PUT /contents/README.md` 造一个引导提交。和前面「Gitea 空仓库 `POST /branches` → 404」是同一类问题：空仓库那个状态各家处理都不一样。

### 改造四：配置 UI

`SyncSetup.svelte` 新增"第 0 步：选择代码平台"，支持 GitHub / Gitea / Forgejo 三个按钮。选后两者时多出一个 **API 地址**输入框（会自动补 `/api/v1`）。

旧配置没有 `platform` 字段，读取时默认按 `github` 处理 —— **升级用户行为完全不变**。

---

## 第二部分：推送到 memos

`src/memos/` 是一套独立的 Node 工具（与前端改造无关，可单独使用）：读取仓库里的 neno 笔记 JSON，上传图片，写入 memos。

### 用法

```bash
# 1. 验证两端连通性
node src/cli.mjs check

# 2. 试跑，只报告会做什么，不写任何东西
node src/cli.mjs sync --dry-run

# 3. 真跑
node src/cli.mjs sync
```

配置全部走环境变量：

```bash
# 代码平台
GIT_PROVIDER=gitea                              # github / gitea / forgejo
GIT_BASE_URL=https://git.example.com/api/v1
GIT_TOKEN=...
GIT_OWNER=alice
GIT_REPO=neno-data

# memos
MEMOS_BASE_URL=https://memos.example.com
MEMOS_USERNAME=alice
MEMOS_PASSWORD=...
MEMOS_VISIBILITY=PRIVATE                        # PRIVATE / PROTECTED / PUBLIC
MEMOS_MIN_INTERVAL_MS=150

# 其他
NENO_STATE_PATH=./.memos-map.json
NENO_DEBUG=1
```

退出码：`0` 成功 / `1` 部分条目失败 / `2` 配置问题。

### 四条踩过坑才得出的规则

每一条都对应一次线上事故，全部写进了代码注释和测试。

#### 1. 图片**绝不**写进正文

memos 有两条独立的图片渲染通道：

- `resourceIdList` / `resourceList` —— 附件区，前端自动渲染
- 正文里的 `![](url)` —— 按 Markdown 渲染

**两条都做 = 同一张图显示两遍。** 实测用户手工发的 11 条带图笔记，`resourceList` 有 1~5 个附件，正文内 `![]()` 数量**全部为 0**。这是 memos 自己的标准做法。

#### 2. `POST /api/v1/memo` **完全忽略** `createdTs`

传 `1793156799` 进去，落库的是"此刻"。换字段名（`created_ts` / `displayTs`）同样无效。

**只有 `PATCH /api/v1/memo/{id}` 认这个字段**（0 误差、幂等）。所以建完必须补一次 patch 校正时间 —— 这是 `createMemo` 之后那段 `timesFixed` 逻辑存在的原因。

#### 3. `resourceIdList` 是**全量覆盖**语义

传 `[]` 就是解绑所有附件。它同时满足两个需求：

- **删图要解绑**：笔记里删掉一张图 → 新列表不含它 → 自动解绑
- **临时读不到不解绑**：源文件短暂消失但已上传过 → 仍用缓存 sha 兜住

判断"要不要更新"必须比较**集合**，不能只判 `!Array.isArray(entry.resourceIds)` —— 否则 `[1,2] → [1]` 这种变化永远检测不到。

#### 4. 缺图必须留痕，否则永不重试

如果图片上传失败但不记录，下一轮会因为"正文没变"跳过整条笔记 —— 等文件补进仓库也永远不会重传。线上 memo #246 就是这么少了一张图。

所以失败时写进 `entry.missingImages[filename]`，并让它参与"是否跳过"的判断。

### 状态文件是幂等的根基

没有 `.memos-map.json`，每轮都会把全部笔记重新灌进 memos，产生成倍的重复记录。

状态写入用「写临时文件 → rename」保证原子性：中途崩溃不会留下半截 JSON。文件损坏时会**先备份再重置**（`.corrupt-<timestamp>`），绝不静默覆盖 —— 里面可能有几百条映射。

### 单向只读语义

neno 是唯一真源，memos 只是"另一个查看端"。所以：

- 笔记从仓库消失 → **只打 `orphanedAt` 标记，绝不删映射、绝不删 memo**
- 用户在 memos 手动删掉 memo → 同步**不会**重建它

第二条不删映射的理由比第一条更硬：如果某次 `getTree` 拿到不完整的树（Gitea 的 `truncated`、网络抖动），所有笔记都会被误判成"已删除"。映射一清，下一轮就会把每一条都重新建一遍，**memos 里瞬间翻倍**。有测试专门守这个场景。

---

## 测试

```bash
npm test
```

**133 个测试全部通过**，覆盖：

| 文件 | 数量 | 守什么 |
|---|---|---|
| `test/forgejo.test.mjs` | 14 | Gitea 协议细节（复数 refs、数组响应、base64 带换行、409/422） |
| `test/github.test.mjs` | 9 | GraphQL 的 200+errors 语义、单数 ref、ETag |
| `test/cross-platform.test.mjs` | 9 | 同一份逻辑跑两平台，仓库内容**逐字节相同** |
| `test/frontend.test.mjs` | 21 | 策略层：两平台冲突语义一致、空仓库引导 |
| `test/memos.test.mjs` | 24 | 幂等、缺图重试、删图解绑、孤儿不翻倍 |
| `test/content.test.mjs` | 8 | 手写 SHA-256 与 `node:crypto` 逐位对拍（含补位边界） |
| `test/frontend-e2e.test.mjs` | 19 | 前端策略层走**真 HTTP**：路径单复数、UTF-8 base64、弱 CAS 守住别人写入、真机 4 处差异 |
| `test/cli.test.mjs` | 19 | 参数解析、配置校验、状态原子写、损坏备份 |
| `test/cli-e2e.test.mjs` | 10 | 真 `spawn` 子进程：退出码、`--dry-run` 零副作用、输出不含 token |
| `test/cli.test.mjs` | 19 | 配置校验、状态原子写入、输出格式 |
| `test/cli-e2e.test.mjs` | 10 | 真跑 `spawn` 子进程，只通过环境变量与退出码交互 |

测试全部走**真实 HTTP mock**（`testkit/`），不打桩。这一层的价值全在"协议细节对不对"上，打桩只能验证"我预期的形状"，验证不了"真实服务端会这样回"。

零运行时依赖 —— 手写 SHA-256 而不是 `node:crypto`（前端也要跑），手写 30 行参数解析而不是 commander。

---

## 部署到 Netlify

`app/` 是纯静态 SPA，Netlify 可以直接托管。仓库根目录已有 `netlify.toml`，**不需要在 UI 里填任何构建配置**。

### 一次性配置

1. Netlify → **Add new project** → **Import an existing project** → 选 GitHub → 授权并选中 `folkson/momo`
2. 构建配置会从 `netlify.toml` 自动读取，什么都不用改：

   | 项 | 值 | 说明 |
   |---|---|---|
   | Base directory | `app` | 前端在子目录；根目录是另一套 Node 工具 |
   | Build command | `npm run build` | |
   | Publish directory | `dist` | ⚠️ 相对 `base`，实际部署 `app/dist` |
   | Node | `24` | 见下方「Node 版本为什么是 24」 |

3. 点 **Deploy**

### 为什么 base 必须设成 app

这个仓库不是一个纯前端项目：根目录还有一套独立的 Node 同步工具（`src/`、`test/`、`testkit/`）。Netlify 默认从仓库根装依赖、跑构建，那样会装错东西 —— 根 `package.json` 里连 vite 都没有。

**一个容易踩的路径陷阱**：`publish` 是相对 `base` 解析的。`base = "app"` + `publish = "dist"` 才是 `app/dist`；写成 `publish = "app/dist"` 会变成 `app/app/dist`，构建报 `publish directory not found`。

### Node 版本为什么是 24

依赖树里有一条硬约束决定了下限：**`html2canvas-pro@2.5.2` 要求 `node >=24.0.0`**。它被 `Share.svelte` 用来生成分享图，是真正的运行时依赖，不是构建期工具。另外 `postcss-calc@11.2.3`（`cssnano` 的传递依赖）要求 `^22.22.3 || ^24.15`。

所以钉 22 是不够的。本地之所以能构建通过，只是因为 npm 的 `engine-strict` 默认是 `false` —— `EBADENGINE` 只是警告，不阻断。换个环境会挂。`netlify.toml` 和 `app/package.json` 的 `engines` 都写 24，两处保持一致。

`NODE_VERSION = "24"` 写主版本号即可，Netlify 会取 24.x 的最新版。

### lockfile

`app/package-lock.json` 已入库。有这个文件，Netlify 会走 `npm ci` 而不是 `npm install`，装出来的版本和本地逐字节一致；没有它则会按 `^` 范围重新解析，可能拉到将来发布的不兼容版本。

⚠️ 副作用：本机若是 Node 22，`npm install` 会报 `momo-app requires node >=24` 的警告。这是预期行为，本地用 Node 22 仍可开发构建，只是会有这条提示。


`netlify.toml` 里有一条 `/* → /index.html 200`，但**这个应用当前用不上它**：页面切换靠 Svelte store 在内存里完成，URL 从头到尾不变，`index.html` 只在首次加载时请求一次，没有路径路由。

留着它是为了以后改成真路由时不用再想，以及用户手输奇怪的 URL 时不至于看到 Netlify 的 404 页。

关键在于**没有**加 `!`（force）后缀。Netlify 默认不 shadow 已存在的静态文件，所以这道 splat 不会吞掉 `/sw.js`、`/manifest.webmanifest`、`/assets/*`。如果加上 `!`，`sw.js` 会被 rewrite 成 `index.html`，Service Worker 直接废掉。

### 缓存头

Vite 给 `assets/` 下的文件带内容 hash，可以放心长缓存；但 `index.html`、`sw.js`、`manifest.webmanifest` 文件名固定，必须短缓存，否则用户会一直拿到旧版本。`netlify.toml` 里已经按这个原则分别设好了。

### 部署后要做的

打开站点，进设置页重新配置同步（Token、平台、仓库）。也可以点「分享」，把生成到 `#neno-config=...` 的链接/二维码拿到其他设备导入 —— 配置在 `#` 之后，不会随请求发到服务器。

### 本地验证构建

```bash
cd app && npm run build && npx vite preview
```

### 用 Netlify CLI 部署（可选）

```bash
npm i -g netlify-cli
netlify login
netlify deploy --build --prod
```

---

## 已知限制

| 限制 | 说明 |
|---|---|
| Gitea 无分支 tip CAS | 见上文。靠"提交前比一次 + 文件级 sha + 提交后复核"兜住 |
| 提交后多一次读请求 | Gitea 的 `ChangeFiles` 响应结构随版本变化，只能重读 ref 确认新 tip |
| Gitea 首次同步多一次树读取 | `files[].sha` 必填，必须先把 `path → sha` 索引建出来 |
| memos 端被删的 memo 不重建 | 这是**设计选择**（单向只读），不是缺陷 |
| HTML→Markdown 是简化实现 | 只处理 Quill 输出的那几个标签；接口已隔离，将来可替换 |

---

## 许可

`app/` 目录是 [openneno/neno](https://github.com/openneno/neno) 的衍生作品，遵循其 **GPL-3.0** 许可（见 `app/LICENSE.md`）。

根目录的同步工具（`src/`、`test/`、`testkit/`）为独立作品，MIT。
