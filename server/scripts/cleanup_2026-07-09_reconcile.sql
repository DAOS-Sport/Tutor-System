-- =====================================================================
-- 2026-07-09 對帳頁面資料清理（正式 DB 用）
-- =====================================================================
-- 用途：
--   (A) 取消（軟刪除）9 筆舊示範/測試待對帳報名單，行為等同後台「取消」按鈕
--       （狀態改 cancelled + 寫入 admin_enrollment_audit_logs 稽核紀錄）
--   (B) 硬刪除 13 筆近期測試提交的報名單（EMRC*/EMRBLUIXS3U）
--   (C) 硬刪除 2 筆測試優惠券（折價券測試/WELCOME10、春節 95 折），
--       連帶清除引用這兩張券的 promotion_usages（RESTRICT FK 擋刪除）
--
-- 已於 2026-07-09 對正式 DB 執行前逐筆確認：
--   - 上述所有 id 皆存在、狀態符合預期
--   - admin_enrollment_audit_logs 為 CASCADE，硬刪除報名單會自動清稽核紀錄
--   - 無 course_periods / promotion_usages 反向掛在被硬刪的 13 筆報名單上
--   - 2 張優惠券共有 promotion_usages 掛在其他報名單（非本次清單），
--     刪券會一併移除這些歷史使用紀錄（券本身已停用，此為預期行為）
--
-- 執行：psql "$PROD_DATABASE_URL" -f server/scripts/cleanup_2026-07-09_reconcile.sql
-- =====================================================================

BEGIN;

-- (A) 取消 9 筆舊示範/測試待對帳報名單（僅限目前仍是 pending_payment 才動作）
INSERT INTO admin_enrollment_audit_logs (enrollment_id, at, action, by_user, reason)
SELECT id, NOW(), 'cancel', 'system_admin_cleanup', '管理員清除舊示範/測試對帳資料'
FROM admin_enrollments
WHERE id = ANY(ARRAY[
  'EMOOWWPFJEH','EMOOWWP0QYU',
  'CP1002','CP1006','CP1007','CP1009','CP1008','CP1011','CP1010'
]::text[])
AND status = 'pending_payment';

UPDATE admin_enrollments
SET status = 'cancelled', updated_at = NOW()
WHERE id = ANY(ARRAY[
  'EMOOWWPFJEH','EMOOWWP0QYU',
  'CP1002','CP1006','CP1007','CP1009','CP1008','CP1011','CP1010'
]::text[])
AND status = 'pending_payment';

-- (C) 硬刪除 2 張測試優惠券前，先清除引用它們的 promotion_usages（RESTRICT FK）
DELETE FROM promotion_usages
WHERE promotion_id = ANY(ARRAY[
  'f953a89f-6978-40a8-9c5a-b102cfdfe706', -- 春節 95 折
  'f2e9482c-6ddb-4b49-b18a-2f951c6abed5'  -- 折價券測試 / WELCOME10
]::uuid[]);

DELETE FROM promotions
WHERE id = ANY(ARRAY[
  'f953a89f-6978-40a8-9c5a-b102cfdfe706',
  'f2e9482c-6ddb-4b49-b18a-2f951c6abed5'
]::uuid[]);

-- (B) 硬刪除 13 筆近期測試報名單（admin_enrollment_audit_logs 為 CASCADE 會一併清除）
DELETE FROM admin_enrollments
WHERE id = ANY(ARRAY[
  'EMRC3HMOKOE','EMRC3HGXFGR','EMRC3GXFYE3',
  'EMRC2484A4U','EMRC2484A1U','EMRC2484AAJ','EMRC2484AI8','EMRC2484ACY',
  'EMRC1OMF1R8','EMRC1OMF1TB','EMRC1OMF1C7','EMRC1OMF12W',
  'EMRBLUIXS3U'
]::text[]);

COMMIT;
