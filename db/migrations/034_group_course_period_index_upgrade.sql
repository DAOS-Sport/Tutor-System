-- 團購多期 course_period 唯一鍵升級。
-- 先建立可支援多期的複合唯一索引，成功後才移除 legacy 單欄唯一限制；不改任何業務資料。
ALTER TABLE course_periods ADD COLUMN IF NOT EXISTS group_order_id UUID;
ALTER TABLE course_periods ADD COLUMN IF NOT EXISTS period_number INTEGER NOT NULL DEFAULT 1;

DO $$
DECLARE blocker RECORD;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_index i
     WHERE i.indrelid = 'course_periods'::regclass
       AND i.indisunique AND i.indisvalid
       AND ARRAY(
         SELECT pg_get_indexdef(i.indexrelid, n, TRUE)
           FROM generate_series(1, i.indnkeyatts) AS n ORDER BY n
       ) = ARRAY['group_order_id', 'period_number']::TEXT[]
  ) THEN
    CREATE UNIQUE INDEX uq_course_periods_group_order_period_v2
      ON course_periods(group_order_id, period_number)
      WHERE group_order_id IS NOT NULL;
  END IF;

  FOR blocker IN
    SELECT idx.relname AS index_name, con.conname AS constraint_name
      FROM pg_index i
      JOIN pg_class idx ON idx.oid = i.indexrelid
      LEFT JOIN pg_constraint con ON con.conindid = i.indexrelid
     WHERE i.indrelid = 'course_periods'::regclass
       AND i.indisunique
       AND ARRAY(
         SELECT pg_get_indexdef(i.indexrelid, n, TRUE)
           FROM generate_series(1, i.indnkeyatts) AS n ORDER BY n
       ) = ARRAY['group_order_id']::TEXT[]
  LOOP
    IF blocker.constraint_name IS NOT NULL THEN
      EXECUTE format('ALTER TABLE course_periods DROP CONSTRAINT %I', blocker.constraint_name);
    ELSE
      EXECUTE format('DROP INDEX %I', blocker.index_name);
    END IF;
  END LOOP;

  IF to_regclass('public.uq_course_periods_group_order') IS NULL
     AND to_regclass('public.uq_course_periods_group_order_period_v2') IS NOT NULL THEN
    ALTER INDEX uq_course_periods_group_order_period_v2 RENAME TO uq_course_periods_group_order;
  END IF;
END $$;
