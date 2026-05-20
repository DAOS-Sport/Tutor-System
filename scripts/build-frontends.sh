#!/usr/bin/env bash
# Task #88：統一前端 build 流程。
# 1. 清掉 server/public/{admin,liff}/assets/ 內所有歷史 hash 殘檔（避免累積 13+ 個）
# 2. build admin（VITE_USE_MOCK=false）
# 3. build liff（VITE_USE_MOCK=false + VITE_LIFF_ID）
# 由 .replit [deployment].build 在 production 部署時呼叫。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "[build] root=$ROOT"

# 1. server 端依賴
echo "[build] (1/3) installing server deps"
cd "$ROOT/server" && npm install --no-audit --no-fund

# 2. clean + build admin
echo "[build] (2/3) cleaning admin assets + building"
# 清掉整個 assets 目錄（包含未來 vite chunk 切分後的 vendor-*.js 等檔），避免殘檔累積
rm -rf "$ROOT/server/public/admin/assets" 2>/dev/null || true
cd "$ROOT/client/admin"
npm install --no-audit --no-fund
VITE_USE_MOCK=false npm run build

# 3. clean + build liff
echo "[build] (3/3) cleaning liff assets + building"
rm -rf "$ROOT/server/public/liff/assets" 2>/dev/null || true
cd "$ROOT/client/liff"
npm install --no-audit --no-fund
VITE_USE_MOCK=false VITE_LIFF_ID="${LIFF_ID:-}" npm run build

echo "[build] done"
