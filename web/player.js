// ====== Danmaku ======
class DanmakuLayer {
  constructor(video, container) {
    this.video = video;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "danmaku-canvas";
    container.append(this.canvas);
    this.ctx = this.canvas.getContext("2d");
    this.items = [];
    this.cursor = 0;
    this.activeRolling = [];
    this.activeFixed = [];
    this.lanes = { rolling: [], top: [], bottom: [] };
    this.lineH = 28;
    this.lastVideoTime = 0;
    this.lastTickAt = 0;
    this.rafId = null;
    this.config = this.loadConfig();
    this.applyVisibility();

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
    this.resize();
    this.start();
  }

  loadConfig() {
    try {
      const stored = JSON.parse(localStorage.getItem("danmakuConfig") || "{}");
      return {
        enabled: stored.enabled !== false,
        fontSize: stored.fontSize || 22,
        opacity: typeof stored.opacity === "number" ? stored.opacity : 0.8,
        speed: stored.speed || 10,
      };
    } catch (_) {
      return { enabled: true, fontSize: 22, opacity: 0.8, speed: 10 };
    }
  }

  saveConfig() {
    try {
      localStorage.setItem("danmakuConfig", JSON.stringify(this.config));
    } catch (_) {}
  }

  setConfig(patch) {
    Object.assign(this.config, patch);
    this.saveConfig();
    this.applyVisibility();
    this.recomputeLanes();
  }

  applyVisibility() {
    this.canvas.classList.toggle("is-hidden", !this.config.enabled);
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cssWidth = rect.width;
    this.cssHeight = rect.height;
    this.recomputeLanes();
  }

  recomputeLanes() {
    const lineH = this.config.fontSize + 6;
    this.lineH = lineH;
    const maxLanes = Math.max(1, Math.floor(this.cssHeight * 0.75 / lineH));
    const reset = (arr) => {
      const out = new Array(maxLanes).fill(0);
      for (let i = 0; i < Math.min(arr.length, maxLanes); i++) out[i] = arr[i];
      return out;
    };
    this.lanes.rolling = reset(this.lanes.rolling);
    this.lanes.top = reset(this.lanes.top);
    this.lanes.bottom = reset(this.lanes.bottom);
  }

  load(items) {
    this.items = (items || []).slice().sort((a, b) => a.time - b.time);
    this.cursor = 0;
    this.activeRolling = [];
    this.activeFixed = [];
    this.lanes.rolling = this.lanes.rolling.map(() => 0);
    this.lanes.top = this.lanes.top.map(() => 0);
    this.lanes.bottom = this.lanes.bottom.map(() => 0);
  }

  get count() { return this.items.length; }

