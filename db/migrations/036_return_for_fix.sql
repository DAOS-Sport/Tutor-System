-- Migration 036: 退回補件（return-for-fix）— U14
-- 現況問題：團購 reject 與一般報名 cancel 都是「終態」，家長無法補件續作；
--   且 admin_enrollments 從來沒有 reason 欄位（原因只寫進 audit log，家長端看不到）。
-- 本 migration 只加欄位，不改任何既有資料或既有狀態語意。
-- Idempotent — 與 server/bootstrap/coreSchema.js 保持一致；可在 prod 重跑。
-- Run: psql $DATABASE_URL -f db/migrations/036_return_for_fix.sql

-- ① 一般報名的退回／取消原因（家長端可見；既有列為 NULL，顯示邏輯需容忍 NULL）
ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS cancel_reason TEXT;

-- ② 退回補件的稽核欄位（誰退的、何時退的）
--    團購沿用既有 group_orders.reject_reason / reviewed_by / reviewed_at，不另加欄位。
ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS returned_at TIMESTAMPTZ;
ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS returned_by TEXT;

-- ③ 團購退回補件次數（供後台辨識「一直補不齊」的團；不影響任何既有邏輯）
ALTER TABLE group_orders ADD COLUMN IF NOT EXISTS return_count INTEGER NOT NULL DEFAULT 0;
