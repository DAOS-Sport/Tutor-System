'use strict';
// 預建檔家長的 LINE 認領（registerNewParentLocalFirst）。
//
// 為什麼需要：舊家教系統移轉會先在本地建好家長＋學員（有電話、沒綁 LINE、Ragic 沒有），
// 家長之後用 LINE 註冊走的是本地優先註冊。原本這條路沿用預建家長卻不寫 line_uid，
// 家長下次用 LINE 登入找不到人，CREATE_Z01_PARENT 也會卡在 outbox。
//
// 守的契約：
//   1. 電話＋學員姓名對上 → 綁 LINE、用家長填的資料更新家長
//   2. 同名既有學員只補空欄位（生日／性別／血型／身分證），不多建學員，並留學員稽核
//   3. 夜間回寫候選拿到的學員欄位與 CREATE_Z01_PARENT 佇列內容一致
//   4. 既有值不覆蓋
//   5. 身分證與同家長另一位學員重複時不補、不報錯
//   6. 只知道電話、學員姓名不符 → CLAIM_VERIFICATION_FAILED，不綁、不多建學員
//   7. 預建家長名下沒有學員 → 無從核對，同樣擋下
//   8. 姓名對上但已存的身分證不同 → 擋下；身分證相同 → 綁定（同 Z03 認領規則）
//   9. 停用學員的姓名不能拿來過關
//  10. 館別沿用預建時的；送 Ragic 的佇列內容是本地合併後的值，不是家長原始送出的
//  11. 全新電話照舊：建家長＋學員並綁 LINE
//  12. 和還沒被對上的登記學員只差一字 → 算核對過關，但另建新學員、記 NEW_SIMILAR 給櫃台反查（Owner 2026-10-20）
//  13. 同一個 LINE 帳號 30 分鐘錯 5 次冷靜（一次送幾個名字算幾次）；並發也最多 5 筆進得去核對；冷靜期不擋成功註冊的重送
//  14. 一次最多核對 3 位；只差一字只在只填一位時能當過關依據
//
// 真實 public schema、合成資料、try/finally 自己刪乾淨。不碰 LINE / Ragic / 正式資料。
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('../server/node_modules/pg');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const target = new URL(url);
assert.ok(['localhost', '127.0.0.1'].includes(target.hostname), '必須是 loopback 的拋棄式測試庫');
assert.match(target.pathname, /^\/daos_(test|audit)/, '必須是 daos_test / daos_audit');

const pool = new Pool({ connectionString: url, options: '-c statement_timeout=20000' });
const dbId = require.resolve('../server/models/db');
require.cache[dbId] = { id: dbId, filename: dbId, loaded: true, exports: { pool } };
const { registerNewParentLocalFirst } = require('../server/services/z03IdentityClaim');
const claimAttempts = require('../server/services/claimAttempts');

