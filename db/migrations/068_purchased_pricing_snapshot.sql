-- F-R01 purchased pricing snapshot.
--
-- NULL deliberately means "no trustworthy purchase-time evidence".  This
-- migration does not backfill from money amounts or the coach's current
-- multiplier because discounts, group pricing and later coach changes make
-- both reconstructions ambiguous.

ALTER TABLE group_orders
  ADD COLUMN IF NOT EXISTS purchased_pricing_multiplier NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS purchased_unit_price NUMERIC(10,2);

ALTER TABLE admin_enrollments
  ADD COLUMN IF NOT EXISTS purchased_pricing_multiplier NUMERIC(5,2);

ALTER TABLE course_periods
  ADD COLUMN IF NOT EXISTS purchased_pricing_multiplier NUMERIC(5,2);

DO $$ BEGIN
  ALTER TABLE group_orders ADD CONSTRAINT chk_group_orders_purchased_multiplier
    CHECK (purchased_pricing_multiplier IS NULL OR purchased_pricing_multiplier > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE group_orders ADD CONSTRAINT chk_group_orders_purchased_unit_price
    CHECK (purchased_unit_price IS NULL OR purchased_unit_price >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE admin_enrollments ADD CONSTRAINT chk_admin_enrollments_purchased_multiplier
    CHECK (purchased_pricing_multiplier IS NULL OR purchased_pricing_multiplier > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE course_periods ADD CONSTRAINT chk_course_periods_purchased_multiplier
    CHECK (purchased_pricing_multiplier IS NULL OR purchased_pricing_multiplier > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN group_orders.purchased_pricing_multiplier IS
  'Coach pricing multiplier actually used when this group purchase was created; NULL means unknown.';
COMMENT ON COLUMN group_orders.purchased_unit_price IS
  'Per-student per-period price resolved when this group purchase was created; freezes later joins.';
COMMENT ON COLUMN admin_enrollments.purchased_pricing_multiplier IS
  'Purchase-time pricing multiplier copied from the authoritative order path; never inferred from amount.';
COMMENT ON COLUMN course_periods.purchased_pricing_multiplier IS
  'Immutable purchase-time multiplier copied from admin_enrollments for FR01 reporting.';
