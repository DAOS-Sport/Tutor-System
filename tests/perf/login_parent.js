// 自動 mint parent JWT（用 JWT_SECRET 直簽，與生產 verify 路徑相容）。
// 從 DB 取一個 active period 對應的 parent；用法：node tests/perf/login_parent.js > /tmp/parent.jwt
const jwt = require('../../server/node_modules/jsonwebtoken');
const { Client } = require('../../server/node_modules/pg');
(async () => {
  const SECRET = process.env.JWT_SECRET;
  if (!SECRET) { console.error('FATAL: JWT_SECRET 未設定'); process.exit(2); }
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  const r = await pg.query(
    `SELECT p.id, p.phone FROM parents p
       JOIN students s ON s.parent_id=p.id
       JOIN course_period_enrollments cpe ON cpe.student_id=s.id AND cpe.status='active'
      LIMIT 1`,
  );
  await pg.end();
  if (!r.rowCount) { console.error('找不到 active 家長'); process.exit(2); }
  const t = jwt.sign({ parentId: r.rows[0].id, phone: r.rows[0].phone, type: 'parent' }, SECRET, { expiresIn: '15m' });
  process.stdout.write(t);
})().catch((e) => { console.error(e.message); process.exit(1); });
