-- Nullable purchase-time session entitlement snapshot. No legacy backfill.
ALTER TABLE group_orders ADD COLUMN IF NOT EXISTS purchased_sessions_per_period INTEGER;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'group_orders'::regclass AND conname = 'chk_group_purchase_sessions'
  ) THEN
    ALTER TABLE group_orders ADD CONSTRAINT chk_group_purchase_sessions
      CHECK (purchased_sessions_per_period IS NULL OR purchased_sessions_per_period > 0);
  END IF;
END $$;
