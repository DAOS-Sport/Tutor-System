-- Parent profile maintenance fields and soft-disable students.
ALTER TABLE parents ADD COLUMN IF NOT EXISTS identity VARCHAR(50);
ALTER TABLE parents ADD COLUMN IF NOT EXISTS home_phone VARCHAR(30);
ALTER TABLE parents ADD COLUMN IF NOT EXISTS home_address TEXT;
ALTER TABLE parents ADD COLUMN IF NOT EXISTS line_id VARCHAR(100);

ALTER TABLE students ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS idx_students_parent_active ON students(parent_id, is_active);

ALTER TABLE group_order_members ADD COLUMN IF NOT EXISTS transfer_last_5 VARCHAR(5);
