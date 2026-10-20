'use strict';
// 櫃台在 Z03 卡片按儲存 → saveZ03RecordDraft → _upgradeZ03RecordToZ01 寫回 Ragic。
// ragic_z03_students 裡 present_in_latest_payload = FALSE 的列是舊匯入留下、Ragic 已經沒有的學員，
// 寫回時只能處理 Ragic 還在的學員：
//   U1 櫃台改了現存學員的生日，同編號的舊列排在後面 → 不可把舊生日寫回去蓋掉
//   U2 舊列和現存學員共用編號、但姓名是舊的 → 不可把舊姓名寫進 Z01 子表，儲存也不能失敗
//   U3 舊列的編號在 Ragic 已不存在 → 不可去新增學員，儲存也不能失敗
//   U4 舊列沒有編號也沒有身分證 → 不能因此擋住升級
//   U6 學員全是舊列 → 提示缺學員、不寫 Ragic
//   U5 本地舊列都還在（儲存不刪資料）
//   每一案也核對回傳的 skipped_removed_students（略過的舊列，位置同後台編輯表格）
//   U7 缺欄提示的「第 N 位」照編輯表格的順序算（舊列也佔位）
//   U8 項次相同的學員列，清單順序以 id 決定（不隨資料列實體位置變動）
// Ragic 讀寫全部 stub：讀取依網址回假資料、寫入只記錄；任何沒預期到的網址直接丟錯。
// 姓名、電話、身分證都是虛構值；所有資料 finally 自己刪乾淨。
process.env.RAGIC_BASE_URL = 'http://127.0.0.1:9';
process.env.RAGIC_API_KEY = 'fake-key-for-test';
process.env.RAGIC_FORM_Z01 = '/zztest/z01/1';
process.env.RAGIC_FORM_Z02 = '/zztest/z02/2';

const assert = require('node:assert/strict');
const axios = require('../server/node_modules/axios');

const ragicState = { z01: new Map(), z02: new Map() };
const writes = [];

function fakeGet(rawUrl, options = {}) {
  const path = String(rawUrl).split('?')[0];
  const params = options.params || {};
  const z01Prefix = `${process.env.RAGIC_FORM_Z01}/`;
  if (path.startsWith(z01Prefix)) {
    const record = ragicState.z01.get(path.slice(z01Prefix.length));
    return Promise.resolve({ data: record ? { ...record } : {} });
  }
  if (path === process.env.RAGIC_FORM_Z02 && typeof params.where === 'string') {
    const [fieldId, op, value] = params.where.split(',');
    assert.equal(op, 'eq');
    const data = {};
    for (const [id, record] of ragicState.z02) {
      if (String(record[fieldId] || '') === value) data[id] = { ...record };
    }
    return Promise.resolve({ data });
  }
  return Promise.reject(new Error(`unexpected Ragic GET ${rawUrl}`));
}

const realCreate = axios.create.bind(axios);
axios.create = (config = {}) => {
  const instance = realCreate({ ...config, baseURL: 'http://127.0.0.1:9' });
  instance.get = fakeGet;
  for (const method of ['post', 'put', 'patch', 'delete', 'request']) {
    instance[method] = () => Promise.reject(new Error(`unexpected Ragic ${method}`));
  }
  return instance;
};

const ragicWriter = require('../server/services/ragicWriter');
ragicWriter.postFormPath = async (formPath, fields) => {
  writes.push({ formPath: String(formPath), fields: { ...fields } });
  return { status: 'SUCCESS' };
};

const { pool } = require('../server/models/db');
const ragic = require('../server/services/ragic');
const ragicAdmin = require('../server/services/ragicAdmin');
const { formatRagicDate } = require('../server/utils/dateTime');

const dbUrl = new URL(process.env.DATABASE_URL);
assert.ok(['localhost', '127.0.0.1'].includes(dbUrl.hostname), '必須是 loopback 的拋棄式測試庫');
assert.match(dbUrl.pathname, /^\/daos_(test|audit)/, '必須是 daos_test / daos_audit');

const SOURCE_PREFIX = 'ZZTEST-Z03-UPG-';
const S = ragic.FIELD.Z01_STUDENT;
const Z02 = ragic.FIELD.Z02;
let passed = 0;
const t = async (name, fn) => { writes.length = 0; await fn(); passed += 1; console.log('PASS ' + name); };

