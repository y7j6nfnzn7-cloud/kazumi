# KazumiWeb 字幕插件（自动识别，全局）

播放器播任意一集，自动用上双语字幕；不用再为每一集手工配文件、改代码。

## 架构：边车（sidecar）

上游 KazumiWeb v0.2.0 是闭源二进制，加不了服务端端点。所以本插件是
同一个容器里的一个 Python 进程（标准库，无依赖）：

- `start.sh` 把二进制放到内网端口 `10001`，把本服务（`proxy.py`）
  放到公开端口 `$PORT`。
- `proxy.py` 是公开入口：`/api/subs/*` 自己处理，其余请求原样反向
  代理到二进制（流式转发，支持 Range，视频播放不受影响）。
- 二进制挂了也不影响字幕端点；代理挂了容器重启（Railway 会拉起）。

## 两条铁律（用户定的）

1. **不许边看边加载**：点播放时字幕必须已经在缓存里。详情页/选集页
   打开时就调 `POST /api/subs/prepare` 提前准备（本集 + 下一集）；
   播放页只读缓存（`GET /api/subs/<bid>/ep<NN>`），缓存没有就静默
   无叠加播放——不显示“生成中/加载中”，不假装有字幕。
2. **20 秒到 1 分钟**：任意打开一个剧，20s–60s 内双语字幕必须准备好
   且符合验收标准（翻译对、时间对得上）。字幕库命中只要 1–5 秒；
   Groq 回退生成一集 12 分钟约 1–3 分钟（目标是压进 60 秒内，
   见下），库里没有的番才走它。

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/subs/<bid>/ep<NN>?lang=ja\|en` | 只读缓存。200 返回 VTT（带 `X-Sub-Source`），404 返回 `{error:not_cached, status}`。不生成、不等待。 |
| POST | `/api/subs/prepare` | `{bid, ep, lang?, title?, titleCn?, episodeUrl?, season?}`。202 立即返回，后台做：缓存 → 字幕库 → Groq 生成。 |
| GET | `/api/subs/status/<bid>/ep<NN>` | `{status: cached/preparing/miss, source, cached}`。 |
| GET | `/api/subs/health` | `{ok, cached_vtt, groq, jimaku, opensubtitles}`。 |

`episodeUrl` 是 AGE 播放页地址（`agedm.io/play/<detailId>/1/<n>`），
只在 Groq 回退需要下载视频时用；字幕库查找不需要它。

## 字幕来源（按顺序）

1. **本地缓存** `subs/cache/<bid>-ep<NN>.<lang>.vtt`（构建时烘进镜像
   的种子 + 运行时下载的缓存）。
2. **字幕库（免 key）**：
   - `Kitsunekko`（GitHub 镜像）：日语番人工字幕。目录名是罗马音，
     所以 `aliases.json` 里记了罗马音目录名；名字对不上的番走 Jimaku。
   - `TVsubtitles`：英语剧人工字幕。先按片名在剧目表里找 tvshow id，
     再按季/集找字幕文件（下载页是 JS 拼 zip 地址，服务端照样拼）。
3. **字幕库（要 key，环境变量里有才启用）**：
   - `Jimaku`（`JIMAKU_API_KEY`）：按日文原名查，最适合日语番。
   - `OpenSubtitles`（`OPENSUBTITLES_API_KEY`）：电影和欧美剧。
4. **Groq Whisper 回退**（`GROQ_API_KEY`，免费版）：库里没有的番才走。
   下载视频 → ffmpeg 抽音频（64k 单声道 mp3）→ Groq
   `whisper-large-v3-turbo` 识别 → VTT。只生成原语言轨（日/英），
   中文是视频自带的硬字幕，播放器本来就不显示 zh VTT，所以**不跑
   OCR**（OCR 是最慢的一步，已砍掉）。超过 25MB 的音频按 ~10 分钟
   切块并行识别再拼时间轴。

没有 key、库里也没有、Groq 也失败 → 状态记 `miss`，播放器静默
无叠加，不阻塞播放。

## 缓存种子（构建时烘进镜像）

| 文件 | 来源 |
|---|---|
| `630160-ep01/02/03/04/05.ja.vtt` + `.zh.vtt` | 机器生成（faster-whisper + RapidOCR，VM 上已验过，见 `subtitles/`），黑暗召唤师第 1–5 集 |
| `245665-ep01.ja.vtt` | Kitsunekko 人工字幕（鬼灭 S1E1），已和本集 ASR 对过时间轴（中位偏差 +0.2s） |
| `93377-ep01.en.vtt` | TVsubtitles 人工字幕（瑞克和莫蒂 S1E1；AGE 视频源已死，播不了，种子先备着） |
| `3275-ep01.en.vtt` | TVsubtitles 人工字幕（降世神通 S1E1） |

## 播放器侧改动（`web/player.js` / `web/app.js`）

- `DualSubLayer` 改调 `/api/subs/<bid>/ep<NN>?lang=<lang>`（缓存只读），
  失败时回退到静态 `/assets/<bid>-ep<NN>.<lang>.vtt`（种子也在主站
  上，双保险）；两个都 404 就静默无叠加，不报错、不弹红字。
- 详情页渲染时调 `POST /api/subs/prepare` 预热“下一集 + 再下一集”；
  播放页加载时预热“下一集”。预热都是 fire-and-forget，不等结果、
  不动 UI。
- Toast 按 `X-Sub-Source` 报真实来源（Kitsunekko / TVsubtitles /
  Groq Whisper / 机器生成），不再一律写“语音识别/画面识别”。

## 环境变量（Railway → 服务 → Variables）

- `GROQ_API_KEY`：console.groq.com 免费注册（走 Google 登录）。
- `JIMAKU_API_KEY`：jimaku.cc 免费注册（走 Google 登录）。
- `OPENSUBTITLES_API_KEY`：opensubtitles.com 免费注册。
- 都没有也能跑：免 key 的两家库 + 缓存种子照常用；只是库里没有
  的番生成不了（状态记 miss，等 VM 端补种子）。

## 本地测试

```sh
# 1) 起一个假的上游（模拟 kazumi_web），跑在 10001
python3 -m http.server 10001 --directory /tmp/mock-upstream &
# 2) 起插件，指向假上游
SUBS_UPSTREAM=http://127.0.0.1:10001 SUBS_PUBLIC_PORT=18080 python3 proxy.py &
# 3) 健康检查 + 缓存直读 + 预热
curl localhost:18080/api/subs/health
curl localhost:18080/api/subs/245665/ep01?lang=ja
curl -X POST localhost:18080/api/subs/prepare -d '{"bid":245665,"ep":2}'
curl localhost:18080/api/subs/status/245665/ep02
```

## 文件

- `proxy.py`：反向代理 + 字幕端点 + Groq 回退（标准库，无依赖）。
- `providers.py`：字幕库客户端（Kitsunekko / TVsubtitles / Jimaku /
  OpenSubtitles），全部带超时、失败返回 None 不抛异常。
- `convert.py`：SRT/ASS → VTT（去注音、去说话人标签、去 HTML/ASS 标签，
  文件头 NOTE 写明来源和机器/人工）。
- `aliases.json`：Bangumi id → 字幕库里的片名/目录名（罗马音对不上时用）。
- `cache/`：VTT 缓存种子（构建时 COPY 进镜像）。
