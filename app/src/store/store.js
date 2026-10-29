import { writable } from "svelte/store";

export const currentPage = writable("neno");//neno(NENO),dayily(每日回顾),luck(每日漫步),setting(设置)
export const settingStore = writable({
    isDark: false,
    themeMode: "light",//light(浅色),dark(深色),system(跟随系统)
    themeColor: "green",//主题色,见 lib/theme.js
});
export const githubStore = writable({
    access_token: "",//代码平台的访问令牌
    repoName: "",//仓库名称
    branch: "master",
    githubName: "",//用户名(仓库所有者)
    lastCommitSha: "",//最后一次提交的sha
    //【momo 改造】新增两个字段，让同一份构建产物能连不同平台
    platform: "github",//github / gitea / forgejo
    gitUrl: "https://api.github.com",//API 基址; Gitea/Forgejo 形如 https://域名/api/v1
});
//notion相关的配置
//internalIntegrationToken apikey
//databaseId 授权的数据库id
export const notionStore = writable({
    isSyncToNotion: false,
    internalIntegrationToken: "",
    databaseId: "",

});
export const countStore = writable({ tagCount: 0, nenoCount: 0, dayCount: 0, dateCount: {} });
//icons: 标签图标 {"#读书": "📚"}
export const tagStore = writable({ pinTags: [], allTags: [], icons: {} });
export const searchNenoByDate = writable({ date: "" });
export const searchNenoByTag = writable({ tag: "" });
export const reload = writable({ tag: 0, action: "" });

export const commitToGithubTag = writable({ timestmp: 0, data: {} });
export const taskCountTag = writable({ all: 0, done: 0 });
//同步状态(不持久化): authError 表示 Token 已失效, 同步暂停直到重新配置
export const syncStatus = writable({ authError: false, syncing: false, error: "", lastSyncAt: 0 });