async function cleanup() {
  await pool.query(`DELETE FROM ragic_z03_records WHERE z01_ragic_record_id LIKE $1`, [`${SOURCE_PREFIX}%`]);
  await pool.query(`DELETE FROM ragic_z03_deleted_student_tombstones WHERE z01_ragic_record_id LIKE $1`, [`${SOURCE_PREFIX}%`]);
}

// ragicStudents：Ragic 現況（Z01 子表＋Z02 主檔）；localStudents：本地 Z03 列，依插入順序得到 id。
async function family(tag, { phone, ragicStudents, localStudents }) {
  const sourceId = `${SOURCE_PREFIX}${tag}`;
  const subtable = {};
  ragicStudents.forEach((s, index) => {
    subtable[String(index + 1)] = {
      [S.NAME]: s.name, [S.STUDENT_CODE]: s.code, [S.ID_NUMBER]: s.id_number,
      [S.BIRTH_DATE]: formatRagicDate(s.birth_date),
    };
    ragicState.z02.set(`${tag}-${index + 1}`, {
      _ragicId: `${tag}-${index + 1}`,
      [Z02.NAME]: s.name, [Z02.STUDENT_CODE]: s.code, [Z02.ID_NUMBER]: s.id_number,
      [Z02.PARENT_PHONE]: phone,
    });
  });
  ragicState.z01.set(sourceId, {
    _ragicId: sourceId, [ragic.FIELD.Z01.PHONE]: phone, _subtable_1001119: subtable,
  });

  const record = (await pool.query(
    `INSERT INTO ragic_z03_records
       (z01_ragic_record_id, raw_name, phone, identity_raw, gender_raw, email_raw, venue_raw,
        status, classification, reason_code)
     VALUES ($1,'測試家長',$2,'一般身分','女','zztest@example.invalid','ZZ館',
        'pending','PENDING_Z03','TRUE_LINE_UID_EMPTY')
     RETURNING id`,
    [sourceId, phone]
  )).rows[0];
  const ids = [];
  for (const s of localStudents) {
    ids.push((await pool.query(
      `INSERT INTO ragic_z03_students
         (z03_record_id, seq_raw, name_raw, birth_date_raw, gender_raw, id_number_raw,
          student_code_raw, source_row_key, classification, present_in_latest_payload)
       VALUES ($1,$2,$3,$4,'男',$5,$6,$7,'VALID',$8)
       RETURNING id`,
      [record.id, s.seq, s.name, s.birth_date || null, s.id_number || null, s.code || null,
        s.present ? s.source_row_key : null, s.present]
    )).rows[0].id);
  }
  return { id: record.id, sourceId, ids };
}

// 照前端編輯模式送：每一列都帶回去（前端 cleanStudentRows 不分舊列、現存列）。
function draftStudents(rows, ids, overrides = {}) {
  return rows.map((s, index) => ({
    id: ids[index], seq_raw: s.seq, name_raw: s.name, birth_date_raw: s.birth_date || '',
    gender_raw: '男', id_number_raw: s.id_number || '', student_code_raw: s.code || '',
    ...(overrides[index] || {}),
  }));
}

const z01Writes = (sourceId) => writes.filter((w) => w.formPath === `${process.env.RAGIC_FORM_Z01}/${sourceId}`);
const z02Writes = () => writes.filter((w) => w.formPath.startsWith(`${process.env.RAGIC_FORM_Z02}`));
const studentNameWrites = (name) => writes.filter((w) => Object.entries(w.fields).some(
  ([k, v]) => (k.startsWith(`${S.NAME}_`) || k === String(Z02.NAME)) && v === name
));
const assertNoCreate = () => {
  for (const w of writes) {
    assert.notEqual(w.formPath, process.env.RAGIC_FORM_Z01, '不可新增 Z01 家長');
    assert.notEqual(w.formPath, process.env.RAGIC_FORM_Z02, '不可新增 Z02 學員');
  }
};
async function statusOf(id) {
  return (await pool.query(`SELECT status FROM ragic_z03_records WHERE id=$1`, [id])).rows[0].status;
}

