//基于 fetch 的代码平台 REST / GraphQL 客户端
//原版 neno 只支持 GitHub。momo 让同一个客户端可以指向 GitHub、Gitea、Forgejo。
//
//## 为什么要运行时可配置
//
//原版把 API 基址固化成一个模块级常量:
//
//    export const GITHUB_API = DEV_API || "https://api.github.com";
//
//这在"自建平台"场景下直接失效 —— 用户填的域名是运行时才知道的。
//但 GITHUB_API 这个名字已经被若干处引用, 所以这里保留导出, 只是用 Proxy
//让它在每次取值时才读真实值。字符串拼接 (`GITHUB_API + path`) 依然工作。
//
//## 唯一需要特别注意的差异
//
//两个平台的错误响应体结构不同:
//  · GitHub: {"message": "...", "documentation_url": "..."}
//  · Gitea : {"message": "...", "url": "..."}  或  {"errors": [...]}
//下面 readError 把两者都兜住。
import {normalizeApiBase} from "../lib/sync/platform.mjs";

//开发环境可以通过 localStorage 的 neno-dev-github-api 指向本地模拟的 GitHub(用于同步测试), 生产构建中不生效
const DEV_API = import.meta.env.DEV ? (() => {
    try {
        return window.localStorage.getItem("neno-dev-github-api");
    } catch (e) {
        return null;
    }
})() : null;

/** @type {string} 当前生效的 API 基址(无尾斜杠) */
let apiBase = DEV_API || "https://api.github.com";

/** @type {string} 当前生效的平台 id */
let platform = "github";

/**
 * 设置当前代码平台。
 *
 * 必须在发起任何请求之前调用。App.svelte 在启动和配置变更时都会调它,
 * 所以用户改完设置立刻生效, 不需要刷新页面。
 *
 * @param {object} [config] 配置
 * @param {string} [config.platform] 平台 id: github / gitea / forgejo
 * @param {string} [config.baseUrl] 自建平台的 API 基址(可只填域名)
 * @returns {string} 规范化后的 API 基址
 */
export function configureApi(config = {}) {
    const next = String(config.platform || platform || "github").toLowerCase();
    platform = next === "" ? "github" : next;

    if (platform === "github") {
        //GitHub 的基址固定, DEV_API 仅用于开发期指向 mock
        apiBase = DEV_API || "https://api.github.com";
        return apiBase;
    }

    //自建平台: 允许用户只填域名(补 /api/v1)、或已带反代前缀
    apiBase = normalizeApiBase(platform, config.baseUrl);
    return apiBase;
}

/**
 * 当前生效的 API 基址。
 *
 * @returns {string} 基址(无尾斜杠); 自建平台尚未填写时为空串
 */
export function currentApiBase() {
    return apiBase;
}

/**
 * 当前生效的平台 id。
 *
 * @returns {string} github / gitea / forgejo
 */
export function currentGitPlatform() {
    return platform;
}

/**
 * 动态取值的 API 基址。
 *
 * ⚠️ 不要用 `import {GITHUB_API} from ...` 再存到变量里长期持有 ——
 * 那样拿到的是 Proxy 本身(没问题), 但如果你把它转成字符串保存, 就固化了
 * 当时的值。直接用 `currentApiBase()` 最清楚。
 */
export const GITHUB_API = new Proxy({}, {
    get(target, prop) {
        if (prop === Symbol.toPrimitive) return () => apiBase;
        if (prop === "toString") return () => apiBase;
        if (prop === "valueOf") return () => apiBase;
        if (prop === "length") return apiBase.length;
        if (typeof prop === "string") return apiBase[prop];
        return undefined;
    },
    has() {
        return true;
    },
});

export class GithubError extends Error {
    constructor(message, status, extra = {}) {
        super(message);
        this.name = "GithubError";
        this.status = status;
        Object.assign(this, extra);
    }
}

/**
 * 按平台生成请求头。
 *
 * GitHub 要求 `Accept: application/vnd.github+json`(用 text/plain 会拿到
 * 不同的错误结构); Gitea 只认普通 JSON。Authorization 两家都是
 * `token <token>`, 所以不用分支。
 */
function headers(token, hasBody) {
    const result = {
        Accept: platform === "github" ? "application/vnd.github+json" : "application/json",
        Authorization: `token ${String(token || "").trim()}`,
    };
    if (hasBody) result["Content-Type"] = "application/json";
    return result;
}

async function readError(response) {
    let message = response.statusText;
    try {
        const body = await response.json();
        message = body.message || body.error || message;
        //Gitea 有时把细节放在 errors 数组里
        if (Array.isArray(body.errors) && body.errors.length > 0) {
            const detail = body.errors
                .map((item) => (typeof item === "string" ? item : item?.message))
                .filter(Boolean)
                .join("; ");
            if (detail) message = `${message}: ${detail}`;
        }
    } catch (e) {
        //忽略无法解析的错误内容
    }
    return new GithubError(message, response.status);
}

//REST 请求, 返回 {data, headers, etag}; query 会拼接到地址上
//传入 etag 时发送条件请求: 内容没有变化时返回 {notModified: true}
export async function rest(token, method, path, {body, query, etag} = {}) {
    if (!apiBase) {
        throw new GithubError("尚未配置代码平台地址", 0);
    }
    let url = apiBase + path;
    if (query) {
        const params = new URLSearchParams();
        Object.entries(query).forEach(([key, value]) => value !== undefined && params.set(key, String(value)));
        url += `?${params}`;
    }
    let response;
    try {
        const requestHeaders = headers(token, body !== undefined);
        if (etag) requestHeaders["If-None-Match"] = etag;
        response = await fetch(url, {
            method,
            headers: requestHeaders,
            body: body === undefined ? undefined : JSON.stringify(body),
            //同步需要拿到最新的分支状态, 不使用浏览器缓存
            cache: "no-store",
        });
    } catch (error) {
        throw new GithubError(error.message || "网络连接失败", 0);
    }
    if (response.status === 304) return {notModified: true, data: null, headers: response.headers, etag};
    if (!response.ok) throw await readError(response);
    const data = response.status === 204 ? null : await response.json();
    return {data, headers: response.headers, etag: response.headers.get("etag")};
}

/**
 * GraphQL 请求 —— 只有 GitHub 有。
 *
 * 自建平台没有 GraphQL 端点, 所以这里直接给出可读的错误, 而不是发一个
 * 必然 404 的请求。调用方(syncEngine)只在 caps.branchHeadCAS 为 true 时
 * 才会走到这里, 所以正常情况下不会命中。
 */
export async function graphql(token, query, variables) {
    if (platform !== "github") {
        throw new GithubError(`${platform} 不支持 GraphQL`, 0);
    }
    let response;
    try {
        response = await fetch(`${apiBase}/graphql`, {
            method: "POST",
            headers: headers(token, true),
            body: JSON.stringify({query, variables}),
        });
    } catch (error) {
        throw new GithubError(error.message || "网络连接失败", 0);
    }
    if (!response.ok) throw await readError(response);
    const result = await response.json();
    if (result.errors && result.errors.length > 0) {
        const first = result.errors[0];
        //★ 注意状态码是 200 —— 上层靠这个值判断"可能是 tip 冲突"
        throw new GithubError(first.message, 200, {type: first.type, errors: result.errors});
    }
    return result.data;
}
