-- 016_promotion_period_caps.sql
-- 雙重交易期數上限：整檔活動總期數 + 每位家長期數。

ALTER TABLE promotions
  ADD COLUMN IF NOT EXISTS platform_total_period_cap INTEGER,
  ADD COLUMN IF NOT EXISTS parent_period_cap INTEGER,
  ADD COLUMN IF NOT EXISTS current_period_uses INTEGER NOT NULL DEFAULT 0;

ALTER TABLE promotion_usages
  ADD COLUMN IF NOT EXISTS used_periods INTEGER NOT NULL DEFAULT 1;

UPDATE promotions p
   SET current_period_uses = COALESCE(u.used_periods, 0)
  FROM (
    SELECT promotion_id, COALESCE(SUM(used_periods), 0)::int AS used_periods
      FROM promotion_usages
     GROUP BY promotion_id
  ) u
 WHERE p.id = u.promotion_id;
