#!/bin/bash
# Reinstall the 5 live rules on a fresh deploy (rules live in the container /
# VM filesystem and are wiped on every redeploy — this is the same step
# Railway needs after each deploy, and the same script works for Oracle,
# Render, or Railway: it only needs the site's public URL).
#
# Usage (from anywhere with curl):
#   ./reinstall-rules.sh https://<new-site-url>
#   ./reinstall-rules.sh http://<oracle-vm-ip>:10000
#
# Rules (2026-11-09 verified live): guangsu 1.0 (only source proven to play
# 斗破/吞噬/一念), AGE 2.3, 7sefun 1.3, MXdm 2.4, mgnacg 1.2.
# guangsu is imported from the archived rules/guangsu.json in this repo
# (no clipboard step).
#
# AGE 特别注意（2026-11-09 22:5x UTC 实测发现的漂移）：
# 官方目录（Predidit/KazumiRules）的 AGE 只有 1.6，setup-rules.sh 从官方
# 装就是 1.6；AGE 2.3 只在 Plus 仓（AzlmZ-del/Kazumi-Plus-Rules）里。
# 浏览器实测：2.3 的斗破能播、有声、前 30 秒和中段无赌博水印，1.6 斗破
# 从未测通过。所以装完官方 4 条后，必须再从 Plus 仓导入 AGE 2.3 覆盖掉
# 1.6（/api/rules/import 同名即覆盖），最后 GET /api/plugins 核对 5 条
# 的名字+版本，AGE 必须是 2.3。某天如果发现站里 AGE 又变回 1.6，说明
# 有人/有脚本按官方目录重装过，按本脚本重装一次即可。
set -u
BASE="${1:?usage: reinstall-rules.sh https://<site-url>}"
BASE="${BASE%/}"
SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

"$SCRIPT_DIR/setup-rules.sh" "$BASE"

echo "== AGE 2.3 from Plus repo (overrides official 1.6) =="
curl -s --max-time 30 -X POST "$BASE/api/rules/import" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://raw.githubusercontent.com/AzlmZ-del/Kazumi-Plus-Rules/main/AGE.json"}'
echo

echo "== verify installed rules =="
curl -s --max-time 20 "$BASE/api/plugins"
echo
