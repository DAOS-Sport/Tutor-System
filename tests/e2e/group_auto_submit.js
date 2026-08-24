/**
 * 自動送審 / 代為送審 端到端實測（跑在 dev repl 的全新程序上，打真 HTTP、寫真 DB）。
 *
 * 為什麼不能只靠靜態斷言：靜態測試看不到跨檔案的斷層（例如白名單加了欄位、
 * SQL 卻沒 SELECT 它），所有斷言都是綠的、功能卻是壞的。這支真的簽 token、
 * 真的打端點、真的讀回 DB 檢查狀態與稽核紀錄。
 *
 * 測試資料以 group_orders.note = 'AUTOSUBMIT_E2E' 標記，finally 一律清乾淨。
 */
const assert = require('assert');
const path = require('path');

// 這支不走 _lib.loginAdmin：它不打登入端點（免踩後台登入限流），改用同一組
// JWT_SECRET 直接簽 token。相依模組都裝在 server/ 底下，故以絕對路徑取用。
const SERVER = path.resolve(__dirname, '../../server');
const jwt = require(path.join(SERVER, 'node_modules', 'jsonwebtoken'));
const { pool } = require(path.join(SERVER, 'models', 'db'));

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const MARK = 'AUTOSUBMIT_E2E';
const SECRET = process.env.JWT_SECRET;
const PROOF = '/uploads/2026-08/aaaaaaaaaaaaaaaaaaaaaaaa.jpg';
const COACH = '933fe307-d0cf-4169-9731-e8c9407bb7cf';

const parentToken = (p) => jwt.sign({ type: 'parent', parentId: p.id, phone: p.phone }, SECRET, { expiresIn: '1h' });
const adminToken = () => jwt.sign(
  { role: 'admin', sub: 'e2e-admin', username: 'e2e-admin', name: 'E2E 測試員' }, SECRET, { expiresIn: '1h' });

async function api(path, { token, method = 'GET', body } = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch { /* 空回應 */ }
  return { status: r.status, data };
}

// 每家 1 位學生；lastPaidIdx 那家「有匯款證明、缺末 5 碼」，其餘全齊。
// 缺的那一塊之後用 my-proof 補上 —— 那正是真實世界最後一家送出付款資料的時點。
async function makeGroup({ courseType, min, max, parents, lastPaidIdx }) {
  const token = 'e2e' + Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36);
  const g = await pool.query(
    `INSERT INTO group_orders (leader_parent_id, venue_id, course_type, coach_id, join_token,
                               min_students, max_students, note, status, period_count)
     VALUES ($1,'B',$2,$3,$4,$5,$6,$7,'forming',1) RETURNING *`,
    [parents[0].id, courseType, COACH, token, min, max, MARK]);
  const order = g.rows[0];
  for (let i = 0; i < parents.length; i += 1) {
    await pool.query(
      `INSERT INTO group_order_members
         (group_order_id, parent_id, student_names, student_ids, payment_proof_url, proof_uploaded_at,
          transfer_last_5, is_leader, status, original_amount, discount_amount, final_amount)
       VALUES ($1,$2,$3,'{}',$4,NOW(),$5,$6,'joined',3300,0,3300)`,
      [order.id, parents[i].id, [`E2E學生${i + 1}`], PROOF,
        i === lastPaidIdx ? null : `9000${i}`, i === 0]);
  }
  return order;
}

const auditOf = async (id) => (await pool.query(
  `SELECT action, by_user FROM group_order_audit_logs WHERE group_order_id = $1 ORDER BY at, id`, [id])).rows;

