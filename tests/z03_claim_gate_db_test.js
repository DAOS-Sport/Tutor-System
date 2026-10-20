'use strict';
// 家長認領閘門（Owner 2026-10-20）：走正式路由 /api/auth/parent-bind-phone（Ragic Z03 那條）。
//   G1 重現 10/20 案例：這戶已因打錯字被鎖成人工審核、登記有兩筆同名學員；家長填對名字 → 綁定
//   G2 姓名只差一字（林語桐／林語彤）→ 綁定，本地學員用登記的姓名，留下 PASSED_NEAR 紀錄
//   G3 姓名完全不對 → 擋下（CLAIM_VERIFICATION_FAILED），這戶不被鎖，留下 FAILED 紀錄
//   G4 姓名不對但身分證相同 → 綁定，留下 PASSED_ID 紀錄
//   G5 同一個 LINE 帳號 30 分鐘內錯 5 次 → 第 6 次就算填對也冷靜（429）；別的 LINE 帳號照常
//   G6 櫃台手動轉人工（ADMIN_DISMISSED）的照樣擋
//   G7 兩個字的姓名只差一字 → 不算（不然只要知道手機＋姓氏就能過）
//   G8 同一個 LINE 帳號的認領排隊：前一筆失敗寫入後，排在後面的那筆才檢查冷靜期（並發不能一起繞過）
//   G9 註冊新增學員（allowStudentAppend）：只差一字的兄弟姊妹另建，不併到既有學員
// 不碰 Ragic（同步呼叫一律丟錯）；所有資料 finally 自己刪乾淨。
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('../server/node_modules/express');
const axios = require('../server/node_modules/axios');
const { pool } = require('../server/models/db');
const ragic = require('../server/services/ragic');
const claimAttempts = require('../server/services/claimAttempts');
const { claimZ03Identity } = require('../server/services/z03IdentityClaim');

const url = new URL(process.env.DATABASE_URL);
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname), '必須是 loopback 的拋棄式測試庫');
assert.match(url.pathname, /^\/daos_(test|audit)/, '必須是 daos_test / daos_audit');

const suffix = String(Date.now()).slice(-6);
const uid = () => `U${crypto.randomBytes(16).toString('hex')}`;
const made = { sources: [], phones: [], uids: [] };
const shadows = new Map();
let passed = 0;
const t = async (name, fn) => { await fn(); passed += 1; console.log('PASS ' + name); };

async function family(tag, { status = 'pending', reason = 'TRUE_LINE_UID_EMPTY', classification = null, students }) {
  const sourceId = `ZZGATE${tag}${suffix}`;
  const phone = `09${tag.charCodeAt(0) % 10}${String(made.sources.length)}${suffix}`.slice(0, 10);
  made.sources.push(sourceId); made.phones.push(phone);
  const rec = (await pool.query(
    `INSERT INTO ragic_z03_records (z01_ragic_record_id,raw_name,phone,phone_canonical,status,classification,reason_code,claim_state)
     VALUES ($1,'閘門測試家長',$2,$2,$3,$4,$5,$4) RETURNING id`,
    [sourceId, phone, status, classification || (status === 'manual_review' ? 'MANUAL_REVIEW' : 'PENDING_Z03'), reason])).rows[0];
  const sub = {};
  for (const [i, s] of students.entries()) {
    await pool.query(
      `INSERT INTO ragic_z03_students (z03_record_id,name_raw,name_normalized,id_number_raw,source_row_key,classification,present_in_latest_payload)
       VALUES ($1,$2,$3,$4,$5,'VALID',TRUE)`, [rec.id, s.name, s.name, s.id || null, `row-${i + 1}`]);
    sub[`row-${i + 1}`] = { 1001115: s.name, 1004090: phone };
  }
  const raw = { _ragicId: sourceId, 1001101: '閘門測試家長', 1001100: phone, 1006846: '', _subtable_1001119: sub };
  shadows.set(phone, raw);
  await pool.query(
    `INSERT INTO ragic_z01_shadow(ragic_record_id,raw_data,fetched_at,last_seen_at,present_in_latest_pull) VALUES ($1,$2::jsonb,NOW(),NOW(),TRUE)`,
    [sourceId, JSON.stringify(raw)]);
  return { id: rec.id, sourceId, phone };
}