  start() {
    if (this.rafId != null) return;
    const tick = (now) => {
      if (!this.lastTickAt) this.lastTickAt = now;
      const dt = Math.min(0.1, (now - this.lastTickAt) / 1000);
      this.lastTickAt = now;
      this.update(dt);
      this.render();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop() {
    if (this.rafId != null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  dispose() {
    this.stop();
    try { this.resizeObs.disconnect(); } catch (_) {}
    this.canvas.remove();
  }

  update(dt) {
    if (!this.config.enabled || !this.items.length || !this.video) return;
    const now = this.video.currentTime;
    if (Math.abs(now - this.lastVideoTime) > 1) {
      // seek
      let lo = 0, hi = this.items.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.items[mid].time < now) lo = mid + 1; else hi = mid;
      }
      this.cursor = lo;
      this.activeRolling = [];
      this.activeFixed = [];
    }
    this.lastVideoTime = now;
    if (this.video.paused) return;

    while (this.cursor < this.items.length && this.items[this.cursor].time <= now) {
      this.emit(this.items[this.cursor]);
      this.cursor++;
    }

    for (const d of this.activeRolling) d.x -= d.speed * dt;
    this.activeRolling = this.activeRolling.filter((d) => d.x + d.width > 0);
    this.activeFixed = this.activeFixed.filter((d) => now < d.endTime);
  }

  emit(item) {
    const W = this.cssWidth, H = this.cssHeight;
    this.ctx.font = this.config.fontSize + "px sans-serif";
    const width = this.ctx.measureText(item.message).width;
    const color = "#" + (item.color || 0xffffff).toString(16).padStart(6, "0");
    if (item.type === 1) {
      const duration = this.config.speed;
      const speed = (W + width) / duration;
      const now = this.video.currentTime;
      let laneIdx = -1;
      for (let i = 0; i < this.lanes.rolling.length; i++) {
        if (this.lanes.rolling[i] <= now) { laneIdx = i; break; }
      }
      if (laneIdx < 0) return;
      this.lanes.rolling[laneIdx] = now + width / speed + 0.3;
      this.activeRolling.push({
        message: item.message, x: W, y: laneIdx * this.lineH + this.config.fontSize,
        speed, width, color,
      });
    } else if (item.type === 4 || item.type === 5) {
      const top = item.type === 5;
      const lanes = top ? this.lanes.top : this.lanes.bottom;
      const now = this.video.currentTime;
      let laneIdx = -1;
      for (let i = 0; i < lanes.length; i++) {
        if (lanes[i] <= now) { laneIdx = i; break; }
      }
      if (laneIdx < 0) return;
      const duration = 4;
      lanes[laneIdx] = now + duration;
      const y = top
        ? laneIdx * this.lineH + this.config.fontSize + 4
        : H - laneIdx * this.lineH - 8;
      this.activeFixed.push({
        message: item.message, x: Math.max(4, (W - width) / 2), y,
        width, color, endTime: now + duration,
      });
    }
  }

  render() {
    if (!this.config.enabled) return;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
    ctx.globalAlpha = this.config.opacity;
    ctx.font = this.config.fontSize + "px sans-serif";
    ctx.textBaseline = "alphabetic";
    ctx.shadowColor = "rgba(0,0,0,0.85)";
    ctx.shadowBlur = 3;
    for (const d of this.activeRolling) {
      ctx.fillStyle = d.color;
      ctx.fillText(d.message, d.x, d.y);
    }
    for (const d of this.activeFixed) {
      ctx.fillStyle = d.color;
      ctx.fillText(d.message, d.x, d.y);
    }
  }
}

let activeDanmaku = null;
function disposeDanmaku() {
  if (activeDanmaku) {
    try { activeDanmaku.dispose(); } catch (_) {}
    activeDanmaku = null;
  }
}

// ====== 双语字幕（按作品原语言配对） ======
// 通用自动探测（用户 2026-11-07 定：不要一个剧一个剧手工配，软件通用适配）：
// 播放任意番任意一集时，先按番剧原语言定配对，再按命名规则自动找字幕文件，不用改代码、不用登记：
//   日语番：web/<bangumiId>-ep<NN>.ja.vtt + .zh.vtt → 中日双语（日文叠加 + 画面中文字幕）
//   英语番：web/<bangumiId>-ep<NN>.en.vtt + .zh.vtt → 中英双语（英文叠加 + 画面中文字幕）
//   国漫（中文原语言）：同英语番，叠加 .en.vtt → 中英双语（英文由机器翻译生成，待做）
// 原语言从 Bangumi 番剧信息的 tags（产地标签：日本 / 美国 / 欧美 / 中国 / 国产…）判断，不写死；
// 拿不到 tags 时默认按日语番处理（本站绝大多数是日番）。
// 文件一律扁平名、放 web/ 根目录，经 /assets/ 直连；服务端静态路由不提供子目录文件，子目录会 404。
// 例如黑暗召唤师（bangumiId 630160）第 1 集：630160-ep01.ja.vtt / 630160-ep01.zh.vtt；
// 瑞克和莫蒂第一季（bangumiId 93377）第 1 集：93377-ep01.en.vtt / 93377-ep01.zh.vtt。
// 叠加语言文件存在（200）就自动启用双语模式；不存在就正常只放原视频，不报错、不弹红字。
// 字幕来源（诚实标注，勿改）：目前没有人工字幕。NEST 内封 mkv 的 BT 在本机走不通，
// Jimaku.cc 要注册 API key（需浏览器办）。现用文件全部由对应集的 AGE 视频本身机器生成：
//  - 叠加语言（日/英）：faster-whisper small 对 AGE 视频音轨做语音识别（ASR），可能听错个别词；
//  - 中文：RapidOCR 识别 AGE 视频画面上烧入的中文字幕（硬字幕），可能认错个别字；
//    无硬字幕的英语番，中文用机器翻译生成（文件头注明是机器翻译）。
// 不是人工字幕组字幕、不是现编的台词；拿到人工字幕后应替换对应文件。
// 注意：AGE 视频本身已烧入中文字幕（硬字幕），所以叠加层只显示叠加语言那一行，
// 画面上同时看到叠加语言 + 中文（硬字幕）= 双语；再叠一层中文会和硬字幕重影。
// 仅中文档 = 关掉叠加层，只看画面自带硬字幕。
function detectOverlayLang(tags) {
  const names = (tags || []).map((t) => (typeof t === "string" ? t : t && t.name) || "");
  const has = (...ws) => ws.some((w) => names.includes(w));
  // 英语番与国漫都叠英文：英语番是中英双语，国漫按原规则也是中英双语（英文机器翻译）。
  if (has("美国", "欧美", "英国", "法国", "加拿大", "澳大利亚", "德国",
          "中国", "国产", "大陆", "香港", "台湾")) return "en";
  return "ja";
}
function dualSubPaths(bid, episode, ovlLang) {
  const ep = String(parseInt(episode || "1", 10) || 1).padStart(2, "0");
  const id = String(bid || "");
  if (!id) return null;
  return {
    // 主：字幕插件端点（只读缓存；缓存没有就 404，不生成、不等待）。
    // v 参数：字幕缓存版本号。服务端曾给字幕加 24 小时缓存，旧字幕会被
    // 浏览器/边缘节点缓存住；改这个数字换个地址，立即绕开旧缓存。
    // 服务端已把 Cache-Control 改成 no-cache，以后更新字幕不用再改这里。
    ovl: "/api/subs/" + id + "/ep" + ep + "?lang=" + ovlLang + "&v=2",
    zh: "/api/subs/" + id + "/ep" + ep + "?lang=zh&v=2",
    // 备：主站静态种子文件（插件端点挂了也能播双语）。
    ovlStatic: "/assets/" + id + "-ep" + ep + "." + ovlLang + ".vtt",
    zhStatic: "/assets/" + id + "-ep" + ep + ".zh.vtt",
    hardsubZh: true,
  };
}

// 预热：详情页/播放页打开时调用，fire-and-forget。让插件在后台为
// 指定集准备字幕（字幕库 → Groq 生成 → 进缓存），不等结果、不动 UI。
// 播放时只读缓存，所以预热必须在播放之前发生。
// episodes: [集号, ...] 或 [{ep: 集号, url: AGE 播放页地址}, ...]
// （有 url 时库里没有的番才能走 Groq 回退生成；没有 url 只走字幕库）。
function warmSubs(bid, episodes) {
  try {
    if (!bid || !Array.isArray(episodes)) return;
    for (const item of episodes) {
      const ep = typeof item === "number" ? item : parseInt(item && item.ep, 10);
      const url = typeof item === "object" && item ? (item.url || "") : "";
      if (!ep || ep < 1) continue;
      fetch("/api/subs/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bid: String(bid), ep, episodeUrl: url || undefined }),
        keepalive: true,
      }).catch(() => {});
    }
  } catch (_) {}
}
function parseVtt(text) {
  const cues = [];
  const blocks = String(text || "").replace(/\r\n/g, "\n").split(/\n\s*\n/);
  const toSec = (s) => {
    const m = s.trim().match(/(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})/);
    if (!m) return null;
    return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
  };
  for (const b of blocks) {
    const lines = b.split("\n").map((x) => x.trim()).filter(Boolean);
    if (!lines.length) continue;
    const ti = lines.findIndex((l) => l.includes("-->"));
    if (ti < 0) continue;
    const [a, c] = lines[ti].split("-->");
    const start = toSec(a), end = toSec(c);
    if (start == null || end == null) continue;
    const txt = lines.slice(ti + 1).join("\n")
      .replace(/<[^>]+>/g, "").replace(/\{[^}]*\}/g, "").trim();
    if (txt) cues.push({ start, end, text: txt });
  }
  cues.sort((x, y) => x.start - y.start);
  return cues;
}
function cueAt(cues, t) {
  let lo = 0, hi = cues.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (cues[mid].start <= t) lo = mid + 1; else hi = mid; }
  for (let i = lo - 1; i >= 0 && i >= lo - 3; i--) {
    if (t >= cues[i].start && t <= cues[i].end) return cues[i];
  }
  return null;
}
// 把原语言叠加 cue 的时间窗口对齐到重叠最多的中文（硬字幕）cue，让双语同频。
// 2026-11-07 真机反馈：日文（ASR 时间轴）和画面硬字幕不同频——ep03 有 1/3
// 的行偏差超过 0.5 秒。对不上的行保留原时间；没有中文行对照的集不做对齐。
function alignCuesToZh(ovlCues, zhCues) {
  const out = ovlCues.map((c) => ({ start: c.start, end: c.end, text: c.text }));
  for (const c of out) {
    let best = null, bestOv = 0;
    for (const z of zhCues) {
      const ov = Math.min(c.end, z.end) - Math.max(c.start, z.start);
      if (ov > bestOv) { bestOv = ov; best = z; }
    }
    if (best && (bestOv >= 0.3 || bestOv >= 0.4 * (c.end - c.start))) {
      c.start = best.start; c.end = best.end;
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}
class DualSubLayer {
  constructor(video, container, opts) {
    this.video = video;
    this.bid = String(opts.bid || "");
    this.episode = opts.episode;
    this.entry = null; // 探测到叠加语言文件后才有值
    this.ovlLang = "ja"; // 默认日语番；load() 里按 tags 修正
    this.dualMode = "ja-zh";
    this.dualLabel = "中日双语";
    this.done = false; this.onReady = null;
    this.mode = "ja-zh";
    try { this.mode = localStorage.getItem("dualSubMode") || "ja-zh"; } catch (_) {}
    if (!["ja-zh", "en-zh", "zh", "off"].includes(this.mode)) this.mode = "ja-zh";
    // 真机问题（2026-11-07）：用户只看到画面硬字幕、日文叠加没出来——
    // 手机上存的 dualSubMode 可能是之前误触留下的“仅中文/关”，叠加层就一直
    // 藏着。按用户要求默认就是双语：存过“仅中文/关”的只重置一次（迁移标记），
    // 之后用户在下拉里主动切的档位仍然保留、不再动。
    try {
      if (!localStorage.getItem("dualSubModeMigrated20261107")) {
        if (this.mode === "zh" || this.mode === "off") {
          this.mode = "ja-zh";
          localStorage.setItem("dualSubMode", "ja-zh");
        }
        localStorage.setItem("dualSubModeMigrated20261107", "1");
      }
    } catch (_) {}
    this.ovlCues = []; this.zhCues = []; this.loaded = false; this.loadError = "";
    this.subSource = ""; // 字幕来源（Kitsunekko / TVsubtitles / Groq Whisper / 机器生成），端点经 X-Sub-Source 返回
    this.ovlUrl = ""; // 实际拿到叠加字幕的地址（端点或静态文件），给原生 <track> 用
    this.node = document.createElement("div");
    this.node.className = "dual-sub";
    this.ovlNode = document.createElement("div");
    this.ovlNode.className = "dual-sub-ja"; // 复用现有叠加层样式（棕色 pill），与语言无关
    this.zhNode = document.createElement("div");
    this.zhNode.className = "dual-sub-zh";
    this.node.append(this.ovlNode, this.zhNode);
    container.append(this.node);
    this._onTime = () => this.render();
    video.addEventListener("timeupdate", this._onTime);
    video.addEventListener("seeked", this._onTime);
    if (this.bid) this.load();
    else { this.done = true; this.render(); }
  }
  async load() {
    // 1) 按番剧 tags 定原语言配对（拿不到就默认日语番）。
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, 3000);
      const res = await fetch("/api/bangumi/" + encodeURIComponent(this.bid), { signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) {
        const info = await res.json();
        this.ovlLang = detectOverlayLang(info && info.tags);
      }
    } catch (e) { /* 默认 ja */ }
    this.dualMode = this.ovlLang + "-zh";
    this.dualLabel = this.ovlLang === "en" ? "中英双语" : "中日双语";
    // 存过的双语档跟着当前番的语言走（ja-zh/en-zh 互换）；仅中文/关原样保留。
    if (this.mode === "ja-zh" || this.mode === "en-zh") this.mode = this.dualMode;
    this.entry = dualSubPaths(this.bid, this.episode, this.ovlLang);
    // 2) 先读插件端点（只读缓存，5 秒超时；缓存没有 = 本集还没有双语
    // 字幕，静默无字幕播放，不设 loadError、不弹红字、不显示“生成中”）。
    // 端点失败再回退到主站静态种子文件。两个都没有才算没有字幕。
    let ovlText = null;
    this.subSource = "";
    const fetchText = async (url, timeoutMs) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, timeoutMs);
      try {
        const r = await fetch(url, { signal: ctrl.signal });
        if (!r.ok) return null;
        const src = r.headers ? (r.headers.get("X-Sub-Source") || "") : "";
        return { text: await r.text(), source: src, url };
      } catch (e) { return null; } finally { clearTimeout(timer); }
    };
    let got = await fetchText(this.entry.ovl, 5000);
    if (!got) got = await fetchText(this.entry.ovlStatic, 5000);
    if (!got) { this.entry = null; this.done = true; this.render(); if (typeof this.onReady === "function") this.onReady(); return; }
    ovlText = got.text;
    this.ovlUrl = got.url || "";
    this.subSource = got.source || "";
    try {
      let zhText = "";
      const zhGot = await fetchText(this.entry.zh, 3000);
      if (zhGot) zhText = zhGot.text;
      else {
        const zhStatic = await fetchText(this.entry.zhStatic, 3000);
        if (zhStatic) zhText = zhStatic.text;
      }
      this.ovlCues = parseVtt(ovlText);
      this.zhCues = zhText ? parseVtt(zhText) : [];
      // 2026-11-07 真机反馈：日文和中文不同频——把叠加行对齐到中文行的时间窗口。
      if (this.zhCues.length) this.ovlCues = alignCuesToZh(this.ovlCues, this.zhCues);
      this.loaded = this.ovlCues.length > 0;
      if (!this.loaded) this.loadError = "字幕文件为空（" + this.dualLabel + "叠加 " + this.ovlCues.length + " 条）";
    } catch (e) { this.loadError = String(e && e.message || e); }
    if (this.loaded && this.ovlUrl) this.attachTrack();
    this.done = true;
    this.render();
    if (typeof this.onReady === "function") this.onReady();
  }
  attachTrack() {
    // iOS 原生全屏里 HTML 叠加层看不见（系统播放器只认 <track>）：把同一份
    // 叠加字幕挂成原生字幕轨，进原生全屏也能看到原语言字幕。
    // 平时 track 保持 disabled（走 HTML 叠加层，避免重影）；只在原生全屏/
    // 真全屏时切成 showing。不加 default，避免内嵌播放时原生轨和叠加层重影。
    try {
      const old = this.video && this.video.querySelector("track[data-dual-sub]");
      if (old) old.remove();
      const tr = document.createElement("track");
      tr.setAttribute("data-dual-sub", "");
      tr.kind = "subtitles";
      tr.label = this.dualLabel;
      tr.srclang = this.ovlLang;
      tr.src = this.ovlUrl;
      this.video.appendChild(tr);
      const syncMode = () => {
        try {
          const showing = inWebkitFullscreen(this.video) || !!document.fullscreenElement;
          if (tr.track) tr.track.mode = showing ? "showing" : "disabled";
        } catch (_) {}
      };
      tr.addEventListener("load", syncMode);
      this.video.addEventListener("webkitbeginfullscreen", syncMode);
      this.video.addEventListener("webkitendfullscreen", syncMode);
      document.addEventListener("fullscreenchange", syncMode);
      syncMode();
    } catch (_) {}
  }
  setMode(mode) {
    this.mode = mode;
    try { localStorage.setItem("dualSubMode", mode); } catch (_) {}
    this.render();
  }
  render() {
    const t = this.video ? this.video.currentTime || 0 : 0;
    if (!this.entry || !this.loaded || this.mode !== this.dualMode) {
      this.node.style.display = "none";
      this.ovlNode.textContent = ""; this.zhNode.textContent = "";
      return;
    }
    // 双语档：只叠加一层原语言行；中文看画面硬字幕（hardsubZh），避免重影。
    const ovl = cueAt(this.ovlCues, t);
    this.node.style.display = ovl ? "" : "none";
    this.ovlNode.textContent = ovl ? ovl.text : "";
    this.zhNode.textContent = "";
    this.zhNode.style.display = "none";
  }
  dispose() {
    try { this.video.removeEventListener("timeupdate", this._onTime); } catch (_) {}
    try { this.video.removeEventListener("seeked", this._onTime); } catch (_) {}
    try { const tr = this.video && this.video.querySelector("track[data-dual-sub]"); if (tr) tr.remove(); } catch (_) {}
    try { this.node.remove(); } catch (_) {}
  }
}
let activeDualSub = null;
function disposeDualSub() {
  if (activeDualSub) {
    try { activeDualSub.dispose(); } catch (_) {}
    activeDualSub = null;
  }
}

