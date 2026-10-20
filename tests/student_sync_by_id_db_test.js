'use strict';
// Ragic ↔ 本地學員以身分證為主（Owner 2026-10-20：中文同名者很多）。同一位家長名下可以有兩位同名、身分證不同的孩子：
//   S1 Ragic 有兩位同名不同身分證、本地只有其中一位 → 另一位另建，各自拿到自己的 Ragic 紀錄編號
//   S2 本地已有兩位同名不同身分證 → 同步不再整位家長失敗，各自對上
//   S3 兩位都已有 Ragic 紀錄編號，Ragic 順序顛倒 → 不互換
//   S4 沒有身分證可分辨時照舊：同名就沿用那一筆，不多建
//   S5 正式 Z01 同步：子表兩位同名不同身分證 → 兩位都建，不記 AMBIGUOUS_STUDENT_MATCH
//   S6 正式 Z01 同步：子表兩位同名都沒身分證 → 照舊記 AMBIGUOUS_STUDENT_MATCH、不建
//   S7 outbox 送出新孩子後回填 Ragic 紀錄編號：同名時依身分證找對人
// 審查補強（不同名同身分證、先無後有身分證、身分證更正；本地列設 last_synced_at，改名才看得到）：
//   S8 正式 Z01：兄弟姊妹身分證撞號 → 不改名，各自留在原本那位
//   S9 parentSync：兄弟姊妹身分證填反 → 不改名、不互換，也不整位家長失敗
//   S10 parentSync：同一個孩子先一筆沒身分證、再一筆有身分證 → 只有一位，補上身分證
//   S11 身分證在 Ragic 更正（舊號已不在 Ragic）→ 不多建，沿用原本那位（parentSync 與正式 Z01）
//   S12 正式 Z01：本地一位同名沒身分證、Ragic 兩位同名不同身分證 → 交人工，不配給任一位、不新建
//   S13 parentSync：本地兩位不同名但身分證相同、Ragic 換新紀錄編號 → 不整位失敗，各自對上
// 複審補強：
//   S14 同一個孩子在 Ragic 出現兩次（同名同身分證）→ 只有一位（本地已有／本地還沒有都一樣）
//   S15 parentSync 對不出是哪一位而略過時，開一張人工整理單；重跑不會多開
//   S16 #52 之後的家庭：舊孩子沒身分證＋新註冊的同名孩子有身分證，Ragic 兩位都在 → 各自對上、不開整理單
//   S17 同名兄弟姊妹、Ragic 把第二位的身分證打成第一位的 → 第一位不被蓋掉，開整理單
// 不碰 Ragic（寫入一律用替身）；所有資料 finally 自己刪乾淨。
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../server/models/db');
const ragic = require('../server/services/ragic');
const parentSync = require('../server/services/parentSync');
const ragicAdmin = require('../server/services/ragicAdmin');
const { processClaimedRagicSyncOutboxJob } = require('../server/services/ragicSyncOutbox');

const url = new URL(process.env.DATABASE_URL);
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname), '必須是 loopback 的拋棄式測試庫');
assert.match(url.pathname, /^\/daos_(test|audit)/, '必須是 daos_test / daos_audit');

const suffix = String(Date.now()).slice(-6);
const made = { phones: [], sources: [] };
let passed = 0;
const t = async (name, fn) => { await fn(); passed += 1; console.log('PASS ' + name); };
const uid = () => `U${crypto.randomBytes(16).toString('hex')}`;

async function makeParent(tag, { lineUid = null } = {}) {
  const phone = `097${tag}${suffix}`.slice(0, 10);
  made.phones.push(phone);
  return (await pool.query(
    `INSERT INTO parents (phone,name,line_uid,is_active) VALUES ($1,'同步測試家長',$2,TRUE) RETURNING *`, [phone, lineUid])).rows[0];
}
const addStudent = async (parentId, name, idNumber, ragicId = null, { synced = false } = {}) => (await pool.query(
  `INSERT INTO students (parent_id,name,id_number,ragic_record_id,is_active,last_synced_at)
   VALUES ($1,$2,$3,$4,TRUE,CASE WHEN $5 THEN NOW() END) RETURNING id`,
  [parentId, name, idNumber, ragicId, synced])).rows[0].id;
