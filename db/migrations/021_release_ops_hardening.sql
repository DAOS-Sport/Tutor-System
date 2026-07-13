-- 021_release_ops_hardening.sql
--
-- 發布前營運修補：所有變更均為 additive / backward-compatible / idempotent。
-- 不刪資料、不覆蓋既有附件、不做歷史訂單 backfill。

-- 試上單次課與現場付費。既有訂單未帶欄位時由程式以 standard / bank_transfer
-- 向後相容，不強制批次更新歷史列。
ALTER TABLE checkout_sessions
  ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'bank_transfer';
ALTER TABLE checkout_sessions
  ADD COLUMN IF NOT EXISTS order_kind TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE checkout_sessions
  ADD COLUMN IF NOT EXISTS request_payload_fingerprint CHAR(64);
ALTER TABLE admin_enrollments
  ADD COLUMN IF NOT EXISTS order_kind TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE admin_enrollments
  ADD COLUMN IF NOT EXISTS payment_method TEXT;
ALTER TABLE course_periods
  ADD COLUMN IF NOT EXISTS is_experience_course BOOLEAN NOT NULL DEFAULT FALSE;

-- 手動扣課需要沿用正式 session/checkin 資料契約。保留舊
-- checked_in_by_student_id 欄位並由櫃檯補登寫入目標學員；真正操作者另記
-- append-only ledger/audit。全段只新增欄位，不放寬或刪除既有約束。
ALTER TABLE course_sessions
  ADD COLUMN IF NOT EXISTS coach_id UUID REFERENCES coaches(id) ON DELETE RESTRICT;
ALTER TABLE checkin_records
  ADD COLUMN IF NOT EXISTS checked_in_by_student_id UUID REFERENCES students(id);
ALTER TABLE checkin_records
  ADD COLUMN IF NOT EXISTS checked_in_source VARCHAR(20) NOT NULL DEFAULT 'parent';
ALTER TABLE checkin_records
  ADD COLUMN IF NOT EXISTS checked_in_by_parent_id UUID REFERENCES parents(id);
ALTER TABLE checkin_records
  ADD COLUMN IF NOT EXISTS checked_in_by_coach_id UUID REFERENCES coaches(id);

CREATE INDEX IF NOT EXISTS idx_checkout_sessions_payment_method
  ON checkout_sessions(payment_method, payment_status);
CREATE INDEX IF NOT EXISTS idx_admin_enrollments_order_kind
  ON admin_enrollments(order_kind, status);

-- 家長與櫃檯 enrollment/checkout/trial/on-site 共用的 request-id ledger。ledger、推薦、
-- 促銷用量與訂單都由同一 transaction 寫入；失敗不會留下 completed 紀錄。
CREATE TABLE IF NOT EXISTS request_idempotency_ledger (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  normalized_request_id TEXT NOT NULL,
  actor_type            TEXT NOT NULL,
  actor_id              TEXT NOT NULL,
  operation             TEXT NOT NULL,
  payload_fingerprint   CHAR(64) NOT NULL,
  result_entity_id      TEXT,
  status                TEXT NOT NULL CHECK (status IN ('processing','completed')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at          TIMESTAMPTZ,
  UNIQUE(actor_type, actor_id, operation, normalized_request_id)
);
CREATE INDEX IF NOT EXISTS idx_request_idempotency_result
  ON request_idempotency_ledger(operation, result_entity_id)
  WHERE result_entity_id IS NOT NULL;

-- 團購付款證明的逐成員資料。舊資料保留原 payment_proof_url，不會被清空或搬移。
ALTER TABLE group_order_members ADD COLUMN IF NOT EXISTS proof_uploaded_at TIMESTAMPTZ;
ALTER TABLE group_order_members ADD COLUMN IF NOT EXISTS transfer_last_5 VARCHAR(5);
ALTER TABLE group_order_members ADD COLUMN IF NOT EXISTS payment_confirmed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE group_order_members ADD COLUMN IF NOT EXISTS payment_confirmed_at TIMESTAMPTZ;
ALTER TABLE group_order_members ADD COLUMN IF NOT EXISTS payment_confirmed_by VARCHAR(50);
ALTER TABLE group_orders ADD COLUMN IF NOT EXISTS roster_approved BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE group_orders ADD COLUMN IF NOT EXISTS roster_approved_at TIMESTAMPTZ;
ALTER TABLE group_orders ADD COLUMN IF NOT EXISTS roster_approved_by VARCHAR(50);

-- 「待分配」是可選的 placeholder，不納入真實教練人數／業績／介紹。
ALTER TABLE coaches ADD COLUMN IF NOT EXISTS is_placeholder BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE admin_staff ADD COLUMN IF NOT EXISTS is_placeholder BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_coaches_placeholder_active
  ON coaches(is_placeholder, is_active);

-- 手動扣課 append-only ledger：每次操作建立一筆已完成 course_session + checkin_records
-- 並保留 request_id 以處理雙擊／retry。不得從此表刪除以「回復」堂數；請走既有復活/稽核流程。
CREATE TABLE IF NOT EXISTS manual_lesson_deductions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id          TEXT NOT NULL,
  payload_fingerprint CHAR(64),
  course_period_id    UUID NOT NULL REFERENCES course_periods(id) ON DELETE RESTRICT,
  admin_enrollment_id TEXT,
  course_session_id   UUID NOT NULL REFERENCES course_sessions(id) ON DELETE RESTRICT,
  student_id          UUID NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  venue_id            TEXT NOT NULL,
  quantity            INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  remaining_before    INTEGER NOT NULL CHECK (remaining_before >= 0),
  remaining_after     INTEGER NOT NULL CHECK (remaining_after >= 0),
  reason              TEXT NOT NULL,
  deducted_by         TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(course_period_id, request_id),
  UNIQUE(course_session_id)
);
ALTER TABLE manual_lesson_deductions
  ADD COLUMN IF NOT EXISTS payload_fingerprint CHAR(64);
CREATE INDEX IF NOT EXISTS idx_manual_lesson_deductions_period_created
  ON manual_lesson_deductions(course_period_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_manual_lesson_deductions_student_created
  ON manual_lesson_deductions(student_id, created_at DESC);