// ====== Progress reporting ======
let activeProgressTimer = null;
function disposeProgressReporter() {
  if (activeProgressTimer != null) {
    clearInterval(activeProgressTimer);
    activeProgressTimer = null;
  }
}
async function reportProgress(payload) {
  try {
    await fetch("/api/history/progress", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (_) {
    // 进度上报失败不打扰用户
  }
}

// 当前播放页持有的 hls.js 实例，跳出页面时销毁
let activeHls = null;
function disposeHls() {
  if (activeHls) {
    try { activeHls.destroy(); } catch (_) {}
    activeHls = null;
  }
}

// 懒加载 hls.js（只在需要时）
let hlsLoaderPromise = null;
function ensureHlsLoaded() {
  if (typeof Hls !== "undefined") return Promise.resolve();
  if (hlsLoaderPromise) return hlsLoaderPromise;
  hlsLoaderPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "/assets/hls.min.js";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("hls.js 加载失败"));
    document.head.append(s);
  });
  return hlsLoaderPromise;
}

function nativeHlsSupported(video) {
  return !!(
    video.canPlayType("application/vnd.apple.mpegurl") ||
    video.canPlayType("application/x-mpegURL") ||
    video.canPlayType("audio/mpegurl")
  );
}

async function attachStream(video, data, onError) {
  const streamType = data.streamType || "unknown";
  const looksLikeHls = streamType === "hls" || /\.m3u8/i.test(data.originalUrl || "");

  if (looksLikeHls && !nativeHlsSupported(video)) {
    try {
      await ensureHlsLoaded();
    } catch (e) {
      onError("加载 hls.js 失败：" + e.message);
      return;
    }
    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
    });
    activeHls = hls;
    hls.on(Hls.Events.ERROR, (_, info) => {
      if (info.fatal) {
        switch (info.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            hls.startLoad();
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            hls.recoverMediaError();
            break;
          default:
            onError("HLS 错误：" + (info.details || info.type));
            disposeHls();
        }
      }
    });
    hls.loadSource(data.playUrl);
    hls.attachMedia(video);
  } else {
    video.src = data.playUrl;
  }
}


