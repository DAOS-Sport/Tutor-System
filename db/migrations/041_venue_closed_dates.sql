-- Migration 041: 場館特殊日期休館（模組 1）
--
-- 038 的 venue_business_hours 只表達「每週固定營業時間」，無法表達
-- 「8/15 中元節公休」「9/1 場地整修」這種單日例外。時段產生器若不知道這些日子，
-- 會照常產生時段、家長照常約得到，教練當天卻進不了場館。
--
-- 設計：只記「關閉」不記「加開」——加開屬於臨時排班，走教練手建時段即可，
-- 不需要另一套規則來互相打架。
--
-- 純新增一張表。Idempotent。
-- Run: psql "$DATABASE_URL" -f db/migrations/041_venue_closed_dates.sql

CREATE TABLE IF NOT EXISTS venue_closed_dates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id    VARCHAR(10) NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  closed_date DATE NOT NULL,
  reason      TEXT,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (venue_id, closed_date)
);
CREATE INDEX IF NOT EXISTS idx_vcd_venue_date ON venue_closed_dates(venue_id, closed_date);