-- Z03 student clean-delete tombstones. A Z03 row is a local projection of a
-- Ragic Z01 subtable, so a physical DELETE alone would be recreated by the next
-- pull. Keep only the immutable source keys needed to suppress an explicitly
-- deleted local student row; the Ragic source itself is never modified here.

CREATE TABLE IF NOT EXISTS ragic_z03_deleted_student_tombstones (
  z01_ragic_record_id TEXT NOT NULL,
  source_row_key TEXT NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_by TEXT,
  reason TEXT,
  PRIMARY KEY (z01_ragic_record_id, source_row_key)
);
