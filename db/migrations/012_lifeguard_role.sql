-- Workstream A：救生員（Lifeguard）疊加身份 + A0/A0.5 既有雙重身份 bug 修復
--
-- 這份 migration 是輔助記錄，真正權威的 DDL 來源是 server/bootstrap/admin.js
-- （啟動時執行，見同檔案內緊鄰 active_overridden_at 之處的相同 ALTER 語句）。
--
-- is_coach / is_counter / is_lifeguard：各自獨立追蹤 Ragic H01「應徵職務」關鍵字命中
-- 情形（教練 / 櫃檯 / 救生員），不互相覆蓋——修正既有 bug（雙重身份員工的教練身份
-- 被 roleVal 三元運算式吃掉，見 server/services/ragicAdmin.js）。
--
-- lifeguard_active：後台可切換的救生員啟用狀態（比照 coaches.is_active 的模式，
-- 新建立的救生員身份預設 FALSE，需要管理員手動開通）。
-- lifeguard_active_overridden_at：防止 Ragic 同步覆蓋人工設定的啟用狀態。
ALTER TABLE admin_staff ADD COLUMN IF NOT EXISTS is_coach BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE admin_staff ADD COLUMN IF NOT EXISTS is_counter BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE admin_staff ADD COLUMN IF NOT EXISTS is_lifeguard BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE admin_staff ADD COLUMN IF NOT EXISTS lifeguard_active BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE admin_staff ADD COLUMN IF NOT EXISTS lifeguard_active_overridden_at TIMESTAMPTZ;
