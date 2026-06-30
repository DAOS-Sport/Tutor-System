-- 011_manual_enroll.sql
-- ─────────────────────────────────────────────────────────────────────────
-- 「櫃檯手動建檔」(報名與對帳 → 手動建檔) 的後端基底（Phase 0，純本地，零 Ragic 依賴）。
--
-- admin_enrollments 補上 Ragic 報名表的欄位外觀（收款人 / 班級 / 付款方式 / 折讓 /
-- 統編 / 程度 / 實際單價 / 作業型態 / 完整堂數），以及給「之後接 Ragic 回寫 + webhook
-- 雙向同步」用的橋接/防迴圈欄（ragic_record_id / external_order_no=報名單號 /
-- sync_source / last_pushed_at / ragic_content_hash）。本期 (Phase 0) 只寫前者；
-- 橋接欄先留欄位，Phase 3/4 接 Ragic 時才填。
--
-- 注意：db/migrate.js 每次重跑所有 .sql，故全部 DDL 必須冪等（ADD COLUMN IF NOT
--       EXISTS / CREATE INDEX IF NOT EXISTS）。本檔欄位同時加進
--       server/bootstrap/coreSchema.js（線上 runtime 權威），否則正式環境不會生效。
-- ─────────────────────────────────────────────────────────────────────────

-- 報名表外觀欄位（手動建檔表單會寫入） ──────────────────────────────────────
ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS payer           TEXT;            -- 收款人
ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS class_name      TEXT;            -- 班級名稱
ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS payment_method  TEXT;            -- 付款方式：現金 / 轉帳
ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS allowance_amount NUMERIC(10,2);  -- 折讓金額
ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS tax_id          VARCHAR(20);     -- 統一編號
ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS level_note      TEXT;            -- 程度說明
ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS unit_price      NUMERIC(10,2);   -- 實際單價
ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS work_type       TEXT;            -- 作業型態
ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS full_sessions   INTEGER;         -- 完整堂數

-- Ragic 橋接 / 雙向同步防迴圈欄（Phase 3/4 才填值；Phase 0 僅 sync_source 預設 'replit'）─
ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS ragic_record_id   VARCHAR(50);   -- Ragic 連結表 _ragicId（回寫後存）
ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS external_order_no TEXT;          -- Ragic 報名單號 (1001451/1004095)，idempotency key
ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS sync_source       TEXT NOT NULL DEFAULT 'replit'; -- 'replit' | 'ragic'（webhook 回灌）
ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS last_pushed_at    TIMESTAMPTZ;   -- 最後一次 Replit→Ragic 寫入時間（防迴圈比對）
ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS ragic_content_hash TEXT;         -- 上次推送內容雜湊（防迴圈 compare-and-skip）

-- 報名單號全域唯一（NULL 不受限）→ webhook / 匯入去重用。
CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_enrollments_external_order_no
  ON admin_enrollments(external_order_no) WHERE external_order_no IS NOT NULL;
