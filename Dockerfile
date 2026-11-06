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

ENV KAZUMI_WEB_HEADLESS=1

EXPOSE 10000

CMD ["./start.sh"]
