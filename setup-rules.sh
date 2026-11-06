#!/bin/bash
# 部署后在 Space 的公网地址上装规则并验证搜索。
# 用法: ./setup-rules.sh https://<user>-<space>.hf.space
# 规则接口来自 0Chencc/KazumiWeb 源码 (lib/server.dart):
#   POST /api/rules/install  body {"name": "<规则名>"}
#   GET  /api/search?plugin=AGE&keyword=<番名>
set -u
BASE="${1:?usage: setup-rules.sh https://<space-url>}"
BASE="${BASE%/}"

echo "== waiting for $BASE to respond =="
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$BASE/" || echo 000)
  echo "try $i: homepage HTTP $code"
  [ "$code" = "200" ] && break
  sleep 10
done

echo "== installing rules =="
for name in AGE giriGiriLove LMM ezdmw; do
  echo "--- install $name ---"
  curl -s --max-time 30 -X POST "$BASE/api/rules/install" \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"$name\"}"
  echo
done

echo "== verifying search (鬼灭之刃 via AGE) =="
curl -s --max-time 30 "$BASE/api/search?plugin=AGE&keyword=%E9%AC%BC%E7%81%AD%E4%B9%8B%E5%88%83" | head -c 500
echo
