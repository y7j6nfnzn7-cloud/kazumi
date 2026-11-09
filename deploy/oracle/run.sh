#!/bin/sh
# Oracle VM runtime entrypoint for KazumiWeb (mirrors repo start.sh,
# but with absolute /opt/kazumiweb paths instead of container /app paths).
# Run by the kazumiweb systemd service. Do not run by hand unless testing.
#
# Layout: kazumi_web binary on 127.0.0.1:10001 (headless, under xvfb),
# subs/proxy.py sidecar as the public front door on $PORT (default 10000).
# The sidecar serves /api/subs/* + /api/skip-points/* itself and reverse-
# proxies everything else to the binary. If the sidecar cannot start,
# fall back to the binary directly on $PORT so the site stays up.
export KAZUMI_WEB_HEADLESS=1
APP_DIR="/opt/kazumiweb"
PUBLIC_PORT="${PORT:-10000}"
cd "$APP_DIR" || exit 1

if command -v python3 >/dev/null 2>&1 && [ -f "$APP_DIR/subs/proxy.py" ]; then
  export KAZUMI_WEB_PORT=10001
  export SUBS_UPSTREAM="http://127.0.0.1:10001"
  export SUBS_PUBLIC_PORT="$PUBLIC_PORT"
  xvfb-run -a ./kazumi_web &
  i=0
  while [ "$i" -lt 30 ]; do
    if curl -sf -o /dev/null "http://127.0.0.1:10001/" 2>/dev/null; then
      break
    fi
    i=$((i + 1))
    sleep 1
  done
  exec python3 "$APP_DIR/subs/proxy.py"
else
  export KAZUMI_WEB_PORT="$PUBLIC_PORT"
  exec xvfb-run -a ./kazumi_web
fi