(async () => {
  assert.ok(SECRET, 'JWT_SECRET must be set');
  const health = await api('/health');
  assert.strictEqual(health.status, 200, 'server must be up on ' + BASE);

  const ps = (await pool.query(
    `SELECT id, phone, name FROM parents
      WHERE is_active = TRUE AND phone IS NOT NULL ORDER BY created_at DESC LIMIT 5`)).rows;
  assert.ok(ps.length >= 4, 'need at least 4 parents in the dev DB');

  // ── A：滿團（1v2，2/2）最後一家補齊 → 必須自動送審 ─────────
  const a = await makeGroup({ courseType: 2, min: 2, max: 2, parents: [ps[0], ps[1]], lastPaidIdx: 1 });
  let r = await api(`/api/group-orders/${a.id}/my-proof`, {
    token: parentToken(ps[1]), method: 'POST', body: { transfer_last_5: '54321' },
  });
  assert.strictEqual(r.status, 200, 'A: my-proof failed → ' + JSON.stringify(r));
  assert.strictEqual(r.data.status, 'submitted',
    'A: full house + everyone paid must auto-submit, got ' + r.data.status);
  const aRow = (await pool.query('SELECT status, submitted_at FROM group_orders WHERE id=$1', [a.id])).rows[0];
  assert.strictEqual(aRow.status, 'submitted', 'A: DB status must be submitted');
  assert.ok(aRow.submitted_at, 'A: submitted_at must be stamped, otherwise the admin list sorts it wrong');
  const aAudit = await auditOf(a.id);
  assert.ok(aAudit.some((x) => x.action.includes('系統自動送審') && x.by_user === '系統自動'),
    'A: auto-submit must leave its own audit row → ' + JSON.stringify(aAudit));
  console.log('✅ A 滿團 → 自動送審 + 稽核紀錄');

  // ── B：未滿團（1v3，2/3）全員付清 → 不可自動送審 ───────────
  const b = await makeGroup({ courseType: 3, min: 2, max: 3, parents: [ps[2], ps[3]], lastPaidIdx: 1 });
  r = await api(`/api/group-orders/${b.id}/my-proof`, {
    token: parentToken(ps[3]), method: 'POST', body: { transfer_last_5: '54322' },
  });
  assert.strictEqual(r.status, 200, 'B: my-proof failed → ' + JSON.stringify(r));
  assert.strictEqual(r.data.status, 'forming',
    'B: 2 of 3 must NOT auto-submit — the third family can still join');
  assert.ok(!(await auditOf(b.id)).some((x) => x.action.includes('送審')), 'B: nothing may be audited as submitted');
  console.log('✅ B 未滿團 → 不自動送審（名單不被提早鎖死）');

  // ── B2：後台「揪團中·已收齊款」看得到它，已送審的不會混進來 ──
  const at = adminToken();
  r = await api('/api/admin/group-orders?status=forming_ready', { token: at });
  assert.strictEqual(r.status, 200, 'B2: admin list failed → ' + JSON.stringify(r));
  const listed = r.data.find((x) => x.id === b.id);
  assert.ok(listed, 'B2: a fully-paid forming group must appear under forming_ready');
  assert.strictEqual(listed.payment_ready, true, 'B2: payment_ready flag');
  assert.strictEqual(listed.paid_member_count, 2, 'B2: paid_member_count');
  assert.strictEqual(listed.can_submit, true, 'B2: can_submit');
  assert.ok(!r.data.some((x) => x.id === a.id), 'B2: an already-submitted group must not show as forming_ready');
  console.log('✅ B2 後台 forming_ready 清單 + 計算欄位');

  // ── B3：不帶 status 的預設清單也要收得到（不然櫃檯還是會漏看）──
  r = await api('/api/admin/group-orders', { token: at });
  assert.ok(r.data.some((x) => x.id === b.id), 'B3: the default list must include forming-ready groups');
  assert.ok(r.data.some((x) => x.id === a.id), 'B3: the default list must still include submitted groups');
  console.log('✅ B3 預設清單同時含待審核與揪團中已收齊款');

  // ── B4：櫃檯代為送審 ─────────────────────────────────────
  r = await api(`/api/admin/group-orders/${b.id}/submit`, { token: at, method: 'POST' });
  assert.strictEqual(r.status, 200, 'B4: proxy submit failed → ' + JSON.stringify(r));
  assert.strictEqual(r.data.status, 'submitted', 'B4: response status');
  assert.strictEqual(r.data.total_students, 2, 'B4: total_students echoed back');
  const bAudit = await auditOf(b.id);
  assert.ok(bAudit.some((x) => x.action.includes('櫃檯代為送審') && x.by_user === 'E2E 測試員'),
    'B4: proxy submit must be audited under the staff name, not disguised as the leader → ' + JSON.stringify(bAudit));
  console.log('✅ B4 櫃檯代為送審 + 具名稽核');

  // ── B5：重複代送審必須被擋（狀態已非 forming）──────────────
  r = await api(`/api/admin/group-orders/${b.id}/submit`, { token: at, method: 'POST' });
  assert.strictEqual(r.status, 409, 'B5: a second proxy submit must be rejected, got ' + r.status);
  console.log('✅ B5 重複代送審被擋');

  // ── C：付款沒齊的團，既不進清單也不可代送審 ────────────────
  const c = await makeGroup({ courseType: 2, min: 2, max: 2, parents: [ps[0], ps[2]], lastPaidIdx: 1 });
  r = await api(`/api/admin/group-orders/${c.id}/submit`, { token: at, method: 'POST' });
  assert.strictEqual(r.status, 409, 'C: incomplete payment must block proxy submit, got ' + r.status);
  assert.strictEqual(r.data.code, 'MISSING_PAYMENT_PROOF', 'C: error code');
  assert.strictEqual((r.data.pending_members || []).length, 1, 'C: must name exactly who is missing');
  assert.ok(r.data.pending_members[0].parent_name, 'C: counter staff need the real name to phone them');
  r = await api('/api/admin/group-orders?status=forming_ready', { token: at });
  assert.ok(!r.data.some((x) => x.id === c.id), 'C: a group with an unpaid member is not forming_ready');
  console.log('✅ C 未收齊 → 不進清單、不可代送審、指名缺件家庭');

  console.log('\ne2e_auto_submit: ALL PASS');
})()
  .catch((e) => { console.error('\n❌ FAILED:', e.message); process.exitCode = 1; })
  .finally(async () => {
    const ids = (await pool.query('SELECT id FROM group_orders WHERE note = $1', [MARK])).rows.map((x) => x.id);
    if (ids.length) {
      await pool.query('DELETE FROM group_order_audit_logs WHERE group_order_id = ANY($1)', [ids]);
      await pool.query('DELETE FROM group_order_members WHERE group_order_id = ANY($1)', [ids]);
      await pool.query('DELETE FROM group_orders WHERE id = ANY($1)', [ids]);
      console.log(`(已清除 ${ids.length} 筆測試團購)`);
    }
    await pool.end();
  });
