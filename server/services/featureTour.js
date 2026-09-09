// A new version replays once for everyone without resetting or deleting old records.
const TOUR_VERSION = '2026-09-09-r2';
const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS liff_feature_tour_runs (
  role TEXT NOT NULL CHECK (role IN ('parent', 'coach')),
  account_id UUID NOT NULL,
  version TEXT NOT NULL,
  shown_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (role, account_id, version)
)`;

async function claimTour(db, role, id) {
  if (!['parent', 'coach'].includes(role) || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id || '')) {
    throw new TypeError('Invalid tour identity');
  }
  const table = role === 'parent' ? 'parents' : 'coaches';
  // Claim before showing: the database key prevents another device/tab showing it again.
  const result = await db.query(
    `INSERT INTO liff_feature_tour_runs (role, account_id, version)
     SELECT $1, id, $3 FROM ${table} WHERE id = $2 AND is_active = TRUE
     ON CONFLICT (role, account_id, version) DO NOTHING RETURNING account_id`,
    [role, id, TOUR_VERSION],
  );
  return result.rowCount === 1;
}

module.exports = { SCHEMA_SQL, claimTour, TOUR_VERSION };
