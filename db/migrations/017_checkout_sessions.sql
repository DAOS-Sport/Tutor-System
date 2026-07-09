-- Checkout mother-order model: one checkout_sessions row groups many admin_enrollments.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS checkout_sessions (
  checkout_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id UUID REFERENCES parents(id) ON DELETE SET NULL,
  enrollment_batch_id UUID,
  request_id TEXT,
  total_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  payment_status TEXT NOT NULL DEFAULT 'pending_payment'
    CHECK (payment_status IN ('pending_payment','pending_reconcile','paid','cancelled')),
  current_route_state TEXT NOT NULL DEFAULT 'pending_payment',
  transfer_last_5 VARCHAR(5),
  payment_proof_url TEXT,
  carrier TEXT,
  audit_log JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_checkout_sessions_parent_request
  ON checkout_sessions(parent_id, request_id)
  WHERE request_id IS NOT NULL;
ALTER TABLE checkout_sessions DROP CONSTRAINT IF EXISTS checkout_sessions_enrollment_batch_id_key;
DROP INDEX IF EXISTS checkout_sessions_enrollment_batch_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_checkout_sessions_parent_batch
  ON checkout_sessions(parent_id, enrollment_batch_id)
  WHERE parent_id IS NOT NULL AND enrollment_batch_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_checkout_sessions_batch_no_parent
  ON checkout_sessions(enrollment_batch_id)
  WHERE parent_id IS NULL AND enrollment_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_checkout_sessions_parent ON checkout_sessions(parent_id);
CREATE INDEX IF NOT EXISTS idx_checkout_sessions_status ON checkout_sessions(payment_status);
CREATE INDEX IF NOT EXISTS idx_checkout_sessions_created_at ON checkout_sessions(created_at DESC);

ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS payment_proof_url TEXT;
ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS period_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS period_number INTEGER NOT NULL DEFAULT 1;
ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS enrollment_batch_id UUID;
ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS carrier TEXT;
ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS invoice_number VARCHAR(20);
ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS invoice_image_url TEXT;
ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS invoice_url TEXT;
ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS invoice_issued_at TIMESTAMPTZ;
ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS checkout_id UUID REFERENCES checkout_sessions(checkout_id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_admin_enrollments_checkout ON admin_enrollments(checkout_id);

CREATE TABLE IF NOT EXISTS checkout_invoices (
  invoice_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_id UUID NOT NULL REFERENCES checkout_sessions(checkout_id) ON DELETE CASCADE,
  order_id TEXT REFERENCES admin_enrollments(id) ON DELETE SET NULL,
  buyer_name TEXT,
  tax_id VARCHAR(20),
  amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  invoice_number VARCHAR(20),
  invoice_image_url TEXT,
  invoice_url TEXT,
  issued_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_checkout_invoices_checkout ON checkout_invoices(checkout_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_checkout_invoice_checkout_level
  ON checkout_invoices(checkout_id)
  WHERE order_id IS NULL;

-- Backfill legacy rows into one checkout per existing enrollment_batch_id.
UPDATE admin_enrollments
   SET enrollment_batch_id = gen_random_uuid()
 WHERE enrollment_batch_id IS NULL;

WITH grouped AS (
  SELECT
    ae.enrollment_batch_id,
    p.id AS parent_id,
    COALESCE(SUM(ae.final_price), 0) AS total_amount,
    MIN(NULLIF(ae.transfer_last_5, '')) AS transfer_last_5,
    MIN(NULLIF(ae.payment_proof_url, '')) AS payment_proof_url,
    MIN(NULLIF(ae.carrier, '')) AS carrier,
    MIN(ae.submitted_at) AS submitted_at,
    CASE
      WHEN bool_and(ae.status IN ('confirmed','active')) THEN 'paid'
      WHEN bool_and(ae.status = 'cancelled') THEN 'cancelled'
      WHEN bool_or(ae.transfer_last_5 IS NOT NULL OR ae.payment_proof_url IS NOT NULL) THEN 'pending_reconcile'
      ELSE 'pending_payment'
    END AS payment_status
  FROM admin_enrollments ae
  LEFT JOIN parents p ON p.phone = ae.parent_phone
  WHERE ae.checkout_id IS NULL
  GROUP BY ae.enrollment_batch_id, p.id, ae.parent_phone
)
INSERT INTO checkout_sessions
  (parent_id, enrollment_batch_id, total_amount, payment_status, current_route_state,
   transfer_last_5, payment_proof_url, carrier, audit_log, created_at, updated_at)
SELECT
  parent_id,
  enrollment_batch_id,
  total_amount,
  payment_status,
  payment_status,
  transfer_last_5,
  payment_proof_url,
  carrier,
  jsonb_build_array(jsonb_build_object('at', NOW(), 'action', 'legacy_backfill', 'by', 'migration')),
  COALESCE(submitted_at, NOW()),
  NOW()
FROM grouped
ON CONFLICT DO NOTHING;

UPDATE admin_enrollments ae
   SET checkout_id = cs.checkout_id
  FROM checkout_sessions cs
 WHERE ae.checkout_id IS NULL
   AND ae.enrollment_batch_id = cs.enrollment_batch_id
   AND (
     (cs.parent_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM parents p WHERE p.id = cs.parent_id AND p.phone = ae.parent_phone
     ))
     OR (cs.parent_id IS NULL AND NOT EXISTS (
       SELECT 1 FROM parents p WHERE p.phone = ae.parent_phone
     ))
   );
