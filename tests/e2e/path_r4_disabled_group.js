/**
 * R4 — 停用的課程組別（course_type_configs.is_active=FALSE）不得經個人報名路徑繞過。
 *
 * 破口：POST /api/enrollments 讀價時未過濾 is_active（групOrders 有過濾），
 * 後台停用的組別在團報被拒、卻能在個人報名以停用價成立。
 *
 * 斷言「安全行為」：對停用組別的個人報名應回 400 COURSE_TYPE_INACTIVE。
 *   修前 → 201（成立）→ 斷言失敗（暴露漏洞）。
 *   修後 → 400 COURSE_TYPE_INACTIVE → 斷言通過。
 */
const path = require('path');
const SERVER = path.join(__dirname, '..', '..', 'server');
const { Client } = require(path.join(SERVER, 'node_modules', 'pg'));
const { randomUUID } = require('crypto');
const { signParentToken } = require(path.join(SERVER, 'middlewares', 'parentAuth'));

const BASE = process.env.BASE_URL || 'http://localhost:3100';
const CT = 6;                 // 不屬 TRIAL50 範圍、base_price>0 的組別
const PHONE = '0900004004';
let failed = false;
function ok(c, m) { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) failed = true; }

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const parentId = randomUUID();
  const studentId = randomUUID();
  let origActive = true;
  try {
    // setup：sentinel 家長 + 學生（is_active）；挑一個 active coach / venue
    const coach = (await db.query(`SELECT id FROM coaches WHERE is_active=TRUE LIMIT 1`)).rows[0];
    const venue = (await db.query(`SELECT id FROM venues WHERE is_active=TRUE LIMIT 1`)).rows[0];
    if (!coach || !venue) throw new Error('需要至少一個 active coach 與 venue');

    await db.query(`INSERT INTO parents (id, phone, name, is_active) VALUES ($1,$2,'R4 測試家長',TRUE)`, [parentId, PHONE]);
    await db.query(`INSERT INTO students (id, parent_id, name, is_active) VALUES ($1,$2,'R4 測試學生',TRUE)`, [studentId, parentId]);

    // 停用該組別（先存原值以便還原）
    origActive = (await db.query(`SELECT is_active FROM course_type_configs WHERE course_type=$1`, [CT])).rows[0].is_active;
    await db.query(`UPDATE course_type_configs SET is_active=FALSE WHERE course_type=$1`, [CT]);

    const token = signParentToken({ parentId, phone: PHONE });
    const res = await fetch(`${BASE}/api/enrollments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        coach: { id: coach.id }, venue: { id: venue.id }, course_type: CT,
        students: [{ id: studentId }], period_count: 1,
      }),
    });
    let body; try { body = await res.json(); } catch { body = null; }
    console.log(`  probe POST /api/enrollments (停用組別 ${CT}) -> ${res.status} ${JSON.stringify(body)}`);

    ok(res.status === 400, '停用組別的個人報名應被拒（400）');
    ok(body && body.code === 'COURSE_TYPE_INACTIVE', '應回 code=COURSE_TYPE_INACTIVE（與 groupOrders 停用語意一致）');
  } finally {
    await db.query(`UPDATE course_type_configs SET is_active=$2 WHERE course_type=$1`, [CT, origActive]).catch(() => {});
    // 清掉可能建立的報名（修前會成立）
    await db.query(`DELETE FROM admin_enrollment_audit_logs WHERE by_user=$1`, [PHONE]).catch(() => {});
    await db.query(`DELETE FROM admin_enrollments WHERE parent_phone=$1`, [PHONE]).catch(() => {});
    await db.query(`DELETE FROM students WHERE id=$1`, [studentId]).catch(() => {});
    await db.query(`DELETE FROM parents WHERE id=$1`, [parentId]).catch(() => {});
    await db.end();
  }
}

main().then(() => { console.log(failed ? '\nR4 FAIL' : '\nR4 PASS'); process.exit(failed ? 1 : 0); })
  .catch((e) => { console.error('R4 ERROR', e); process.exit(2); });
