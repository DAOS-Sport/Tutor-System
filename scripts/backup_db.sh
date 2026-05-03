#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# DAOS 每日資料庫備份腳本
# 排程建議：Replit Scheduled Deployments，每日 03:00 (Asia/Taipei)
# 環境變數需求：DATABASE_URL、REPLIT_OBJECT_STORAGE_BUCKET
# ─────────────────────────────────────────────────────────────
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "[backup] DATABASE_URL is empty" >&2
  exit 1
fi
if [[ -z "${REPLIT_OBJECT_STORAGE_BUCKET:-}" ]]; then
  echo "[backup] REPLIT_OBJECT_STORAGE_BUCKET is empty" >&2
  exit 1
fi

TS=$(date -u +%Y%m%dT%H%M%SZ)
TMPDIR=$(mktemp -d)
FILE="$TMPDIR/daos_${TS}.sql.gz"

echo "[backup] dumping $TS"
pg_dump --format=plain --no-owner --no-privileges "$DATABASE_URL" | gzip -9 > "$FILE"

SIZE=$(stat -c%s "$FILE" 2>/dev/null || stat -f%z "$FILE")
echo "[backup] dump size = ${SIZE} bytes"

# 上傳到 Replit Object Storage（沿用 Replit CLI；若沒有 CLI 則改用 SDK）
UPLOADED=0
if command -v replit >/dev/null 2>&1; then
  replit object-storage upload \
    --bucket "$REPLIT_OBJECT_STORAGE_BUCKET" \
    --key "backups/daos_${TS}.sql.gz" \
    --file "$FILE"
  UPLOADED=1
else
  if node "$(dirname "$0")/_object_storage_upload.js" \
       "backups/daos_${TS}.sql.gz" "$FILE"; then
    UPLOADED=1
  fi
fi

if [[ "$UPLOADED" -ne 1 ]]; then
  echo "[backup] FATAL: 無法上傳遠端（既無 replit CLI，也無 @replit/object-storage SDK）。" >&2
  echo "[backup] 本地檔案保留於：$FILE，請手動處理後再排程。" >&2
  exit 3
fi

# 30 天輪轉：本機臨時檔由本腳本刪除；遠端（Object Storage）保留期由 bucket lifecycle policy 控制
find "$(dirname "$FILE")" -mtime +30 -name 'daos_*.sql.gz' -delete 2>/dev/null || true

rm -rf "$TMPDIR"
echo "[backup] done -> backups/daos_${TS}.sql.gz"
