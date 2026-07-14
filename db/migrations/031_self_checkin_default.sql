-- U13 營運決策（2026-07-14 上架）：所有場館、所有課程一律改用「自助簽到」模式。
--  1. 既有全部課程期一次性切換為 self（含 active/completed 等所有狀態；非 active 期別
--     本來就不可簽到，切換無副作用，但清單顯示一致）。
--  2. 欄位預設值改為 'self'：之後對帳開通新建的課程期（ensureSoloCoursePeriod /
--     ensureGroupCoursePeriod 未指定 checkin_mode）自動繼承自助簽到。
--  後台「簽到模式管理」仍可逐期或整館切回預約制（booking），此 migration 不影響該功能。
--  注意：此 UPDATE 為「一次性」營運切換，只放在 migration；bootstrap 不做全表 UPDATE，
--  避免每次重啟覆蓋管理者手動切回 booking 的期別。

UPDATE course_periods SET checkin_mode = 'self', updated_at = NOW()
 WHERE checkin_mode <> 'self';

ALTER TABLE course_periods ALTER COLUMN checkin_mode SET DEFAULT 'self';

-- 與 bootstrap 的一次性切換共用同一旗標：兩邊誰先跑都只切這一次，
-- 之後管理者手動切回 booking 的期別不會被部署重啟覆蓋。
CREATE TABLE IF NOT EXISTS system_flags (key TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
INSERT INTO system_flags (key) VALUES ('u13_self_checkin_default_20260714')
ON CONFLICT (key) DO NOTHING;
