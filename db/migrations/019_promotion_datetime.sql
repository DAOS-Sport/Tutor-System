-- 019_promotion_datetime.sql
-- 優惠起迄由「日期」升級為「日期＋時間」：start_date / end_date DATE → TIMESTAMPTZ。
-- 目的：
--   1) 支援設定時分（起日預設 00:00、迄日預設 23:59:59，台灣時間）。
--   2) 根治 DATE 型別在 TZ=Asia/Taipei 下序列化成「前一天 16:00」的顯示/回填問題。
-- 保留欄位名（不改名），僅換型別；比較改以 NOW() 絕對時刻。
-- Idempotent — 僅在欄位仍為 date 時才 ALTER；backfill start→當日 00:00、end→當日 23:59:59。
-- Run: psql $DATABASE_URL -f db/migrations/019_promotion_datetime.sql

SET TIME ZONE 'Asia/Taipei';

DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'promotions' AND column_name = 'start_date') = 'date' THEN
    ALTER TABLE promotions
      ALTER COLUMN start_date TYPE TIMESTAMPTZ USING (start_date::timestamptz),
      ALTER COLUMN end_date   TYPE TIMESTAMPTZ USING (end_date::timestamptz + INTERVAL '23 hours 59 minutes 59 seconds');
  END IF;
END $$;
