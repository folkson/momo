//同步配置向导使用的接口: 校验 Token, 获取用户信息, 列出/创建仓库
//这些接口不依赖 githubStore, 以便在保存配置之前使用
//
//【momo 改造】原来这些接口都假定 GitHub:
//   · repoUrl() 硬编码 github.com
//   · listRepos 依赖 permissions.push（Gitea 结构不同）
//   · createRepo 的默认分支处理不同
//   · decodeNenoToken 把非 GitHub 的 gitUrl 当成"旧的 Gitee 配置"直接拒绝
//现在全部按平台分流，但**对外函数签名保持不变**，调用方无需改动。
import {Base64} from "js-base64";
import {rest, currentApiBase, currentGitPlatform} from "./githubClient.js";
import {PLATFORMS, normalizeApiBase} from "../lib/sync/platform.mjs";

export const GITHUB_URL = "https://api.github.com";
//已不再支持的 Gitee 地址, 仅用于识别旧配置
export const LEGACY_GITEE_URL = "https://gitee.com/api/v5";

//各平台的 token 生成入口
const TOKEN_URLS = {
    github: "https://github.com/settings/tokens/new?scopes=repo,workflow&description=NENO",
    gitea: "",   // 自建实例，域名由用户决定，无法预先给出
    forgejo: "",
};
const FINE_GRAINED_TOKEN_URLS = {
    github: "https://github.com/settings/personal-access-tokens/new",
};

export const TOKEN_URL = TOKEN_URLS.github;
export const FINE_GRAINED_TOKEN_URL = FINE_GRAINED_TOKEN_URLS.github;

/**
 * 按平台取 token 生成入口（可能为空，表示需要用户自己找）。
 *
 * @param {string} [platform] 平台 id
 * @returns {string}
 */
export function tokenUrlFor(platform = currentGitPlatform()) {
    return TOKEN_URLS[platform] || "";
}

export const DEFAULT_REPO_NAME = "neno-data";

/**
 * 仓库的网页地址。
 *
 * 【momo 改造】原来硬编码 `https://github.com/${fullName}`。
 * 现在从 API 基址反推站点根（去掉 /api 与 /api/v1）。
 *
 * @param {string} fullName `owner/repo`
 * @param {string} [platform] 平台
 * @param {string} [apiBase] API 基址
 * @returns {string}
 */
export function repoUrl(fullName, platform = currentGitPlatform(), apiBase = currentApiBase()) {
    if (platform === "github") return `https://github.com/${fullName}`;
    const base = String(apiBase || "").replace(/\/+$/, "").replace(/\/api(\/v\d+)?$/i, "");
    return base === "" ? "" : `${base}/${fullName}`;
}

//把接口错误转换成用户能看懂的提示
export function describeError(error) {
    const status = error && error.status;
    if (status === 401) return "Token 无效或已过期, 请重新生成";
    if (status === 403) return "Token 权限不足, 请确认已勾选仓库读写权限";
    if (status === 404) return "找不到对应的资源, 请检查 Token 的仓库访问范围, 或确认 API 地址是否正确";
    if (status === 422) return "仓库名已存在或不合法, 请换一个名字";
    if (!status || status >= 500) return "网络连接失败, 请检查网络后重试";
    return (error && error.message) || "未知错误";
}

//校验 Token 并返回用户信息
export async function fetchAccount(token) {
    const re = await rest(token, "GET", "/user");
    const platform = currentGitPlatform();
    //GitHub 用 name, Gitea 用 full_name
    const name = re.data.name || re.data.full_name || re.data.login;
    const scopes = re.headers.get("x-oauth-scopes");
    return {
        login: re.data.login,
        name,
        avatar: re.data.avatar_url,
        platform,
        //经典 Token 会返回授权范围, 细粒度 Token 没有这个响应头;
        //Gitea 也没有这个头 —— 两种情况都返回 null
        scopes: typeof scopes === "string" ? scopes.split(",").map((s) => s.trim()).filter(Boolean) : null,
    };
}

/**
 * 从仓库响应里取出 owner/repo。
 *
 * @param {any} raw 原始响应
 * @returns {{owner: string, repo: string, fullName: string, private: boolean, url: string}}
 */
