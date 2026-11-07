# KazumiWeb v0.2.0 — Docker deploy (Render / Railway / any $PORT host)
# Verified facts:
# - Release asset: https://github.com/0Chencc/KazumiWeb/releases/download/v0.2.0/KazumiWeb-v0.2.0-linux-x64.tar.gz
#   (tarball top dir is KazumiWeb/)
# - Runtime needs xvfb + libwebkit2gtk-4.1-0 + libayatana-appindicator3-1
# - Server listens on $KAZUMI_WEB_PORT; platforms pass their port as $PORT,
#   so start.sh maps PORT -> KAZUMI_WEB_PORT. Hosts with direct internet do
#   NOT need proxyEnable (default false is fine).
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    libwebkit2gtk-4.1-0 \
    libayatana-appindicator3-1 \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN curl -L -o /tmp/kazumiweb.tar.gz \
      https://github.com/0Chencc/KazumiWeb/releases/download/v0.2.0/KazumiWeb-v0.2.0-linux-x64.tar.gz \
    && tar -xzf /tmp/kazumiweb.tar.gz -C /app --strip-components=1 \
    && rm /tmp/kazumiweb.tar.gz \
    && chmod +x /app/kazumi_web \
    && ls -la /app

COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

# 本地补丁：覆盖上游 web/ 里的 player.js / styles.css。
# 上游 tarball 里没有这些改动（横屏按钮、双击快进、双语字幕叠加层），
# 不覆盖的话部署出来还是旧版。
# 注意：字幕 VTT 必须放 web/ 根目录（/assets/*.vtt 直连），不要放子目录——
# 服务端静态路由不提供子目录文件，/assets/subs/*.vtt 会 404（2026-11-07 实测）。
COPY web/player.js /app/web/player.js
COPY web/styles.css /app/web/styles.css

# 自改前端（2026-11-07）：web/ 里是改过的 app.js / player.js / styles.css / index.html，
# 覆盖上游 v0.2.0 包里的同名文件：一键横屏、双击快进、首页更新日期、国产分类、封面提速。
# 上游 tarball 不变，只换前端静态文件；后端二进制和启动命令都不动。
COPY web/ /app/web/

ENV KAZUMI_WEB_HEADLESS=1

EXPOSE 10000

CMD ["./start.sh"]
