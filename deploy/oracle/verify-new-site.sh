#!/bin/bash
# 切换前自动排查 — 机器能验的部分（curl 层面）。
# 用法: ./verify-new-site.sh https://<新站地址>
# 通过标准（见 deploy/MIGRATION-CHECKLIST.md 切换前排查表）：
#   首页 200、5 条规则全在且版本对、3 部番搜得到、字幕边车健康。
# 机器验不了的（播不播得出、有没有声、快进、日期渲染、分类点按、锁/手势）
# 必须由用户在 iPhone Safari 上人工验，脚本最后会打印那份人工清单。
# 任何一项 FAIL 就不切，先查原因。
set -u
BASE="${1:?usage: verify-new-site.sh https://<site-url>}"
BASE="${BASE%/}"
FAIL=0
ok()   { echo "PASS: $1"; }
bad()  { echo "FAIL: $1"; FAIL=1; }

echo "== 1. 首页 =="
code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "$BASE/") || code=000
[ "$code" = "200" ] && ok "首页 HTTP 200" || bad "首页 HTTP $code（要 200）"

echo "== 2. 规则（5 条，一个不少，版本要对） =="
PLUGINS=$(curl -s --max-time 20 "$BASE/api/plugins" || echo "")
for want in '"name":"guangsu","version":"1.0"' '"name":"AGE","version":"2.3"' \
            '"name":"7sefun","version":"1.3"' '"name":"MXdm","version":"2.4"' \
            '"name":"mgnacg","version":"1.2"'; do
  # /api/plugins 返回形态各版本略有不同：名字+版本分开判，空格容忍。
  name=$(echo "$want" | sed 's/.*name":"//;s/".*//')
  ver=$(echo "$want" | sed 's/.*version":"//;s/".*//')
  if echo "$PLUGINS" | grep -q "$name" && echo "$PLUGINS" | grep -q "$ver"; then
    ok "规则 $name $ver 在"
  else
    bad "规则 $name $ver 缺失或版本不对（原始返回前 300 字：$(echo "$PLUGINS" | head -c 300)）"
  fi
done

echo "== 3. 搜索（3 部番都要出结果） =="
for kw in "斗破苍穹" "吞噬星空" "一念永恒"; do
  enc=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$kw")
  t0=$(date +%s)
  out=$(curl -s --max-time 20 "$BASE/api/search?plugin=guangsu&keyword=$enc" || echo "")
  t1=$(date +%s)
  if echo "$out" | grep -q "$kw"; then ok "搜 $kw 有结果（$((t1-t0)) 秒）"; else bad "搜 $kw 无结果"; fi
done

echo "== 4. 字幕边车 =="
health=$(curl -s --max-time 15 "$BASE/api/subs/health" || echo "")
if echo "$health" | grep -qi '"ok": *true'; then ok "边车 /api/subs/health ok"; else bad "边车 health 不正常：$(echo "$health" | head -c 200)"; fi

echo "== 5. 跳点 learned 表（跨设备那份不断） =="
learned=$(curl -s --max-time 15 "$BASE/api/skip-points/learned" || echo "")
if echo "$learned" | grep -q "points"; then ok "skip-points/learned 可读"; else bad "skip-points/learned 读不到"; fi

echo
if [ "$FAIL" = 0 ]; then
  echo "机器能验的项全部通过。再由用户在 iPhone Safari 上人工验："
else
  echo "有 FAIL 项——不要切换，先查原因修好再重验。"
fi
cat <<'EOF'
人工验（iPhone Safari，逐项打勾）：
 [ ] 首页 3 秒内出三节，无白屏
 [ ] 斗破/吞噬/一念第 1 集 15 秒内出画面、有声
 [ ] 快进 10 秒跳完续播不卡不丢声
 [ ] 已完结只写“已完结”，更新中写周几+月日，待播写完整年月日
 [ ] 全部/国产/日漫/美漫/少儿/新剧 6 个分类都出内容
 [ ] 50 集以上的剧分段条和跳到第 N 集能用
 [ ] 长按 2 倍速、双击暂停、锁常驻可点
EOF
[ "$FAIL" = 0 ]
