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

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FAILED=0

run() {
  local name="$1"; local path="$2"
  echo "── $name ── $path"
  if ! npx --yes autocannon@8.0.0 --json -d "$DUR" -c "$CONN" \
      -H "authorization: Bearer $JWT" "$BASE$path" \
      | node "$HERE/assert_autocannon.js" "$name"; then
    FAILED=1
  fi
  echo
}

# 路由早已是 /course-intros（routes/admin.js）；舊寫法 /courseIntros 回 404，
# 在第 0 步修好「失敗不再回報成功」之前，這條一直被當成通過。
run "course intros list"    "/api/admin/course-intros"
run "enrollments list"      "/api/admin/enrollments"
run "reports/revenue"       "/api/admin/reports/revenue"
run "reports/sessions"      "/api/admin/reports/sessions"

exit "$FAILED"