function toRepo(raw) {
    const fullName = String(raw.full_name || raw.fullName || "");
    const [ownerFromName, repoFromName] = fullName.split("/");
    //Gitea 的 full_name 一定存在；兜底用 owner.login + name
    const owner = ownerFromName || String(raw.owner?.login || raw.owner?.username || "");
    const repo = repoFromName || String(raw.name || "");
    return {
        owner,
        repo,
        fullName: `${owner}/${repo}`,
        private: !!raw.private,
        url: raw.html_url || repoUrl(`${owner}/${repo}`),
    };
}

/**
 * 判断某个仓库是否可写。
 *
 * 【momo 改造】两个平台的权限结构不同：
 *   · GitHub: `permissions.push` / `permissions.admin`
 *   · Gitea:  也有 `permissions.push`，但部分版本缺该字段 → 保守当可写
 *
 * @param {any} raw 原始响应
 * @returns {boolean}
 */
function canPush(raw) {
    if (!raw.permissions) return true;
    return !!(raw.permissions.push || raw.permissions.admin);
}

//列出 Token 可以写入的仓库, 按更新时间倒序
export async function listRepos(token) {
    //Gitea 的分页参数是 limit/page，GitHub 是 per_page/page —— 两个都发，各自忽略不认识的
    const re = await rest(token, "GET", "/user/repos", {
        query: {sort: "updated", per_page: 100, limit: 100, page: 1},
    });
    const list = Array.isArray(re.data) ? re.data : [];
    return list.filter(canPush).map(toRepo);
}

//新建一个私有仓库, auto_init 保证仓库有默认分支和第一次提交
export async function createRepo(token, name) {
    const platform = currentGitPlatform();
    const body = {
        name,
        private: true,
        auto_init: true,
        description: "NENO 笔记数据仓库",
    };
    //Gitea/Forgejo 支持显式指定默认分支名；GitHub 用实例默认值
    if (platform !== "github") body.default_branch = "main";

    const re = await rest(token, "POST", "/user/repos", {body});
    return toRepo(re.data);
}

//其他设备/插件(utools, cli, 浏览器插件)使用的 neno token: 配置的 base64 编码, 保持原有格式
export function encodeNenoToken(store) {
    return Base64.encode(JSON.stringify({
        access_token: store.access_token,
        repoName: store.repoName,
        githubName: store.githubName,
        gitUrl: currentApiBase(),
        //【momo 改造】把平台也编进去，导入方才知道该走哪条协议
        platform: currentGitPlatform(),
    }));
}

export function decodeNenoToken(text) {
    let value = String(text || "").trim();
    //支持直接粘贴同步链接
    const index = value.indexOf("#neno-config=");
    if (index !== -1) {
        value = decodeURIComponent(value.substring(index + "#neno-config=".length));
    }
    const data = JSON.parse(Base64.decode(value));

    //【momo 改造】原来任何非 GitHub 的 gitUrl 都被当成"旧的 Gitee 配置"拒绝。
    //现在只有真正的 Gitee 老地址才拒绝，自建 Gitea/Forgejo 正常放行。
    if (data.gitUrl === LEGACY_GITEE_URL) {
        const error = new Error("NENO 已不再支持 Gitee, 请改用 GitHub 或自建 Gitea/Forgejo");
        error.unsupported = true;
        throw error;
    }
    if (!data.access_token || !data.repoName || !data.githubName) {
        throw new Error("配置不完整");
    }

    const platform = String(data.platform || "github").toLowerCase();
    if (PLATFORMS[platform] === undefined) {
        throw new Error(`不支持的代码平台: ${platform}`);
    }
    //GitHub 的基址固定；其他平台做规范化，防止用户粘了尾斜杠或漏了 /api/v1
    const gitUrl = platform === "github"
        ? "https://api.github.com"
        : normalizeApiBase(platform, data.gitUrl || "");

    return {
        access_token: data.access_token,
        repoName: data.repoName,
        githubName: data.githubName,
        gitUrl,
        platform,
    };
}

//同步链接把配置放在 # 之后, 不会随请求发送到服务器
export function buildSyncLink(store) {
    const base = `${window.location.origin}${window.location.pathname}`;
    return `${base}#neno-config=${encodeURIComponent(encodeNenoToken(store))}`;
}
