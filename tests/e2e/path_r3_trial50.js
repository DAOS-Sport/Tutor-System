/**
 * R3 — TRIAL50 體驗課 5 折的「並發雙折」：一次推薦只能兌一次體驗課折扣。
 *
 * 破口：/api/enrollments 的資格判斷 SELECT referral_records 未加 FOR UPDATE，
 * 且 markTrialPaid 的 rowCount 被忽略；N 筆並發請求可同時通過資格閘 → N 筆 5 折。
 *
 * 斷言「安全行為」：同一 (referee, coach) 並發 5 筆 TRIAL50 報名，最終只成立 1 筆折扣。
 *   修前 → 多筆 201 / 多筆 promotion_usages → 斷言失敗（暴露漏洞）。
 *   修後 → 恰 1 筆 201、其餘 400、promotion_usages 恰 1 筆 → 斷言通過。
 *
 * 註（已停用推薦折扣 2026-07：TRIAL50 移除，暫時停跑；恢復推薦折扣時再啟用）：
 *   TRIAL50 優惠與 MGM 推薦折扣已下架，DB 內不再有此 promotion。
 *   本測試於開頭加了守衛：找不到 TRIAL50 時記錄 SKIP 並以 exit 0 收場（不誤判為 FAIL），
 *   保留整份測試邏輯以利日後恢復折扣時重新啟用。
 */
const path = require('path');
const SERVER = path.join(__dirname, '..', '..', 'server');
const { Client } = require(path.join(SERVER, 'node_modules', 'pg'));
const { randomUUID } = require('crypto');
const { signParentToken } = require(path.join(SERVER, 'middlewares', 'parentAuth'));

const BASE = process.env.BASE_URL || 'http://localhost:3100';
const CT = 1;                 // TRIAL50 applicable_course_types 含 1
const N = 5;
const PHONE = '0900003003';
let failed = false;
function ok(c, m) { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) failed = true; }

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  // 守衛：已停用推薦折扣（2026-07：TRIAL50 移除）。找不到 TRIAL50 優惠即 SKIP（no-op），
  // 不進行任何 setup / 斷言，直接以 exit 0 收場，避免在無此優惠時誤判為 FAIL。
  // 恢復推薦折扣時，重新種入 TRIAL50 即會自動恢復本測試。
  const trialProbe = (await db.query(`SELECT id FROM promotions WHERE upper(coupon_code)='TRIAL50'`)).rows[0];
  if (!trialProbe) {
    console.log('  ⏭ SKIP R3：找不到 TRIAL50 優惠（已停用推薦折扣 2026-07：TRIAL50 移除，暫時停跑；恢復推薦折扣時再啟用）');
    await db.end();
    console.log('\nR3 SKIP');
    process.exit(0);
  }

  const parentId = randomUUID();
  const studentId = randomUUID();
  const token = randomUUID().replace(/-/g, '');
  let trial0 = 0;
  try {
    const coach = (await db.query(`SELECT id FROM coaches WHERE is_active=TRUE LIMIT 1`)).rows[0];
    const venue = (await db.query(`SELECT id FROM venues WHERE is_active=TRUE LIMIT 1`)).rows[0];
    const referrer = (await db.query(`SELECT id FROM parents WHERE is_active=TRUE LIMIT 1`)).rows[0];
    const trial = (await db.query(`SELECT id, current_uses FROM promotions WHERE upper(coupon_code)='TRIAL50'`)).rows[0];
    if (!coach || !venue || !referrer || !trial) throw new Error('缺 active coach/venue/parent 或 TRIAL50 promotion');
    trial0 = trial.current_uses;

    await db.query(`INSERT INTO parents (id, phone, name, is_active) VALUES ($1,$2,'R3 受推薦家長',TRUE)`, [parentId, PHONE]);
    await db.query(`INSERT INTO students (id, parent_id, name, is_active) VALUES ($1,$2,'R3 測試學生',TRUE)`, [studentId, parentId]);
    // 已註冊、尚未兌換的推薦：status='registered'
    await db.query(
      `INSERT INTO referral_records (id, token, referrer_parent_id, coach_id, referee_parent_id, referee_phone, status)
       VALUES ($1,$2,$3,$4,$5,$6,'registered')`,
      [randomUUID(), token, referrer.id, coach.id, parentId, PHONE]
    );

    const jwt = signParentToken({ parentId, phone: PHONE });
    const payload = {
      coach: { id: coach.id }, venue: { id: venue.id }, course_type: CT,
      students: [{ id: studentId }], period_count: 1,
      promotion: { coupon_code: 'TRIAL50' },
    };
    const fire = () => fetch(`${BASE}/api/enrollments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
      body: JSON.stringify(payload),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

    const results = await Promise.all(Array.from({ length: N }, fire));
    const statuses = results.map((r) => r.status);
    const n201 = statuses.filter((s) => s === 201).length;
    console.log(`  fired ${N} concurrent TRIAL50 enrollments -> statuses ${JSON.stringify(statuses)}`);

    const usage = (await db.query(
      `SELECT count(*)::int c FROM promotion_usages WHERE promotion_id=$1 AND parent_id=$2`,
      [trial.id, parentId]
    )).rows[0].c;
    const refStatus = (await db.query(`SELECT status FROM referral_records WHERE token=$1`, [token])).rows[0].status;
    console.log(`  discounted enrollments (201)=${n201}  TRIAL50 usages=${usage}  referral.status=${refStatus}`);

    ok(n201 === 1, `並發 ${N} 筆中應恰有 1 筆成立（實得 ${n201}）`);
    ok(usage === 1, `TRIAL50 promotion_usages 應恰 1 筆（實得 ${usage}）`);
    ok(refStatus === 'trial_paid', 'referral 狀態應被推進為 trial_paid');
  } finally {
    // teardown：清 sentinel 產生的所有資料 + 還原 TRIAL50 current_uses
    await db.query(`DELETE FROM promotion_usages WHERE parent_id=$1`, [parentId]).catch(() => {});
    await db.query(`DELETE FROM admin_enrollment_audit_logs WHERE by_user=$1`, [PHONE]).catch(() => {});
    await db.query(`DELETE FROM admin_enrollments WHERE parent_phone=$1`, [PHONE]).catch(() => {});
    await db.query(`DELETE FROM referral_records WHERE token=$1`, [token]).catch(() => {});
    await db.query(`DELETE FROM students WHERE id=$1`, [studentId]).catch(() => {});
    await db.query(`DELETE FROM parents WHERE id=$1`, [parentId]).catch(() => {});
    await db.query(`UPDATE promotions SET current_uses=$1 WHERE upper(coupon_code)='TRIAL50'`, [trial0]).catch(() => {});
    await db.end();
  }
}

main().then(() => { console.log(failed ? '\nR3 FAIL' : '\nR3 PASS'); process.exit(failed ? 1 : 0); })
  .catch((e) => { console.error('R3 ERROR', e); process.exit(2); });