// ====== 视频元素资源释放 ======
// iOS Safari 的视频解码管线不随 DOM 移除而释放，且同时存在的管线有
// 硬上限（1~3 个）——不显式释放旧 video，切集后新视频会"一次 206 即死"。
// 标准释放手法：pause → 摘除 src → load()。
let activeVideoEl = null;
function disposeActiveVideo() {
  const v = activeVideoEl;
  activeVideoEl = null;
  if (!v) return;
  try {
    v.pause();
    v.removeAttribute("src");
    while (v.firstChild) v.removeChild(v.firstChild);
    v.load();
  } catch (_) {}
}

// ====== 键盘快捷键（桌面浏览器） ======
// Space 播放/暂停 · ←/→ ±5s · ↑/↓ 音量 · F 全屏 · M 静音 · P 画中画
let _playerKeyHandler = null;
function disposePlayerKeys() {
  if (_playerKeyHandler) {
    document.removeEventListener("keydown", _playerKeyHandler);
    _playerKeyHandler = null;
  }
}
function bindPlayerKeys(video) {
  disposePlayerKeys();
  _playerKeyHandler = (ev) => {
    const tag = (ev.target && ev.target.tagName) || "";
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    switch (ev.key) {
      case " ":
        ev.preventDefault();
        if (video.paused) video.play();
        else video.pause();
        break;
      case "ArrowLeft":
        ev.preventDefault();
        video.currentTime = Math.max(0, video.currentTime - 5);
        break;
      case "ArrowRight":
        ev.preventDefault();
        video.currentTime = video.currentTime + 5;
        break;
      case "ArrowUp":
        ev.preventDefault();
        video.volume = Math.min(1, video.volume + 0.1);
        break;
      case "ArrowDown":
        ev.preventDefault();
        video.volume = Math.max(0, video.volume - 0.1);
        break;
      case "f":
      case "F":
        if (document.fullscreenElement) document.exitFullscreen();
        else if (video.requestFullscreen) video.requestFullscreen();
        break;
      case "m":
      case "M":
        video.muted = !video.muted;
        break;
      case "p":
      case "P":
        togglePictureInPicture(video);
        break;
    }
  };
  document.addEventListener("keydown", _playerKeyHandler);
}

// ====== 画中画 ======
// 标准 API（Chrome/Edge）与 WebKit presentation mode（iOS/macOS Safari）
function pipSupported(video) {
  return (
    (document.pictureInPictureEnabled && !video.disablePictureInPicture) ||
    typeof video.webkitSetPresentationMode === "function"
  );
}
async function togglePictureInPicture(video) {
  try {
    if (typeof video.webkitSetPresentationMode === "function" &&
        !document.pictureInPictureEnabled) {
      const mode = video.webkitPresentationMode;
      video.webkitSetPresentationMode(mode === "picture-in-picture" ? "inline" : "picture-in-picture");
      return;
    }
    if (document.pictureInPictureElement === video) await document.exitPictureInPicture();
    else await video.requestPictureInPicture();
  } catch (_) {
    // 部分浏览器要求用户手势内调用；静默失败即可
  }
}

// ====== 点按快进 / 快退（触屏 + 鼠标，单击双击分开判断） ======
// 真机问题（2026-11-07）：① iOS 不触发 dblclick（双击触发缩放），且 video
// 原生点按会立即暂停/播放——双击的第一下先暂停，快进就出不来；② 点按直接
// 落在 video 上会弹 iOS 原生控制层（顶部两条栏、底部进度条、中间大暂停键
// 和两个 ±10 秒键、右下角圆形设置键），挡住画面。
// 做法：视频上方盖一层 .tap-zone（只盖视频区，底部留 52px 给原生控制条
//  scrub 用），点按落在它上面，不碰 video 元素本身，原生控制层不会弹出来；
// 点一下先等 280ms：280ms 内又来一下 = 双击（左 1/3 快退 10 秒、右 1/3
// 快进 10 秒、中间暂停/播放）；没来第二下 = 单击暂停/播放。
// 快进/快退只闪 seek-flash 小提示（“快进 10 秒”），不弹大控制层，视频继续播。
let _seekFlashTimer = null;
function showSeekFlash(wrap, text) {
  let n = wrap.querySelector(".seek-flash");
  if (!n) { n = el("div", { class: "seek-flash" }); wrap.append(n); }
  n.textContent = text;
  n.classList.add("is-show");
  clearTimeout(_seekFlashTimer);
  _seekFlashTimer = setTimeout(() => n.classList.remove("is-show"), 700);
}
// 快进/快退后立刻收起内嵌原生控制条（controls 开关一次，控制条隐藏；
// 60ms 后恢复 controls，控制条只在用户下次点按视频时再出现）。
function hideInlineControls(video) {
  try {
    if (!video || !video.controls) return;
    video.controls = false;
    setTimeout(() => { try { video.controls = true; } catch (_) {} }, 60);
  } catch (_) {}
}
function seekBy(video, wrap, delta) {
  if (!video) return;
  video.currentTime = Math.max(0, video.currentTime + delta);
  showSeekFlash(wrap, delta > 0 ? "快进 10 秒" : "快退 10 秒");
  hideInlineControls(video);
}
function bindTapSeek(video, wrap) {
  let zone = wrap.querySelector(".tap-zone");
  if (!zone) { zone = el("div", { class: "tap-zone" }); wrap.append(zone); }
  let pending = null, pendingX = 0, pendingY = 0;
  const togglePlay = () => {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  };
  const doDouble = (x, y) => {
    const r = wrap.getBoundingClientRect();
    const relX = (x - r.left) / Math.max(1, r.width);
    if (relX < 0.34) seekBy(video, wrap, -10);
    else if (relX > 0.66) seekBy(video, wrap, 10);
    else togglePlay();
  };
  // 2026-11-07 真机反馈：双击快进点不了——手指两次落点常差 60px 以上，
  // 旧逻辑按像素距离判双击就失效（变成两次单击=暂停）。改按“两次点在
  // 同一个三分区（左/中/右）”判双击，手指漂移也不怕；窗口放宽到 350ms。
  const thirdOf = (x) => {
    const r = wrap.getBoundingClientRect();
    const rel = (x - r.left) / Math.max(1, r.width);
    return rel < 0.34 ? 0 : rel > 0.66 ? 2 : 1;
  };
  const onTap = (x, y) => {
    if (pending) {
      clearTimeout(pending); pending = null;
      if (thirdOf(x) === thirdOf(pendingX)) { doDouble(x, y); return; }
    }
    pendingX = x; pendingY = y;
    pending = setTimeout(() => { pending = null; togglePlay(); }, 350);
  };
  let lastTouchEnd = 0;
  zone.addEventListener("touchend", (ev) => {
    ev.preventDefault(); // 阻止合成 click 与 iOS 双击缩放
    if (!ev.changedTouches || !ev.changedTouches.length) return;
    const t = ev.changedTouches[0];
    lastTouchEnd = Date.now();
    onTap(t.clientX, t.clientY);
  }, { passive: false });
  zone.addEventListener("click", (ev) => {
    if (Date.now() - lastTouchEnd < 600) return; // 触屏合成的 click，忽略
    onTap(ev.clientX, ev.clientY);
  });
}

