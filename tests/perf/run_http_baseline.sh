#!/usr/bin/env bash
# 核心 API HTTP 基線（autocannon 30 秒、10 連線）
# 用法：BASE_URL=http://localhost:3000 ADMIN_JWT=xxx bash tests/perf/run_http_baseline.sh
set -euo pipefail

BASE="${BASE_URL:-http://localhost:3000}"
JWT="${ADMIN_JWT:-}"
DUR="${DUR:-30}"
CONN="${CONN:-10}"

if [[ -z "$JWT" ]]; then
  echo "ADMIN_JWT empty - 請先登入並設定 ADMIN_JWT 環境變數" >&2
  exit 1
fi

run() {
  local name="$1"; local path="$2"
  echo "── $name ── $path"
  npx --yes autocannon -d "$DUR" -c "$CONN" \
    -H "authorization: Bearer $JWT" "$BASE$path" || true
  echo
}

run "courses list"          "/api/admin/courseIntros"
run "enrollments list"      "/api/admin/enrollments"
run "reports/revenue"       "/api/admin/reports/revenue"
run "reports/sessions"      "/api/admin/reports/sessions"
