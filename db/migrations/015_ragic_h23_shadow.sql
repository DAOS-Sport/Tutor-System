-- 015_ragic_h23_shadow.sql
-- Form 23「新生/基本資料」教練薪資倍率影子表。

CREATE TABLE IF NOT EXISTS ragic_h23_shadow (
  ragic_record_id TEXT PRIMARY KEY,
  ragic_key TEXT,
  staff_emp_id TEXT,
  staff_name TEXT,
  raw_data JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ragic_h23_shadow_fetched
  ON ragic_h23_shadow(fetched_at);
CREATE INDEX IF NOT EXISTS idx_ragic_h23_shadow_staff
  ON ragic_h23_shadow(staff_emp_id, staff_name);
