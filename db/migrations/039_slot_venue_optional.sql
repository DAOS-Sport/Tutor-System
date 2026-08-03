-- Migration 039: 自動產生的時段改為「不綁場館」
--
-- 背景：038 讓時段自動產生後，跨館教練出現無解衝突——
--   coach_availability_slots 的 UNIQUE(coach_id, start_at) 與 services/slots.js 的
--   detectConflict（「同一教練不可時間重疊，跨場館均計算」）都在表達同一條業務規則：
--   一位教練同一時刻只能在一個地方。而正式庫有 103 位教練掛 3 個場館、9 位實際跨 2 館授課。
--   若為每個 (教練,場館) 都產生同一時刻的時段，唯一鍵只會留下先寫入的那一館，
--   其餘場館的家長會看到零時段——比現況更難查。
--
-- 解法：自動產生的時段 venue_id 留 NULL，語意是「這位教練這個時間有空」；
--   場館在家長預約當下由 course_period.venue_id 決定並寫回該列（認領）。
--   教練手建的時段仍帶 venue_id，行為完全不變。
--
-- 只放寬欄位可空，不改任何既有資料。Idempotent。
-- Run: psql "$DATABASE_URL" -f db/migrations/039_slot_venue_optional.sql

ALTER TABLE coach_availability_slots ALTER COLUMN venue_id DROP NOT NULL;

-- 家長端查詢會走 (coach_id, status, start_at)，補一支涵蓋 NULL venue 的索引。
CREATE INDEX IF NOT EXISTS idx_slots_coach_status_start
  ON coach_availability_slots(coach_id, status, start_at);