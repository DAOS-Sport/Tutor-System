const { Pool } = require('pg');
// PostgreSQL startup option applies before the connection is handed to any
// caller. This avoids a race between pool.on('connect') SET TIME ZONE and the
// caller's first query, while still enforcing Taipei on every pooled session.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: '-c timezone=Asia/Taipei',
});
pool.on('error', (err) => console.error('[DB] unexpected error:', err));
module.exports = { pool };
