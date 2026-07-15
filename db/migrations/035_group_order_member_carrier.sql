-- 團購成員付款資料補上既有電子發票載具欄位；只新增欄位，不改寫歷史付款／發票資料。
ALTER TABLE group_order_members ADD COLUMN IF NOT EXISTS carrier TEXT;
