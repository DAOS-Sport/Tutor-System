-- Additive nullable snapshots. Existing lessons retain NULL and purchase evidence.
BEGIN;
ALTER TABLE manual_lesson_deductions
  ADD COLUMN IF NOT EXISTS lesson_pricing_multiplier NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS coach_original_pricing_multiplier NUMERIC(5,2);
DO $$ BEGIN
  ALTER TABLE manual_lesson_deductions ADD CONSTRAINT chk_manual_lesson_multiplier
    CHECK (lesson_pricing_multiplier IS NULL OR lesson_pricing_multiplier BETWEEN 1.00 AND 1.50);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE manual_lesson_deductions ADD CONSTRAINT chk_manual_original_multiplier
    CHECK (coach_original_pricing_multiplier IS NULL OR coach_original_pricing_multiplier BETWEEN 1.00 AND 1.50);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE manual_lesson_deductions ADD CONSTRAINT chk_manual_multiplier_snapshot_pair
    CHECK ((lesson_pricing_multiplier IS NULL) = (coach_original_pricing_multiplier IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
COMMIT;
