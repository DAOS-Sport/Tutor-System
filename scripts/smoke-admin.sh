#!/usr/bin/env bash
# Task #85/#88：後台 7 條核心 endpoint 煙霧測試。
# 用法：bash scripts/smoke-admin.sh [BASE_URL]  （預設 http://localhost:3000）
# 任一 endpoint 非 200 → exit 1；用來在部署 build 後擋下壞掉的版本。
set -euo pipefail

BASE="${1:-http://localhost:3000}"
USER="${SMOKE_ADMIN_USER:-admin}"
PASS="${SMOKE_ADMIN_PASS:-admin}"

echo "[smoke] base=$BASE user=$USER"

# health
HEALTH=$(curl -sf "$BASE/health" -o /dev/null -w "%{http_code}" || true)
if [[ "$HEALTH" != "200" ]]; then
  echo "[smoke] FAIL: /health → $HEALTH"
  exit 1
fi
echo "[smoke] /health OK"

# login → token
TOKEN=$(curl -sf -X POST "$BASE/api/admin/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" \
  | python3 -c 'import json,sys;print(json.load(sys.stdin).get("token",""))' 2>/dev/null || true)

if [[ -z "$TOKEN" ]]; then
  echo "[smoke] FAIL: login as $USER returned no token (in production set SMOKE_ADMIN_USER/PASS env)"
  exit 1
fi
echo "[smoke] login OK"

# 7 條 Task #85 列出的核心 endpoint
EPS=(
  "/api/admin/chat/rooms"
  "/api/admin/chat/keywords"
  "/api/admin/chat/alerts"
  "/api/admin/learn/tags"
  "/api/admin/learn/coach-eval"
  "/api/admin/learn/thresholds"
  "/api/admin/learn/intros"
)

FAILED=0
for ep in "${EPS[@]}"; do
  code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOKEN" "$BASE$ep")
  if [[ "$code" == "200" ]]; then
    echo "[smoke] OK  $ep → 200"
  else
    echo "[smoke] FAIL $ep → $code"
    FAILED=$((FAILED + 1))
  fi
done

if [[ $FAILED -gt 0 ]]; then
  echo "[smoke] $FAILED endpoint(s) failed"
  exit 1
fi
echo "[smoke] all 7 admin endpoints healthy"