// ====== 一键横屏 ======
// 真机问题（2026-11-07）：iOS 上横屏按钮无效，且 iOS 原生全屏
// （webkit presentation mode）会接管播放——HTML 叠加层（双语字幕、点按层、
// 快进提示）全消失，点按还会弹 iOS 自带的控制层（顶部两条栏、底部进度条、
// 中间大暂停键和两个 ±10 秒键、右下角圆形设置键），JS 关不掉。
// 所以 iOS 上一律走 CSS 旋转全屏（把播放器旋转 90° 铺满屏幕）：点一下就是
// 横屏，不用再手动横过手机；字幕和点按层都在，控制层由我们自己管。
// 桌面端仍走真全屏 + screen.orientation.lock。
// 若视频已在 iOS 原生全屏里（用户点了视频自带的全屏键），先退出它再旋转，
// 否则旋转后的 wrap 会被原生全屏层盖住、看起来像“按钮无效”。
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
function setLandscapeLabel(btn, text) {
  if (!btn) return;
  const label = btn.querySelector(".label");
  if (label) label.textContent = text;
}
function inWebkitFullscreen(video) {
  try { return video && video.webkitPresentationMode === "fullscreen"; } catch (_) { return false; }
}
async function toggleLandscape(video, wrap, btn) {
  if (wrap.classList.contains("is-rotated")) { exitRotated(wrap, btn); return; }
  if (document.fullscreenElement) { await document.exitFullscreen().catch(() => {}); setLandscapeLabel(btn, "横屏"); return; }
  if (inWebkitFullscreen(video)) {
    try { video.webkitExitFullscreen(); } catch (_) {}
    // 等原生全屏退出（webkitendfullscreen）再旋转，避免两层叠加
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      video.addEventListener("webkitendfullscreen", finish, { once: true });
      setTimeout(finish, 800);
    });
  }
  if (!IS_IOS && document.fullscreenEnabled && wrap.requestFullscreen) {
    try {
      await wrap.requestFullscreen();
      if (screen.orientation && screen.orientation.lock) {
        await screen.orientation.lock("landscape").catch(() => {});
      }
      setLandscapeLabel(btn, "退出横屏");
      const onFs = () => {
        if (!document.fullscreenElement) {
          document.removeEventListener("fullscreenchange", onFs);
          setLandscapeLabel(btn, "横屏");
          if (screen.orientation && screen.orientation.unlock) { try { screen.orientation.unlock(); } catch (_) {} }
        }
      };
      document.addEventListener("fullscreenchange", onFs);
      return;
    } catch (_) { /* 掉到 CSS 旋转方案 */ }
  }
  enterRotated(wrap, btn);
}
// 拦截视频自带的全屏键：iOS 内嵌控制条上的全屏键会进原生全屏（叠加层全丢、
// 控制层关不掉），直接退出它、改走 CSS 旋转横屏。
function bindNativeFullscreenGuard(video, wrap, btn) {
  if (!video || typeof video.webkitEnterFullscreen !== "function") return;
  video.addEventListener("webkitbeginfullscreen", () => {
    try { video.webkitExitFullscreen(); } catch (_) {}
    if (!wrap.classList.contains("is-rotated")) enterRotated(wrap, btn);
  });
  video.addEventListener("webkitendfullscreen", () => {
    if (!wrap.classList.contains("is-rotated")) setLandscapeLabel(btn, "横屏");
  });
}
function enterRotated(wrap, btn) {
  wrap.classList.add("is-rotated");
  document.body.classList.add("no-scroll");
  let exit = wrap.querySelector(".rotate-exit");
  if (!exit) {
    exit = el("button", { class: "rotate-exit sl", type: "button" }, "退出横屏");
    exit.addEventListener("click", (ev) => { ev.stopPropagation(); exitRotated(wrap, btn); });
    wrap.append(exit);
  }
  exit.style.display = "";
  setLandscapeLabel(btn, "退出横屏");
}
function exitRotated(wrap, btn) {
  wrap.classList.remove("is-rotated");
  document.body.classList.remove("no-scroll");
  const exit = wrap.querySelector(".rotate-exit");
  if (exit) exit.style.display = "none";
  setLandscapeLabel(btn, "横屏");
}

