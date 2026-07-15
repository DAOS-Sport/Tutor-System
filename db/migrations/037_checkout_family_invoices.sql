-- 歷史／匯入資料相容：同一 checkout 若含多個家庭，可各自保存一張發票。
-- 新版團報仍維持「每家庭一張 checkout」，一般單與單家庭 checkout 不受影響。
ALTER TABLE checkout_invoices
  ADD COLUMN IF NOT EXISTS family_key TEXT;

-- 舊索引只允許一筆 order_id IS NULL；家庭發票同樣不綁單一子訂單，因此把條件
-- 收斂為 legacy checkout-level row（family_key 亦為 NULL）。只有偵測到舊 predicate
-- 才重建，避免 migration 重跑時反覆鎖表。
DO $family_invoice_index$
DECLARE
  index_oid OID := to_regclass('uq_checkout_invoice_checkout_level');
  index_predicate TEXT;
BEGIN
  IF index_oid IS NOT NULL THEN
    SELECT pg_get_expr(indpred, indrelid)
      INTO index_predicate
      FROM pg_index
     WHERE indexrelid = index_oid;
    IF index_predicate IS NULL OR index_predicate NOT ILIKE '%family_key%' THEN
      EXECUTE 'DROP INDEX uq_checkout_invoice_checkout_level';
    END IF;
  END IF;
END
$family_invoice_index$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_checkout_invoice_checkout_level
  ON checkout_invoices(checkout_id)
  WHERE order_id IS NULL AND family_key IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_checkout_invoice_family
  ON checkout_invoices(checkout_id, family_key)
  WHERE family_key IS NOT NULL;
