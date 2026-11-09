# KazumiWeb 搬家清单 — Railway 试用到期前（2026-12-06）

> 现状（2026-11-09 核实）：站跑在 Railway 试用上（一次性 $5 额度，30 天，约 12-06 到期）。
> 试用后免费档每月只给 $1 额度，0.5 GB 内存一个月就要 $5，养不活这个站。
> 代码在 GitHub `y7j6nfnzn7-cloud/kazumi`，规则、置顶名单都在仓库里，搬家不用重做，
> 只是换个跑的地方。

## 硬规矩（用户 2026-11-09 特别交代，搬家不要把现有站搞乱）

1. **搬家是“复制一份过去”，不是“搬走”**：Railway 上的站一动不动、一直开着，
   直到新站被验证通过才切换；新站没验过之前，旧链接不变、旧站不停。
   任何一步都不许停旧站、不许改旧站的配置、不许在旧站上试新东西。
2. **切换前必须逐项排查，不过就不切**：逐项清单见下“切换前排查表”，
   任何一项不过就停下来查原因、修好、重验，修不好宁可不切。
   可以用 `deploy/oracle/verify-new-site.sh <新站地址>` 先跑机器能验的部分，
   再加用户在 iPhone Safari 上的人工验。
3. **数据和配置搬过去要逐项对数**：规则、置顶名单、分类、跳点、自检——
   逐项核对数量和内容，少了错了就补，不要丢。对数表见下。
4. **回滚方案**：新站一旦出问题，立刻切回 Railway 旧链接
   `https://kazumi-production.up.railway.app/`，旧站要随时能用。
   切换后第一周每天看一次新站，发现问题先切回旧链接再修，不要在新站上硬撑。
   旧站一直保留到试用到期（约 12-06）自动停，在此之前它是随时可用的回滚目标。

### 切换前排查表（全部通过才能切）

| # | 项 | 怎么验 | 通过标准 |
|---|---|---|---|
| 1 | 首页加载 | iPhone Safari 打开新链接 | 3 秒内出首页三节，无白屏 |
| 2 | 搜索出结果 | 搜斗破/吞噬/一念 | 每次 <5 秒出结果，首条正确 |
| 3 | 斗破能播有声 | 播第 1 集 | 15 秒内出画面、有声 |
| 4 | 吞噬能播有声 | 播第 1 集 | 15 秒内出画面、有声 |
| 5 | 一念能播有声 | 播第 1 集 | 15 秒内出画面、有声 |
| 6 | 快进 | 播的时候快进 10 秒 | 跳完续播不卡不丢声 |
| 7 | 5 条规则全在 | `GET /api/plugins` | guangsu 1.0、AGE 2.3（Plus 仓导入，官方目录只有 1.6）、7sefun 1.3、MXdm 2.4、mgnacg 1.2，一个不少 |
| 8 | 日期格式对 | 看已完结和更新中的卡 | 已完结只写“已完结”，更新中写周几+月日不带年份，待播写完整年月日 |
| 9 | 分类能进 | 点全部/国产/日漫/美漫/少儿/新剧 | 每个分类都出内容，不空白、不消失 |
| 10 | 选集跳转 | 打开一部 50 集以上的剧 | 分段条和跳到第 N 集能用 |
| 11 | 锁/手势 | 播的时候长按、双击、锁 | 长按 2 倍速、双击暂停、锁常驻可点 |

### 搬家对数表（逐项核对）

| 数据 | 旧站（Railway） | 新站 | 核对方法 |
|---|---|---|---|
| 规则 | 5 条（见上表第 7 项） | 5 条同名同版本 | `GET /api/plugins` 对名字+版本 |
| 置顶名单 | CN_HOT_IDS 135 条 | 135 条 | `grep -c` 代码里的 hot-list.json / 首页国漫前 20 顺序 |
| 分类 | 全部/国产/日漫/美漫/少儿/新剧 | 6 个都在 | 点一遍分类栏 |
| 跳点 | skip-points.json（已标定的）+ 服务端 learned（count>=3） | 点数一致 | 对比两个文件的 points 数量 |
| 自检 | selfcheck.js + 每天检查脚本 | 都在、能跑 | 打开“我的”页自检一节 |
| 待播清单 | upcoming-titles.json（A–E 5 条） | 5 条都在 | 对比文件 |
| 干净源表 | clean-sources.json | 一致 | 对比文件 |

### 回滚步骤（新站出问题时，5 分钟内切回）

1. 把给用户的链接换回 `https://kazumi-production.up.railway.app/`（旧站一直开着）。
2. 在新站上查原因（`journalctl -u kazumiweb -f`、`/api/plugins`、首页状态）。
3. 修好后按“切换前排查表”重验全项，通过了再切回去；修不好就留在旧站，
   不要反复切来切去。

## 首选：Oracle Cloud Always Free（新加坡区）— 永久免费、一直在线

为什么是它：Ampere A1 ARM，2 OCPU / 12 GB 内存，10 TB/月出站流量，永久免费不是试用；
新加坡离国内最近，这批里国内访问最好。代价：注册要绑卡（只验证，不扣 Always Free 的费用），
建实例有时抢不到容量（"out of host capacity"，换个时间再试）。

