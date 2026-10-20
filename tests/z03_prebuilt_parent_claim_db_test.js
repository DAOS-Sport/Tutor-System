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
//   8. 全新電話照舊：建家長＋學員並綁 LINE
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

let passed = 0;
const made = { parents: [] };
const t = async (name, fn) => { await fn(); passed += 1; console.log('PASS ' + name); };
const phone = () => `09${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const lineUid = () => `Utest${randomUUID().replace(/-/g, '')}`.slice(0, 33);

async function prebuilt(p, venue, kids) {
  const parent = (await pool.query(
    `INSERT INTO parents (phone,name,primary_venue_id,is_active) VALUES ($1,'預建家長',$2,TRUE) RETURNING id`,
    [p, venue])).rows[0];
  made.parents.push(parent.id);
  const studentIds = [];
  for (const k of kids) {
    studentIds.push((await pool.query(
      `INSERT INTO students (parent_id,name,birth_date,id_number,is_active) VALUES ($1,$2,$3::date,$4,TRUE) RETURNING id`,
      [parent.id, k.name, k.birth_date || null, k.id_number || null])).rows[0].id);
  }
  return { parentId: parent.id, studentIds };
}

const register = (p, venue, parent, students, uid) => registerNewParentLocalFirst({
  parent: { phone: p, primary_venue_id: venue, ...parent },
  students,
  lineUid: uid,
  idempotencyKey: `t-${randomUUID()}`,
});

const rejection = (fn) => fn().then(() => null, (e) => e);
const parentRow = async (id) => (await pool.query(`SELECT * FROM parents WHERE id=$1`, [id])).rows[0];
const studentRows = async (parentId) => (await pool.query(
  `SELECT *, to_char(birth_date,'YYYY-MM-DD') AS bd FROM students WHERE parent_id=$1 ORDER BY created_at`, [parentId])).rows;

(async () => {
  try {
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
      await pool.query(`DELETE FROM parents WHERE id = ANY($1::uuid[])`, [ids]);
    } catch (e) {
      console.error('清除失敗：' + e.message);
      process.exitCode = 1;
    }
    await pool.end();
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
