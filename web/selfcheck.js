// ====== 站内自检（self-check）v1 — 内置轻量智能体：查问题、报数字，只修安全的项 ======
// 用户 2026-11-09 定：站里内置一个智能体，做加源、测试、验更新日期这类简单操作，
// 让 Mika 轻松一点。第一版 = 站内自检（纯前端 JS）+ Mika 每日 cron（站外脚本）。
// 本文件只做前者；每日脚本在 ~/workspace/kazumiweb/rules-daily-check.py。
//
//
// 能自动做的：
// - 从已知目录（官方 KazumiRules index.json、Plus 仓 index.json）比对版本。
// - 已装规则在官方仓有新版本：有“旧版备份”才自动更新。备份 = 第一次见到
// 某个已装版本时就顺手把当时的官方 raw 存下来（那时 raw 的 version ==
// 已装版本，见 ensureRuleBackups，每次完整自检都先跑一遍）；之后目录出
// 新版时用存好的旧版备份回滚。只在更新那一刻才去拉 raw 是不行的——
// 那时 raw 已经是新版，永远拿不到旧版备份（2026-11-09 复核抓到的毛病）。
// 更新后立刻跑 3 部固定番验证，全过才保留；不过就用备份 JSON 调
// POST /api/rules/import 回滚，并报警。
// - 全新规则（目录里有、站里没装过）：永远不自动装，只列为“待确认候选”，
// 报给 Mika/用户，确认了再装，装完再跑 3 部番验证，不过就删。
// 不能做的：
// - 它自己发现不了新源：不会搜 GitHub、不会逛中文互联网；新规则只能来自
// 已知目录，发现新目录要靠 Mika。
// - 不删任何规则（坏源只报警，不自动删）；不碰 guangsu（不在任何目录里，
// 永远排除在自动更新之外）；不改 CN_HOT_IDS 顺序；不编跳点、不编干净源。
// - 后端没有“不安装就测试某条规则”的接口：新版验证只能先装、再测、
// 不过再回滚——装这个动作短暂发生，但失败的版本不会留下来。
// - 解析成功只证明能出可播流（/api/resolve 回了 playUrl），有声需浏览器
// 真实播放确认，自检不听声音；水印/赞助卡烧进视频像素，自检看不见。
// - 前端写不了共享表：skip-points.json / clean-sources.json 仍由 Mika 写。
// 回归检查（2026-11-09 用户防丢要求）：首页三节/分类列表“往下翻一点就没了”
// 是之前出过的毛病——根因是去重用了常驻集合，第二次回首页把缓存的三节
// 全滤空（第一批实现已改成按次对照去重）。自检记基线（每页每 hash 一份，
// 当天有效），滚动、回首页、切分类再回来后重数卡数：少了、某节整个消失
// 就报。只报问题，不自动改数据、不触发重渲染。
// - 热榜（CN_HOT_IDS）：自检只核对 web/hot-list.json 能拉到、数量与内置
// 数组一致、无重复；排序变更只能由 Mika/用户确认，自检永远不自动改顺序。
// 云合/灯塔/骨朵/B站热度没有公开接口，自检拉不到，只能等 Mika 对照提议。
// 安全：自检全程包 try/catch，出错只报、不挡站；轻量版不跑全量解析。
// 硬规矩（2026-11-09 用户亲口定）：任何检测都不能在他看剧的时候跑——
// 正在播放视频时轻量/完整自检一律不启动（见 videoIsPlaying 守卫），
// 不抢视频的网络和 CPU，不把画面弄卡、更不许卡退；完整自检只在他主动
// 点按钮时跑，超时短、失败就停。滚动/切路由触发的防丢基线对比只是
// DOM 数卡数，不发网络请求，不算检测。
(function () {
"use strict";
if (typeof window === "undefined") return;

// ---- 固定测试集：3 部番（与每日脚本同一套） ----
var SELFCHECK_TITLES = [
{ title: "斗破苍穹", bid: "153197"},
{ title: "吞噬星空", bid: "244239"},
{ title: "一念永恒", bid: "244226"},
];
// ---- 已知目录（只从这里比对，不自己去找新目录） ----
var CATALOGS = [
{ key: "official", label: "官方仓",
indexUrl: "https://raw.githubusercontent.com/Predidit/KazumiRules/main/index.json",
rawBase: "https://raw.githubusercontent.com/Predidit/KazumiRules/main/"},
{ key: "plus", label: "Plus仓",
indexUrl: "https://raw.githubusercontent.com/AzlmZ-del/Kazumi-Plus-Rules/main/index.json",
rawBase: "https://raw.githubusercontent.com/AzlmZ-del/Kazumi-Plus-Rules/main/"},
];
var NEVER_AUTO = { guangsu: true}; // guangsu 不在任何目录里，永远不自动更新
var REPORT_KEY = "selfcheckLastReport";
var BACKUP_KEY = "selfcheckRuleBackups";
var SEARCH_TIMEOUT_MS = 10000;
var EPISODES_TIMEOUT_MS = 15000;
var RESOLVE_TIMEOUT_MS = 45000;

// ---- 纯函数（可单测，也挂到 window.KazumiSelfCheck 上） ----
// 版本号比较：纯数字点分段可比时返回 -1/0/1；带非数字段时返回 null（不可比，不自动更新）
function versionCompare(a, b) {
var pa = String(a == null? "": a).split(".");
var pb = String(b == null? "": b).split(".");
if (!pa.length ||!pb.length) return null;
var n = Math.max(pa.length, pb.length);
for (var i = 0; i < n; i++) {
var x = pa[i] == null? 0: pa[i];
var y = pb[i] == null? 0: pb[i];
if (!/^\d+$/.test(x) ||!/^\d+$/.test(y)) return null;
var d = parseInt(x, 10) - parseInt(y, 10);
if (d!== 0) return d < 0? -1: 1;
}
return 0;
}
function isNewerVersion(installed, catalog) {
var c = versionCompare(installed, catalog);
return c!= null && c < 0;
}
// 裸年月：卡片上绝不该出现的格式（已完结只写“已完结”，更新中写“月日 周X更新”）
function hasBareYearMonth(line) {
return /\d{4}年\d{1,2}月(?![日])/.test(line || "");
}
function loadBackups() {
try { return JSON.parse(localStorage.getItem(BACKUP_KEY) || "{}") || {};} catch (_) { return {};}
}
function saveBackups(o) {
try { localStorage.setItem(BACKUP_KEY, JSON.stringify(o));} catch (_) {}
}
function saveReport(r) {
try { localStorage.setItem(REPORT_KEY, JSON.stringify(r));} catch (_) {}
}
function loadReport() {
try { return JSON.parse(localStorage.getItem(REPORT_KEY) || "null");} catch (_) { return null;}
}
function timedFetch(url, init, ms) {
// 优先用站里现成的 fetchWithTimeout（app.js），没有就自己包 AbortController
if (typeof fetchWithTimeout === "function") return fetchWithTimeout(url, init, ms);
var c = new AbortController();
var t = setTimeout(function () { c.abort();}, ms);
var p = fetch(url, Object.assign({}, init, { signal: c.signal}));
return p.then(function (r) { clearTimeout(t); return r;}, function (e) { clearTimeout(t); throw e;});
}

// ---- 轻量检查：只查已加载内容，不跑全量解析（打开站自动跑一次） ----
function collectLoadedItems() {
var items = [];
var seen = {};
function push(list) {
if (!list) return;
for (var i = 0; i < list.length; i++) {
var it = list[i];
if (it && it.id!= null &&!seen[it.id]) { seen[it.id] = true; items.push(it);}
}
}
try { if (typeof HOME_SECTIONS!== "undefined" && HOME_SECTIONS.items) push(HOME_SECTIONS.items);} catch (_) {}
try { if (typeof LATEST_CACHE!== "undefined") LATEST_CACHE.forEach(function (v) { push(v);});} catch (_) {}
try { if (typeof POPULAR_STATE!== "undefined" && POPULAR_STATE.items) push(POPULAR_STATE.items);} catch (_) {}
return items;
}
function checkDates() {
var res = { name: "更新日期", ok: true, checked: 0, fails: [], detail: ""};
var items = collectLoadedItems();
var today = new Date(); today.setHours(0, 0, 0, 0);
var wdCn = ["日", "一", "二", "三", "四", "五", "六"];
for (var i = 0; i < items.length; i++) {
var it = items[i];
var u;
try { u = updateInfoFor(it);} catch (_) { continue;}
if (!u) continue;
var line = "";
try { line = updateLineFor(it, true) || "";} catch (_) { continue;}
res.checked++;
var title = it.nameCn || it.name || ("id=" + it.id);
if (hasBareYearMonth(line)) {
res.ok = false;
if (res.fails.length < 5) res.fails.push(title + " 显示了裸年月「" + line + "」");
} else if (u.airDate.getTime() > today.getTime() && line.indexOf("待播")!== 0) {
res.ok = false;
if (res.fails.length < 5) res.fails.push(title + " 未来档没标待播「" + line + "」");
} else if (u.finished && line.indexOf("已完结")!== 0) {
res.ok = false;
if (res.fails.length < 5) res.fails.push(title + " 已完结却没写已完结「" + line + "」");
} else if (!u.finished && u.airDate.getTime() <= today.getTime() && line.indexOf("周" + wdCn[u.weekday]) < 0) {
res.ok = false;
if (res.fails.length < 5) res.fails.push(title + " 星期算错，应为周" + wdCn[u.weekday] + "「" + line + "」");
}
}
// 再扫一遍页面上实际显示的文字：有裸年月就是真凭实据
// （选择器是 .poster-card .sub：sub 是卡片里的子 div，不是卡片自己的 class）
try {
var subs = document.querySelectorAll(".poster-card .sub");
for (var j = 0; j < subs.length; j++) {
var t = subs[j].textContent || "";
if (hasBareYearMonth(t)) {
res.ok = false;
if (res.fails.length < 5) res.fails.push("页面上已显示裸年月「" + t + "」");
break;
}
}
} catch (_) {}
res.detail = "查了 " + res.checked + " 部" + (res.fails.length? "，问题 " + res.fails.length + " 条（仅列前 5 条）": "，无问题");
return res;
}
function checkDuplicates() {
var res = { name: "首页跨节重复", ok: true, checked: 0, fails: [], detail: ""};
try {
var where = {};
var secs = document.querySelectorAll("[data-home-section]");
secs.forEach(function (sec) {
var key = sec.getAttribute("data-home-section");
sec.querySelectorAll(".poster-card .name").forEach(function (n) {
var t = (n.textContent || "").trim();
if (!t) return;
where[t] = where[t] || [];
if (where[t].indexOf(key) < 0) where[t].push(key);
});
});
var dups = Object.keys(where).filter(function (t) { return where[t].length > 1;});
res.checked = Object.keys(where).length;
if (dups.length) {
res.ok = false;
res.fails = dups.slice(0, 5).map(function (t) { return "「" + t + "」出现在 " + where[t].join("、");});
}
res.detail = "查了 " + res.checked + " 个标题" + (dups.length? "，重复 " + dups.length + " 个": "，无重复");
} catch (e) { res.ok = false; res.detail = "查不了：" + e.message;}
return res;
}
function checkBrokenImages() {
var res = { name: "裂图", ok: true, checked: 0, fails: [], detail: ""};
try {
var imgs = document.querySelectorAll(".poster-card img,.tl-card img");
var broken = 0;
imgs.forEach(function (im) {
if (im.getAttribute("data-broken") === "1" || im.style.display === "none") broken++;
else if (im.complete && im.naturalWidth === 0 && im.getAttribute("src")) broken++;
});
res.checked = imgs.length;
res.ok = broken === 0;
res.detail = "查了 " + imgs.length + " 张图，裂/隐藏 " + broken + " 张";
if (broken) res.fails.push(broken + " 张图裂了或已被隐藏（coverImg 已兜底，不留灰盒）");
} catch (e) { res.ok = false; res.detail = "查不了：" + e.message;}
return res;
}
function checkKids() {
var res = { name: "少儿节", ok: true, checked: 0, fails: [], detail: ""};
try {
if (typeof POPULAR_STATE!== "undefined" && POPULAR_STATE.region === "cn") {
res.checked = (POPULAR_STATE.kidsItems || []).length;
res.detail = "国产分类下少儿 " + res.checked + " 部（目标至少 20 部，后台补页中）";
res.ok = res.checked >= 1; // 有 1 部就算通过；低于 20 只提示、不判失败
if (res.checked < 20) res.detail += "（未到 20 部目标，只提示）"; // 警告写进 detail，不进 fails、不判失败
} else {
res.detail = "未加载（切到“国产”分类后才有少儿数）";
}
} catch (e) { res.detail = "查不了：" + e.message;}
return res;
}
// ---- 首页三节/分类列表还在不在（回归检查，只报问题，不改数据） ----
// 基线按当前 hash + 当天记一份（切页、换天就重记，不过期数据不拿来比）。
// 触发：每次轻量/完整自检 + 滚动停下后 + 切路由后（各延迟 1-1.5 秒等渲染完）。
var sectionBaselines = {};
var sectionPersistLast = null;
function todayKey() {
try {
var d = new Date();
return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
} catch (_) { return ""; }
}
function currentHashKey() {
try { return (typeof location !== "undefined" && location.hash) || "#/home"; } catch (_) { return "#/home"; }
}
function snapshotSections() {
var sections = {};
var total = 0;
try {
var secs = document.querySelectorAll("[data-home-section]");
for (var i = 0; i < secs.length; i++) {
var key = secs[i].getAttribute("data-home-section") || ("sec" + i);
var n = secs[i].querySelectorAll(".poster-card").length;
sections[key] = n;
total += n;
}
} catch (_) {}
var grid = 0;
try { grid = document.querySelectorAll(".poster-grid .poster-card").length; } catch (_) {}
return { sections: sections, grid: grid, total: total + grid };
}
function fmtSections(snap) {
var parts = Object.keys(snap.sections).map(function (k) { return k + " " + snap.sections[k] + "张"; });
parts.push("分类列表 " + snap.grid + "张");
return parts.join("、");
}
function checkSectionPersistence() {
var res = { name: "首页三节还在不在", ok: true, checked: 0, fails: [], detail: "" };
try {
var snap = snapshotSections();
var key = todayKey() + "|" + currentHashKey();
res.checked = snap.total;
if (snap.total === 0) {
if (!sectionBaselines[key]) {
res.detail = "本页没加载出首页三节/分类列表（不在首页或分类页），本次不记基线";
} else {
res.ok = false;
res.detail = "基线 " + fmtSections(sectionBaselines[key].snap) + "，现在一张都没了";
res.fails.push("首页三节/分类列表整片消失（之前记过基线，现在 0 张）");
}
sectionPersistLast = res;
return res;
}
var base = sectionBaselines[key];
if (!base) {
sectionBaselines[key] = { at: new Date().toISOString(), snap: snap };
res.detail = "已记基线：" + fmtSections(snap) + "（当天有效；滚动/回首页/切分类后再数，少了就报）";
sectionPersistLast = res;
return res;
}
var problems = [];
Object.keys(base.snap.sections).forEach(function (k) {
var before = base.snap.sections[k];
var now = (snap.sections[k] == null) ? 0 : snap.sections[k];
if (now < before) problems.push(k + "节从 " + before + " 张掉到 " + now + " 张");
});
if (snap.grid < base.snap.grid) problems.push("分类列表从 " + base.snap.grid + " 张掉到 " + snap.grid + " 张");
if (problems.length) {
res.ok = false;
res.fails = problems;
res.detail = "基线 " + fmtSections(base.snap) + "；现在 " + fmtSections(snap);
} else {
res.detail = "基线 " + fmtSections(base.snap) + "；现在 " + fmtSections(snap) + "，没少";
}
} catch (e) { res.ok = false; res.detail = "查不了：" + e.message; }
sectionPersistLast = res;
return res;
}
var sectionPersistTimer = null;
function scheduleSectionPersist(delayMs) {
try {
if (sectionPersistTimer) clearTimeout(sectionPersistTimer);
sectionPersistTimer = setTimeout(function () {
sectionPersistTimer = null;
try { checkSectionPersistence(); } catch (_) {}
}, delayMs || 1200);
} catch (_) {}
}
function watchSectionPersistence() {
try {
if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
if (watchSectionPersistence._done) return;
watchSectionPersistence._done = true;
window.addEventListener("scroll", function () { scheduleSectionPersist(1000); }, { passive: true });
window.addEventListener("hashchange", function () { scheduleSectionPersist(1500); });
} catch (_) {}
}
// ---- 播放中禁检（硬规矩）：任何检测都不能在看剧时跑 ----
// 页面上有视频正在播（没暂停、没播完、已起播）就返回 true；
// 轻量/完整自检的入口都先查它，正在播就一律不启动、不发请求、不抢带宽。
function videoIsPlaying() {
try {
var v = document.querySelector("video");
return !!(v && !v.paused && !v.ended && v.currentTime > 0);
} catch (_) { return false; }
}
async function checkPlugins() {
var res = { name: "已装规则", ok: true, checked: 0, fails: [], detail: ""};
try {
var plugins = await fetchJson("/api/plugins");
res.checked = (plugins || []).length;
if (!res.checked) {
res.ok = false;
res.detail = "规则被清空了（/api/plugins 为空，部署后常见，需重装）";
res.fails.push("规则列表为空");
return res;
}
res.detail = "已装 " + res.checked + " 条：" + plugins.map(function (p) { return p.name + " " + p.version;}).join("、");
} catch (e) {
res.ok = false;
res.detail = "拉不到规则列表：" + e.message;
res.fails.push("拉不到规则列表");
}
return res;
}
// 热榜只核对、不重排：hot-list.json 能拉到、数量与内置数组一致、无重复；
// 顺序对不上只报给 Mika/用户确认，自检永远不自动改顺序（前 20 是用户亲定的）。
// 云合/灯塔/骨朵/B站热度没有公开接口，自检拉不到，只能等 Mika 对照提议。
async function checkHotList() {
var res = { name: "热榜名单", ok: true, checked: 0, fails: [], detail: ""};
try {
var r = await timedFetch("/assets/hot-list.json", {}, 10000);
if (!r.ok) {
res.ok = false;
res.detail = "hot-list.json 拉不到（HTTP " + r.status + "），用内置数组兜底；排序变更需 Mika 确认";
res.fails.push("hot-list.json 拉不到");
return res;
}
var data = await r.json();
var ids = (data && data.ids) || [];
res.checked = ids.length;
var dups = ids.filter(function (id, i) { return ids.indexOf(id)!== i;});
if (!ids.length) {
res.ok = false;
res.detail = "hot-list.json 里没有 id，内置数组仍在用；排序变更需 Mika 确认";
res.fails.push("hot-list.json 为空");
return res;
}
if (dups.length) {
res.ok = false;
res.fails.push("热榜有重复 id：" + dups.slice(0, 5).join("、"));
}
var builtin = [];
try { if (typeof CN_HOT_IDS_BUILTIN!== "undefined") builtin = CN_HOT_IDS_BUILTIN;} catch (_) {}
if (builtin.length && builtin.length!== ids.length) {
res.ok = false;
res.fails.push("hot-list.json 共 " + ids.length + " 部，内置数组 " + builtin.length + " 部，数量对不上");
} else if (builtin.length) {
var firstDiff = -1;
for (var i = 0; i < ids.length; i++) { if (ids[i]!== builtin[i]) { firstDiff = i; break; } }
if (firstDiff >= 0) {
res.ok = false;
res.fails.push("hot-list.json 第 " + (firstDiff + 1) + " 位起与内置数组顺序不同（需 Mika/用户确认才改，自检不改）");
}
}
res.detail = "hot-list.json 版本 " + (data.version || "未知") + "，共 " + ids.length + " 部"
+ (dups.length? "，重复 " + dups.length + " 个": "，无重复")
+ (res.fails.length? "；排序变更需 Mika/用户确认，自检不改顺序": "；顺序与内置数组一致");
} catch (e) {
res.ok = false;
res.detail = "查不了：" + e.message;
res.fails.push("查不了");
}
return res;
}
// 安全自动修（只做这三件）：集数回填重跑（已有逻辑）、24h 失败源跳过（已有）、裂图隐藏（已有）。
// 不装/不删规则、不改日期数据本身。
function autoFixSafe() {
var fixed = [];
try {
if (typeof HOME_SECTIONS!== "undefined" && HOME_SECTIONS.items && typeof attachAiredCounts === "function") {
attachAiredCounts(HOME_SECTIONS.items.slice());
fixed.push("已触发集数回填");
}
} catch (_) {}
return fixed;
}

// ---- 3 部番逐源验证（搜索 + 选集 + 解析） ----
async function verifyTitleOnRule(plugin, title) {
var t0 = (typeof performance!== "undefined" && performance.now)? performance.now(): Date.now();
var now = function () { return Math.round(((typeof performance!== "undefined" && performance.now)? performance.now(): Date.now()) - t0);};
try {
var items = await pluginSearchSingle(plugin, title);
var searchMs = now();
if (!items ||!items.length) return { title: title, ok: false, stage: "search", searchMs: searchMs, detail: "搜不到"};
var first = items[0];
var firstName = first.nameCn || first.name || "";
if (firstName.indexOf(title) < 0 && title.indexOf(firstName) < 0) {
return { title: title, ok: false, stage: "search", searchMs: searchMs, detail: "首条不对：「" + firstName + "」"};
}
var epsRes = await timedFetch("/api/episodes?plugin=" + encodeURIComponent(plugin) + "&src=" + encodeURIComponent(first.src), {}, EPISODES_TIMEOUT_MS);
if (!epsRes.ok) return { title: title, ok: false, stage: "episodes", searchMs: searchMs, detail: "选集 HTTP " + epsRes.status};
var epsData = await epsRes.json();
var eps = (((epsData.roads || [])[0] || {}).episodes) || [];
if (!eps.length ||!eps[0]) return { title: title, ok: false, stage: "episodes", searchMs: searchMs, detail: "选集 0 集"};
var rc = new AbortController();
var rt = setTimeout(function () { rc.abort();}, RESOLVE_TIMEOUT_MS);
var rres;
try { rres = await fetch("/api/resolve?plugin=" + encodeURIComponent(plugin) + "&episodeUrl=" + encodeURIComponent(eps[0].src), { signal: rc.signal});}
finally { clearTimeout(rt);}
var resolveMs = now() - searchMs;
if (!rres.ok) return { title: title, ok: false, stage: "resolve", searchMs: searchMs, resolveMs: resolveMs, detail: "解析 HTTP " + rres.status};
var data = await rres.json();
if (!data.playUrl &&!data.originalUrl) return { title: title, ok: false, stage: "resolve", searchMs: searchMs, resolveMs: resolveMs, detail: "解析无可播地址"};
return { title: title, ok: true, stage: "ok", searchMs: searchMs, resolveMs: resolveMs, detail: "解析出可播流"};
} catch (e) {
var isTimeout = e && e.name === "AbortError";
return { title: title, ok: false, stage: isTimeout? "timeout": "error", detail: (e && e.message) || "未知错误"};
}
}
async function verifyRule(plugin) {
var results = [];
for (var i = 0; i < SELFCHECK_TITLES.length; i++) {
results.push(await verifyTitleOnRule(plugin, SELFCHECK_TITLES[i].title));
}
return { plugin: plugin, results: results, ok: results.every(function (r) { return r.ok;})};
}

// ---- 目录比对 + 自动更新（只动官方仓的已装规则，且有旧版备份才动） ----
async function fetchCatalog(cat) {
try {
var res = await timedFetch(cat.indexUrl, {}, 15000);
if (!res.ok) return { catalog: cat, items: null, error: "HTTP " + res.status};
var data = await res.json();
return { catalog: cat, items: Array.isArray(data)? data: (data.items || []), error: null};
} catch (e) { return { catalog: cat, items: null, error: (e && e.message) || "拉不到"};}
}
async function fetchRuleJson(cat, name) {
try {
var res = await timedFetch(cat.rawBase + encodeURIComponent(name) + ".json", {}, 15000);
if (!res.ok) return null;
return await res.json();
} catch (_) { return null;}
}
// 备份先行：第一次见到某个已装版本时就顺手把当时的官方 raw 存下来
// （那时 raw 的 version == 已装版本，才能当旧版备份）。每次完整自检
// 在比对更新之前先跑一遍；只在更新那一刻才拉 raw 是不行的——那时
// raw 已经是新版，永远拿不到旧版备份（2026-11-09 复核抓到的毛病）。
async function ensureRuleBackups(installed, officialCat) {
var backups = loadBackups();
var changed = false;
for (var i = 0; i < (installed || []).length; i++) {
var p = installed[i];
if (!p || NEVER_AUTO[p.name]) continue;
var saved = backups[p.name];
if (saved && String(saved.version) === String(p.version) && saved.json) continue;
var raw = await fetchRuleJson(officialCat, p.name);
if (raw && raw.name === p.name && String(raw.version) === String(p.version)) {
backups[p.name] = { version: String(p.version), json: raw, savedAt: new Date().toISOString() };
changed = true;
}
}
if (changed) saveBackups(backups);
}
// 自动更新一条已装规则：备份（优先用 ensureRuleBackups 存好的旧版；
// 没有时兜底拉一次 raw，只有 raw 的 version 仍等于已装版本才算备份）→
// 安装新版 → 3 部番验证 → 全过保留，不过回滚备份。无有效备份时不动，只报。
async function autoUpdateRule(installed, catalogItem, officialCat) {
var name = installed.name;
var from = installed.version, to = catalogItem.version;
if (NEVER_AUTO[name]) return { name: name, action: "skip", detail: name + " 永远不自动更新"};
var backups = loadBackups();
var saved = backups[name];
var backupJson = (saved && String(saved.version) === String(from) && saved.json) ? saved.json : null;
if (!backupJson) {
var raw = await fetchRuleJson(officialCat, name);
if (raw && raw.name === name && String(raw.version) === String(from)) {
backupJson = raw;
backups[name] = { version: String(from), json: raw, savedAt: new Date().toISOString() };
saveBackups(backups);
}
}
if (!backupJson) {
return { name: name, action: "skip-no-backup",
detail: name + " 有新版 " + from + "→" + to + "，但拉不到旧版 " + from + " 的 JSON 备份，暂不自动更新（等 Mika 手动处理）"};
}
try {
await fetchJsonPost("/api/rules/install", { name: name});
} catch (e) {
return { name: name, action: "install-failed", detail: name + " 安装新版 " + to + " 失败：" + e.message + "，旧版未动"};
}
var verify = await verifyRule(name);
if (verify.ok) {
return { name: name, action: "updated", detail: name + " 已自动更新 " + from + "→" + to + "，3 部番验证全过"};
}
// 回滚：用备份 JSON 重新导入（同名替换）
var rolledBack = false, rollbackErr = "";
try {
await fetchJsonPost("/api/rules/import", { json: backupJson});
rolledBack = true;
} catch (e) { rollbackErr = e.message;}
return { name: name, action: rolledBack? "rolled-back": "rollback-failed",
detail: name + " 更新后 3 部番验证不过（" + verify.results.filter(function (r) { return!r.ok;}).map(function (r) { return r.title + ":" + r.detail;}).join("；") + "），"
+ (rolledBack? "已回滚到旧版 " + from: "回滚失败：" + rollbackErr + "，需 Mika 手动处理")};
}

async function runLight(opts) {
opts = opts || {};
// 正在播放视频时不跑任何检测：不发请求、不抢带宽、不卡画面；
// 也不覆盖上次的真实自检报告（直接返回，不 saveReport）。
if (videoIsPlaying() && !opts.force) {
return { kind: "light", at: new Date().toISOString(), checks: [{ name: "自检", ok: true, detail: "正在播放视频，本次不跑检测（不抢网络、不卡画面）" }], fixed: [], ok: true, skippedForPlayback: true };
}
var report = { kind: "light", at: new Date().toISOString(), checks: [], fixed: [], ok: true};
try { report.checks.push(checkDates());} catch (e) { report.checks.push({ name: "更新日期", ok: false, detail: "查不了：" + e.message});}
try { report.checks.push(checkDuplicates());} catch (e) { report.checks.push({ name: "首页跨节重复", ok: false, detail: "查不了：" + e.message});}
try { report.checks.push(checkBrokenImages());} catch (e) { report.checks.push({ name: "裂图", ok: false, detail: "查不了：" + e.message});}
try { report.checks.push(checkKids());} catch (e) { report.checks.push({ name: "少儿节", ok: false, detail: "查不了：" + e.message});}
try { report.checks.push(checkSectionPersistence());} catch (e) { report.checks.push({ name: "首页三节还在不在", ok: false, detail: "查不了：" + e.message});}
try { report.checks.push(await checkPlugins());} catch (e) { report.checks.push({ name: "已装规则", ok: false, detail: "查不了：" + e.message});}
try { report.checks.push(await checkHotList());} catch (e) { report.checks.push({ name: "热榜名单", ok: false, detail: "查不了：" + e.message});}
report.fixed = autoFixSafe();
report.ok = report.checks.every(function (c) { return c.ok;});
if (!opts.quiet) saveReport(report);
else saveReport(report);
return report;
}

async function runFull(onProgress) {
var report = { kind: "full", at: new Date().toISOString(), checks: [], fixed: [], catalog: {}, verify: [], updates: [], candidates: [], ok: true};
function progress(t) { try { if (onProgress) onProgress(t);} catch (_) {}}
progress("正在做轻量检查…");
var light = await runLight({ quiet: true});
if (light.skippedForPlayback) {
report.checks = light.checks;
report.ok = true;
report.skippedForPlayback = true;
return report; // 正在播放：轻量已跳过，完整版也不继续，不覆盖上次真实报告
}
report.checks = light.checks;
report.fixed = light.fixed;
// 目录比对（官方 + Plus）
progress("正在比对规则目录…");
var installed = [];
try { installed = await fetchJson("/api/plugins") || [];} catch (e) { installed = [];}
var cats = [];
for (var ci = 0; ci < CATALOGS.length; ci++) cats.push(await fetchCatalog(CATALOGS[ci]));
var official = cats[0], plus = cats[1];
var installedNames = {};
installed.forEach(function (p) { installedNames[p.name] = p;});
function byName(items) {
var m = {};
(items || []).forEach(function (it) { if (it && it.name) m[it.name] = it;});
return m;
}
var officialByName = official.items? byName(official.items): null;
var plusByName = plus.items? byName(plus.items): null;
report.catalog = {
official: official.items? official.items.length + " 条": "拉不到（" + official.error + "）",
plus: plus.items? plus.items.length + " 条": "拉不到（" + plus.error + "）",
};
// 候选新规则：目录里有、站里没装过 —— 只列出，永远不自动装
var candSeen = {};
[officialByName, plusByName].forEach(function (m, idx) {
if (!m) return;
Object.keys(m).forEach(function (n) {
if (!installedNames[n] &&!candSeen[n]) {
candSeen[n] = true;
report.candidates.push({ name: n, version: String(m[n].version), from: idx === 0? "官方仓": "Plus仓", action: "待确认：不自动装，确认后手动装再验证"});
}
});
});
// Plus 仓同名高版本：同名≠同规则，只列为候选，不自动更新
if (plusByName) {
installed.forEach(function (p) {
var it = plusByName[p.name];
if (it && isNewerVersion(p.version, it.version)) {
report.candidates.push({ name: p.name, version: String(it.version), from: "Plus仓（同名高版本）", action: "待确认：Plus 版与官方版不是同一条规则，不自动更新"});
}
});
}
// 自动更新：只动官方仓同名高版本，且有旧版备份才动。
// 先跑 ensureRuleBackups：目录出新版之前把当时的旧版 raw 存下来，
// 否则更新那一刻再拉 raw 已经是新版，永远拿不到备份（见上面注释）。
if (officialByName) {
await ensureRuleBackups(installed, CATALOGS[0]);
for (var i = 0; i < installed.length; i++) {
var p = installed[i];
var it = officialByName[p.name];
if (it && isNewerVersion(p.version, it.version)) {
progress("正在自动更新 " + p.name + " " + p.version + "→" + it.version + "…");
report.updates.push(await autoUpdateRule(p, it, CATALOGS[0]));
} else if (it && String(it.version)!== String(p.version) && versionCompare(p.version, it.version) == null) {
report.updates.push({ name: p.name, action: "skip-version", detail: p.name + " 版本号比不了（" + p.version + " vs " + it.version + "），不自动更新"});
}
}
} else {
report.updates.push({ name: "-", action: "skip", detail: "官方目录拉不到，本次不自动更新"});
}
// 3 部番逐源验证（全部已装规则）
progress("正在逐源验证 3 部番…");
var names = installed.map(function (p) { return p.name;});
var _verifyResults = [];
for (var _vi = 0; _vi < names.length; _vi++) { _verifyResults.push(await verifyRule(names[_vi])); }
report.verify = _verifyResults;
report.ok = report.checks.every(function (c) { return c.ok;})
&& report.verify.every(function (v) { return v.ok;})
&& report.updates.every(function (u) { return u.action === "updated" || u.action === "skip" || u.action === "skip-no-backup" || u.action === "skip-version";});
saveReport(report);
return report;
}

// ---- “我的”页挂载（不改 app.js：包一层 renderTabMy） ----
var running = false;
function fmtTime(iso) {
try { return new Date(iso).toLocaleString("zh-CN", { hour12: false});} catch (_) { return iso || "";}
}
function renderReportInto(box, report) {
if (!report) { box.textContent = "还没跑过自检，点下面的按钮开始。"; return;}
var lines = [];
lines.push("上次：" + fmtTime(report.at) + "（" + (report.kind === "full"? "完整自检": "轻量自检") + "）· " + (report.ok? "全部通过": "有问题，见下"));
report.checks.forEach(function (c) {
lines.push((c.ok? "✓ ": "✗ ") + c.name + "：" + c.detail);
(c.fails || []).forEach(function (f) { lines.push("　　- " + f);});
});
if (report.fixed && report.fixed.length) lines.push("自动修了：" + report.fixed.join("、") + "（只修安全的项）");
if (report.catalog && (report.catalog.official || report.catalog.plus)) {
lines.push("目录：官方仓 " + report.catalog.official + "；Plus仓 " + report.catalog.plus);
}
(report.updates || []).forEach(function (u) { lines.push("更新：" + u.detail);});
(report.verify || []).forEach(function (v) {
lines.push((v.ok? "✓ ": "✗ ") + v.plugin + "："
+ v.results.map(function (r) { return r.title + (r.ok? "搜" + ((r.searchMs || 0) / 1000).toFixed(1) + "s/解" + ((r.resolveMs || 0) / 1000).toFixed(1) + "s": "失败(" + r.detail + ")");}).join("；"));
});
(report.candidates || []).forEach(function (c) {
lines.push("候选：" + c.name + " " + c.version + "（" + c.from + "）— " + c.action);
});
lines.push("注意：解析成功只证明能出可播流，有声和水印需浏览器真实播放确认；新规则要确认后才装。");
box.textContent = lines.join("\n");
}
function appendSelfcheckSection(container) {
if (!container || container.querySelector("[data-selfcheck]")) return;
var page = container.querySelector(".page.my") || container;
var statusBox = el("div", { class: "selfcheck-status", style: "white-space:pre-wrap;font-size:13px;line-height:1.7"}, "还没跑过自检。");
var runBtn = button("开始完整自检", { icon: "check_circle", variant: "filled", onclick: async function () {
if (running) return;
// 正在播放视频时不启动完整自检（硬规矩：不抢网络、不卡画面、不卡退）。
if (videoIsPlaying()) { statusBox.textContent = "正在播放视频，先暂停再自检（检测不在播放时跑，不卡画面）。"; toast("正在播放，先暂停再自检"); return; }
running = true;
runBtn.disabled = true;
statusBox.textContent = "正在完整自检（3 部番逐源验证，可能要 1 分钟左右）…";
try {
var rep = await runFull(function (t) { statusBox.textContent = t;});
if (rep.skippedForPlayback) { statusBox.textContent = "正在播放视频，本次没跑（检测不在播放时跑，不卡画面）。"; toast("正在播放，先暂停再自检"); }
else { renderReportInto(statusBox, rep); toast(rep.ok? "自检全部通过": "自检发现问题，见站内自检一节"); }
} catch (e) {
statusBox.textContent = "自检出错：" + e.message;
} finally { running = false; runBtn.disabled = false;}
}});
var note = el("div", { style: "font-size:12px;opacity:.75;margin-top:6px"},
"轻量自检打开站时自动跑（只查已加载内容）；完整自检点按钮才跑；正在播放视频时自检不跑，不卡画面。自动更新只动官方仓已装规则的新版且有旧版备份时才动；新规则永远先报、确认后才装；不删源、不碰 guangsu。");
var sec;
try {
sec = section({ title: "站内自检", desc: "日期、源、重复、裂图自己查；有问题才报", body: el("div", {}, statusBox, el("div", { style: "margin-top:8px"}, runBtn), note)});
} catch (_) {
sec = el("div", { class: "section"}, el("div", { class: "section-title"}, "站内自检"), statusBox, runBtn, note);
}
sec.setAttribute("data-selfcheck", "1");
page.append(sec);
renderReportInto(statusBox, loadReport());
}
function hookMyPage() {
try {
if (typeof renderTabMy!== "function" || renderTabMy.__selfcheckHooked) return;
var orig = renderTabMy;
var wrapped = async function (container) {
await orig(container);
try { appendSelfcheckSection(container);} catch (_) {}
};
wrapped.__selfcheckHooked = true;
renderTabMy = wrapped;
} catch (_) {}
}

// 轻量版打开站自动跑一次（只查已加载内容，不跑全量解析）
function autoLight() {
try {
if (!document.querySelector(".poster-card") &&!(typeof HOME_SECTIONS!== "undefined" && HOME_SECTIONS.items)) return;
runLight({ quiet: true}).catch(function () {});
} catch (_) {}
}
hookMyPage();
watchSectionPersistence();
if (document.readyState === "complete") setTimeout(autoLight, 1200);
else window.addEventListener("load", function () { setTimeout(autoLight, 1200);});

window.KazumiSelfCheck = {
versionCompare: versionCompare,
isNewerVersion: isNewerVersion,
hasBareYearMonth: hasBareYearMonth,
checkSectionPersistence: checkSectionPersistence,
snapshotSections: snapshotSections,
runLight: runLight,
runFull: runFull,
ensureRuleBackups: ensureRuleBackups,
autoUpdateRule: autoUpdateRule,
checkHotList: checkHotList,
videoIsPlaying: videoIsPlaying,
titles: SELFCHECK_TITLES,
};
})();
