#!/bin/sh
# Platforms (Render, Railway, ...) inject their public port as $PORT.
# KazumiWeb reads $KAZUMI_WEB_PORT, so map it here. Default 10000 (Render).
#
# 字幕插件（2026-11-07）：本容器里再跑一个 Python 边车服务
# （/app/subs/proxy.py），它是公开入口：/api/subs/* 自己处理，其余请求
# 反向代理到本机 10001 上的 kazumi_web 二进制。这样不用动闭源二进制
# 也能加字幕端点。边车起不来时回退到老做法（二进制直接占 $PORT），
# 主站不受影响。
export KAZUMI_WEB_HEADLESS=1
PUBLIC_PORT="${PORT:-10000}"

if command -v python3 >/dev/null 2>&1 && [ -f /app/subs/proxy.py ]; then
  export KAZUMI_WEB_PORT=10001
  export SUBS_UPSTREAM="http://127.0.0.1:10001"
  export SUBS_PUBLIC_PORT="$PUBLIC_PORT"
  # 二进制放后台（内网端口），等它能响应再起边车。
  xvfb-run -a ./kazumi_web &
  i=0
  while [ "$i" -lt 30 ]; do
    if curl -sf -o /dev/null "http://127.0.0.1:10001/" 2>/dev/null; then
      break
    fi
    i=$((i + 1))
    sleep 1
  done
  exec python3 /app/subs/proxy.py
else
  export KAZUMI_WEB_PORT="$PUBLIC_PORT"
  exec xvfb-run -a ./kazumi_web
fi