const names = async (parentId) => (await pool.query(
  `SELECT id, name, id_number FROM students WHERE parent_id=$1 ORDER BY created_at, id`, [parentId])).rows;
const kids = async (parentId) => (await pool.query(
  `SELECT name, id_number, ragic_record_id FROM students WHERE parent_id=$1 ORDER BY id_number NULLS LAST, name`, [parentId])).rows;

async function inTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function cleanup() {
  const parentIds = (await pool.query(`SELECT id FROM parents WHERE phone = ANY($1::text[])`, [made.phones])).rows.map((r) => r.id);
  const claimIds = (await pool.query(
    `SELECT id FROM identity_claims WHERE phone_canonical = ANY($1::text[]) OR source_record_id = ANY($2::text[])`,
    [made.phones, made.sources])).rows.map((r) => r.id);
  if (claimIds.length) {
    await pool.query(`DELETE FROM identity_claim_events WHERE claim_id = ANY($1::uuid[])`, [claimIds]);
    await pool.query(`DELETE FROM ragic_sync_outbox WHERE claim_id = ANY($1::uuid[])`, [claimIds]);
  }
  await pool.query(`DELETE FROM source_record_links WHERE source_record_id = ANY($1::text[])`, [made.sources]);
  if (claimIds.length) await pool.query(`DELETE FROM identity_claims WHERE id = ANY($1::uuid[])`, [claimIds]);
  if (parentIds.length) {
    await pool.query(`DELETE FROM parent_identity_backoffice_tasks WHERE canonical_parent_id = ANY($1::uuid[])`, [parentIds]);
    await pool.query(`DELETE FROM parent_line_uid_bindings WHERE canonical_parent_id = ANY($1::uuid[])`, [parentIds]);
    await pool.query(`DELETE FROM student_audit_logs WHERE student_id IN (SELECT id FROM students WHERE parent_id = ANY($1::uuid[]))`, [parentIds]);
    await pool.query(`DELETE FROM students WHERE parent_id = ANY($1::uuid[])`, [parentIds]);
    await pool.query(`DELETE FROM parents WHERE id = ANY($1::uuid[])`, [parentIds]);
  }
}

function z01Row(sourceId, phone, lineUid, students) {
  const sub = {};
  students.forEach((s, i) => { sub[`row-${i + 1}`] = { 1001115: s.name, ...(s.id ? { 1001118: s.id } : {}), 1004090: phone }; });
  return { _ragicId: sourceId, 1001101: '同步測試家長', 1001100: phone, 1006846: lineUid, _subtable_1001119: sub };
}

async function syncFormal(raw) {
  return inTx(async (client) => ragicAdmin.__test__.syncCanonicalZ01Record(
    client, raw, ragic.mapZ01Parent(raw), await parentSync.loadVenuesMap(client)));
}