### 步骤

1. **注册 Oracle Cloud（要用户本人做）**：[cloud.oracle.com](https://cloud.oracle.com) 注册，
   绑卡只为验证身份。**Home region 选新加坡（Singapore），注册时定死、以后改不了**，
   选错整个账号就废了，必须重注册。不要选错。
2. 建实例：Compute → Create instance → 镜像 Ubuntu 24.04，形状 Ampere A1 Flex，
   1 OCPU / 6 GB 内存（够用了），启动盘 50 GB。安全列表放行 22（SSH）、80、443。
   抢不到容量就换个时间再试，不要改区。
3. SSH 上去，拉代码、部署（一行）：
   ```bash
   git clone https://github.com/y7j6nfnzn7-cloud/kazumi.git ~/kazumi
   cd ~/kazumi/deploy/oracle && sudo bash deploy.sh
   ```
   脚本会：装依赖（xvfb、libwebkit2gtk-4.1、libayatana-appindicator3、python3、ffmpeg）、
   下上游 v0.2.0 **arm64** 包（已验过 sha256，见 deploy.sh）、装到 /opt/kazumiweb、
   覆盖本站的 web/ + subs/、装 systemd 服务并自启、开防火墙。
4. 验：`curl http://<VM 公网 IP>:10000/` 返回 200。
5. 装规则（规则每次重部署都会清空，这步每次都要做）：
   ```bash
   ./reinstall-rules.sh http://<VM 公网 IP>:10000
   ```
   装 5 条：guangsu 1.0（已存档自动导）、AGE 2.3、7sefun 1.3、MXdm 2.4、mgnacg 1.2。
6. HTTPS（iPhone“添加到主屏幕”要 HTTPS 才行）：任选其一 —
   - `cloudflared-tunnel.sh`（免费隧道，不用买域名，见同目录脚本；要用户在浏览器里
     点一次 Cloudflare 登录，Google 账号，免费套餐不绑卡）；
   - 或自己有域名就挂 nginx + certbot（现在没有域名，不要买）。
7. **用户在 iPhone Safari 上验新链接**：首页加载、搜斗破/吞噬/一念、播一集有声、
   快进续播、分类/少儿/新剧都正常，再切换。没验过不算搬完。
8. Railway 不用手动关，试用到期自动停。旧链接在切换前照常用。

### 风险（实话）

- Oracle 2026-06 曾无公告把 A1 额度从 4 OCPU/24 GB 砍半到 2/12 GB，条款可能再变。
- 实例 7 天内 CPU/网络/内存 95 分位都低于 20% 可能被回收；一个人每天看剧大概率
  不会一直低于 20%，但有这个风险（每天打开一次基本就破了）。
- 国内访问没实测过：新加坡 IP 从国内的速度，回国后必须实测。

## 备选 A：Render 免费档 — 当天能搭，代码零改

`deploy-repo/render.yaml` 已就绪（Docker 部署，免费档，不绑卡）。
Render Dashboard → New → Web Service → 选仓库 → Environment 选 Docker → Plan 选 Free。
代价：**15 分钟没人访问就休眠，下次打开冷启动等约 1 分钟**；流量 5 GB/月（视频流
直接走源站 CDN，不经过服务器，够用）；没有持久磁盘，重启后规则清空（重装流程同上）。
国内访问没有被墙的报告，但没有国内节点，会比较慢。
适合：Oracle 抢不到容量时先顶着，同时继续蹲 Oracle。

## 备选 B：Cloudflare Tunnel + 现有 VM — 零成本，不用注册

VM 自 2026-10-18 起仅出站，Tunnel 是纯出站连接，正好适配。VM 上跑 KazumiWeb +
cloudflared，给一个公开 HTTPS 链接，流量不限。代价：站的可用性 = VM 的可用性，
VM 挂了站就没了；而且隧道登录那步（2026-11-05 挂起的进程）早已失效，要重跑
`cloudflared tunnel login` 再拿新链接。详见 `~/workspace/kazumiweb/CLOUDFLARE-TUNNEL-HANDOFF.md`
（登录链接已过期，不要用旧的）。

## 不用的选项（已排除，不要再试）

- Vercel / Netlify 免费档：只能跑 serverless 函数，跑不了常驻 Go 服务器；
  `/api/resolve` 最长 45 秒超函数时限；规则存在磁盘上，serverless 下会丢。
- Fly.io：2024-10 后新账号没有免费额度，最便宜约 $2/月，要绑卡。
- Hugging Face Spaces：2026-08 起新建 Docker Space 要 PRO（$9/月）。
- Railway Hobby $5/月：零迁移的付费兜底，要用户点头才升。

## 每天检查脚本

`rules-daily-check.py` 的 cron 迁到新 VM，或留在现有 VM（它只调公网 URL，
跑在哪都行，改里面的 BASE_URL 即可）。

## 决策点（要用户定的）

1. Oracle 注册绑卡验证：用户自己在浏览器里做（Mika 不碰卡号）。
2. Oracle 抢不到容量时：先上 Render 顶着，还是等容量（默认：先上 Render）。
3. 最终切换：等用户在 iPhone 上验过新链接再切。
