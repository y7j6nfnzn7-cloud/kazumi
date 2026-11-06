# KazumiWeb — 网页版看番（Docker 部署）

把 [Kazumi](https://github.com/Predidit/Kazumi)（免费看番 App）搬进浏览器：
iOS 上用 Safari 打开、添加到主屏幕就能当 App 用，不用侧载、不用注册登录。

- 版本：`v0.2.0`（[0Chencc/KazumiWeb](https://github.com/0Chencc/KazumiWeb)）
- 带弹幕，打开就能搜番、看番
- 规则（AGE / giriGiriLove / LMM / ezdmw）部署后通过 `POST /api/rules/install` 安装

## 部署

### Render（免费，不绑卡，推荐首选）

1. 在 [Render Dashboard](https://dashboard.render.com) 用 GitHub 登录（免费账号，不绑卡）。
2. New → Web Service → 选这个仓库 → Environment 选 **Docker**。
3. Plan 选 **Free**，点 Create。等构建完成，拿到 `https://kazumi-web-xxxx.onrender.com`。
4. 免费档 15 分钟没人访问会休眠，下次打开冷启动等约 1 分钟。

### Railway（免费试用 30 天，不绑卡；之后每月 $1 额度，只够跑几天）

1. 在 [Railway](https://railway.app) 用 GitHub 登录。
2. New Project → Deploy from GitHub repo → 选这个仓库（Dockerfile 自动识别）。
3. 生成公网域名后即得地址。试用 $5 额度 30 天，到期后 Free 档每月 $1 额度不够长期跑——只当临时方案。

## 部署后验证

```bash
./setup-rules.sh https://<你的公网地址>
```

脚本会等首页返回 200，装 4 条规则，再搜“鬼灭之刃”验证。
能播的一集优先走 **giriGiriLove** 源（AGE 的 resolve 目前会超时）。

## 注意

- KazumiWeb 本身**无鉴权**：拿到链接的人都能打开，只私下发，不要公开贴。
- 免费档都会休眠/冷启动，不是 24 小时常驻保证。