let passed = 0;
const made = { parents: [] };
const t = async (name, fn) => { await fn(); passed += 1; console.log('PASS ' + name); };
const phone = () => `09${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const lineUid = () => `Utest${randomUUID().replace(/-/g, '')}`.slice(0, 33);

async function prebuilt(p, venue, kids, { active = true } = {}) {
  const parent = (await pool.query(
    `INSERT INTO parents (phone,name,primary_venue_id,is_active) VALUES ($1,'預建家長',$2,TRUE) RETURNING id`,
    [p, venue])).rows[0];
  made.parents.push(parent.id);
  const studentIds = [];
  for (const k of kids) {
    studentIds.push((await pool.query(
      `INSERT INTO students (parent_id,name,birth_date,id_number,is_active) VALUES ($1,$2,$3::date,$4,$5) RETURNING id`,
      [parent.id, k.name, k.birth_date || null, k.id_number || null, active])).rows[0].id);
  }
  return { parentId: parent.id, studentIds };
}

const register = (p, venue, parent, students, uid) => registerNewParentLocalFirst({
  parent: { phone: p, primary_venue_id: venue, ...parent },
  students,
  lineUid: uid,
  idempotencyKey: `t-${randomUUID()}`,
});

// 塞 n 筆核對失敗紀錄給這個 LINE 帳號（模擬先前錯過幾次）。
async function seedFailures(lineUid, phone, n) {
  for (let i = 0; i < n; i += 1) {
    const a = await claimAttempts.reserveClaimAttempt({ lineUid, phone, path: 'TEST', submittedName: `錯${i}` });
    await claimAttempts.finishClaimAttempt(a.id, { outcome: 'FAILED' });
  }
}

const rejection = (fn) => fn().then(() => null, (e) => e);
const parentRow = async (id) => (await pool.query(`SELECT * FROM parents WHERE id=$1`, [id])).rows[0];
const queuedStudents = async (parentId) => (await pool.query(
  `SELECT o.payload_reference FROM ragic_sync_outbox o JOIN identity_claims c ON c.id=o.claim_id
    WHERE c.canonical_parent_id=$1 AND o.operation='CREATE_Z01_PARENT'`, [parentId])).rows.map((r) => r.payload_reference.students);
const studentRows = async (parentId) => (await pool.query(
  `SELECT *, to_char(birth_date,'YYYY-MM-DD') AS bd FROM students WHERE parent_id=$1 ORDER BY created_at`, [parentId])).rows;

(async () => {
  try {
    // 舊版建過的表沒有 guess_count：SCHEMA_SQL 要能補上（不然開機後每筆註冊都會 42703）。
    await pool.query(claimAttempts.SCHEMA_SQL);
    await pool.query('ALTER TABLE parent_claim_attempts DROP COLUMN guess_count');
    await pool.query(claimAttempts.SCHEMA_SQL);
    assert.equal((await pool.query(
      "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='parent_claim_attempts' AND column_name='guess_count'")).rows[0].n, 1);
    const venue = (await pool.query(`SELECT id FROM venues WHERE COALESCE(is_active, TRUE) ORDER BY id LIMIT 1`)).rows[0].id;

    await t('電話＋姓名對上：綁 LINE、補學員資料、稽核、回寫候選與佇列一致', async () => {
      const p = phone(); const uid = lineUid();
      const f = await prebuilt(p, venue, [{ name: '王小明' }]);
      await register(p, venue,
        { name: '王大明', gender: '男', email: 'wang@example.invalid', identity: '一般身分' },
        [{ name: '王小明', birth_date: '2015-03-04', gender: '男', blood_type: 'A', id_number: 'a123456789' }], uid);

      const parent = await parentRow(f.parentId);
      assert.equal(parent.line_uid, uid);
      assert.equal(parent.name, '王大明');
      assert.equal(parent.email, 'wang@example.invalid');
      assert.equal((await pool.query(`SELECT id FROM parents WHERE line_uid=$1`, [uid])).rows[0].id, f.parentId);

      const kids = await studentRows(f.parentId);
      assert.equal(kids.length, 1);
      assert.equal(kids[0].id, f.studentIds[0]);
      assert.equal(kids[0].bd, '2015-03-04');
      assert.equal(kids[0].gender, '男');
      assert.equal(kids[0].blood_type, 'A');
      assert.equal(kids[0].id_number, 'A123456789');

      const audit = (await pool.query(
        `SELECT changes FROM student_audit_logs WHERE student_id=$1 AND action='edit'`, [kids[0].id])).rows;
      assert.equal(audit.length, 1);
      assert.equal(audit[0].changes.birth_date.after, '2015-03-04');

      const backup = (await pool.query(
        `SELECT to_char(s.birth_date,'YYYY-MM-DD') AS bd, s.gender, s.blood_type, s.id_number
           FROM students s JOIN parents p ON p.id = s.parent_id
          WHERE s.is_active AND p.is_active AND p.line_uid IS NOT NULL AND p.line_uid <> ''
            AND (s.ragic_record_id IS NULL OR s.last_synced_at IS NULL) AND p.id=$1`, [f.parentId])).rows;
      const queued = (await pool.query(
        `SELECT o.payload_reference FROM ragic_sync_outbox o JOIN identity_claims c ON c.id=o.claim_id
          WHERE c.canonical_parent_id=$1 AND o.operation='CREATE_Z01_PARENT'`, [f.parentId])).rows;
      assert.equal(backup.length, 1);
      assert.equal(queued.length, 1);
      const q = queued[0].payload_reference.students[0];
      assert.equal(backup[0].bd, q.birth_date);
      assert.equal(backup[0].gender, q.gender);
      assert.equal(backup[0].blood_type, q.blood_type);
      assert.equal(backup[0].id_number, String(q.id_number).toUpperCase());
    });

    await t('既有值不覆蓋；身分證與同家長另一位重複時不補', async () => {
      const p = phone(); const uid = lineUid();
      const f = await prebuilt(p, venue, [{ name: '李小華', birth_date: '2014-01-01' }, { name: '李小美', id_number: 'B223456789' }]);
      await register(p, venue, { name: '李媽媽', gender: '女' },
        [{ name: '李小華', birth_date: '2016-06-06', gender: '女', blood_type: 'O', id_number: 'B223456789' }], uid);
      const s = (await studentRows(f.parentId)).find((row) => row.id === f.studentIds[0]);
      assert.equal(s.bd, '2014-01-01');
      assert.equal(s.gender, '女');
      assert.equal(s.id_number, null);
      assert.equal((await parentRow(f.parentId)).line_uid, uid);
      const queued = await queuedStudents(f.parentId);
      assert.equal(queued.length, 1);
      assert.equal(queued[0][0].birth_date, '2014-01-01');
      assert.equal(queued[0][0].gender, '女');
      assert.equal(queued[0][0].id_number, '');
    });

    await t('姓名對上但已存的身分證不同：擋下；相同：綁定', async () => {
      const p = phone();
      const f = await prebuilt(p, venue, [{ name: '張小芳', id_number: 'C123456789' }]);
      const err = await rejection(() => register(p, venue, { name: '張家長' }, [{ name: '張小芳', id_number: 'C223456789' }], lineUid()));
      assert.equal(err?.code, 'CLAIM_VERIFICATION_FAILED');
      assert.equal((await parentRow(f.parentId)).line_uid, null);
      const uid = lineUid();
      await register(p, venue, { name: '張家長' }, [{ name: '張小芳', id_number: 'c123456789' }], uid);
      assert.equal((await parentRow(f.parentId)).line_uid, uid);
    });

    await t('只填一位登記上沒有、和既有學員只差一字的：綁定、另建新學員、既有的不動、留 NEW_SIMILAR', async () => {
      const p = phone(); const uid = lineUid();
      const f = await prebuilt(p, venue, [{ name: '陳冠宇' }]);
      await register(p, venue, { name: '陳家長' }, [{ name: '陳冠廷', birth_date: '2019-05-05', id_number: 'A299999999' }], uid);
      assert.equal((await parentRow(f.parentId)).line_uid, uid);
      const kids = await studentRows(f.parentId);
      assert.deepEqual(kids.map((k) => [k.name, k.bd, k.id_number]), [['陳冠宇', null, null], ['陳冠廷', '2019-05-05', 'A299999999']]);
      assert.deepEqual((await queuedStudents(f.parentId))[0].map((s) => s.name), ['陳冠廷']);
      const att = (await pool.query(`SELECT outcome, matched_name FROM parent_claim_attempts WHERE source_record_id=$1`, [f.parentId])).rows;
      assert.deepEqual(att, [{ outcome: 'NEW_SIMILAR', matched_name: '陳冠宇' }]);
    });

    await t('兄弟姊妹只差一字（登記沒身分證）：既有那位照舊、新的一位另建，資料不互相污染', async () => {
      const p = phone(); const uid = lineUid();
      const f = await prebuilt(p, venue, [{ name: '陳冠宇' }]);
      await register(p, venue, { name: '陳家長' }, [{ name: '陳冠宇' }, { name: '陳冠廷', birth_date: '2019-05-05' }], uid);
      assert.equal((await parentRow(f.parentId)).line_uid, uid);
      const kids = await studentRows(f.parentId);
      assert.deepEqual(kids.map((k) => [k.name, k.bd]), [['陳冠宇', null], ['陳冠廷', '2019-05-05']]);
      assert.deepEqual((await queuedStudents(f.parentId))[0].map((s) => s.name), ['陳冠宇', '陳冠廷']);
    });

    await t('兄弟姊妹只差一字（登記有身分證、新的一位身分證不同）：照常綁定並另建', async () => {
      const p = phone(); const uid = lineUid();
      const f = await prebuilt(p, venue, [{ name: '蔡承恩', id_number: 'H123456789' }]);
      await register(p, venue, { name: '蔡家長' },
        [{ name: '蔡承恩', id_number: 'h123456789' }, { name: '蔡承安', id_number: 'H223456789' }], uid);
      assert.equal((await parentRow(f.parentId)).line_uid, uid);
      assert.deepEqual((await studentRows(f.parentId)).map((k) => k.name), ['蔡承恩', '蔡承安']);
    });

    await t('同一個 LINE 帳號同時送 8 筆錯的：最多 5 筆進得去核對，其餘冷靜、不綁', async () => {
      const p = phone(); const uid = lineUid();
      const f = await prebuilt(p, venue, [{ name: '黃小並' }]);
      const errs = await Promise.all(Array.from({ length: 8 }, (_, i) =>
        rejection(() => register(p, venue, { name: '黃家長' }, [{ name: `錯名${i}號` }], uid))));
      const codes = errs.map((e) => e?.code);
      assert.ok(codes.every((c) => c === 'CLAIM_VERIFICATION_FAILED' || c === 'CLAIM_COOLDOWN'), JSON.stringify(codes));
      assert.ok(codes.filter((c) => c === 'CLAIM_VERIFICATION_FAILED').length <= claimAttempts.FAILURE_LIMIT, JSON.stringify(codes));
      assert.ok(codes.includes('CLAIM_COOLDOWN'), JSON.stringify(codes));
      assert.equal((await parentRow(f.parentId)).line_uid, null);
    });

    await t('一位完全對上、另一位和未送出的登記學員只差一字：另建並標 NEW_SIMILAR', async () => {
      const p = phone(); const uid = lineUid();
      const f = await prebuilt(p, venue, [{ name: '林小樂' }, { name: '林語彤' }]);
      await register(p, venue, { name: '林家長' }, [{ name: '林小樂' }, { name: '林語桐' }], uid);
      assert.equal((await parentRow(f.parentId)).line_uid, uid);
      assert.deepEqual((await studentRows(f.parentId)).map((k) => k.name), ['林小樂', '林語彤', '林語桐']);
      const att = (await pool.query(`SELECT outcome, matched_name FROM parent_claim_attempts WHERE source_record_id=$1`, [f.parentId])).rows;
      assert.deepEqual(att, [{ outcome: 'NEW_SIMILAR', matched_name: '林語彤' }]);
    });

    await t('一次塞好幾個名字、只靠其中一個差一字：不過關，且按名字數計入冷靜', async () => {
      const p = phone(); const uid = lineUid();
      const f = await prebuilt(p, venue, [{ name: '林語彤' }]);
      const guess = (names) => rejection(() => register(p, venue, { name: '猜名者' }, names.map((name) => ({ name })), uid));
      assert.equal((await guess(['陳小明', '林雨涵', '林語桐']))?.code, 'CLAIM_VERIFICATION_FAILED');
      assert.equal((await guess(['王大同', '李小華']))?.code, 'CLAIM_VERIFICATION_FAILED');
      assert.equal((await guess(['林語彤']))?.code, 'CLAIM_COOLDOWN');
      assert.equal((await parentRow(f.parentId)).line_uid, null);
      const rows = (await pool.query(
        `SELECT outcome, guess_count FROM parent_claim_attempts WHERE source_record_id=$1 ORDER BY id`, [f.parentId])).rows;
      assert.deepEqual(rows, [{ outcome: 'FAILED', guess_count: 3 }, { outcome: 'FAILED', guess_count: 2 }]);
    });

    await t('已錯 4 個名字：再送 2 個名字就冷靜（上限是名字數 5）；只送 1 個對的仍可綁', async () => {
      const p = phone(); const uid = lineUid();
      const f = await prebuilt(p, venue, [{ name: '孫小邊' }]);
      await seedFailures(uid, p, claimAttempts.FAILURE_LIMIT - 1);
      const err = await rejection(() => register(p, venue, { name: '孫家長' }, [{ name: '孫小邊' }, { name: '孫小界' }], uid));
      assert.equal(err?.code, 'CLAIM_COOLDOWN');
      assert.equal((await parentRow(f.parentId)).line_uid, null);
      await register(p, venue, { name: '孫家長' }, [{ name: '孫小邊' }], uid);
      assert.equal((await parentRow(f.parentId)).line_uid, uid);
    });

    await t('一次超過 3 位學員：比對前就擋下、不計冷靜；改填一位就能綁', async () => {
      const p = phone(); const uid = lineUid();
      const f = await prebuilt(p, venue, [{ name: '吳小四' }]);
      const err = await rejection(() => register(p, venue, { name: '吳家長' },
        [{ name: '吳小四' }, { name: '吳小五' }, { name: '吳小六' }, { name: '吳小七' }], uid));
      assert.equal(err?.code, 'CLAIM_TOO_MANY_STUDENTS');
      assert.equal((await parentRow(f.parentId)).line_uid, null);
      await register(p, venue, { name: '吳家長' }, [{ name: '吳小四' }], uid);
      assert.equal((await parentRow(f.parentId)).line_uid, uid);
    });

    await t('兄弟姊妹同名那位也有送出：新的一位另建、不標相近', async () => {
      const p = phone(); const uid = lineUid();
      const f = await prebuilt(p, venue, [{ name: '鄭冠宇' }]);
      await register(p, venue, { name: '鄭家長' }, [{ name: '鄭冠宇' }, { name: '鄭冠廷' }], uid);
      const att = (await pool.query(`SELECT outcome FROM parent_claim_attempts WHERE source_record_id=$1`, [f.parentId])).rows;
      assert.deepEqual(att, [{ outcome: 'PASSED_EXACT' }]);
    });

    await t('冷靜期不擋已成功註冊的重送（idempotent replay）', async () => {
      const p = phone(); const uid = lineUid(); const key = `t-${randomUUID()}`;
      const f = await prebuilt(p, venue, [{ name: '高小重' }]);
      const args = { parent: { phone: p, primary_venue_id: venue, name: '高家長' }, students: [{ name: '高小重' }], lineUid: uid, idempotencyKey: key };
      await registerNewParentLocalFirst(args);
      await seedFailures(uid, p, claimAttempts.FAILURE_LIMIT);
      assert.equal((await registerNewParentLocalFirst(args)).replayed, true);
      assert.equal((await rejection(() => registerNewParentLocalFirst({ ...args, idempotencyKey: `t-${randomUUID()}` })))?.code, 'CLAIM_COOLDOWN');
    });

    await t('姓名不對但身分證相同：綁定、沿用既有學員', async () => {
      const p = phone(); const uid = lineUid();
      const f = await prebuilt(p, venue, [{ name: '許小涵', id_number: 'E223456789' }]);
      await register(p, venue, { name: '許家長' }, [{ name: '許曉晗晗', id_number: 'e223456789' }], uid);
      assert.equal((await parentRow(f.parentId)).line_uid, uid);
      assert.deepEqual((await studentRows(f.parentId)).map((k) => k.name), ['許小涵']);
    });

    await t('核對失敗會留下 FAILED 紀錄（同一個 LINE 帳號錯 5 次會冷靜）', async () => {
      const p = phone(); const uid = lineUid();
      const f = await prebuilt(p, venue, [{ name: '鄭小安' }]);
      const err = await rejection(() => register(p, venue, { name: '冒領者' }, [{ name: '毫無關係' }], uid));
      assert.equal(err?.code, 'CLAIM_VERIFICATION_FAILED');
      const att = (await pool.query(`SELECT outcome FROM parent_claim_attempts WHERE source_record_id=$1`, [f.parentId])).rows;
      assert.deepEqual(att.map((a) => a.outcome), ['FAILED']);
    });

    await t('停用學員的姓名不能拿來過關', async () => {
      const p = phone();
      const f = await prebuilt(p, venue, [{ name: '林小停' }], { active: false });
      const err = await rejection(() => register(p, venue, { name: '林家長' }, [{ name: '林小停' }], lineUid()));
      assert.equal(err?.code, 'CLAIM_VERIFICATION_FAILED');
      assert.equal((await parentRow(f.parentId)).line_uid, null);
    });

    await t('館別沿用預建時的', async () => {
      const venues = (await pool.query(`SELECT id FROM venues ORDER BY id LIMIT 2`)).rows.map((r) => r.id);
      assert.equal(venues.length, 2, '測試庫至少要有兩個場館');
      const p = phone();
      const f = await prebuilt(p, venues[0], [{ name: '吳小館' }]);
      await register(p, venues[1], { name: '吳家長' }, [{ name: '吳小館' }], lineUid());
      assert.equal((await parentRow(f.parentId)).primary_venue_id, venues[0]);
    });

    await t('只知道電話、學員姓名不符：擋下，不綁、不多建學員', async () => {
      const p = phone(); const uid = lineUid();
      const f = await prebuilt(p, venue, [{ name: '陳小安' }]);
      const err = await rejection(() => register(p, venue, { name: '冒領者' }, [{ name: '不相干' }], uid));
      assert.equal(err?.code, 'CLAIM_VERIFICATION_FAILED');
      assert.equal((await parentRow(f.parentId)).line_uid, null);
      assert.equal((await studentRows(f.parentId)).length, 1);
    });

    await t('預建家長名下沒有學員：無從核對，擋下', async () => {
      const p = phone(); const uid = lineUid();
      const f = await prebuilt(p, venue, []);
      const err = await rejection(() => register(p, venue, { name: '某家長' }, [{ name: '任何人' }], uid));
      assert.equal(err?.code, 'CLAIM_VERIFICATION_FAILED');
      assert.equal((await parentRow(f.parentId)).line_uid, null);
      assert.equal((await studentRows(f.parentId)).length, 0);
    });

    await t('全新電話照舊：建家長＋學員並綁 LINE', async () => {
      const p = phone(); const uid = lineUid();
      const result = await register(p, venue, { name: '新家長' }, [{ name: '新學員', birth_date: '2017-02-02' }], uid);
      made.parents.push(result.parent.id);
      const parent = await parentRow(result.parent.id);
      assert.equal(parent.line_uid, uid);
      const kids = await studentRows(parent.id);
      assert.equal(kids.length, 1);
      assert.equal(kids[0].name, '新學員');
    });

    console.log(`\n${passed} 個測試全數通過`);
  } finally {
    try {
      const ids = made.parents;
      await pool.query(`DELETE FROM parent_identity_requests WHERE canonical_parent_id = ANY($1::uuid[])`, [ids]);
      await pool.query(`DELETE FROM ragic_sync_outbox WHERE claim_id IN (SELECT id FROM identity_claims WHERE canonical_parent_id = ANY($1::uuid[]))`, [ids]);
      await pool.query(`DELETE FROM identity_claims WHERE canonical_parent_id = ANY($1::uuid[])`, [ids]);
      await pool.query(`DELETE FROM student_audit_logs WHERE student_id IN (SELECT id FROM students WHERE parent_id = ANY($1::uuid[]))`, [ids]);
      await pool.query(`DELETE FROM students WHERE parent_id = ANY($1::uuid[])`, [ids]);
      await pool.query(
        `DELETE FROM parent_claim_attempts WHERE source_record_id = ANY($1::text[])
            OR phone_canonical IN (SELECT phone FROM parents WHERE id = ANY($2::uuid[]))`, [ids.map(String), ids]);
      await pool.query(`DELETE FROM parents WHERE id = ANY($1::uuid[])`, [ids]);
    } catch (e) {
      console.error('清除失敗：' + e.message);
      process.exitCode = 1;
    }
    await pool.end();
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
