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
// ====== 跳过片头（只做片头；片尾不做——播完停在那儿，点“下一集”即可） ======
// 双来源（用户定）：
//  (1) Mika 预先实测标定（主来源）：看每部番第 1 集，从 0:00 起记片头曲结束、
//      正片第一句对白/第一个正片镜头出现的秒数 = introEnd，存进服务端共享的
//      web/skip-points.json（points，source:"measured"，同一季通用，换 OP 重标；
//      字幕可辅助判断：OP 歌词结束、对白开始就是点）。表里没写的番不自动跳，
//      不猜秒数。不用黑帧/静音自动检测当正式办法：吞噬星空开头约 20 秒本身
//      就是黑底 AXIS 卡，黑帧检测会把正片开头当片头误跳。
//  (2) 他手动跳的纠错（覆盖来源）：同一部番、同一源，他在片头时段手动快进/
//      拖进度条，落点在 ±5 秒内出现 3 次以上，才以他的落点为准覆盖 Mika 的
//      标定；不到 3 次不采用。表里记每次落点和次数，满 3 次才生效。
// 共享说明：正式表 web/skip-points.json 是服务端共享的唯一真源（手机与 VM
// 共用）；浏览器本地只存“候选”（localStorage skipCandidates），因为前端
// 没有写回静态文件的接口——候选满 3 次后会 POST /api/skip-points/report
// 上报（subs/proxy.py 已实现，审核队列存 subs/skip-reports.json），由 Mika
// 审核后写进正式表；服务端收到的 learned 点也可经 GET /api/skip-points/learned
// 读回（见 loadLearnedSkipPoints），跨设备共享，不用等写表。正式表当前为
// 空（points:{}），自动跳在任何番上都不生效，直到标定写入。
let SKIP_POINTS_CACHE = null;
async function loadSkipPoints() {
  if (SKIP_POINTS_CACHE) return SKIP_POINTS_CACHE;
  try {
    const r = await fetch("/assets/skip-points.json", { cache: "no-store" }); // 服务端对 /assets/*.json 发 7 天缓存（Cache-Control: max-age=604800），不加 no-store 会读到旧表，标定不生效。
    if (!r.ok) throw new Error("no skip table");
    SKIP_POINTS_CACHE = await r.json();
  } catch (_) { SKIP_POINTS_CACHE = { points: {}, candidates: {} }; }
  return SKIP_POINTS_CACHE;
}
function skipKey(bid, plugin) { return String(bid || "") + "|" + String(plugin || ""); }
function loadSkipCandidates() {
  try { return JSON.parse(localStorage.getItem("skipCandidates") || "{}") || {}; } catch (_) { return {}; }
}
function saveSkipCandidates(o) {
  try { localStorage.setItem("skipCandidates", JSON.stringify(o)); } catch (_) {}
}
function loadSkipPromoted() {
  try { return JSON.parse(localStorage.getItem("skipPromoted") || "{}") || {}; } catch (_) { return {}; }
}
function saveSkipPromoted(o) {
  try { localStorage.setItem("skipPromoted", JSON.stringify(o)); } catch (_) {}
}
// 手动跳过学习：fromSec<60（片头时段内出发）、向前跳 >=10 秒、落点 10–180 秒
// 才记一次。同一 key 下与落点 ±5 秒内的样本满 3 次，取中位数扶正为正式
// introEnd（覆盖 Mika 标定），并尝试上报服务端。
function recordManualSkip(bid, plugin, fromSec, toSec) {
  try {
    if (bid == null || !plugin) return;
    if (!(fromSec < 60) || !(toSec - fromSec >= 10) || toSec < 10 || toSec > 180) return;
    const key = skipKey(bid, plugin);
    const all = loadSkipCandidates();
    const rec = all[key] || { samples: [] };
    rec.samples.push(Math.round(toSec));
    if (rec.samples.length > 20) rec.samples = rec.samples.slice(-20);
    all[key] = rec;
    saveSkipCandidates(all);
    const cluster = rec.samples.filter((s) => Math.abs(s - toSec) <= 5);
    if (cluster.length >= 3) {
      const sorted = cluster.slice().sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const promoted = loadSkipPromoted();
      if (promoted[key] !== median) {
        promoted[key] = median;
        saveSkipPromoted(promoted);
        // 上报服务端审核写表（无此接口时静默失败；本地已扶正可用）
        try {
          fetch("/api/skip-points/report", { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ key, bid: String(bid), plugin, introEnd: median, samples: rec.samples, source: "learned", count: cluster.length }) }).catch(() => {});
        } catch (_) {}
      }
    }
  } catch (_) {}
}
// 服务端 learned 点（第三来源）：用户在任何设备上手动 3 次扶正的点，
// 上报后存在服务端审核队列里；播放页启动时拉一次 GET /api/skip-points/learned
// 读回，优先级在 本机扶正（skipPromoted）与正式表（skip-points.json）之后。
// 这样手机上扶正的点不用等 Mika 写表，VM 也能用；Mika 审核后写进正式表，
// 正式表仍是最高优先级的共享真源。拉不到就当没有，不挡播放。
let SKIP_LEARNED_CACHE = null;
async function loadLearnedSkipPoints() {
  if (SKIP_LEARNED_CACHE) return SKIP_LEARNED_CACHE;
  try {
    const r = await fetch("/api/skip-points/learned");
    if (!r.ok) throw new Error("no learned table");
    SKIP_LEARNED_CACHE = await r.json();
  } catch (_) { SKIP_LEARNED_CACHE = { points: {} }; }
  return SKIP_LEARNED_CACHE;
}
// 生效的 introEnd：他手动 3 次扶正的 > Mika 实测标定的 > 服务端 learned 的；都没有则 null（不跳）。
async function effectiveIntroEnd(bid, plugin) {
  const key = skipKey(bid, plugin);
  const promoted = loadSkipPromoted();
  if (promoted[key] != null) return { introEnd: promoted[key], source: "learned" };
  const table = await loadSkipPoints();
  const row = (table.points || {})[key] || (table.points || {})[String(bid) + "|*"];
  if (row && row.introEnd != null) return { introEnd: row.introEnd, source: row.source || "measured" };
  const learned = await loadLearnedSkipPoints();
  const lr = (learned.points || {})[key] || (learned.points || {})[String(bid) + "|*"];
  if (lr && lr.introEnd != null) return { introEnd: lr.introEnd, source: "learned" };
  return null;
}
function fmtSkipTime(s) {
  const m = Math.floor(s / 60), ss = Math.floor(s % 60);
  return m + ":" + String(ss).padStart(2, "0");
}

let activeHls = null;
let activeHlsLevels = [];
function disposeHls() {
  if (activeHls) {
    try { activeHls.destroy(); } catch (_) {}
    activeHls = null;
  }
  activeHlsLevels = [];
  try { window.__onHlsLevels = null; } catch (_) {}
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
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      // 只认当前还在用的实例：切集后旧实例的回调晚到，不能再去碰新页面的
      // 画质下拉（旧闭包 + 新 DOM = 引用过期那类问题，2026-11-09 复测）。
      if (activeHls !== hls) return;
      activeHlsLevels = (hls.levels || []).slice();
      try { if (typeof window.__onHlsLevels === "function") window.__onHlsLevels(activeHlsLevels); } catch (_) {}
    });
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