// ============================================================
// 播放页：视频 + 控件行 + 弹幕设置（SettingsSliderTile 风格）
// ============================================================
async function renderPlayer(params) {
  disposeActiveVideo();
  disposeHls();
  disposeDanmaku();
  disposeDualSub();
  disposeProgressReporter();
  disposePlayerKeys();
  const { plugin, episodeUrl, title, bid, episode, road, src } = params;
  const epNum = parseInt(episode || "1", 10);
  const roadNum = parseInt(road || "0", 10);
  $app.innerHTML = "";
  renderNavRail("");
  window.scrollTo(0, 0);

  const page = el("div", { class: "page" });
  $app.append(appBar({ title: title || "播放", back: true, compact: true }), page);
  const status = loadingNode("正在解析视频源，可能需要几秒…");
  page.append(status);

  let data;
  try {
    data = await fetchJson("/api/resolve?plugin=" + encodeURIComponent(plugin) + "&episodeUrl=" + encodeURIComponent(episodeUrl));
  } catch (e) {
    status.remove();
    page.append(errorState({ title: "解析失败", message: e.message, onRetry: () => renderPlayer(params) }));
    return;
  }
  status.remove();

  // 布局：竖屏 / 窄屏时面板在视频下方；横屏宽屏时作为右侧侧栏（video_page_layout.dart）
  const main = el("div", { class: "player-main" });
  const panel = el("div", { class: "player-panel" });
  page.append(el("div", { class: "player-layout" }, main, panel));
  const seriesTitle = (title || "").split(" · ").slice(0, -1).join(" · ") || title || "";

  const video = el("video", { controls: true, playsinline: true, "webkit-playsinline": true, preload: "metadata" });
  const playerWrap = el("div", { class: "player-wrap" }, video);
  main.append(playerWrap);

  const errorNode = el("div", { class: "player-error" });
  errorNode.style.display = "none";
  main.append(errorNode);
  const showError = (msg) => { errorNode.textContent = msg; errorNode.style.display = "block"; };

  await attachStream(video, data, showError);
  activeVideoEl = video;

  // ====== 控件行：上一集 / 下一集 / 倍速 / 画面比例 / 重新解析 ======
  const prevBtn = button("上一集", { icon: "skip_previous" });
  const nextBtn = button("下一集", { icon: "skip_next" });
  prevBtn.disabled = true;
  nextBtn.disabled = true;

  // 播放偏好（倍速 / 画面比例）记在 localStorage，下次进播放页沿用
  let prefs = {};
  try { prefs = JSON.parse(localStorage.getItem("playerPrefs") || "{}") || {}; } catch (_) {}
  const savePrefs = (patch) => { Object.assign(prefs, patch); try { localStorage.setItem("playerPrefs", JSON.stringify(prefs)); } catch (_) {} };
  const rateSelect = el("select", { class: "btn btn-tonal", "aria-label": "倍速" });
  const initialRate = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0].includes(prefs.rate) ? prefs.rate : 1.0;
  for (const r of [0.5, 0.75, 1.0, 1.25, 1.5, 2.0]) {
    const opt = el("option", { value: String(r) }, r === 1.0 ? "倍速 1x" : "倍速 " + r + "x");
    if (r === initialRate) opt.setAttribute("selected", "");
    rateSelect.append(opt);
  }
  const applyRate = () => {
    const r = parseFloat(rateSelect.value);
    if (!Number.isNaN(r)) { video.playbackRate = r; savePrefs({ rate: r }); }
  };
  rateSelect.addEventListener("change", applyRate);
  if (initialRate !== 1.0) video.addEventListener("loadedmetadata", () => { video.playbackRate = initialRate; }, { once: true });

  const fitSelect = el("select", { class: "btn btn-tonal", "aria-label": "画面比例" });
  const initialFit = ["contain", "cover", "fill"].includes(prefs.fit) ? prefs.fit : "contain";
  for (const f of [{ v: "contain", label: "画面 适应" }, { v: "cover", label: "画面 填充" }, { v: "fill", label: "画面 拉伸" }]) {
    const opt = el("option", { value: f.v }, f.label);
    if (f.v === initialFit) opt.setAttribute("selected", "");
    fitSelect.append(opt);
  }
  video.style.objectFit = initialFit;
  fitSelect.addEventListener("change", () => { video.style.objectFit = fitSelect.value; savePrefs({ fit: fitSelect.value }); });

  const reload = button("重新解析", { variant: "text", icon: "refresh", onclick: () => renderPlayer(params) });
  const back10Btn = button("快退 10 秒", { variant: "text", onclick: () => seekBy(video, playerWrap, -10) });
  const fwd10Btn = button("快进 10 秒", { variant: "text", onclick: () => seekBy(video, playerWrap, 10) });
  const landscapeBtn = button("横屏", { variant: "text", onclick: () => toggleLandscape(video, playerWrap, landscapeBtn) });
  const controls = el("div", { class: "player-controls" }, prevBtn, nextBtn, rateSelect, fitSelect, reload, back10Btn, fwd10Btn, landscapeBtn);
  if (pipSupported(video)) {
    controls.append(button("画中画", { variant: "text", icon: "picture_in_picture", onclick: () => togglePictureInPicture(video) }));
  }
  main.append(controls);
  bindPlayerKeys(video);
  bindTapSeek(video, playerWrap);
  bindNativeFullscreenGuard(video, playerWrap, landscapeBtn);

  // 选集（roads + 上次观看）只拉一次：上一集/下一集 和 选集面板共用
  const playCtx = { plugin, src, title: seriesTitle, bid };
  const roadsPromise = plugin && src ? loadRoadsAndHistory(plugin, src, bid).catch(() => null) : Promise.resolve(null);
  roadsPromise.then((info) => {
    const currentRoad = info && info.roads[roadNum];
    if (!currentRoad || !Array.isArray(currentRoad.episodes)) return;
    const eps = currentRoad.episodes;
    const idx = epNum - 1;
    const goEp = (newIdx) => {
      if (newIdx < 0 || newIdx >= eps.length) return;
      go("/play", playEpisodeParams(playCtx, eps[newIdx], newIdx, roadNum));
    };
    if (idx > 0) { prevBtn.disabled = false; prevBtn.addEventListener("click", () => goEp(idx - 1)); }
    if (idx < eps.length - 1) { nextBtn.disabled = false; nextBtn.addEventListener("click", () => goEp(idx + 1)); }
    // 预热下一集（带播放地址，库里没有才能走 Groq 回退）：本集播着的
    // 时候后台准备好，用户点下一集时缓存里已经有了。
    if (idx + 1 < eps.length) {
      warmSubs(bid, [{ ep: epNum + 1, url: eps[idx + 1] && eps[idx + 1].src }]);
    }
  });

  const typeLabel = data.streamType === "hls"
    ? "HLS" + (nativeHlsSupported(video) ? "（原生）" : "（hls.js）")
    : data.streamType === "mp4" ? "MP4" : "直链";
  main.append(el("div", { class: "player-meta" }, "规则 " + data.pluginName + " · " + typeLabel + " · " + data.originalUrl));

  video.addEventListener("error", () => {
    showError("播放器报告错误。可能是源失效或浏览器不支持该格式。");
  });

  // ====== 弹幕：SettingsSection（开关 + 三个 slider tile） ======
  const danmaku = new DanmakuLayer(video, playerWrap);
  activeDanmaku = danmaku;

  // ====== 双语字幕：按原语言配对（中日双语 / 中英双语 / 仅中文 / 关，记在 localStorage） ======
  const dualSub = new DualSubLayer(video, playerWrap, { bid, episode: epNum });
  activeDualSub = dualSub;
  // 通用探测：字幕档下拉默认隐藏，探测到叠加语言文件加载成功后才出现；
  // 本集无字幕文件时不显示、不报错、不弹红字。双语档的文案（中日/中英）随番的原语言定。
  const subSelect = el("select", { class: "btn btn-tonal", "aria-label": "字幕" });
  subSelect.style.display = "none";
  const dualOpt = el("option", { value: dualSub.dualMode }, "字幕 " + dualSub.dualLabel);
  const zhOpt = el("option", { value: "zh" }, "字幕 仅中文");
  const offOpt = el("option", { value: "off" }, "字幕 关");
  subSelect.append(dualOpt, zhOpt, offOpt);
  subSelect.addEventListener("change", () => {
    dualSub.setMode(subSelect.value);
    toast(subSelect.value === dualSub.dualMode ? "已切换" + dualSub.dualLabel + "字幕（" + (dualSub.ovlLang === "en" ? "英文" : "日文") + "叠加 + 画面中文字幕）"
      : subSelect.value === "zh" ? "仅中文：只看画面自带中文字幕" : "字幕已关");
  });
  controls.append(subSelect);
  let subUIHandled = false;
  const showSubUI = () => {
    if (subUIHandled || !dualSub.done) return;
    subUIHandled = true;
    // 字幕文件存在但加载失败时在播放页 meta 区提示，不静默
    if (dualSub.loadError) showError("双语字幕加载失败：" + dualSub.loadError + "（视频本身的中文字幕仍可正常看）");
    else if (dualSub.loaded) {
      dualOpt.value = dualSub.dualMode;
      dualOpt.textContent = "字幕 " + dualSub.dualLabel;
      subSelect.value = dualSub.mode;
      subSelect.style.display = "";
      toast(dualSub.dualLabel + "字幕已加载：" + (dualSub.ovlLang === "en" ? "英文 " : "日文 ") + dualSub.ovlCues.length + " 条" + (dualSub.zhCues.length ? " / 中文 " + dualSub.zhCues.length + " 条" : "") + (dualSub.subSource ? "（" + dualSub.subSource + "）" : "") + (dualSub.subSource && dualSub.subSource.indexOf("Whisper") >= 0 ? "，机器生成仅供参考" : ""));
    }
    // 无字幕文件（entry 为空、无 loadError）：保持隐藏，不提示。
    // 但静默触发一次本集预热（带播放地址），让插件在后台准备好，
    // 下次打开本集或播到它时缓存里就有了；本次播放不等、不显示加载。
    if (!dualSub.loaded && !dualSub.loadError) {
      warmSubs(bid, [{ ep: epNum, url: episodeUrl }]);
    }
  };
  dualSub.onReady = showSubUI;
  if (dualSub.done) showSubUI();
  setTimeout(showSubUI, 2500);

  const sourceTile = tile({ icon: "unfold_more", title: "弹幕源", desc: "自动匹配", chevron: true, onclick: () => {
    openDanmakuSourceSheet({ keyword: seriesTitle, onPick: async (pick) => {
      danmakuDesc.textContent = "正在加载弹幕…";
      try {
        const dm = await fetchJson("/api/danmaku/episode?episodeId=" + encodeURIComponent(pick.episodeId));
        danmaku.load(dm.items || []);
        danmakuDesc.textContent = "共 " + danmaku.count + " 条";
        sourceTile.querySelector(".tile-desc").textContent = pick.animeTitle + " · " + (pick.episodeTitle || "");
        toast("已切换弹幕源，共 " + danmaku.count + " 条");
      } catch (e) {
        danmakuDesc.textContent = "弹幕加载失败";
        toast("弹幕加载失败：" + e.message);
      }
    } });
  } });
  const danmakuSection = section({
    title: "弹幕",
    desc: "加载中…",
    rows: [
      splitRow(sourceTile),
      splitRow(switchTile({ icon: "subtitles", title: "显示弹幕", checked: danmaku.config.enabled, onChange: (v) => danmaku.setConfig({ enabled: v }) })),
      splitRow(sliderTile({ label: "字号", min: 14, max: 36, step: 1, value: danmaku.config.fontSize,
        format: (v) => v + " px", onInput: (v) => danmaku.setConfig({ fontSize: v }) })),
      splitRow(sliderTile({ label: "不透明度", min: 20, max: 100, step: 5, value: Math.round(danmaku.config.opacity * 100),
        format: (v) => v + "%", onInput: (v) => danmaku.setConfig({ opacity: v / 100 }) })),
      splitRow(sliderTile({ label: "滚动时长", min: 5, max: 20, step: 1, value: danmaku.config.speed,
        format: (v) => v + " 秒", onInput: (v) => danmaku.setConfig({ speed: v }) })),
    ],
  });
  const danmakuDesc = danmakuSection.querySelector(".section-desc");

  // ====== 面板：选集 | 评论 | 弹幕（player_content_tabs.dart） ======
  const panelTabs = el("div", { class: "tabs no-divider", role: "tablist" });
  const panelBody = el("div", { class: "player-panel-body" });
  panel.append(panelTabs, panelBody);
  let panelTab = "episodes";
  const panelNodes = {};
  async function renderPanel() {
    panelBody.innerHTML = "";
    for (const k of Object.keys(panelNodes)) panelNodes[k].classList.toggle("is-active", k === panelTab);
    if (panelTab === "danmaku") { panelBody.append(danmakuSection); return; }
    if (panelTab === "comments") { panelBody.append(episodeCommentsPanel(bid, epNum)); return; }
    panelBody.append(loadingNode("", "medium"));
    const info = await roadsPromise;
    if (panelTab !== "episodes") return;
    panelBody.innerHTML = "";
    if (!info || !info.roads.length) { panelBody.append(emptyState({ icon: "live_tv", title: "没有可用的播放列表", compact: true })); return; }
    panelBody.append(episodePanel({
      plugin, src, title: seriesTitle, bid, roads: info.roads, lastWatched: info.lastWatched,
      activeRoadIdx: roadNum, currentRoad: roadNum, currentEpisode: epNum,
    }));
  }
  for (const t of [{ key: "episodes", label: "选集" }, { key: "comments", label: "评论" }, { key: "danmaku", label: "弹幕" }]) {
    const node = el("button", { class: "tab sl" + (t.key === panelTab ? " is-active" : ""), type: "button", role: "tab" }, t.label);
    node.addEventListener("click", () => { panelTab = t.key; renderPanel(); });
    panelNodes[t.key] = node;
    panelTabs.append(node);
  }
  renderPanel();

  if (bid && episode) {
    try {
      const dm = await fetchJson("/api/danmaku?bangumiId=" + encodeURIComponent(bid) + "&episode=" + encodeURIComponent(episode));
      danmaku.load(dm.items || []);
      danmakuDesc.textContent = "共 " + danmaku.count + " 条";
      if (!danmaku.count) sourceTile.querySelector(".tile-desc").textContent = "自动匹配未找到弹幕，可手动选择";
    } catch (e) {
      danmakuDesc.textContent = "弹幕加载失败";
    }
  } else {
    danmakuDesc.textContent = "需从番剧详情页打开才能加载弹幕";
    sourceTile.querySelector(".tile-desc").textContent = "可手动选择弹幕源";
  }

  // ====== 进度同步 ======
  if (bid && episode && plugin) {
    try {
      const h = await fetchJson("/api/history?bangumiId=" + encodeURIComponent(bid) + "&pluginName=" + encodeURIComponent(plugin));
      const prog = h.history && h.history.progresses && h.history.progresses[String(epNum)];
      if (prog && prog.progressMs > 5000) {
        const seekTo = prog.progressMs / 1000;
        const doSeek = () => {
          if (Math.abs((video.currentTime || 0) - seekTo) > 2) {
            try { video.currentTime = seekTo; } catch (_) {}
          }
        };
        if (video.readyState >= 1) doSeek();
        else video.addEventListener("loadedmetadata", doSeek, { once: true });
        toast("已从 " + formatPosition(prog.progressMs) + " 继续播放");
      }
    } catch (_) {}

    const epName = (title || "").split(" · ").pop() || "";
    const send = () => {
      const t = video.currentTime || 0;
      if (t < 5) return;
      reportProgress({
        bangumiId: parseInt(bid, 10),
        pluginName: plugin,
        episode: epNum,
        road: roadNum,
        progressMs: Math.floor(t * 1000),
        // KazumiWeb 契约：lastSrc = 本集地址（历史直达续播），src = 详情页地址（恢复上一集/下一集）
        lastSrc: episodeUrl,
        episodeName: epName,
        deviceId: getDeviceId(),
        src: src || "",
      });
    };
    activeProgressTimer = setInterval(send, 5000);
    video.addEventListener("pause", send);
    window.addEventListener("pagehide", send, { once: true });
  }
}

