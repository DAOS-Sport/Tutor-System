-- Local review artifact only. Do not apply to deployment DB without explicit release authorization.
-- 團報家庭可在付款資料中選擇統編；只新增 nullable 欄位，不改寫既有載具或發票資料。
BEGIN;
ALTER TABLE group_order_members ADD COLUMN IF NOT EXISTS tax_id VARCHAR(20);
COMMIT;
-- Rollback application first; retain this additive column and saved invoice identity.
