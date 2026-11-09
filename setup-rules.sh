#!/bin/bash
# 部署后在公网地址上装规则并验证搜索。
# 用法: ./setup-rules.sh https://kazumi-production.up.railway.app
# 规则接口来自 0Chencc/KazumiWeb 源码 (lib/server.dart):
#   POST /api/rules/install  body {"name": "<规则名>"}
#   POST /api/rules/import   body {"url": "<规则 JSON 链接>"} 或 {"json": <规则对象>}
#   GET  /api/search?plugin=AGE&keyword=<番名>
# 注意：部署后容器存储会清空，/api/plugins 变 []，必须重装全部规则。
set -u
BASE="${1:?usage: setup-rules.sh https://<site-url>}"
BASE="${BASE%/}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "== waiting for $BASE to respond =="
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$BASE/" || echo 000)
  echo "try $i: homepage HTTP $code"
  [ "$code" = "200" ] && break
  sleep 10
done

echo "== installing official rules =="
for name in AGE MXdm mgnacg 7sefun; do
  echo "--- install $name ---"
  curl -s --max-time 30 -X POST "$BASE/api/rules/install" \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"$name\"}"
  echo
done

echo "== guangsu (rules/guangsu.json 已存档，自动导入） =="
# guangsu 1.0（JHeyzo 分支，api.guangsuapi.com）是当前唯一证实能播
# 斗破/吞噬/一念 3 部番的源；规则 JSON 已存档在 rules/guangsu.json
# （2026-11-09 核对过：name=guangsu、version=1.0），部署后自动导入，
# 不用手动剪贴板。文件缺失时报错提醒，不要静默跳过。
if [ -f "$SCRIPT_DIR/rules/guangsu.json" ]; then
  echo "--- import guangsu from rules/guangsu.json ---"
  PAYLOAD=$(printf '{"json": %s}' "$(cat "$SCRIPT_DIR/rules/guangsu.json")")
  curl -s --max-time 30 -X POST "$BASE/api/rules/import" \
    -H 'Content-Type: application/json' --data-binary "$PAYLOAD"
  echo
else
  echo "ERROR: rules/guangsu.json 缺失，guangsu 需手动导入，不要跳过" >&2
fi

echo "== verifying search (鬼灭之刃 via AGE; 斗破苍穹 via guangsu if installed) =="
curl -s --max-time 30 "$BASE/api/search?plugin=AGE&keyword=%E9%AC%BC%E7%81%AD%E4%B9%8B%E5%88%83" | head -c 500
echo
curl -s --max-time 30 "$BASE/api/search?plugin=guangsu&keyword=%E6%96%97%E7%A0%B4%E8%8B%8D%E7%A9%B9" | head -c 500
echo