// 离开播放页时销毁 hls.js + 弹幕 + 进度上报
window.addEventListener("hashchange", () => {
  const { path } = parseRoute();
  if (path !== "/play") {
    disposeHls();
    disposeDanmaku();
    disposeDualSub();
    disposeProgressReporter();
  }
});

// ============================================================
// 弹幕源切换（danmaku_source_sheet.dart）：选择弹幕源 → 选择番剧 → 选择分集
// ============================================================
function danmakuSearchHistory() {
  try { const a = JSON.parse(localStorage.getItem("danmakuSearchHistory") || "[]"); return Array.isArray(a) ? a : []; } catch (_) { return []; }
}
function pushDanmakuSearchHistory(kw) {
  const arr = danmakuSearchHistory().filter((x) => x !== kw);
  arr.unshift(kw);
  try { localStorage.setItem("danmakuSearchHistory", JSON.stringify(arr.slice(0, 5))); } catch (_) {}
}
// opts: { keyword, onPick({ episodeId, animeTitle, episodeTitle }) }
function openDanmakuSourceSheet(opts) {
  let step = 0;           // 0 搜索 1 番剧 2 分集
  let keyword = opts.keyword || "";
  let animes = [];
  let anime = null;
  let episodes = [];
  openSheet({ title: "选择弹幕源", compact: true }, (body, close, ctl) => {
    const backBtn = iconBtn("arrow_back", { label: "返回" });
    backBtn.style.display = "none";
    ctl.sheet.querySelector(".sheet-header").prepend(backBtn);
    backBtn.addEventListener("click", () => { step = Math.max(0, step - 1); render(); });
    const progress = el("div", { class: "step-bar" }, el("span", {}), el("span", {}), el("span", {}));
    const content = el("div", {});
    body.append(progress, content);

    function setHeader() {
      ctl.setTitle(["选择弹幕源", "选择番剧", "选择分集"][step]);
      ctl.setDesc(step === 0 ? "" : step === 1 ? keyword : (anime ? anime.animeTitle : ""));
      backBtn.style.display = step > 0 ? "" : "none";
      [...progress.children].forEach((seg, i) => {
        seg.className = i < step ? "is-done" : i === step ? "is-current" : "";
      });
    }
    async function doSearch(kw) {
      keyword = kw;
      pushDanmakuSearchHistory(kw);
      step = 1;
      render();
      content.innerHTML = "";
      content.append(loadingNode("正在检索弹幕源", "medium"));
      try {
        const data = await fetchJson("/api/danmaku/search?keyword=" + encodeURIComponent(kw));
        animes = data.items || [];
      } catch (e) {
        content.innerHTML = "";
        content.append(errorState({ title: "弹幕源检索失败", message: e.message, compact: true, onRetry: () => doSearch(kw),
          actions: [button("返回搜索", { onclick: () => { step = 0; render(); } })] }));
        return;
      }
      if (step === 1) render();
    }
    async function pickAnime(a) {
      anime = a;
      step = 2;
      render();
      content.innerHTML = "";
      content.append(loadingNode("正在获取分集", "medium"));
      try {
        const data = await fetchJson("/api/danmaku/episodes?animeId=" + encodeURIComponent(a.animeId));
        episodes = data.items || [];
      } catch (e) {
        content.innerHTML = "";
        content.append(errorState({ title: "获取分集失败", message: e.message, compact: true, onRetry: () => pickAnime(a),
          actions: [button("返回番剧", { onclick: () => { step = 1; render(); } })] }));
        return;
      }
      if (step === 2) render();
    }

    function renderSearch() {
      const input = el("input", { class: "text-field", type: "search", placeholder: "番剧名称", autocomplete: "off" });
      input.value = keyword;
      const submit = () => { const v = input.value.trim(); if (v) doSearch(v); };
      input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); submit(); } });
      content.append(el("div", { class: "field-row", style: "margin-top:0" }, iconSvg("search"), input));
      const recent = danmakuSearchHistory();
      if (recent.length) {
        content.append(el("div", { class: "field-label" }, "最近搜索"),
          el("div", { class: "chips", style: "margin-top:8px" }, ...recent.map((kw) =>
            el("button", { class: "chip sl", type: "button", onclick: () => doSearch(kw) }, iconSvg("history"), kw))));
      }
      content.append(el("div", { class: "sheet-actions", style: "padding:20px 0 0" },
        button("取消", { variant: "text", onclick: close }),
        button("搜索", { variant: "filled", icon: "search", onclick: submit })));
      setTimeout(() => { try { input.focus(); } catch (_) {} }, 30);
    }
    function renderAnimes() {
      if (!animes.length) {
        content.append(emptyState({ icon: "search_off", title: "没有找到匹配的番剧", compact: true, actions: [button("返回搜索", { onclick: () => { step = 0; render(); } })] }));
        return;
      }
      content.append(splitList(animes.map((a) => splitRow(
        tile({ title: a.animeTitle, desc: a.typeDescription || (a.episodeCount ? a.episodeCount + " 集" : ""), chevron: true }),
        { onclick: () => pickAnime(a) })), { tight: true }));
    }
    function renderEpisodes() {
      if (!episodes.length) {
        content.append(emptyState({ icon: "subtitles", title: "这部番剧没有分集弹幕", compact: true, actions: [button("返回番剧", { onclick: () => { step = 1; render(); } })] }));
        return;
      }
      let filter = "";
      let range = null;   // [start, end] 1-based inclusive
      const total = episodes.length;
      const listNode = el("div", {});
      const countNode = el("div", { class: "t-label-large c-variant", style: "padding:12px 4px 4px" });
      const rows = () => {
        let list = episodes.map((e, i) => ({ e, n: i + 1 }));
        if (range) list = list.filter((x) => x.n >= range[0] && x.n <= range[1]);
        if (filter) list = list.filter((x) => (x.e.episodeTitle || "").toLowerCase().includes(filter) || String(x.n) === filter);
        return list;
      };
      const renderList = () => {
        listNode.innerHTML = "";
        const list = rows();
        countNode.textContent = list.length === total ? "共 " + total + " 集" : "显示 " + list.length + " 集，共 " + total + " 集";
        if (!list.length) { listNode.append(emptyState({ icon: "search_off", title: "没有匹配的分集", compact: true })); return; }
        listNode.append(splitList(list.map(({ e, n }) => splitRow(
          el("div", { class: "ep-row dm-ep-row" }, el("div", { class: "body" }, el("div", { class: "name" }, e.episodeTitle || ("第 " + n + " 话"))), iconSvg("chevron_right")),
          { onclick: () => { close(); opts.onPick({ episodeId: e.episodeId, animeTitle: anime.animeTitle, episodeTitle: e.episodeTitle }); } })), { tight: true, r20: true }));
      };
      if (total > 25) {
        const f = el("input", { class: "text-field", type: "search", placeholder: "标题或集号", autocomplete: "off" });
        f.addEventListener("input", () => { filter = f.value.trim().toLowerCase(); renderList(); });
        const toolbar = el("div", { class: "field-row", style: "margin-top:0" }, f);
        if (total > 100) {
          const jump = el("input", { class: "text-field dm-jump", type: "number", placeholder: "集号", min: "1", max: String(total) });
          jump.addEventListener("keydown", (ev) => {
            if (ev.key !== "Enter") return;
            const n = parseInt(jump.value, 10);
            if (!n || n < 1 || n > total) { toast("集号范围：1–" + total); return; }
            close();
            const e = episodes[n - 1];
            opts.onPick({ episodeId: e.episodeId, animeTitle: anime.animeTitle, episodeTitle: e.episodeTitle });
          });
          toolbar.append(jump);
          const chips = el("div", { class: "chips", style: "margin-top:8px" });
          const ranges = [null];
          for (let s = 1; s <= total; s += 100) ranges.push([s, Math.min(s + 99, total)]);
          const renderChips = () => {
            chips.innerHTML = "";
            for (const r of ranges) {
              const sel = (r === null && range === null) || (r && range && r[0] === range[0]);
              chips.append(filterChip(r ? r[0] + "-" + r[1] : "全部", sel, () => { range = r; renderChips(); renderList(); }));
            }
          };
          renderChips();
          content.append(toolbar, chips);
        } else {
          content.append(toolbar);
        }
      }
      content.append(countNode, listNode);
      renderList();
    }
    function render() {
      setHeader();
      content.innerHTML = "";
      if (step === 0) renderSearch();
      else if (step === 1) renderAnimes();
      else renderEpisodes();
    }
    render();
  });
}