(async () => {
  try {
    await t('S1 Ragic 兩位同名不同身分證、本地只有一位：另一位另建，各拿各的 Ragic 紀錄編號', async () => {
      const p = await makeParent('1');
      await addStudent(p.id, '鄭乙乙', 'G123456789');
      await inTx((c) => parentSync.upsertLocalStudents(c, p.id, [
        { name: '鄭乙乙', id_number: 'F223456789', ragic_record_id: `RF${suffix}` },
        { name: '鄭乙乙', id_number: 'G123456789', ragic_record_id: `RG${suffix}` },
      ]));
      assert.deepEqual(await kids(p.id), [
        { name: '鄭乙乙', id_number: 'F223456789', ragic_record_id: `RF${suffix}` },
        { name: '鄭乙乙', id_number: 'G123456789', ragic_record_id: `RG${suffix}` },
      ]);
    });

    await t('S2 本地已有兩位同名不同身分證：同步不整位失敗，各自對上', async () => {
      const p = await makeParent('2');
      await addStudent(p.id, '鄭乙乙', 'F223456789');
      await addStudent(p.id, '鄭乙乙', 'G123456789');
      await inTx((c) => parentSync.upsertLocalStudents(c, p.id, [
        { name: '鄭乙乙', id_number: 'G123456789', ragic_record_id: `R2G${suffix}` },
        { name: '鄭乙乙', id_number: 'F223456789', ragic_record_id: `R2F${suffix}` },
      ]));
      assert.deepEqual(await kids(p.id), [
        { name: '鄭乙乙', id_number: 'F223456789', ragic_record_id: `R2F${suffix}` },
        { name: '鄭乙乙', id_number: 'G123456789', ragic_record_id: `R2G${suffix}` },
      ]);
    });

    await t('S3 兩位都已有 Ragic 紀錄編號，Ragic 順序顛倒：不互換', async () => {
      const p = await makeParent('3');
      await addStudent(p.id, '鄭乙乙', 'F223456789', `R3F${suffix}`);
      await addStudent(p.id, '鄭乙乙', 'G123456789', `R3G${suffix}`);
      await inTx((c) => parentSync.upsertLocalStudents(c, p.id, [
        { name: '鄭乙乙', id_number: 'G123456789', ragic_record_id: `R3G${suffix}` },
        { name: '鄭乙乙', id_number: 'F223456789', ragic_record_id: `R3F${suffix}` },
      ]));
      assert.deepEqual(await kids(p.id), [
        { name: '鄭乙乙', id_number: 'F223456789', ragic_record_id: `R3F${suffix}` },
        { name: '鄭乙乙', id_number: 'G123456789', ragic_record_id: `R3G${suffix}` },
      ]);
    });

    await t('S4 沒有身分證可分辨時照舊：同名就沿用那一筆，不多建', async () => {
      const p = await makeParent('4');
      await addStudent(p.id, '王小明', null);
      await inTx((c) => parentSync.upsertLocalStudents(c, p.id, [{ name: '王小明', ragic_record_id: `R4${suffix}` }]));
      assert.deepEqual(await kids(p.id), [{ name: '王小明', id_number: null, ragic_record_id: `R4${suffix}` }]);
    });

    await t('S5 正式 Z01 同步：子表兩位同名不同身分證 → 兩位都建，不記 AMBIGUOUS', async () => {
      const lineUid = uid();
      const phone = `0975${suffix}`; made.phones.push(phone);
      const sourceId = `ZZSYNC5${suffix}`; made.sources.push(sourceId);
      const result = await syncFormal(z01Row(sourceId, phone, lineUid,
        [{ name: '鄭乙乙', id: 'F223456789' }, { name: '鄭乙乙', id: 'G123456789' }]));
      assert.deepEqual(result.studentIssues.filter((i) => i.code === 'AMBIGUOUS_STUDENT_MATCH'), []);
      assert.deepEqual((await kids(result.parent.id)).map((k) => k.id_number), ['F223456789', 'G123456789']);
    });

    await t('S6 正式 Z01 同步：子表兩位同名都沒身分證 → 照舊記 AMBIGUOUS、不建', async () => {
      const lineUid = uid();
      const phone = `0976${suffix}`; made.phones.push(phone);
      const sourceId = `ZZSYNC6${suffix}`; made.sources.push(sourceId);
      const result = await syncFormal(z01Row(sourceId, phone, lineUid, [{ name: '陳同名' }, { name: '陳同名' }]));
      assert.ok(result.studentIssues.some((i) => i.code === 'AMBIGUOUS_STUDENT_MATCH'));
      assert.deepEqual(await kids(result.parent.id), []);
    });

    await t('S7 outbox 送出新孩子後回填 Ragic 紀錄編號：同名時依身分證找對人', async () => {
      const lineUid = uid();
      const p = await makeParent('7', { lineUid });
      const older = await addStudent(p.id, '鄭乙乙', 'F223456789');
      const newer = await addStudent(p.id, '鄭乙乙', 'G123456789');
      const sourceId = `ZZSYNC7${suffix}`; made.sources.push(sourceId);
      const correlationId = crypto.randomUUID();
      const claim = (await pool.query(
        `INSERT INTO identity_claims
           (purpose,state,phone_canonical,student_name_normalized,canonical_parent_id,canonical_student_id,
            line_uid_hash,source_system,source_table,source_record_id,correlation_id,verified_at,linked_at)
         VALUES ('CLAIM_LEGACY','SYNC_PENDING',$1,'鄭乙乙',$2,$3,$4,'RAGIC','Z01',$5,$6,NOW(),NOW()) RETURNING *`,
        [p.phone, p.id, newer, crypto.createHash('sha256').update(lineUid).digest('hex'), sourceId, correlationId])).rows[0];
      const payload = { canonical_parent_id: p.id, profile_patch: {}, skip_uid_write: true, verify_readback: false,
        students_to_append: [{ name: '鄭乙乙', id_number: 'G123456789' }] };
      const job = (await pool.query(
        `INSERT INTO ragic_sync_outbox
           (idempotency_key,claim_id,operation,source_system,source_table,source_record_id,payload_reference,
            state,correlation_id,target_record_id,field_id,attempts)
         VALUES ($1,$2,'BIND_Z01_LINE_UID','RAGIC','Z01',$3,$4::jsonb,'processing',$5,$3,'1006846',1) RETURNING *`,
        [`bind-z01-line-uid:${sourceId}`, claim.id, sourceId, JSON.stringify(payload), correlationId])).rows[0];
      const out = await processClaimedRagicSyncOutboxJob(job, {
        writer: async () => { throw new Error('unexpected Ragic parent write'); },
        reader: async () => { throw new Error('unexpected Ragic read'); },
        studentWriter: async () => ({ z02: { ragicRecordId: `R7G${suffix}` } }),
      });
      assert.equal(out.outcome, 'synced', JSON.stringify(out));
      const rid = async (id) => (await pool.query(`SELECT ragic_record_id FROM students WHERE id=$1`, [id])).rows[0].ragic_record_id;
      assert.equal(await rid(newer), `R7G${suffix}`);
      assert.equal(await rid(older), null);
    });

    await t('S8 正式 Z01：兄弟姊妹身分證撞號 → 不改名，各自留在原本那位', async () => {
      const lineUid = uid();
      const phone = `0981${suffix}`; made.phones.push(phone);
      const sourceId = `ZZSYNC8${suffix}`; made.sources.push(sourceId);
      const first = await syncFormal(z01Row(sourceId, phone, lineUid, [{ name: '王小明', id: 'A123456789' }]));
      const ming = (await names(first.parent.id))[0].id;
      const hua = await addStudent(first.parent.id, '王小華', null, null, { synced: true });
      await syncFormal(z01Row(sourceId, phone, lineUid, [{ name: '王小明', id: 'A123456789' }, { name: '王小華', id: 'A123456789' }]));
      const rows = await names(first.parent.id);
      assert.deepEqual(rows.map((r) => [r.id, r.name]), [[ming, '王小明'], [hua, '王小華']]);
    });

    await t('S9 parentSync：兄弟姊妹身分證填反 → 不改名、不互換，也不整位家長失敗', async () => {
      const p = await makeParent('9');
      const ming = await addStudent(p.id, '王小明', 'A123456789', null, { synced: true });
      const hua = await addStudent(p.id, '王小華', 'B123456789', null, { synced: true });
      await inTx((c) => parentSync.upsertLocalStudents(c, p.id, [
        { name: '王小明', id_number: 'B123456789', ragic_record_id: `R9A${suffix}` },
        { name: '王小華', id_number: 'A123456789', ragic_record_id: `R9B${suffix}` },
      ]));
      const rows = await names(p.id);
      assert.deepEqual(rows.map((r) => [r.id, r.name, r.id_number]),
        [[ming, '王小明', 'A123456789'], [hua, '王小華', 'B123456789']]);
    });

    await t('S10 parentSync：同一個孩子先一筆沒身分證、再一筆有身分證 → 只有一位，補上身分證', async () => {
      const p = await makeParent('a');
      await addStudent(p.id, '王小明', null, null, { synced: true });
      await inTx((c) => parentSync.upsertLocalStudents(c, p.id, [
        { name: '王小明', ragic_record_id: `R10${suffix}` },
        { name: '王小明', id_number: 'A123456789' },
      ]));
      assert.deepEqual((await names(p.id)).map((r) => [r.name, r.id_number]), [['王小明', 'A123456789']]);
    });

    await t('S11 身分證在 Ragic 更正（舊號已不在 Ragic）→ 不多建，沿用原本那位', async () => {
      const p = await makeParent('b');
      const ming = await addStudent(p.id, '王小明', 'A123456780', null, { synced: true });
      await inTx((c) => parentSync.upsertLocalStudents(c, p.id, [{ name: '王小明', id_number: 'A123456789', ragic_record_id: `R11${suffix}` }]));
      assert.deepEqual((await names(p.id)).map((r) => r.id), [ming]);
      const lineUid = uid();
      const phone = `0982${suffix}`; made.phones.push(phone);
      const sourceId = `ZZSYNC11${suffix}`; made.sources.push(sourceId);
      const first = await syncFormal(z01Row(sourceId, phone, lineUid, [{ name: '王小美', id: 'C123456780' }]));
      await syncFormal(z01Row(sourceId, phone, lineUid, [{ name: '王小美', id: 'C123456789' }]));
      assert.equal((await names(first.parent.id)).length, 1);
    });

    await t('S12 正式 Z01：本地一位同名沒身分證、Ragic 兩位同名不同身分證 → 交人工，不配給任一位、不新建', async () => {
      const lineUid = uid();
      const phone = `0983${suffix}`; made.phones.push(phone);
      const sourceId = `ZZSYNC12${suffix}`; made.sources.push(sourceId);
      const first = await syncFormal(z01Row(sourceId, phone, lineUid, [{ name: '陳大寶' }]));
      const old = (await names(first.parent.id))[0];
      const result = await syncFormal(z01Row(sourceId, phone, lineUid,
        [{ name: '陳大寶', id: 'D123456789' }, { name: '陳大寶', id: 'D223456789' }]));
      assert.ok(result.studentIssues.some((i) => i.code === 'AMBIGUOUS_STUDENT_MATCH'), JSON.stringify(result.studentIssues));
      assert.deepEqual(await names(first.parent.id), [old]);
    });

    await t('S13 parentSync：本地兩位不同名但身分證相同、Ragic 換新紀錄編號 → 不整位失敗，各自對上', async () => {
      const p = await makeParent('c');
      await addStudent(p.id, '王小明', 'E123456789', `R13old1${suffix}`, { synced: true });
      await addStudent(p.id, '王小華', 'E123456789', `R13old2${suffix}`, { synced: true });
      await inTx((c) => parentSync.upsertLocalStudents(c, p.id, [
        { name: '王小明', id_number: 'E123456789', ragic_record_id: `R13new1${suffix}` },
        { name: '王小華', id_number: 'E123456789', ragic_record_id: `R13new2${suffix}` },
      ]));
      assert.deepEqual((await kids(p.id)).map((k) => [k.name, k.ragic_record_id]).sort(),
        [['王小明', `R13new1${suffix}`], ['王小華', `R13new2${suffix}`]].sort());
    });

    const tasks = async (parentId) => (await pool.query(
      `SELECT reason_code FROM parent_identity_backoffice_tasks WHERE canonical_parent_id=$1`, [parentId])).rows.map((r) => r.reason_code);

    await t('S14 同一個孩子在 Ragic 出現兩次（同名同身分證）→ 只有一位', async () => {
      const p = await makeParent('d');
      await addStudent(p.id, '王小明', 'A123456789', `R14a${suffix}`, { synced: true });
      await inTx((c) => parentSync.upsertLocalStudents(c, p.id, [
        { name: '王小明', id_number: 'A123456789', ragic_record_id: `R14a${suffix}` },
        { name: '王小明', id_number: 'A123456789', ragic_record_id: `R14b${suffix}` },
      ]));
      assert.equal((await names(p.id)).length, 1);
      const q = await makeParent('e');
      await inTx((c) => parentSync.upsertLocalStudents(c, q.id, [
        { name: '王小明', id_number: 'A123456789' }, { name: '王小明', id_number: 'A123456789' },
      ]));
      assert.equal((await names(q.id)).length, 1);
    });

    await t('S15 parentSync 對不出是哪一位而略過時，開一張人工整理單；重跑不會多開', async () => {
      const p = await makeParent('f');
      await addStudent(p.id, '陳同名', null, null, { synced: true });
      await addStudent(p.id, '陳同名', null, null, { synced: true });
      for (let i = 0; i < 2; i += 1) {
        await inTx((c) => parentSync.upsertLocalStudents(c, p.id, [{ name: '陳同名', id_number: 'D123456789' }]));
      }
      assert.equal((await names(p.id)).length, 2);
      assert.deepEqual(await tasks(p.id), ['STUDENT_MATCH_AMBIGUOUS']);
    });

    await t('S16 舊孩子沒身分證＋新註冊的同名孩子有身分證、Ragic 兩位都在 → 各自對上、不開整理單', async () => {
      for (const [tag, order] of [['g', ['F223456789', 'G123456789']], ['h', ['G123456789', 'F223456789']]]) {
        const p = await makeParent(tag);
        const old = await addStudent(p.id, '鄭乙乙', null, null, { synced: true });
        const fresh = await addStudent(p.id, '鄭乙乙', 'G123456789', null, { synced: true });
        await inTx((c) => parentSync.upsertLocalStudents(c, p.id, order.map((id) => ({ name: '鄭乙乙', id_number: id }))));
        const rows = await names(p.id);
        assert.deepEqual(rows.map((r) => [r.id, r.id_number]), [[old, 'F223456789'], [fresh, 'G123456789']]);
        assert.deepEqual(await tasks(p.id), []);
      }
    });

    await t('S17 同名兄弟姊妹、Ragic 把第二位的身分證打成第一位的 → 第一位不被蓋掉，開整理單', async () => {
      const p = await makeParent('i');
      const x = (await pool.query(
        `INSERT INTO students (parent_id,name,id_number,birth_date,gender,is_active,last_synced_at)
         VALUES ($1,'鄭乙乙','F223456789','2012-01-01','男',TRUE,NOW()) RETURNING id`, [p.id])).rows[0].id;
      await pool.query(
        `INSERT INTO students (parent_id,name,id_number,birth_date,gender,is_active,last_synced_at)
         VALUES ($1,'鄭乙乙','G123456789','2015-06-06','女',TRUE,NOW())`, [p.id]);
      await inTx((c) => parentSync.upsertLocalStudents(c, p.id, [
        { name: '鄭乙乙', id_number: 'F223456789', birth_date: '2012-01-01', gender: '男' },
        { name: '鄭乙乙', id_number: 'F223456789', birth_date: '2015-06-06', gender: '女' },
      ]));
      const row = (await pool.query(`SELECT to_char(birth_date,'YYYY-MM-DD') AS b, gender FROM students WHERE id=$1`, [x])).rows[0];
      assert.deepEqual(row, { b: '2012-01-01', gender: ragic.normalizeGender('男') }, JSON.stringify(row));
      assert.deepEqual(await tasks(p.id), ['STUDENT_MATCH_AMBIGUOUS']);
    });

    console.log(`\n${passed} 個測試全數通過`);
  } finally {
    try { await cleanup(); } catch (e) { console.error('清除失敗：' + e.message); process.exitCode = 1; }
    await pool.end();
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