async function main() {
  await t('U1 改了現存學員的生日，同編號的舊列不會把舊生日寫回去', async () => {
    const phone = '0990000101';
    const ragicStudents = [{ name: '測試甲', code: 'ZZ-U1', id_number: 'Z900000101', birth_date: '2018-01-01' }];
    const rows = [
      { seq: '1', name: '測試甲', code: 'ZZ-U1', id_number: 'Z900000101', birth_date: '2018-01-01', present: true, source_row_key: '1:0' },
      { seq: '2', name: '測試甲', code: 'ZZ-U1', id_number: 'Z900000101', birth_date: '2018-01-01', present: false },
    ];
    const f = await family('U1', { phone, ragicStudents, localStudents: rows });
    const result = await ragicAdmin.saveZ03RecordDraft(f.id, {
      record: {}, students: draftStudents(rows, f.ids, { 0: { birth_date_raw: '2018-02-02' } }),
    }, 'test-admin');
    assert.equal(result.synced_to_ragic, true);
    assert.deepEqual(result.skipped_removed_students, [{ id: f.ids[1], name: '測試甲', position: 2 }]);
    const newBirth = formatRagicDate('2018-02-02');
    const subtableBirths = z01Writes(f.sourceId).map((w) => w.fields[`${S.BIRTH_DATE}_1`]).filter(Boolean);
    assert.deepEqual(subtableBirths, [newBirth], 'Z01 子表只寫一次、而且是新生日');
    assert.deepEqual(z02Writes().map((w) => w.fields[Z02.BIRTH_DATE]), [newBirth], 'Z02 只寫一次、而且是新生日');
    assertNoCreate();
    assert.equal(await statusOf(f.id), 'resolved');
  });

  await t('U2 舊列和現存學員共用編號但姓名是舊的：不寫舊姓名，儲存成功', async () => {
    const phone = '0990000102';
    const ragicStudents = [{ name: '測試乙', code: 'ZZ-U2', id_number: 'Z900000102', birth_date: '2017-05-05' }];
    const rows = [
      { seq: '1', name: '測試已', code: 'ZZ-U2', id_number: 'Z900000102', birth_date: '2017-05-05', present: false },
      { seq: '1', name: '測試乙', code: 'ZZ-U2', id_number: 'Z900000102', birth_date: '2017-05-05', present: true, source_row_key: '1:0' },
    ];
    const f = await family('U2', { phone, ragicStudents, localStudents: rows });
    const result = await ragicAdmin.saveZ03RecordDraft(f.id, {
      record: {}, students: draftStudents(rows, f.ids),
    }, 'test-admin');
    assert.equal(result.synced_to_ragic, true);
    assert.deepEqual(result.skipped_removed_students, [{ id: f.ids[0], name: '測試已', position: 1 }]);
    assert.equal(studentNameWrites('測試已').length, 0, '舊姓名不可寫進 Ragic');
    assert.equal(studentNameWrites('測試乙').length, 2, '現存學員照常寫 Z01 子表與 Z02');
    assertNoCreate();
    assert.equal(await statusOf(f.id), 'resolved');
  });

  await t('U3 舊列的編號在 Ragic 已不存在：不新增學員，儲存成功', async () => {
    const phone = '0990000103';
    const ragicStudents = [{ name: '測試丙', code: 'ZZ-U3', id_number: 'Z900000103', birth_date: '2016-03-03' }];
    const rows = [
      { seq: '1', name: '測試丙', code: 'ZZ-U3', id_number: 'Z900000103', birth_date: '2016-03-03', present: true, source_row_key: '1:0' },
      { seq: '2', name: '測試丁', code: 'ZZ-U3-OLD', id_number: 'Z900000193', birth_date: '2015-04-04', present: false },
    ];
    const f = await family('U3', { phone, ragicStudents, localStudents: rows });
    const result = await ragicAdmin.saveZ03RecordDraft(f.id, {
      record: {}, students: draftStudents(rows, f.ids),
    }, 'test-admin');
    assert.equal(result.synced_to_ragic, true);
    assert.deepEqual(result.skipped_removed_students, [{ id: f.ids[1], name: '測試丁', position: 2 }]);
    assert.equal(studentNameWrites('測試丁').length, 0, 'Ragic 已移除的學員不寫回');
    assertNoCreate();
    assert.equal(await statusOf(f.id), 'resolved');
  });

  await t('U4 舊列沒有編號也沒有身分證，不擋升級', async () => {
    const phone = '0990000104';
    const ragicStudents = [{ name: '測試戊', code: 'ZZ-U4', id_number: 'Z900000104', birth_date: '2019-06-06' }];
    const rows = [
      { seq: '1', name: '測試戊', code: 'ZZ-U4', id_number: 'Z900000104', birth_date: '2019-06-06', present: true, source_row_key: '1:0' },
      { seq: '2', name: '測試己', present: false },
    ];
    const f = await family('U4', { phone, ragicStudents, localStudents: rows });
    const result = await ragicAdmin.saveZ03RecordDraft(f.id, {
      record: {}, students: draftStudents(rows, f.ids),
    }, 'test-admin');
    assert.deepEqual(result.missing, []);
    assert.equal(result.synced_to_ragic, true);
    assert.deepEqual(result.skipped_removed_students, [{ id: f.ids[1], name: '測試己', position: 2 }]);
    assert.equal(studentNameWrites('測試己').length, 0);
    assert.equal(await statusOf(f.id), 'resolved');
  });

  await t('U6 學員全是舊列的家庭：提示缺學員、不寫 Ragic', async () => {
    const phone = '0990000106';
    const rows = [
      { seq: '1', name: '測試庚', code: 'ZZ-U6', id_number: 'Z900000106', birth_date: '2014-07-07', present: false },
    ];
    const f = await family('U6', { phone, ragicStudents: [], localStudents: rows });
    const result = await ragicAdmin.saveZ03RecordDraft(f.id, {
      record: {}, students: draftStudents(rows, f.ids),
    }, 'test-admin');
    assert.deepEqual(result.missing.map((m) => m.key), ['students']);
    assert.match(result.missing[0].label, /Ragic 現存學員/);
    assert.deepEqual(result.skipped_removed_students, [{ id: f.ids[0], name: '測試庚', position: 1 }]);
    assert.equal(writes.length, 0, '不寫 Ragic');
    assert.equal(await statusOf(f.id), 'pending');
  });

  await t('U5 儲存不會刪掉舊列（本地資料原樣保留）', async () => {
    const n = (await pool.query(
      `SELECT COUNT(*)::int n FROM ragic_z03_students s JOIN ragic_z03_records r ON r.id = s.z03_record_id
        WHERE r.z01_ragic_record_id LIKE $1 AND s.present_in_latest_payload = FALSE`,
      [`${SOURCE_PREFIX}%`]
    )).rows[0].n;
    assert.equal(n, 5);
  });

  await t('U7 缺欄提示的「第 N 位」對得上編輯表格（舊列排在前面也佔位）', async () => {
    const phone = '0990000107';
    const ragicStudents = [{ name: '測試壬', code: '', id_number: '', birth_date: '2013-08-08' }];
    const rows = [
      { seq: '1', name: '測試辛', code: 'ZZ-U7-OLD', id_number: 'Z900000197', birth_date: '2012-09-09', present: false },
      { seq: '2', name: '測試壬', birth_date: '2013-08-08', present: true, source_row_key: '1:0' },
    ];
    const f = await family('U7', { phone, ragicStudents, localStudents: rows });
    const result = await ragicAdmin.saveZ03RecordDraft(f.id, {
      record: {}, students: draftStudents(rows, f.ids),
    }, 'test-admin');
    assert.deepEqual(result.missing, [
      { key: 'students.1.student_code', label: '第 2 位學員「測試壬」的學員編號或身分證字號' },
    ]);
    assert.deepEqual(result.skipped_removed_students, [{ id: f.ids[0], name: '測試辛', position: 1 }]);
    assert.equal(writes.length, 0, '缺欄不寫 Ragic');
    assert.equal(await statusOf(f.id), 'pending');
  });

  await t('U8 項次相同的學員列，清單順序以 id 決定', async () => {
    const f = await family('U8', { phone: '0990000108', ragicStudents: [], localStudents: [] });
    // 先插 id 較大的列：只靠 seq_raw 排序時，同項次的兩列會照插入順序回來（id 大的在前）。
    const [small, large] = (await pool.query(
      `SELECT nextval(pg_get_serial_sequence('ragic_z03_students','id'))::text AS id FROM generate_series(1,2)`
    )).rows.map((r) => r.id);
    for (const [sid, name] of [[large, '測試子'], [small, '測試癸']]) {
      await pool.query(
        `INSERT INTO ragic_z03_students (id, z03_record_id, seq_raw, name_raw, classification, present_in_latest_payload)
         VALUES ($1,$2,'1',$3,'VALID',TRUE)`,
        [sid, f.id, name]
      );
    }
    const [item] = await ragicAdmin.listZ03Records({ status: 'all', q: f.sourceId });
    assert.deepEqual(item.students.map((s) => s.id), [small, large]);
  });
}

(async () => {
  await cleanup();
  try {
    await main();
    console.log(`z03_upgrade_skips_removed_students_db_test: ${passed} PASS`);
  } finally {
    await cleanup();
    await pool.end();
  }
})().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
