// 後台測試帳號夾具：路徑測試預設用 manager/manager 登入，但全新 bootstrap 只種
// admin/staff（server/bootstrap/admin.js 的 DEFAULT_USERS），所以要自己建。
// 已存在的帳號一律不動（不覆寫別人的密碼），只有這裡建的才在收尾時刪掉。
const path = require('path');
const SERVER = path.join(__dirname, '..', '..', 'server');
const { Client } = require(path.join(SERVER, 'node_modules', 'pg'));
const bcrypt = require(path.join(SERVER, 'node_modules', 'bcryptjs'));

async function query(sql, params) {
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  try { return await pg.query(sql, params); } finally { await pg.end(); }
}

// 以 spec 的帳號執行 main：帳號不存在就建，main 結束（成功或失敗）後刪掉自己建的。
async function withAdminAccount({ username, password, role, venueId = null }, main) {
  const hash = await bcrypt.hash(String(password), 10);
  const created = await query(
    `INSERT INTO admin_users (id, username, password_hash, name, role, venue_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (username) DO NOTHING RETURNING id`,
    [`e2e-${username}`, username, hash, `E2E ${role}`, role, venueId]
  );
  try {
    return await main();
  } finally {
    if (created.rowCount) await query('DELETE FROM admin_users WHERE id = $1', [created.rows[0].id]);
  }
}

module.exports = { withAdminAccount };