// 等到有請求卡在 advisory lock 上（排隊中）；舊程式不排隊，等不到就照常往下走，讓斷言去抓。
async function lockWaiter(db) {
  for (let i = 0; i < 60; i += 1) {
    if ((await db.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted`)).rows[0].n) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function cleanup() {
  const claims = (await pool.query(
    `SELECT id, canonical_parent_id FROM identity_claims WHERE source_record_id = ANY($1::text[]) OR phone_canonical = ANY($2::text[])`,
    [made.sources, made.phones])).rows;
  const claimIds = claims.map((r) => r.id);
  const parentIds = [...new Set([
    ...claims.map((r) => r.canonical_parent_id).filter(Boolean),
    ...(await pool.query(`SELECT id FROM parents WHERE phone = ANY($1::text[])`, [made.phones])).rows.map((r) => r.id),
  ])];
  if (claimIds.length) {
    await pool.query(`DELETE FROM identity_claim_events WHERE claim_id = ANY($1::uuid[])`, [claimIds]);
    await pool.query(`DELETE FROM ragic_sync_outbox WHERE claim_id = ANY($1::uuid[])`, [claimIds]);
  }
  await pool.query(`DELETE FROM parent_identity_backoffice_tasks WHERE source_record_ids && $1::text[]`, [made.sources]);
  await pool.query(`DELETE FROM source_record_links WHERE source_record_id = ANY($1::text[])`, [made.sources]);
  if (claimIds.length) await pool.query(`DELETE FROM identity_claims WHERE id = ANY($1::uuid[])`, [claimIds]);
  await pool.query(`DELETE FROM ragic_z03_records WHERE z01_ragic_record_id = ANY($1::text[])`, [made.sources]);
  await pool.query(`DELETE FROM ragic_z01_shadow WHERE ragic_record_id = ANY($1::text[])`, [made.sources]);
  await pool.query(`DELETE FROM parent_claim_attempts WHERE phone_canonical = ANY($1::text[])`, [made.phones]);
  if (parentIds.length) {
    await pool.query(`DELETE FROM parent_line_uid_bindings WHERE canonical_parent_id = ANY($1::uuid[])`, [parentIds]);
    await pool.query(`DELETE FROM student_audit_logs WHERE student_id IN (SELECT id FROM students WHERE parent_id = ANY($1::uuid[]))`, [parentIds]);
    await pool.query(`DELETE FROM students WHERE parent_id = ANY($1::uuid[])`, [parentIds]);
    await pool.query(`DELETE FROM parents WHERE id = ANY($1::uuid[])`, [parentIds]);
  }
}

(async () => {
  await pool.query(claimAttempts.SCHEMA_SQL);
  const originalAxiosPost = axios.post;
  const originalRagic = {};
  let server;
  try {
    for (const name of ['getParentByPhone', 'getParentByLineUid', 'createParentWithStudentsInRagic']) {
      originalRagic[name] = ragic[name];
      ragic[name] = async () => { throw new Error(`unexpected Ragic call: ${name}`); };
    }
    // 本地 Z03 查不到的狀態（打錯字鎖住、櫃台轉人工）正式站會去讀 Ragic 再重建本地資料：這裡唯讀回傳同一筆。
    ragic.getParentByPhone = async (p) => shadows.get(String(p).replace(/\D/g, '')) || null;
    let currentUid = uid();
    axios.post = async () => ({ status: 200, data: { sub: currentUid, aud: 'gate-channel' } });
    process.env.LINE_LOGIN_CHANNEL_ID = 'gate-channel';
    process.env.PARENT_IDENTITY_RESOLVER_V2 = 'true';
    process.env.PARENT_LOCAL_FIRST = 'true';
    delete require.cache[require.resolve('../server/services/lineAuth')];
    delete require.cache[require.resolve('../server/routes/auth')];
    const app = express();
    app.use(express.json());
    app.use('/api/auth', require('../server/routes/auth'));
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const claim = async (f, studentName, extra = {}, asUid = uid()) => {
      currentUid = asUid;
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/parent-bind-phone`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id_token: `tok-${crypto.randomUUID()}`, phone: f.phone,
          claim: { student_name: studentName, phone: f.phone, parent_name: '閘門測試家長', ...extra } }),
      });
      return { status: res.status, body: await res.json() };
    };
    const z03 = async (f) => (await pool.query(`SELECT status, reason_code FROM ragic_z03_records WHERE id=$1`, [f.id])).rows[0];
    const attempts = async (f) => (await pool.query(
      `SELECT outcome, matched_name FROM parent_claim_attempts WHERE phone_canonical=$1 ORDER BY id`, [f.phone])).rows;
    const kids = async (f) => (await pool.query(
      `SELECT s.name FROM students s JOIN parents p ON p.id=s.parent_id WHERE p.phone=$1 ORDER BY s.name`, [f.phone])).rows.map((r) => r.name);

    await t('G0 重現 10/20 手動修正後的狀態（已解決、原因仍是打錯字、兩筆同名）：填對名字就綁定', async () => {
      const f = await family('Z', { status: 'resolved', reason: 'IDENTITY_NOT_FOUND', classification: 'MANUAL_REVIEW',
        students: [{ name: '林語彤', id: 'Q200000001' }, { name: '林語彤', id: 'Q200000001' }] });
      const r = await claim(f, '林語彤');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.status, 'bound_and_logged_in');
    });

    await t('G1 已被打錯字鎖住、登記兩筆同名：家長填對名字就綁定', async () => {
      const f = await family('A', { status: 'manual_review', reason: 'IDENTITY_NOT_FOUND',
        students: [{ name: '林語彤', id: 'Q200000001' }, { name: '林語彤', id: 'Q200000001' }] });
      const r = await claim(f, '林語彤');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.status, 'bound_and_logged_in');
      assert.equal((await z03(f)).status, 'resolved');
    });

    await t('G2 姓名只差一字：綁定、學員用登記姓名、留 PASSED_NEAR', async () => {
      const f = await family('B', { students: [{ name: '林語彤' }] });
      const r = await claim(f, '林語桐');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(await kids(f), ['林語彤']);
      assert.deepEqual(await attempts(f), [{ outcome: 'PASSED_NEAR', matched_name: '林語彤' }]);
    });

    await t('G3 姓名完全不對：擋下、這戶不被鎖、留 FAILED', async () => {
      const f = await family('C', { students: [{ name: '陳小安' }] });
      const r = await claim(f, '王大明');
      assert.equal(r.status, 409);
      assert.equal(r.body.code, 'CLAIM_VERIFICATION_FAILED');
      assert.doesNotMatch(r.body.error, /Z03|family|exact/i);
      assert.equal((await z03(f)).status, 'pending');
      assert.deepEqual((await attempts(f)).map((a) => a.outcome), ['FAILED']);
      const again = await claim(f, '陳小安');
      assert.equal(again.status, 200, JSON.stringify(again.body));
    });

    await t('G4 姓名不對但身分證相同：綁定、留 PASSED_ID', async () => {
      const f = await family('D', { students: [{ name: '林小樂', id: 'F128000111' }] });
      const r = await claim(f, '林曉樂樂', { student_id_number: 'f128000111' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(await kids(f), ['林小樂']);
      assert.equal((await attempts(f))[0].outcome, 'PASSED_ID');
    });

    await t('G5 同一個 LINE 帳號錯 5 次就冷靜；別的 LINE 帳號照常', async () => {
      const f = await family('E', { students: [{ name: '周小宇' }] });
      const bad = uid();
      for (let i = 0; i < 5; i += 1) assert.equal((await claim(f, `錯名${i}號`, {}, bad)).status, 409);
      const cooled = await claim(f, '周小宇', {}, bad);
      assert.equal(cooled.status, 429);
      assert.equal(cooled.body.code, 'CLAIM_COOLDOWN');
      assert.equal((await z03(f)).status, 'pending');
      const other = await claim(f, '周小宇', {}, uid());
      assert.equal(other.status, 200, JSON.stringify(other.body));
    });

    await t('G6 櫃台手動轉人工的照樣擋', async () => {
      const f = await family('F', { status: 'manual_review', reason: 'ADMIN_DISMISSED', students: [{ name: '吳小傑' }] });
      const r = await claim(f, '吳小傑');
      assert.equal(r.status, 409);
      assert.equal(r.body.code, 'MANUAL_REVIEW_REQUIRED');
      assert.doesNotMatch(r.body.error, /Z03|family/i);
    });

    await t('G7 兩個字的姓名只差一字：不算', async () => {
      const f = await family('G', { students: [{ name: '王明' }] });
      const r = await claim(f, '王亮');
      assert.equal(r.status, 409);
      assert.equal(r.body.code, 'CLAIM_VERIFICATION_FAILED');
    });

    await t('G8 同一個 LINE 帳號的認領排隊：前面錯滿 5 次，排在後面的那筆就算填對也冷靜', async () => {
      const f = await family('H', { students: [{ name: '謝小並' }] });
      const busy = uid();
      const holder = await pool.connect();
      let pending;
      try {
        await claimAttempts.acquireClaimSlot(holder, busy);
        pending = claim(f, '謝小並', {}, busy);
        await lockWaiter(pool);
        for (let i = 0; i < claimAttempts.FAILURE_LIMIT; i += 1) {
          await claimAttempts.recordClaimAttempt({ lineUid: busy, phone: f.phone, path: 'Z03', submittedName: `錯${i}`, outcome: 'FAILED' });
        }
      } finally {
        await claimAttempts.releaseClaimSlot(holder, busy);
        holder.release();
      }
      const r = await pending;
      assert.equal(r.status, 429, JSON.stringify(r.body));
      assert.equal(r.body.code, 'CLAIM_COOLDOWN');
    });

    await t('G9 註冊新增學員：只差一字的兄弟姊妹另建，不併到既有學員', async () => {
      const f = await family('I', { students: [{ name: '陳冠宇' }] });
      const r = await claimZ03Identity({ phone: f.phone, studentName: '陳冠廷', lineUid: uid(),
        studentInput: { name: '陳冠廷', birth_date: '2019-05-05' }, allowStudentAppend: true });
      assert.equal(r.student.name, '陳冠廷');
      assert.ok((await kids(f)).includes('陳冠廷'));
      assert.deepEqual(await attempts(f), []);
    });

    console.log(`\n${passed} 個測試全數通過`);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    axios.post = originalAxiosPost;
    Object.assign(ragic, originalRagic);
    delete process.env.PARENT_IDENTITY_RESOLVER_V2;
    delete process.env.PARENT_LOCAL_FIRST;
    try { await cleanup(); } catch (e) { console.error('清除失敗：' + e.message); process.exitCode = 1; }
    await pool.end();
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