// ====== 锁按钮跑位自愈 ======
// 2026-11-11 桌面复测：一念永恒选集区倒序/正序/跳操作后，锁一度跑到页面
// 顶边、被视口上沿裁掉一半；点它切换锁定后才回视频右上角。静态看锁一直
// 在 playerWrap 里、.player-wrap 也是 relative，触发条件没复现出来；
// 加一道自愈：滚动停下 / 退出横屏时，若锁的定位基准（offsetParent）不是
// 视频容器，就把它挪回容器里并强制重排，把陈旧的绘制位置刷掉。平时不做
// 事，只在异常时动手；监听只绑一次，不随切集累积。
let activePlayerWrap = null;
function reanchorLock(wrap) {
  if (!wrap || !wrap.isConnected) { if (wrap === activePlayerWrap) activePlayerWrap = null; return; }
  const lock = wrap.querySelector(".ui-lock-btn");
  if (!lock) return;
  if (lock.parentElement !== wrap || lock.offsetParent !== wrap) wrap.append(lock);
  void lock.offsetWidth; // 强制重排，刷掉陈旧的绘制位置
}
if (typeof window !== "undefined" && !window.__lockReanchorBound) {
  window.__lockReanchorBound = true;
  let lockReanchorTimer = null;
  window.addEventListener("scroll", () => {
    clearTimeout(lockReanchorTimer);
    lockReanchorTimer = setTimeout(() => { if (activePlayerWrap) reanchorLock(activePlayerWrap); }, 150);
  }, { passive: true, capture: true });
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

// ====== 手势：长按 2 倍速 / 双击播放暂停 / 单点显隐控制条（触屏 + 鼠标） ======
// 用户定（2026-11-09；与 B站/腾讯/爱奇艺手机端一致：双击播放/暂停、长按 2 倍速、
// 松手恢复原速；倍速档 0.5/0.75/1/1.25/1.5/2，1.25 保留）：
//  - 长按左/右边缘 = 2 倍速快退/快进：按住 250ms 触发；右边缘播放中用
//    playbackRate=2 平滑走（不反复 seek、不重新缓冲），左边缘没有负倍速、
//    暂停时右边缘也不改播放状态，改用 250ms 一步 ±0.5 秒连续 seek（=2 倍速）。
//    松手恢复原倍速/停下。中间长按不做事。
//  - 双击屏幕任意位置 = 播放/暂停（不分左中右；旧的“双击左/右快进、中间暂停”
//    映射已删，两套映射并存会冲突）。
//  - 单点 = 显示/隐藏控制条（锁住时什么都不做）；边缘单点不快进，只有长按才快进。
//  - 互斥：长按 250ms 与双击窗口 300ms 用定时器互相取消——先触发的赢，
//    另一个不再触发；长按触发后清掉待确认的单击，长按松手不算一次点按。
//  - 控制条自动隐藏：播放中 1.5 秒无操作就淡出（.controls-hidden），
//    单点/点锁图标时短暂出现；暂停时一直显示；锁住时一直藏着；锁图标永不隐藏。
// 真机旧问题（2026-11-07）：iOS 不触发 dblclick（双击触发缩放），且 video
// 原生点按会立即暂停/播放；点按直接落在 video 上会弹 iOS 原生控制层。
// 做法不变：视频上方盖一层 .tap-zone + 左右 .edge-zone，点按落在它们上面，
// 不碰 video 元素本身，原生控制层不会弹出来。
let _seekFlashTimer = null;
function showSeekFlash(wrap, text) {
  let n = wrap.querySelector(".seek-flash");
  if (!n) { n = el("div", { class: "seek-flash" }); wrap.append(n); }
  n.textContent = text;
  n.classList.add("is-show");
  clearTimeout(_seekFlashTimer);
  _seekFlashTimer = setTimeout(() => n.classList.remove("is-show"), 1000);
}
// 10 秒快进/快退按钮已删（2026-11-09 复核后改）：长按 2 倍速手势已完全
// 覆盖它们的功能。手动跳过片头学习只走 seeked 监听（见 renderPlayer 末尾），
// 不再经过这里。
function seek2xStep(video, wrap, delta) {
  if (!video) return;
  video.currentTime = Math.max(0, (video.currentTime || 0) + delta);
  showSeekFlash(wrap, delta > 0 ? "快进 2 倍速" : "快退 2 倍速");
}
function bindTapSeek(video, wrap) {
  let zone = wrap.querySelector(".tap-zone");
  if (!zone) { zone = el("div", { class: "tap-zone" }); wrap.append(zone); }
  // 边缘快进/快退判定区：一根手指那么大——左右各占视频宽度的 34%（竖屏
  // 393px 下约 134px，远大于 48px 最小触摸目标），高度覆盖视频主体
  // （顶部 44px 留给返回键、底部 84px 留给控制条区，不碰这两处）。
  // 判定区 z-index 4：在 tap-zone(3) 之上、跳过片头按钮(7)之下，字幕层
  // dual-sub(5)在它们之上但 pointer-events:none 不挡点按。长按只在边缘区
  // 触发，中间区长按不做事；双击不分区域，任意位置都是播放/暂停。
  // 左右用“哪个判定区元素接到点按”来分，不用坐标算——旋转 90° 后判定区
  // 跟着转，元素归属和旧的坐标换算结果一致，横屏也不会错。
  let edgeL = wrap.querySelector(".edge-zone.edge-left");
  let edgeR = wrap.querySelector(".edge-zone.edge-right");
  if (!edgeL) { edgeL = el("div", { class: "edge-zone edge-left" }); wrap.append(edgeL); }
  if (!edgeR) { edgeR = el("div", { class: "edge-zone edge-right" }); wrap.append(edgeR); }

  const LONG_PRESS_MS = 250;   // 用户定：按住 0.25 秒触发长按（国内常见 300–350ms，用户定 250ms）
  const DOUBLE_TAP_MS = 300;   // 双击窗口：300ms 内第二下 = 双击
  const REPEAT_MS = 250;       // 长按连续 seek 步进间隔
  const REPEAT_STEP = 0.5;     // 每步 0.5 秒：0.5 / 0.25 = 2 倍速
  const AUTO_HIDE_MS = 1500;   // 用户定：控制条 1.5 秒无操作淡出
  const MOVE_CANCEL_PX = 24;   // 手指滑动超 24px 就不是点按/长按

  const togglePlay = () => {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  };

  // ---- 控制条自动隐藏（按钮不长时间盖住正片） ----
  // 控制条在视频下方页面流里，本身不盖画面；但横屏旋转态、跳过片头浮钮、
  // 全屏退出键、返回键都在画面上，1.5 秒无操作就一起淡出（.controls-hidden），
  // 单点/点锁图标时再短暂出现。锁图标（.ui-lock-btn）永不隐藏，字幕永不隐藏。
  const main = wrap.closest(".player-main");
  const controlsEl = main ? main.querySelector(".player-controls") : null;
  const isLocked = () => !!main && main.classList.contains("ui-locked");
  let hideTimer = null;
  const armAutoHide = () => {
    clearTimeout(hideTimer); hideTimer = null;
    if (!main || video.paused || isLocked() || main.classList.contains("controls-hidden")) return;
    hideTimer = setTimeout(() => {
      // 菜单开着（倍速下拉 / 更多菜单）：不藏，1.5 秒后再看——原生 select
      // 时代就是这个定时器在用户挑倍速时把控制条藏了、连下拉一起杀掉，
      // 点选落到进度条上误跳播（2026-11-11 桌面复测：点 9 次只弹出 2 次）。
      if (main.classList.contains("menu-open")) { armAutoHide(); return; }
      if (!video.paused && !isLocked()) hideControls();
    }, AUTO_HIDE_MS);
  };
  const showControls = () => {
    if (!main || isLocked()) return;
    main.classList.remove("controls-hidden");
    armAutoHide();
  };
  const hideControls = () => {
    // 菜单开着时也不藏：单点视频会走到这儿，藏了就把菜单一起盖掉。
    if (!main || main.classList.contains("menu-open")) return;
    main.classList.add("controls-hidden");
    clearTimeout(hideTimer); hideTimer = null;
  };
  const pokeControls = () => {
    if (!main || isLocked() || main.classList.contains("controls-hidden")) return;
    armAutoHide();
  };
  // 桌面端回归（2026-11-09 线上复测）：1.5 秒只认 pointerdown/click 才续命，
  // 鼠标从锁图标（视频右上角）移到视频下方的控制条要 1.5 秒以上，控制条
  // 在半路就藏了，暂停点不中。鼠标移动本身就是“有操作”：在视频区/控制条
  // 上移动就重新计时；控制条藏着时鼠标一移进来就重新出现（一碰就回）。
  // 只认鼠标：触屏滑动也会触发 pointermove，不能让它把控制条顶出来。
  const pokeFromMouseMove = (ev) => {
    if (ev && ev.pointerType && ev.pointerType !== "mouse") return;
    if (!main || isLocked()) return;
    if (main.classList.contains("controls-hidden")) showControls();
    else pokeControls();
  };
  video.addEventListener("play", armAutoHide);
  video.addEventListener("pause", () => {
    clearTimeout(hideTimer); hideTimer = null;
    // 锁住时不移除 controls-hidden：锁住就是要让按钮一直藏着，
    // 暂停也不该把它放出来（.ui-locked 的 display:none 还盖着，
    // 但状态要一致，不然解锁后行为会乱）。
    if (main && !isLocked()) main.classList.remove("controls-hidden");
  });
  if (controlsEl) {
    controlsEl.addEventListener("pointerdown", pokeControls);
    controlsEl.addEventListener("click", pokeControls);
    controlsEl.addEventListener("pointermove", pokeFromMouseMove);
    controlsEl.addEventListener("mouseenter", pokeControls);
  }
  // 进度条行也是控制条的一部分：点它、拖它、鼠标在它上面移动都算操作，
  // 1.5 秒重新计时（复测回归：只绑了 .player-controls，拖进度条不续命）。
  const seekRowEl = main ? main.querySelector(".player-seek-row") : null;
  if (seekRowEl) {
    seekRowEl.addEventListener("pointerdown", pokeControls);
    seekRowEl.addEventListener("click", pokeControls);
    seekRowEl.addEventListener("input", pokeControls);
    seekRowEl.addEventListener("pointermove", pokeFromMouseMove);
  }
  // 锁开关在 bindTapSeek 之后才创建，直接监听不到；只看 ui-locked 的变化，
  // 不看 controls-hidden（否则显隐切换会自己触发自己、来回乒乓）。
  let wasLocked = isLocked();
  if (main && typeof MutationObserver !== "undefined") {
    new MutationObserver(() => {
      const locked = isLocked();
      if (locked === wasLocked) return;
      wasLocked = locked;
      if (locked) { clearTimeout(hideTimer); hideTimer = null; }
      else showControls();
    }).observe(main, { attributes: true, attributeFilter: ["class"] });
  }
  // 视频区鼠标移动也续命/唤回控制条（事件从 tap-zone/edge-zone 冒泡上来）。
  wrap.addEventListener("pointermove", pokeFromMouseMove);
  armAutoHide();

  // ---- 手势状态机：一次操作只触发一个动作 ----
  let pendingTapTimer = null; // 待确认的单击：等 300ms 看有没有第二下
  let lpTimer = null, lpInterval = null, lpSide = null, lpFired = false;
  let lpStartX = 0, lpStartY = 0, lpStartTime = 0, lpMoved = false, lpSavedRate = 1;
  let lastRealPressEndAt = 0; // 最近一次真实点按（mouseup/touchend）结束的时间戳；浏览器自己的 click 紧跟在它后面（<100ms），靠它识别、忽略——合成 click 不更新它

  const doSingleTap = () => {
    if (isLocked()) {
      // 锁住时单点不再静默无反应（2026-11-10 用户定：锁不能把人困住）：
      // 明确告诉用户怎么解锁，并让右上角的锁图标闪一下、看得见。
      toast("已锁定，点右上角锁解锁");
      const lockBtn = main && main.querySelector(".ui-lock-btn");
      if (lockBtn) {
        lockBtn.classList.remove("is-attention");
        void lockBtn.offsetWidth; // 强制重排，让脉冲动画每次点按都能重播
        lockBtn.classList.add("is-attention");
        setTimeout(() => lockBtn.classList.remove("is-attention"), 900);
      }
      return;
    }
    if (!main) return;
    if (main.classList.contains("controls-hidden")) showControls();
    else hideControls();
  };

  const fireLongPress = () => {
    lpTimer = null;
    if (lpMoved) return;
    // 长按赢了：待确认的单击作废——双击的第一下不能在长按后补一个暂停/显隐。
    clearTimeout(pendingTapTimer); pendingTapTimer = null;
    lpFired = true;
    lpStartTime = video.currentTime || 0;
    video._suppressSkipLearn = true; // 长按期间逐次 seek 不记学习样本
    if (lpSide === "right" && !video.paused) {
      // 播放中正向：原生 playbackRate=2 最平滑，不反复 seek、不重新缓冲。
      lpSavedRate = video.playbackRate || 1;
      try { video.playbackRate = 2; } catch (_) {}
      showSeekFlash(wrap, "快进 2 倍速");
      // 闪字 1 秒就消失，长按期间每 800ms 补闪一次，让它一直看得见。
      lpInterval = setInterval(() => showSeekFlash(wrap, "快进 2 倍速"), 800);
    } else {
      // 反向没有负倍速；暂停时正向也不改播放状态：250ms 一步 ±0.5 秒连续 seek。
      const delta = lpSide === "right" ? REPEAT_STEP : -REPEAT_STEP;
      seek2xStep(video, wrap, delta);
      lpInterval = setInterval(() => seek2xStep(video, wrap, delta), REPEAT_MS);
    }
  };
  const endLongPress = () => {
    clearTimeout(lpTimer); lpTimer = null;
    clearInterval(lpInterval); lpInterval = null;
    if (!lpFired) return false;
    lpFired = false;
    // 松手恢复原速/停下。
    if (lpSide === "right" && !video.paused) {
      try { video.playbackRate = lpSavedRate || 1; } catch (_) {}
    }
    // 长按整段只记一个学习样本：按住时的位置 → 松手时的位置（向前 >=10 秒、
    // 落点 10–180 秒才记，recordManualSkip 内部再按 ±5 秒/3 次扶正）。
    try {
      const to = video.currentTime || 0;
      if (video._skipCtx && to - lpStartTime >= 10) recordManualSkip(video._skipCtx.bid, video._skipCtx.plugin, lpStartTime, to);
    } catch (_) {}
    // seeked 事件可能晚于 touchend 才触发，抑制标志多留 400ms 再清。
    setTimeout(() => { video._suppressSkipLearn = false; }, 400);
    return true;
  };

  const onPressStart = (side, x, y) => {
    lpSide = side; lpMoved = false; lpStartX = x; lpStartY = y;
    clearTimeout(lpTimer); lpTimer = null;
    // 只有边缘区才设长按定时器；中间区按住再久也不触发长按。
    if (side === "left" || side === "right") lpTimer = setTimeout(fireLongPress, LONG_PRESS_MS);
    pokeControls();
  };
  const onPressMove = (x, y) => {
    if (Math.abs(x - lpStartX) > MOVE_CANCEL_PX || Math.abs(y - lpStartY) > MOVE_CANCEL_PX) {
      lpMoved = true;
      clearTimeout(lpTimer); lpTimer = null;
    }
  };
  const onPressEnd = () => {
    clearTimeout(lpTimer); lpTimer = null;
    if (lpFired) { endLongPress(); return; } // 长按松手：不算点按，不触发单击/双击
    if (lpMoved) return; // 滑动：不算点按
    // 短点按：等 300ms 看有没有第二下。
    if (pendingTapTimer) {
      clearTimeout(pendingTapTimer); pendingTapTimer = null;
      togglePlay(); // 双击屏幕任意位置 = 播放/暂停
      pokeControls();
      return;
    }
    pendingTapTimer = setTimeout(() => { pendingTapTimer = null; doSingleTap(); }, DOUBLE_TAP_MS);
  };
  const onPressCancel = () => {
    clearTimeout(lpTimer); lpTimer = null;
    if (lpFired) endLongPress();
  };

  let lastTouchEnd = 0;
  let mouseDown = false;
  const bindTapTarget = (target, side) => {
    target.addEventListener("touchstart", (ev) => {
      if (!ev.changedTouches || !ev.changedTouches.length) return;
      const t = ev.changedTouches[0];
      onPressStart(side, t.clientX, t.clientY);
    }, { passive: true });
    target.addEventListener("touchmove", (ev) => {
      if (!ev.changedTouches || !ev.changedTouches.length) return;
      const t = ev.changedTouches[0];
      onPressMove(t.clientX, t.clientY);
    }, { passive: true });
    target.addEventListener("touchend", (ev) => {
      ev.preventDefault(); // 阻止合成 click 与 iOS 双击缩放
      ev.stopPropagation();
      lastTouchEnd = Date.now();
      lastRealPressEndAt = Date.now();
      onPressEnd();
    }, { passive: false });
    target.addEventListener("touchcancel", () => { onPressCancel(); }, { passive: true });
    target.addEventListener("mousedown", (ev) => {
      mouseDown = true;
      onPressStart(side, ev.clientX, ev.clientY);
    });
    target.addEventListener("mousemove", (ev) => { if (mouseDown) onPressMove(ev.clientX, ev.clientY); });
    target.addEventListener("mouseup", () => {
      if (!mouseDown) return;
      mouseDown = false;
      lastRealPressEndAt = Date.now();
      onPressEnd();
    });
    // 按住拖出元素外再松手：target 收不到 mouseup，用 mouseleave 兜底取消，
    // 否则长按的 2 倍速/连续 seek 会一直走下去停不下来。
    target.addEventListener("mouseleave", () => {
      if (!mouseDown) return;
      mouseDown = false;
      onPressCancel();
    });
    // 长按还会触发浏览器的 contextmenu（尤其安卓）：禁掉，不让菜单盖住画面。
    target.addEventListener("contextmenu", (ev) => { ev.preventDefault(); });
    target.addEventListener("click", (ev) => {
      // 点按已在 touchend/mouseup 里处理，click 正常只拦冒泡、不再触发动作，
      // 否则一次点按会触发两次（桌面端 mouseup + click 各一次）。
      // 兜底：合成 click（自动化/无障碍工具直接派发 click，没有前置
      // mousedown/mouseup）——没有 100ms 内的真实点按，就把它当一次点按走
      // 同一套单击/双击逻辑；浏览器自己的 click 紧跟 mouseup（<100ms），
      // 直接忽略，不会算两次。100ms 而不用 300ms：两次合成 click 之间
      // 通常隔 100ms 以上，窗口太宽会把第二次合成 click 也吞掉。
      ev.stopPropagation();
      ev.preventDefault();
      if (Date.now() - lastRealPressEndAt > 100) onPressEnd();
    });
  };
  bindTapTarget(zone, "middle");
  bindTapTarget(edgeL, "left");
  bindTapTarget(edgeR, "right");
  // 横屏长按还会弹出系统菜单（复制等）：tap-zone 只盖视频区，wrap 整层再禁一次兜底。
  wrap.addEventListener("contextmenu", (ev) => { ev.preventDefault(); });
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
  if (document.fullscreenElement) { await document.exitFullscreen().catch(() => {}); setLandscapeLabel(btn, "全屏"); return; }
  if (inWebkitFullscreen(video)) {
    // 等原生全屏退出（webkitendfullscreen）再旋转，避免两层叠加。
    // 第一次退出若被忽略（转场进行中调用会被吞），再试一次。
    for (let attempt = 0; attempt < 2 && inWebkitFullscreen(video); attempt++) {
      try { video.webkitExitFullscreen(); } catch (_) {}
      await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        video.addEventListener("webkitendfullscreen", finish, { once: true });
        setTimeout(finish, 800);
      });
    }
  }
  if (!IS_IOS && document.fullscreenEnabled && wrap.requestFullscreen) {
    try {
      await wrap.requestFullscreen();
      if (screen.orientation && screen.orientation.lock) {
        await screen.orientation.lock("landscape").catch(() => {});
      }
      setLandscapeLabel(btn, "退出全屏");
      const onFs = () => {
        if (!document.fullscreenElement) {
          document.removeEventListener("fullscreenchange", onFs);
          setLandscapeLabel(btn, "全屏");
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
    // iOS 原生全屏会丢掉 HTML 叠加层（字幕、点屏快进全没）、控制层也关不掉：
    // 退出它再走 CSS 旋转横屏。退出是异步的，必须等 webkitendfullscreen
    // （或 800ms 超时）再旋转，否则旋转会被原生全屏层盖住、看起来像
    // “横屏按钮无效、只有一个全屏能点”（2026-11-07 真机反馈）。
    try { video.webkitExitFullscreen(); } catch (_) {}
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      if (!wrap.classList.contains("is-rotated")) enterRotated(wrap, btn);
    };
    video.addEventListener("webkitendfullscreen", finish, { once: true });
    setTimeout(() => {
      finish();
      // 退出若被忽略（转场进行中调用会被吞）：转场已结束，再试一次退出。
      try { if (inWebkitFullscreen(video)) video.webkitExitFullscreen(); } catch (_) {}
    }, 800);
  });
  video.addEventListener("webkitendfullscreen", () => {
    if (!wrap.classList.contains("is-rotated")) setLandscapeLabel(btn, "全屏");
  });
}
function enterRotated(wrap, btn) {
  wrap.classList.add("is-rotated");
  document.body.classList.add("no-scroll");
  // 横屏也要那排按钮（2026-11-10 用户定）：控制条行平时在页面流里（播放器下方），
  // 旋转后播放器是 fixed 铺满视口，会把它盖住。进横屏时把它挪进旋转框里贴在底部
  // （CSS .is-rotated .player-controls-wrap）；退出时挪回原位。只挪节点不重建：
  // 事件监听和状态都在节点上，不会丢；手势只绑在 tap-zone/edge-zone 上，
  // 控制条挪进来也不会触发点按逻辑。
  const main = wrap.closest(".player-main");
  const cw = main && main.querySelector(".player-controls-wrap");
  if (cw && cw.parentElement !== wrap) {
    cw._homeNext = cw.nextSibling; // 退出时插回原来的位置（.player-meta 之前）
    wrap.append(cw);
  }
  let exit = wrap.querySelector(".rotate-exit");
  if (!exit) {
    exit = el("button", { class: "rotate-exit sl", type: "button" }, "退出全屏");
    exit.addEventListener("click", (ev) => { ev.stopPropagation(); exitRotated(wrap, btn); });
    wrap.append(exit);
  }
  exit.style.display = "";
  setLandscapeLabel(btn, "退出全屏");
}
function exitRotated(wrap, btn) {
  wrap.classList.remove("is-rotated");
  document.body.classList.remove("no-scroll");
  const main = wrap.closest(".player-main");
  const cw = wrap.querySelector(".player-controls-wrap");
  if (cw && main && cw.parentElement === wrap) {
    if (cw._homeNext && cw._homeNext.parentElement === main) main.insertBefore(cw, cw._homeNext);
    else main.append(cw);
    cw._homeNext = null;
  }
  const exit = wrap.querySelector(".rotate-exit");
  if (exit) exit.style.display = "none";
  setLandscapeLabel(btn, "全屏");
  // 退出横屏会动 .player-wrap 的定位上下文（fixed ↔ relative），顺手把锁
  // 按钮的位置刷一次，别让它留在旧的绘制位置上。
  reanchorLock(wrap);
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
  let resolveMs = 0;
  const resolveStart = performance.now();
  // 自动换源（解析失败 / 播放器报错共用）：记下失败源，24 小时内不再首选它；
  // 按干净度+延迟试别的源同一集，试出来就跳过去；都试不出返回 { switched:false, hadOthers }。
  // fb 记录已试过的源，防止来回跳；同一集内最多把 5 个源各试一次。
  const switchTried = new Set((params.fb || "").split(",").filter(Boolean));
  async function autoSwitchSource(failedPlugin) {
    markPluginParseFailed(failedPlugin);
    switchTried.add(failedPlugin);
    const seriesName = (title || "").split(" · ").slice(0, -1).join(" · ") || title || "";
    let hadOthers = false;
    const switchLog = [];
    try {
      const plugins = await fetchJson("/api/plugins");
      let latMap = {};
      try { latMap = JSON.parse(localStorage.getItem("pluginLatency") || "{}") || {}; } catch (_) {}
      let clean = { clean: {}, dirty: [] };
      try { clean = await loadCleanSources(); } catch (_) {}
      const _orderedAll = orderPluginsCleanFirst(plugins, clean, seriesName, bid)
        .sort((a, b) => {
          const ca = (clean.clean && clean.clean[a.name]) ? 0 : 1;
          const cb = (clean.clean && clean.clean[b.name]) ? 0 : 1;
          return (ca - cb) || ((latMap[a.name] == null ? 1e9 : latMap[a.name]) - (latMap[b.name] == null ? 1e9 : latMap[b.name]));
        });
      const _fresh = _orderedAll.filter((p) => !pluginFailedRecently(p.name));
      const orderedFinal = _fresh.length ? _fresh : _orderedAll;
      for (const p of orderedFinal) {
        if (switchTried.has(p.name)) continue;
        hadOthers = true;
        let r = null;
        try { r = await pluginSearchBest(p.name, [seriesName]); } catch (_) { switchLog.push(p.name + " 搜不到"); continue; }
        const best = r && r.best;
        if (!best || best.score < 20) { switchLog.push(p.name + " 搜不到"); continue; }
        let info = null;
        for (let att = 0; att < 3 && !info; att++) {
          try { info = await loadRoadsAndHistory(p.name, best.item.src, bid); }
          catch (_) { if (att < 2) await new Promise((res) => setTimeout(res, 800)); }
        }
        if (!info) { switchLog.push(p.name + " 取集数失败"); continue; }
        const eps = ((info.roads || [])[0] || {}).episodes || [];
        if (!eps[epNum - 1]) { switchLog.push(p.name + " 没这集"); continue; }
        // 跳页前先直接解析验证：能解析才跳，不行就地换下一个，不白跳一次整页。
        // （吞噬第 1 集教训：AGE 解析 20 秒超时，盲跳到 MXdm 又超时，光速/7sefun 明明 1 秒能解析却没走到。）
        let okRes = null;
        let okMs = 0;
        const cached2 = (typeof getCachedResolve === "function") ? getCachedResolve(p.name, eps[epNum - 1].src) : null;
        if (cached2) { okRes = cached2.data; okMs = cached2.ms; }
        else {
          try {
            const _s2 = performance.now();
            const rc2 = new AbortController();
            const rt2 = setTimeout(() => rc2.abort(), 5000);
            try {
              const rr = await fetch("/api/resolve?plugin=" + encodeURIComponent(p.name) + "&episodeUrl=" + encodeURIComponent(eps[epNum - 1].src), { signal: rc2.signal });
              if (rr.ok) { okRes = await rr.json(); okMs = Math.round(performance.now() - _s2); }
            } finally { clearTimeout(rt2); }
          } catch (_) {}
          if (okRes) { try { if (typeof setCachedResolve === "function") setCachedResolve(p.name, eps[epNum - 1].src, okRes, okMs); } catch (_) {} }
        }
        if (!okRes) { switchLog.push(p.name + " 解析失败"); switchTried.add(p.name); markPluginParseFailed(p.name); continue; }
        localStorage.setItem("lastPlugin", p.name);
        toast("已自动换源，正在解析…");
        go("/play", {
          plugin: p.name, episodeUrl: eps[epNum - 1].src,
          title: (seriesName ? seriesName + " · " : "") + (eps[epNum - 1].name || ("第" + epNum + "集")),
          episode: String(epNum), road: "0", src: best.item.src,
          bid: bid || undefined, fb: [...switchTried, p.name].join(","),
        });
        return { switched: true, hadOthers, log: switchLog };
      }
    } catch (_) { /* 拿规则列表失败就直接报错 */ }
    return { switched: false, hadOthers, log: switchLog };
  }
  try {
    // 2026-11-11 用户定：5 秒没进去就是失败。详情页/选源时实测过的解析结果
    // （15 分钟内）直接用，不用再解析一次；没现成结果才解析，5 秒超时就换源。
    const cached = (typeof getCachedResolve === "function") ? getCachedResolve(plugin, episodeUrl) : null;
    if (cached) {
      data = cached.data;
      resolveMs = cached.ms;
    } else {
      const rc = new AbortController();
      const rt = setTimeout(() => rc.abort(), 5000);
      let rres;
      try { rres = await fetch("/api/resolve?plugin=" + encodeURIComponent(plugin) + "&episodeUrl=" + encodeURIComponent(episodeUrl), { signal: rc.signal }); }
      finally { clearTimeout(rt); }
      if (!rres.ok) throw new Error("HTTP " + rres.status + ": " + rres.statusText);
      data = await rres.json();
      resolveMs = Math.round(performance.now() - resolveStart);
      try { if (typeof setCachedResolve === "function") setCachedResolve(plugin, episodeUrl, data, resolveMs); } catch (_) {}
    }
    try {
      const lat = JSON.parse(localStorage.getItem("pluginLatency") || "{}") || {};
      lat[plugin] = resolveMs;
      localStorage.setItem("pluginLatency", JSON.stringify(lat));
    } catch (_) {}
    // 解析成功：清除该源的失败记录（会话内 + 24h），下次自动选源不再跳过它。
    clearPluginParseFailed(plugin);
  } catch (e) {
    // 这个源解析失败（比如 AGE 某条目 20 秒超时 504）：自动换别的源试同一集，
    // 不让用户自己回去选源（2026-11-09 用户定：哪个能播用哪个）。
    status.textContent = "这个源播不出来，正在自动换别的源试同一集…";
    const sw = await autoSwitchSource(plugin);
    if (sw.switched) return;
    status.remove();
    page.append(errorState({ title: "解析失败", message: sw.hadOthers ? "这个源播不出来，换了其他源也播不出来：" + (sw.log && sw.log.length ? sw.log.join("；") + "。" : "") + e.message : e.message, onRetry: () => renderPlayer(params) }));
    return;
  }
  status.remove();

  // 布局：竖屏 / 窄屏时面板在视频下方；横屏宽屏时作为右侧侧栏（video_page_layout.dart）
  const main = el("div", { class: "player-main" });
  const panel = el("div", { class: "player-panel" });
  page.append(el("div", { class: "player-layout" }, main, panel));
  const seriesTitle = (title || "").split(" · ").slice(0, -1).join(" · ") || title || "";

  // controls:false：浏览器原生控制条暂停时会盖住烧进画面的中文硬字幕下半行，
  // 且站里没有任何 ::cue/原生控制条样式能给它让位。改由页面自绘控件 +
  // tap-zone（已扩到全幅）+ 大播放按钮管播放/暂停；另加 ::cue 样式（styles.css）
  // 管全屏原生字幕轨。tap-zone 的手势（长按 2 倍速、双击播放/暂停、单点显隐控制条）、键盘空格、大播放按钮都不变。
  const video = el("video", { controls: false, playsinline: true, "webkit-playsinline": true, preload: "metadata" });
  const playerWrap = el("div", { class: "player-wrap" }, video);
  main.append(playerWrap);

  const errorNode = el("div", { class: "player-error" });
  errorNode.style.display = "none";
  main.append(errorNode);
  const showError = (msg) => { errorNode.textContent = msg; errorNode.style.display = "block"; };

  await attachStream(video, data, showError);
  activeVideoEl = video;

  // ====== 控件行：上一集 / 下一集 / 倍速 / 画面比例 / 重新解析 ======
  const prevBtn = button("上一集");
  const nextBtn = button("下一集");
  prevBtn.disabled = true;
  nextBtn.disabled = true;

  // 播放偏好（倍速 / 画面比例）记在 localStorage，下次进播放页沿用
  let prefs = {};
  try { prefs = JSON.parse(localStorage.getItem("playerPrefs") || "{}") || {}; } catch (_) {}
  const savePrefs = (patch) => { Object.assign(prefs, patch); try { localStorage.setItem("playerPrefs", JSON.stringify(prefs)); } catch (_) {} };
  // 锁不跨页面/跨集保留（2026-11-10 用户定：锁不能把人困住）：每次打开
  // 播放器、每换一集都默认解锁。旧的 playerPrefs.uiLock=true 会让锁住
  // 的状态跟到下一集/下一次打开，点画面也没反应，所以一进播放页就清掉
  // 并写回；锁只在本集内有效。
  if (prefs.uiLock) { prefs.uiLock = false; savePrefs({ uiLock: false }); }
  // 倍速：原生 <select> 在桌面横屏下极不稳（2026-11-11 桌面复测：点 9 次
  // 只弹出 2 次、2x 三次都选不上——控制条 1.5 秒自动隐藏会把 select 设成
  // visibility:hidden，Chrome 随即关掉原生下拉；菜单开着时鼠标在原生弹窗
  // 上不产生页面 pointermove，定时器一到就把弹窗杀掉，点选落到进度条上
  // 误跳播）。改成自定义下拉：按钮 + 菜单 div，菜单开着时 main 加
  // .menu-open，自动隐藏看到就跳过（见 bindTapSeek 的 armAutoHide）；
  // 选完 / 点外面 / 按 Esc 关菜单，关完把焦点还给页面（空格恢复播放/暂停）。
  const RATES = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
  const initialRate = RATES.includes(prefs.rate) ? prefs.rate : 1.0;
  const rateBtn = button(initialRate + "x", { variant: "tonal" });
  rateBtn.setAttribute("aria-label", "倍速");
  rateBtn.setAttribute("aria-haspopup", "menu");
  rateBtn.setAttribute("aria-expanded", "false");
  const rateMenu = el("div", { class: "player-rate-menu", role: "menu", "aria-label": "倍速" });
  const rateOptions = {};
  const syncRateOptions = (r) => {
    for (const [k, o] of Object.entries(rateOptions)) {
      const on = +k === r;
      o.classList.toggle("is-active", on);
      o.setAttribute("aria-checked", String(on));
    }
  };
  const setRate = (r) => {
    video.playbackRate = r;
    savePrefs({ rate: r });
    const l = rateBtn.querySelector(".label");
    if (l) l.textContent = r + "x";
    syncRateOptions(r);
  };
  for (const r of RATES) {
    const opt = el("button", { class: "rate-opt", type: "button", role: "menuitemradio", "aria-checked": String(r === initialRate) }, r + "x");
    if (r === initialRate) opt.classList.add("is-active");
    opt.addEventListener("click", (ev) => { ev.stopPropagation(); setRate(r); closeRateMenu(); });
    rateMenu.append(opt);
    rateOptions[r] = opt;
  }
  const rateWrap = el("div", { class: "rate-wrap" }, rateBtn, rateMenu);
  // 两个菜单（倍速下拉 / 更多菜单）只要有一个开着，自动隐藏就暂停。
  const syncMenuOpenClass = () => {
    main.classList.toggle("menu-open", rateMenu.classList.contains("is-open") || moreMenu.classList.contains("is-open"));
  };
  const onRateMenuOutside = (ev) => { if (!rateWrap.contains(ev.target)) closeRateMenu(); };
  const onRateMenuKey = (ev) => { if (ev.key === "Escape") { ev.stopPropagation(); closeRateMenu(); } };
  const openRateMenu = () => {
    rateMenu.classList.add("is-open");
    rateBtn.setAttribute("aria-expanded", "true");
    syncMenuOpenClass();
    document.addEventListener("pointerdown", onRateMenuOutside, true);
    document.addEventListener("keydown", onRateMenuKey, true);
  };
  const closeRateMenu = () => {
    if (!rateMenu.classList.contains("is-open")) return;
    rateMenu.classList.remove("is-open");
    rateBtn.setAttribute("aria-expanded", "false");
    syncMenuOpenClass();
    document.removeEventListener("pointerdown", onRateMenuOutside, true);
    document.removeEventListener("keydown", onRateMenuKey, true);
    // 选完把焦点还给页面：按钮拿着焦点时空格会再触发它，键盘快捷键失灵。
    try { if (document.activeElement) document.activeElement.blur(); } catch (_) {}
  };
  rateBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (rateMenu.classList.contains("is-open")) closeRateMenu();
    else openRateMenu();
  });
  if (initialRate !== 1.0) video.addEventListener("loadedmetadata", () => { video.playbackRate = initialRate; }, { once: true });

  const fitSelect = el("select", { class: "btn btn-tonal", "aria-label": "画面比例" });
  const initialFit = ["contain", "cover", "fill"].includes(prefs.fit) ? prefs.fit : "contain";
  for (const f of [{ v: "contain", label: "画面 适应" }, { v: "cover", label: "画面 填充" }, { v: "fill", label: "画面 拉伸" }]) {
    const opt = el("option", { value: f.v }, f.label);
    if (f.v === initialFit) opt.setAttribute("selected", "");
    fitSelect.append(opt);
  }
  video.style.objectFit = initialFit;
  fitSelect.addEventListener("change", () => { video.style.objectFit = fitSelect.value; savePrefs({ fit: fitSelect.value }); try { fitSelect.blur(); } catch (_) {} });

  // 播放/暂停按钮：controls:false 后页面上必须有一个明确的播放/暂停入口，
  // 不能只靠点按视频——竖屏时 tap-zone 只覆盖视频主体（top:44px/bottom:84px，
  // 上下留给返回键和控制条区；横屏旋转态才铺满全幅，见 styles.css），
  // 按钮仍是无障碍与桌面端的兜底。
  const playPauseBtn = button("暂停", { variant: "text", onclick: () => {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  } });
  const syncPlayPauseBtn = () => {
    const l = playPauseBtn.querySelector(".label");
    if (l) l.textContent = video.paused ? "播放" : "暂停";
  };
  video.addEventListener("play", syncPlayPauseBtn);
  video.addEventListener("pause", syncPlayPauseBtn);
  // 控制条主排（2026-11-10 按腾讯思路重排）：只留 6 个固定项——播放/暂停、
  // 上一集、下一集、倍速、跳过片头开关、全屏，flex 均分一排全部可见、
  // 不横向滑动（旧的 7 项 + 横向滑动 + 右侧“›”提示已删，用户找不到按钮）。
  // 画质/字幕/画面比例/重新解析/画中画仍在“更多”菜单里，只是触发按钮
  // 挪到下面第二行，不占主排。快退/快进 10 秒按钮已删（长按 2 倍速已覆盖）；
  // 控制条里的“锁按钮”已删（角落常驻锁图标才是用户要的入口，两个锁重复）。
  const moreMenu = el("div", { class: "player-more-menu" });
  const moreBtn = button("更多", { variant: "text", onclick: (ev) => {
    if (ev) ev.stopPropagation();
    moreMenu.classList.toggle("is-open");
    syncMenuOpenClass(); // 更多菜单开着时自动隐藏也暂停（和倍速下拉同一机制）
  } });
  const reload = button("重新解析", { variant: "text", icon: "refresh", onclick: () => renderPlayer(params) });
  const landscapeBtn = button("全屏", { variant: "text", onclick: () => toggleLandscape(video, playerWrap, landscapeBtn) });
  // 画质下拉（仅 hls.js 分支）：MANIFEST_PARSED 后读 hls.levels 生成；
  // 单码率（levels<=1）或 Safari 原生 HLS 时隐藏（原生无 JS 画质接口）。
  const qualitySelect = el("select", { class: "btn btn-tonal", "aria-label": "画质" });
  qualitySelect.style.display = "none";
  const populateQuality = (levels) => {
    qualitySelect.innerHTML = "";
    if (!levels || levels.length <= 1 || nativeHlsSupported(video)) { qualitySelect.style.display = "none"; return; }
    const auto = el("option", { value: "-1" }, "画质 自动");
    auto.setAttribute("selected", "");
    qualitySelect.append(auto);
    levels.forEach((lv, i) => {
      qualitySelect.append(el("option", { value: String(i) }, "画质 " + (lv.height ? lv.height + "p" : "档位 " + (i + 1))));
    });
    qualitySelect.style.display = "";
  };
  qualitySelect.addEventListener("change", () => {
    const idx = parseInt(qualitySelect.value, 10);
    if (activeHls) { try { activeHls.nextLevel = Number.isNaN(idx) ? -1 : idx; } catch (_) {} }
    try { qualitySelect.blur(); } catch (_) {}
  });
  window.__onHlsLevels = populateQuality;
  populateQuality(activeHlsLevels);
  // 自动跳过片头开关：默认关（false），记在 playerPrefs；只在有正式 introEnd
  // 的番上生效，没标定的番不跳。开关在控制行随时能关；开的状态用高亮
  // （.is-on）表示，文案固定写“跳过片头”（带“：开/关”六个字一排塞不下，
  // 393px 下“上一集”会被挤掉 2px），切开关时 toast 会报开还是关。
  const skipToggleBtn = button("跳过片头", { variant: "text", cls: "skip-toggle", onclick: () => {
    const v = !prefs.autoSkipIntro;
    savePrefs({ autoSkipIntro: v });
    skipToggleBtn.classList.toggle("is-on", v);
    toast(v ? "自动跳过片头已开（仅已标定片头的番）" : "自动跳过片头已关");
  } });
  if (prefs.autoSkipIntro) skipToggleBtn.classList.add("is-on");
  // 锁按钮（控制条里那个）已删：角落常驻锁图标才是入口，见 renderPlayer 末尾的 setUiLock/lockIcon。
  // 主排只留 6 个固定项（2026-11-10 按腾讯思路重排）：播放/暂停、上一集、
  // 下一集、倍速、跳过片头开关、全屏，flex 均分一排全部可见、不横向滑动；
  // “更多”（画质/画面比例/重新解析/画中画）挪到下面第二行，不占主排。
  const controls = el("div", { class: "player-controls" }, playPauseBtn, prevBtn, nextBtn, rateWrap, skipToggleBtn, landscapeBtn);
  const controlsSecondary = el("div", { class: "player-controls-secondary" }, moreBtn);
  // ====== 进度条 + 当前/总时长（2026-11-09 线上复测回归） ======
  // controls:false 后原生进度条没了，自定义控制条之前也漏了进度条——
  // 桌面 Chrome 下 DOM 里根本没有进度条和时长。补一行：range 拖动快进
  // （鼠标拖、触屏拖都能用）+ 当前/总时长；拖动就是手动 seek，走现成
  // 的 seeked 学习记录（不另记）；timeupdate 同步，拖动时不抢拇指。
  const fmtClock = (s) => {
    if (!isFinite(s) || s == null || s < 0) s = 0;
    const m = Math.floor(s / 60), ss = Math.floor(s % 60);
    return m + ":" + String(ss).padStart(2, "0");
  };
  const seekRange = el("input", { type: "range", class: "player-seek", min: "0", max: "100", step: "0.1", value: "0", "aria-label": "播放进度" });
  const timeLabel = el("span", { class: "player-time" }, "0:00 / 0:00");
  const seekRow = el("div", { class: "player-seek-row" }, seekRange, timeLabel);
  let seekDragging = false;
  const syncSeekUI = () => {
    const d = video.duration;
    const t = video.currentTime || 0;
    timeLabel.textContent = fmtClock(t) + (isFinite(d) && d > 0 ? " / " + fmtClock(d) : "");
    if (!seekDragging && isFinite(d) && d > 0) seekRange.value = String(Math.min(100, Math.max(0, (t / d) * 100)));
  };
  const doSeekFromBar = () => {
    const d = video.duration;
    if (!isFinite(d) || d <= 0) return;
    const pct = parseFloat(seekRange.value) || 0;
    try { video.currentTime = (pct / 100) * d; } catch (_) {}
    syncSeekUI();
  };
  seekRange.addEventListener("input", () => { seekDragging = true; doSeekFromBar(); });
  seekRange.addEventListener("change", () => { seekDragging = false; syncSeekUI(); });
  seekRange.addEventListener("pointerdown", () => { seekDragging = true; });
  seekRange.addEventListener("pointerup", () => { seekDragging = false; syncSeekUI(); seekRange.blur(); });
  video.addEventListener("timeupdate", syncSeekUI);
  video.addEventListener("loadedmetadata", syncSeekUI);
  video.addEventListener("durationchange", syncSeekUI);
  if (pipSupported(video)) {
    moreMenu.append(button("画中画", { variant: "text", icon: "picture_in_picture", onclick: () => togglePictureInPicture(video) }));
  }
  moreMenu.append(fitSelect, qualitySelect, reload);
  // 主排不再横向滑动，右侧滚动提示和 resize 复查一并删掉（2026-11-10）。
  const controlsWrap = el("div", { class: "player-controls-wrap" }, seekRow, controls, controlsSecondary);
  // “更多”菜单是控制条的一部分（2026-11-10 横屏修法）：放进 controlsWrap 里，
  // 横屏时跟着控制条一起挪进旋转框、从条上方弹出；竖屏渲染位置不变（仍在第二行下方）。
  controlsWrap.append(moreMenu);
  main.append(controlsWrap);
  bindPlayerKeys(video);
  bindTapSeek(video, playerWrap);
  bindNativeFullscreenGuard(video, playerWrap, landscapeBtn);

  // 选集（roads + 上次观看）只拉一次：上一集/下一集 和 选集面板共用
  const playCtx = { plugin, src, title: seriesTitle, bid };
  const roadsPromise = plugin && src ? loadRoadsAndHistory(plugin, src, bid).catch(() => null) : Promise.resolve(null);
  roadsPromise.then((info) => {
    // 切集/离页后才回来：本页的 DOM 已拆，别再碰旧按钮、也别给旧集预热字幕。
    if (!video.isConnected) return;
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
  main.append(el("div", { class: "player-meta" }, "规则 " + data.pluginName + " · " + typeLabel + " · 延迟 " + (resolveMs / 1000).toFixed(1) + " 秒"));

  let videoSwitching = false;
  video.addEventListener("error", async () => {
    // 播放器报错（如 7sefun 的 MP4 死链）也自动换源，不直接报死（2026-11-11 斗破年番4
    // 7sefun 黑屏就是只报了错没换源）。video error 可能连着触发，只换一次。
    if (videoSwitching) return;
    videoSwitching = true;
    const sw = await autoSwitchSource(plugin);
    if (!sw.switched) showError("播放器报告错误。可能是源失效或浏览器不支持该格式。");
  });

  // 卡住检测：解析成功但分片拉不下来时，video 不报 error，只会一直转圈
  // （2026-11-11 吞噬星空：光速解析 0.2 秒成功，分片在 gs.gszyi.com:999 上，
  // 手机上每一次都打不开，桌面却能播）。20 秒内进度一动不动就当卡住，自动换源。
  let stallTimer = null, stallLastTime = -1, stallLastCheck = Date.now();
  const armStallWatch = () => {
    clearInterval(stallTimer);
    stallLastTime = video.currentTime; stallLastCheck = Date.now();
    stallTimer = setInterval(() => {
      if (!video.isConnected) { clearInterval(stallTimer); return; }
      if (videoSwitching || video.paused || video.ended) return;
      if (video.currentTime !== stallLastTime) { stallLastTime = video.currentTime; stallLastCheck = Date.now(); return; }
      if (Date.now() - stallLastCheck > 20000) {
        clearInterval(stallTimer);
        videoSwitching = true;
        autoSwitchSource(plugin).then((sw) => { if (!sw.switched) showError("视频一直加载不出来，换了其他源也播不出来。"); });
      }
    }, 2000);
  };
  video.addEventListener("playing", () => { stallLastTime = video.currentTime; stallLastCheck = Date.now(); });
  armStallWatch();

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
    try { subSelect.blur(); } catch (_) {}
    toast(subSelect.value === dualSub.dualMode ? "已切换" + dualSub.dualLabel + "字幕（" + (dualSub.ovlLang === "en" ? "英文" : "日文") + "叠加 + 画面中文字幕）"
      : subSelect.value === "zh" ? "仅中文：只看画面自带中文字幕" : "字幕已关");
  });
  // 字幕下拉也进“更多”菜单，不占主排宽度；有字幕文件时才出现（见 showSubUI）。
  moreMenu.append(subSelect);
  let subUIHandled = false;
  const showSubUI = () => {
    if (subUIHandled || !dualSub.done) return;
    // 离页后（切集/返回）2500ms 的延迟回调才跑：video 已不在文档里，
    // 别再碰已拆掉的 DOM、也别在别的页面上弹字幕 toast（引用过期那类问题）。
    if (!video.isConnected) return;
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
        sourceTile.querySelector(".tile-desc").textContent = (pick.animeTitle || "未命名") + " · " + (pick.episodeTitle || "");
        toast("已切换弹幕源，共 " + danmaku.count + " 条");
      } catch (e) {
        // 上游弹幕源常年 403（2026-11-11：/api/danmaku 16 次全 502），修不了：
        // 不留报错面板、不弹 toast，只显示“暂无弹幕”，播放不受影响。
        danmakuDesc.textContent = "暂无弹幕";
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
      // 同上：上游 403 是常态，失败就显示“暂无弹幕”，不留报错面板。
      danmakuDesc.textContent = "暂无弹幕";
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
        let resumed = false;
        const doSeek = () => {
          const d = video.duration;
          // 断点已到片尾（离结束不到 5 秒）：从头播，别停在黑屏片尾。
          // 上次播到片尾存下的断点就是 23:36=总时长，直接 seek 到片尾会
          // 立刻 ended、画面黑在 0:00 没声——这就是斗破第 1 集黑屏的原因。
          if (Number.isFinite(d) && seekTo >= d - 5) return;
          if (Math.abs((video.currentTime || 0) - seekTo) > 2) {
            try { video.currentTime = seekTo; } catch (_) {}
          }
          if (!resumed) { resumed = true; toast("已从 " + formatPosition(prog.progressMs) + " 继续播放"); }
        };
        if (video.readyState >= 1) doSeek();
        else video.addEventListener("loadedmetadata", doSeek, { once: true });
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
    // 播到片尾：把本集断点清零，别再存一个“23:36=总时长”的断点，
    // 否则下次打开又要靠守卫拦一次。清不掉也不怕，守卫还在。
    video.addEventListener("ended", () => {
      try {
        reportProgress({
          bangumiId: parseInt(bid, 10),
          pluginName: plugin,
          episode: epNum,
          road: roadNum,
          progressMs: 0,
          lastSrc: episodeUrl,
          episodeName: epName,
          deviceId: getDeviceId(),
          src: src || "",
        });
      } catch (_) {}
    });
  }

  // ====== 自动播放：解析完就播，不停在暂停 ======
  // 之前这里没有任何 play() 调用（play 只在键盘/点按手势里），所以解析完
  // 流接上了也一直停在 0:00，快进能换帧、时间不走。放最后调用：续播 doSeek
  // 已先注册（loadedmetadata 先 seek 再播），不会播起来又被拉回进度。
  // iOS 拦有声自动播时 play() 会 reject，显示一个大播放按钮兜底，点一下就行。
  const showBigPlay = () => {
    if (playerWrap.querySelector(".big-play")) return;
    const b = el("button", { class: "big-play", type: "button", "aria-label": "播放" }, "▶");
    b.addEventListener("click", () => { b.remove(); video.play().catch(() => {}); });
    video.addEventListener("playing", () => b.remove(), { once: true });
    playerWrap.append(b);
  };
  const tryAutoplay = () => {
    if (video.error) return;
    try {
      const p = video.play();
      if (p && typeof p.catch === "function") p.catch(() => showBigPlay());
    } catch (_) { showBigPlay(); }
  };
  if (video.readyState >= 1) tryAutoplay();
  else video.addEventListener("loadedmetadata", tryAutoplay, { once: true });

  // ====== 跳过片头（只做片头；片尾不做） ======
  // 防冲突/点不到/卡顿/干扰的要点（用户硬要求，逐项落实）：
  //  - 按钮 z-index 7（styles.css .skip-intro-btn），高于 tap-zone(3) 与
  //    dual-sub(5)，与 seek-flash/big-play 同级；点按 stopPropagation，
  //    不会被 bindTapSeek 的 touchend 吞掉变成暂停/快进；min-height 48px，
  //    只在片头窗口内出现，其余时间隐藏。
  //  - 自动跳只在从头开始（续播位置 <5 秒）且本集只跳一次时生效，跳完记
  //    skippedOnce；撤回后本集不再自动跳；不和断点续播 doSeek、tryAutoplay、
  //    长按快进抢 currentTime；手动按钮与自动跳调同一个 seekIntro()。
  //  - 不加逐帧检测、不加 requestAnimationFrame；跳点判断只用现成的
  //    timeupdate（约 4Hz）与 loadedmetadata；学习记录只在手动 seek 时写一次。
  //  - 按钮放右下角、bottom 96px（原生控制条上方），不盖字幕主行；自动跳
  //    提示条约 5 秒带撤回，过期自动消失，不常驻。
  video._skipCtx = { bid: bid ? parseInt(bid, 10) : null, plugin };
  let skipIntroEnd = null, skipIntroSource = "", skipDoneThisEp = false, skipPreTime = 0;
  let skipPillTimer = null;
  const showSkipPill = (fromSec, toSec) => {
    let pill = playerWrap.querySelector(".skip-pill");
    if (pill) pill.remove();
    pill = el("div", { class: "skip-pill" },
      el("span", {}, "已跳过片头 " + fmtSkipTime(fromSec) + " → " + fmtSkipTime(toSec)),
      el("button", { type: "button", onclick: (ev) => {
        ev.stopPropagation();
        try { video.currentTime = skipPreTime; } catch (_) {}
        skipDoneThisEp = true; // 撤回后本集不再自动跳
        if (pill) pill.remove();
        clearTimeout(skipPillTimer);
      } }, "撤回"));
    pill.addEventListener("click", (ev) => ev.stopPropagation());
    pill.addEventListener("touchend", (ev) => ev.stopPropagation(), { passive: true });
    playerWrap.append(pill);
    clearTimeout(skipPillTimer);
    skipPillTimer = setTimeout(() => { if (pill) pill.remove(); }, 5000);
  };
  const seekIntro = (fromAuto) => {
    if (skipIntroEnd == null) {
      // 没标定的番：手动点的才提示，自动跳不走到这儿（trySkipAuto 先判了 null）。
      if (!fromAuto) toast("这部还没标定片头，暂不能跳过");
      return false;
    }
    if (skipDoneThisEp) return false;
    skipPreTime = video.currentTime || 0;
    skipDoneThisEp = true;
    try { video.currentTime = skipIntroEnd; } catch (_) { return false; }
    showSkipPill(skipPreTime, skipIntroEnd);
    return true;
  };
  const skipBtn = el("button", { class: "skip-intro-btn", type: "button" }, "跳过片头");
  skipBtn.style.display = "none";
  skipBtn.addEventListener("click", (ev) => { ev.stopPropagation(); seekIntro(false); });
  skipBtn.addEventListener("touchend", (ev) => { ev.stopPropagation(); seekIntro(false); }, { passive: true });
  playerWrap.append(skipBtn);
  // 角落小锁图标：锁住时唯一留在画面上的按钮，点一下就解锁（不误触：
  // 它在右上角 48px，远离中间的点按区和右下角的跳过片头浮钮；锁住时
  // 控制条、进度条、跳过片头浮钮、全屏退出键、大播放按钮都藏起来，画面干净，
  // 手势（边缘长按 2 倍速快进快退、双击播放/暂停）照常走。锁只在本集内有效：
  // 进播放页时已默认解锁（见上方的锁重置），不跨页面/跨集保留；锁住时点画面
  // 会弹提示“已锁定，点右上角锁解锁”并让锁图标闪一下（见 bindTapSeek 的
  // doSingleTap）。横屏竖屏都一样（图标在 playerWrap 里，跟着旋转走）。
  const setUiLock = (v) => {
    prefs.uiLock = !!v;
    savePrefs({ uiLock: prefs.uiLock });
    main.classList.toggle("ui-locked", prefs.uiLock);
    lockIcon.textContent = prefs.uiLock ? "🔒" : "🔓";
  };
  const lockIcon = el("button", { class: "ui-lock-btn", type: "button", "aria-label": "锁按钮", title: "锁按钮：点一下隐藏/显示按钮" }, prefs.uiLock ? "🔒" : "🔓");
  // 锁图标点一次只翻一次：click 和 touchend 都会触发，500ms 内去重，
  // 不然一次点按翻两次等于没反应（skipBtn 不怕这个，它有 skipDoneThisEp
  // 幂等 guard；setUiLock 没有，所以这里必须去重）。
  let lastLockTap = 0;
  const toggleUiLock = () => {
    const now = Date.now();
    if (now - lastLockTap < 500) return;
    lastLockTap = now;
    setUiLock(!prefs.uiLock);
  };
  lockIcon.addEventListener("click", (ev) => { ev.stopPropagation(); toggleUiLock(); });
  lockIcon.addEventListener("touchend", (ev) => { ev.stopPropagation(); ev.preventDefault(); toggleUiLock(); }, { passive: false });
  playerWrap.append(lockIcon);
  // 锁跑位自愈的锚点：当前播放页的视频容器（见文件上方 reanchorLock）。
  activePlayerWrap = playerWrap;
  reanchorLock(playerWrap);
  // 进播放页时已默认解锁（见上方的锁重置），这里不再按旧值加锁。
  // 原生进度条拖动的学习：programmaticSeek 为 true 时是 doSeek/自动跳/
  // 按钮 seek，不记；否则是从 <60 秒出发、向前 >=10 秒、落点 10–180 秒的手动跳。
  let programmaticSeek = true, seekFrom = 0, lastStableTime = 0;
  setTimeout(() => { programmaticSeek = false; }, 1500);
  video.addEventListener("timeupdate", () => { if (!video.seeking) lastStableTime = video.currentTime || 0; });
  video.addEventListener("seeked", () => {
    const to = video.currentTime || 0;
    if (!programmaticSeek && video._skipCtx && !video._suppressSkipLearn) recordManualSkip(video._skipCtx.bid, video._skipCtx.plugin, lastStableTime, to);
  });
  // 续播 doSeek 与自动跳都走 programmatic：setup 时立即置 true 1500ms，
  // 盖住开播时 doSeek 的那次 seek（loadedmetadata 可能在 setup 前已触发，
  // 只靠 loadedmetadata 监听盖不住）；1500ms 后恢复，之后的手动拖动才记学习样本。
  effectiveIntroEnd(bid, plugin).then((row) => {
    if (!row) {
      // 没标定的番：不猜秒数、不自动跳；但按钮要让用户看得见状态，
      // 不能悄悄藏起来让人以为按钮坏了。片头时段（前 120 秒）显示
      // “跳过片头（未标定）”，点它只提示、不跳（见 seekIntro 的
      // skipIntroEnd==null 分支）；播到正片就自己消失。用户手动跳的
      // 落点仍走 recordManualSkip 学习，3 次扶正后下次打开就有正式点了。
      skipBtn.textContent = "跳过片头（未标定）";
      skipBtn.classList.add("is-unset");
      video.addEventListener("timeupdate", () => {
        skipBtn.style.display = (video.currentTime || 0) < 120 ? "" : "none";
      });
      return;
    }
    skipIntroEnd = row.introEnd;
    skipIntroSource = row.source;
    // 手动按钮只在片头窗口内出现
    video.addEventListener("timeupdate", () => {
      if (skipDoneThisEp) { skipBtn.style.display = "none"; return; }
      skipBtn.style.display = (video.currentTime || 0) < skipIntroEnd ? "" : "none";
    });
    // 自动跳：开关开 + 从头开始（无断点或断点 <5 秒）+ 本集未跳过。
    // 注册在 loadedmetadata 上，排在续播 doSeek 之后（doSeek 先注册），
    // 所以不会把续播位置拉回片头。
    const trySkipAuto = () => {
      if (!prefs.autoSkipIntro || skipDoneThisEp || skipIntroEnd == null) return;
      const t = video.currentTime || 0;
      if (t >= 5) return; // 断点续播（>=5 秒）不跳
      if (t >= skipIntroEnd) return;
      programmaticSeek = true;
      seekIntro(true);
      setTimeout(() => { programmaticSeek = false; }, 500);
    };
    if (video.readyState >= 1) trySkipAuto();
    else video.addEventListener("loadedmetadata", trySkipAuto, { once: true });
  }).catch(() => {});
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
