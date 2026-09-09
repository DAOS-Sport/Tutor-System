const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS liff_feature_tours (
  role TEXT NOT NULL CHECK (role IN ('parent', 'coach')),
  account_id UUID NOT NULL,
  shown_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (role, account_id)
)`;

async function claimTour(db, role, id) {
  if (!['parent', 'coach'].includes(role) || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id || '')) {
    throw new TypeError('Invalid tour identity');
  }
  const table = role === 'parent' ? 'parents' : 'coaches';
  // Claim before showing: the database key prevents another device/tab showing it again.
  const result = await db.query(
    `INSERT INTO liff_feature_tours (role, account_id)
     SELECT $1, id FROM ${table} WHERE id = $2 AND is_active = TRUE
     ON CONFLICT (role, account_id) DO NOTHING RETURNING account_id`,
    [role, id],
  );
  return result.rowCount === 1;
}

module.exports = { SCHEMA_SQL, claimTour };
