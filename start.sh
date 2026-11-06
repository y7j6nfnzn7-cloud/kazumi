#!/bin/sh
# Platforms (Render, Railway, ...) inject their public port as $PORT.
# KazumiWeb reads $KAZUMI_WEB_PORT, so map it here. Default 10000 (Render).
export KAZUMI_WEB_PORT="${PORT:-10000}"
export KAZUMI_WEB_HEADLESS=1
exec xvfb-run -a ./kazumi_web
