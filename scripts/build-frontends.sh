#!/usr/bin/env bash
# Task #88：統一前端 build 流程。
# 1. 清掉 server/public/{admin,liff}/assets/ 內所有歷史 hash 殘檔（避免累積 13+ 個）
# 2. build admin（VITE_USE_MOCK=false）
# 3. build liff（VITE_USE_MOCK=false + VITE_LIFF_ID）
# 由 .replit [deployment].build 在 production 部署時呼叫。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "[build] root=$ROOT"

# 版本戳記：讓「線上到底跑哪一版」一眼可驗（DiagBlock / admin 角落 / /health 都讀這個）。
# 用 VITE_ 前綴讓 Vite 自動曝光到 import.meta.env；同時寫一份給後端 /health 讀。
export VITE_BUILD_SHA="${VITE_BUILD_SHA:-$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)}"
export VITE_BUILD_TIME="${VITE_BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%MZ)}"
echo "[build] version: $VITE_BUILD_SHA @ $VITE_BUILD_TIME"
printf '{"sha":"%s","time":"%s"}\n' "$VITE_BUILD_SHA" "$VITE_BUILD_TIME" > "$ROOT/server/build-info.json"

# 1. server 端依賴
echo "[build] (1/3) installing server deps"
cd "$ROOT/server" && npm install --no-audit --no-fund

# 2. clean + build admin
echo "[build] (2/3) cleaning admin assets + building"
# 清掉整個 assets 目錄（包含未來 vite chunk 切分後的 vendor-*.js 等檔），避免殘檔累積
rm -rf "$ROOT/server/public/admin/assets" 2>/dev/null || true
cd "$ROOT/client/admin"
# Replit deployment containers commonly set NODE_ENV=production. Vite and the
# React build toolchain intentionally live in devDependencies, so opt in to
# those dependencies explicitly for this build-only install.
npm install --include=dev --no-audit --no-fund
VITE_USE_MOCK=false npm run build

# 3. clean + build liff
echo "[build] (3/3) cleaning liff assets + building"
rm -rf "$ROOT/server/public/liff/assets" 2>/dev/null || true
cd "$ROOT/client/liff"
npm install --include=dev --no-audit --no-fund
VITE_USE_MOCK=false \
  VITE_LIFF_ID_PARENT="${VITE_LIFF_ID_PARENT:-}" \
  VITE_LIFF_ID_COACH="${VITE_LIFF_ID_COACH:-}" \
  VITE_LIFF_ID="${LIFF_ID:-}" \
  npm run build

# 4. 可選：build 完成後串接後台煙霧（需另一個 process 已起 server）
# SKIP_SMOKE=1 可關閉；SMOKE_BASE 預設 http://localhost:3000
if [[ "${SKIP_SMOKE:-0}" != "1" ]]; then
  SMOKE_BASE="${SMOKE_BASE:-http://localhost:3000}"
  echo "[build] (4/4) running admin smoke against $SMOKE_BASE (set SKIP_SMOKE=1 to skip)"
  if curl -sf -o /dev/null --max-time 3 "$SMOKE_BASE/health"; then
    bash "$ROOT/scripts/smoke-admin.sh" "$SMOKE_BASE"
  else
    echo "[build] smoke skipped: $SMOKE_BASE/health not reachable (likely deploy-time, no server yet)"
  fi
fi

echo "[build] done"
