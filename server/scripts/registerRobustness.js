/**
 * 註冊各環節的健壯性稽核：任何人在任何欄位亂填，都不可以把系統打掛。
 *
 *   ALLOW_DEMO_LOGIN=1 PORT=3001 node server/index.js &
 *   node server/scripts/registerRobustness.js
 *
 * 只在 dev 跑。會建立並刪除測試家長，不動任何真實家庭的資料。
 *
 * 判準（三條，缺一不可）：
 *   1. 絕不 5xx —— 使用者填錯是常態，那是 4xx；5xx 表示我們沒接住
 *   2. 回應一定是 JSON 而且帶 code —— 前端靠 code 顯示訊息，
 *      吐 HTML 錯誤頁的話畫面就是一片空白或「資料載入失敗」
 *   3. 全部灌完伺服器還活著 —— 一個沒接住的例外會讓整台掛掉，
 *      那不只是這位家長註冊失敗，是所有人一起失敗
 */
const path = require('path');
const { signFlowToken } = require('../middlewares/flowAuth');
const { pool } = require('../models/db');

const BASE = process.env.ROBUST_BASE || 'http://localhost:3001';
const RUN   = process.env.ROBUST_RUN || String(Date.now());
const PHONE = '0900000188';

let pass = 0, fail = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) { pass++; }
  else { fail++; failures.push(label + (detail ? '  → ' + detail : '')); }
}
const uid = (tag) => 'DEMOTEST_ROBUST_' + RUN + '_' + tag;

async function post(path_, body, token, raw) {
  const r = await fetch(BASE + path_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: raw !== undefined ? raw : JSON.stringify(body || {}),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

/** 一次請求要同時滿足三條判準才算過。 */
function 檢查回應(標籤, res) {
  ok(標籤 + '：沒有 5xx', res.status < 500,
     'HTTP ' + res.status + ' ' + String(res.text).slice(0, 120));
  ok(標籤 + '：回得出 JSON', res.json !== null,
     '回的是 ' + String(res.text).slice(0, 100));
  if (res.status >= 400) {
    ok(標籤 + '：錯誤帶得出 code', !!(res.json && res.json.code),
       JSON.stringify(res.json).slice(0, 120));
  }
  ok(標籤 + '：沒有把堆疊吐給使用者',
     !/at\s+\w+.*\(.*:\d+:\d+\)|node_modules|Error:\s+\w+Error/.test(String(res.text)),
     String(res.text).slice(0, 150));
}

// ── 壞值集合：每一個都是真的有人會填、或真的有人會送的東西 ──────────────
const 壞字串 = [
  '', '   ', null, undefined, 0, 123, true, [], {}, { a: 1 },
  'a'.repeat(10000),                       // 超長貼上
  '　　全形空白　　',
  '👨‍👩‍👧‍👦😀',                              // emoji 名字
  '<script>alert(1)</script>',
  "'; DROP TABLE parents; --",
  '__proto__',
  '\u0000\u0001控制字元',
  'O’Brien-王',                        // 撇號與連字號
];
const 壞電話 = [
  '', '   ', null, 912345678, '0912-345-678', '+886912345678', '09123456789',
  '091234567', '0812345678', '０９１２３４５６７８',                 // 全形
  'abcdefghij', '09 1234 5678', '0912345678 ', ' 0912345678',
  'a'.repeat(500),
];
const 壞日期 = [
  '', null, '2019-10', '2019', '2019-13-01', '2019-02-30', '0000-00-00',
  '9999-99-99', '2019/10/05', '05-10-2019', '2019-10-05T00:00:00Z',
  '2020-02-29',            // 閏日，這個是合法的
  '2119-01-01',            // 未來
  '1900-01-01',            // 很久以前
  123456789, [], {},
];
const 壞身分證 = [
  '', null, 'A12345678', 'A1234567890', 'a123456789', 'Ａ１２３４５６７８９',
  '1234567890', 'A12345678X', ' A123456789 ', 'A123456789\n', 123456789,
];
const 壞性別 = ['', null, '男生', 'M', 0, [], {}, 'a'.repeat(300)];
const 壞血型 = ['', null, 'o', 'A型', 'AB+', 'Z', 0, [], 'a'.repeat(300)];
const 壞Email = [
  '', '   ', null, 'abc', 'a@b', '@b.com', 'a@.com', 'a b@c.com',
  'a@b.com '.repeat(200), 123, [], {},
];

const 好家長 = (venueId) => ({
  name: '健壯性測試家長', phone: PHONE, email: 'robust@example.test',
  gender: '女', primary_venue_id: venueId,
});
const 好學員 = {
  name: '健壯性測試學員', id_number: 'A123456789',
  birth_date: '2019-10-05', gender: '男', blood_type: 'O',
};

async function cleanup() {
  const pids = (await pool.query(
    "SELECT id FROM parents WHERE phone=$1 OR line_uid LIKE 'DEMOTEST\\_ROBUST\\_%'", [PHONE]
  )).rows.map(r => r.id);
  const cq = 'SELECT id FROM identity_claims WHERE phone_canonical=$1'
           + (pids.length ? ' OR canonical_parent_id=ANY($2::uuid[])' : '');
  const cids = (await pool.query(cq, pids.length ? [PHONE, pids] : [PHONE])).rows.map(r => r.id);
  if (cids.length) {
    await pool.query('DELETE FROM ragic_sync_outbox WHERE claim_id=ANY($1::uuid[])', [cids]);
    await pool.query('DELETE FROM parent_identity_requests WHERE claim_id=ANY($1::uuid[])', [cids]);
  }
  if (pids.length) {
    const sids = (await pool.query('SELECT id FROM students WHERE parent_id=ANY($1::uuid[])', [pids]))
                   .rows.map(r => r.id);
    for (const tbl of ['students', 'parents']) {
      const q = `SELECT tc.table_name AS child, kcu.column_name AS col
                   FROM information_schema.table_constraints tc
                   JOIN information_schema.key_column_usage kcu ON kcu.constraint_name=tc.constraint_name
                   JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name=tc.constraint_name
                  WHERE tc.constraint_type='FOREIGN KEY' AND ccu.table_name=$1 AND ccu.column_name='id'`;
      const ids = tbl === 'students' ? sids : pids;
      if (!ids.length) continue;
      for (const c of (await pool.query(q, [tbl])).rows) {
        if (c.child === 'students' && tbl === 'parents') continue;
        await pool.query(`DELETE FROM "${c.child}" WHERE "${c.col}"=ANY($1::uuid[])`, [ids]).catch(() => {});
      }
    }
  }
  if (cids.length) await pool.query('DELETE FROM identity_claims WHERE id=ANY($1::uuid[])', [cids]);
  if (pids.length) {
    await pool.query('DELETE FROM students WHERE parent_id=ANY($1::uuid[])', [pids]);
    await pool.query('DELETE FROM parents WHERE id=ANY($1::uuid[])', [pids]);
  }
  return pids.length;
}

(async () => {
  console.log('清掉殘留：' + (await cleanup()) + ' 筆');
  const venue = (await pool.query('SELECT id,name FROM venues WHERE is_active ORDER BY id LIMIT 1')).rows[0];

  // ══ A. 每個環節走一遍 ════════════════════════════════════════════════
  console.log('\n══ A. 每個環節 ══');

  console.log('  A1 全新電話 → 註冊分支');
  const a1 = await post('/api/auth/verify-phone', { phone: PHONE }, signFlowToken({ lineUid: uid('a1') }));
  檢查回應('A1 verify-phone', a1);
  ok('A1 全新電話走註冊分支', a1.json?.status === 'not_found', JSON.stringify(a1.json));

  console.log('  A2 既有電話 → 學員姓名驗證分支（只讀，不完成綁定）');
  const existing = (await pool.query(
    `SELECT phone FROM parents WHERE is_active AND ragic_record_id IS NOT NULL
       AND phone ~ '^09[0-9]{8}$' ORDER BY id LIMIT 1`)).rows[0];
  if (existing) {
    const a2 = await post('/api/auth/verify-phone', { phone: existing.phone },
                          signFlowToken({ lineUid: uid('a2') }));
    檢查回應('A2 verify-phone', a2);
    ok('A2 既有電話不會被當成新戶', a2.json?.status !== 'not_found',
       JSON.stringify(a2.json));
    // 姓名填錯必須乾淨拒絕，不可以炸
    const a2b = await post('/api/auth/verify-student',
      { claim: { student_name: '絕對不存在的名字', phone: existing.phone } },
      signFlowToken({ lineUid: uid('a2'), phone: existing.phone }));
    檢查回應('A2 verify-student 姓名錯', a2b);
  } else {
    console.log('     （dev 上沒有可用的既有樣本，略過）');
  }

  console.log('  A3 新戶完成註冊');
  const a3 = await post('/api/auth/register',
    { parent: 好家長(venue.id), students: [好學員] }, signFlowToken({ lineUid: uid('a3') }));
  檢查回應('A3 register', a3);
  ok('A3 註冊成功', a3.status === 200 && !!a3.json?.token,
     a3.status + ' ' + JSON.stringify(a3.json).slice(0, 200));
  const token = a3.json?.token;

  console.log('  A4 同一支 LINE 再送一次（中途跳掉重來）');
  const a4 = await post('/api/auth/register',
    { parent: 好家長(venue.id), students: [好學員] }, signFlowToken({ lineUid: uid('a3') }));
  檢查回應('A4 重送', a4);
  ok('A4 重送不會建出第二筆', a4.status === 200, a4.status + '');

  console.log('  A5 多位學員一次註冊');
  await cleanup();
  const a5 = await post('/api/auth/register', {
    parent: 好家長(venue.id),
    students: [好學員,
               { ...好學員, name: '健壯性測試學員2', id_number: 'B123456789' },
               { ...好學員, name: '健壯性測試學員3', id_number: 'C123456789' }],
  }, signFlowToken({ lineUid: uid('a5') }));
  檢查回應('A5 三位學員', a5);
  ok('A5 三位學員都建起來',
     a5.status === 200 && (a5.json?.parent?.students || []).length === 3,
     a5.status + ' 學員數=' + (a5.json?.parent?.students || []).length);

  // ══ B. 灌壞值 ═══════════════════════════════════════════════════════
  console.log('\n══ B. 每個欄位灌壞值（重點：不可以 5xx、不可以吐堆疊）══');
  let n = 0;
  const 收下的怪值 = [];
  const 灌 = async (欄位, 值, 造請求) => {
    await cleanup();
    n++;
    const 標籤 = 'B ' + 欄位 + '=' + String(JSON.stringify(值)).slice(0, 40);
    const res = await post('/api/auth/register', 造請求(值), signFlowToken({ lineUid: uid('b' + n) }));
    檢查回應(標籤, res);
    // 硬性要求只有一條：必填欄位留空、或送進非字串的容器，一定要擋下。
    // 其餘「怪但存得下去」的值（emoji 姓名、性別填『男生』、未來的生日…）
    // 不強制擋 —— 那是資料品質問題，跟「會不會當機」是兩件事，混在一起看
    // 只會讓真正的當機被淹沒。它們另外列出來，讓人決定要不要收緊。
    const 必擋 = 值 === '' || 值 === null || 值 === undefined
              || (typeof 值 === 'string' && !值.trim()) || Array.isArray(值);
    if (必擋) ok(標籤 + ' 必須被擋下', res.status !== 200, 'HTTP ' + res.status);
    else if (res.status === 200) 收下的怪值.push(欄位 + ' = ' + String(JSON.stringify(值)).slice(0, 60));
  };

  for (const v of 壞字串) await 灌('家長姓名', v, (x) =>
    ({ parent: { ...好家長(venue.id), name: x }, students: [好學員] }));
  for (const v of 壞電話) await 灌('家長電話', v, (x) =>
    ({ parent: { ...好家長(venue.id), phone: x }, students: [好學員] }));
  for (const v of 壞Email) await 灌('Email', v, (x) =>
    ({ parent: { ...好家長(venue.id), email: x }, students: [好學員] }));
  for (const v of 壞性別) await 灌('家長性別', v, (x) =>
    ({ parent: { ...好家長(venue.id), gender: x }, students: [好學員] }));
  for (const v of [...壞字串, 'NO_SUCH_VENUE']) await 灌('館別', v, (x) =>
    ({ parent: { ...好家長(venue.id), primary_venue_id: x }, students: [好學員] }));
  for (const v of 壞字串) await 灌('學員姓名', v, (x) =>
    ({ parent: 好家長(venue.id), students: [{ ...好學員, name: x }] }));
  for (const v of 壞身分證) await 灌('學員身分證', v, (x) =>
    ({ parent: 好家長(venue.id), students: [{ ...好學員, id_number: x }] }));
  for (const v of 壞日期) await 灌('學員生日', v, (x) =>
    ({ parent: 好家長(venue.id), students: [{ ...好學員, birth_date: x }] }));
  for (const v of 壞性別) await 灌('學員性別', v, (x) =>
    ({ parent: 好家長(venue.id), students: [{ ...好學員, gender: x }] }));
  for (const v of 壞血型) await 灌('學員血型', v, (x) =>
    ({ parent: 好家長(venue.id), students: [{ ...好學員, blood_type: x }] }));

  console.log('  B+ 整包結構壞掉');
  for (const [標籤, body] of [
    ['沒有 parent',      { students: [好學員] }],
    ['parent 是字串',    { parent: 'abc', students: [好學員] }],
    ['parent 是陣列',    { parent: [], students: [好學員] }],
    ['沒有 students',    { parent: 好家長(venue.id) }],
    ['students 是物件',  { parent: 好家長(venue.id), students: {} }],
    ['students 空陣列',  { parent: 好家長(venue.id), students: [] }],
    ['students 裡是 null', { parent: 好家長(venue.id), students: [null] }],
    ['students 裡是字串', { parent: 好家長(venue.id), students: ['abc'] }],
    ['students 300 筆',  { parent: 好家長(venue.id), students: Array(300).fill(好學員) }],
    ['整包是陣列',       []],
    ['整包是 null',      null],
  ]) {
    await cleanup(); n++;
    const res = await post('/api/auth/register', body, signFlowToken({ lineUid: uid('c' + n) }));
    檢查回應('B+ ' + 標籤, res);
  }

  console.log('  B+ 根本不是 JSON');
  for (const [標籤, raw] of [
    ['壞掉的 JSON', '{"parent": '],
    ['純文字',      'hello'],
    ['空 body',     ''],
  ]) {
    n++;
    const res = await post('/api/auth/register', null, signFlowToken({ lineUid: uid('d' + n) }), raw);
    檢查回應('B+ ' + 標籤, res);
  }

  console.log('  B+ verify-phone 的電話欄位');
  for (const v of 壞電話) {
    const res = await post('/api/auth/verify-phone', { phone: v }, signFlowToken({ lineUid: uid('e' + (n++)) }));
    檢查回應('B+ verify-phone=' + String(JSON.stringify(v)).slice(0, 30), res);
  }

  console.log('  B+ verify-student 的 claim');
  for (const v of [null, 'abc', [], { student_name: '' }, { student_name: 'a'.repeat(9000) }]) {
    const res = await post('/api/auth/verify-student', { claim: v },
                           signFlowToken({ lineUid: uid('f' + (n++)), phone: PHONE }));
    檢查回應('B+ verify-student claim=' + String(JSON.stringify(v)).slice(0, 30), res);
  }

  console.log('  B+ token 本身壞掉');
  for (const [標籤, tk] of [
    ['沒有 token', undefined], ['亂寫', 'abc.def.ghi'],
    ['別人的 token', token], ['空字串', ''],
  ]) {
    const res = await post('/api/auth/register', { parent: 好家長(venue.id), students: [好學員] }, tk);
    檢查回應('B+ token ' + 標籤, res);
    ok('B+ token ' + 標籤 + ' 不會放行', res.status !== 200 || 標籤 === '別人的 token',
       'HTTP ' + res.status);
  }

  // ══ C. 跑完伺服器還活著 ══════════════════════════════════════════════
  console.log('\n══ C. 灌完之後伺服器還活著嗎 ══');
  const h = await fetch(BASE + '/health').then(r => r.status).catch(() => 0);
  ok('C 伺服器沒有被打掛', h === 200, 'health=' + h);
  const stillWorks = await post('/api/auth/register',
    { parent: 好家長(venue.id), students: [好學員] }, signFlowToken({ lineUid: uid('z') }));
  ok('C 灌完之後正常註冊仍然可用', stillWorks.status === 200,
     'HTTP ' + stillWorks.status + ' ' + JSON.stringify(stillWorks.json).slice(0, 150));

  console.log('\n收尾：刪掉 ' + (await cleanup()) + ' 筆測試資料');
  console.log('\n' + pass + ' 通過 / ' + fail + ' 失敗   （共 ' + (pass + fail) + ' 項斷言）');
  if (收下的怪值.length) {
    console.log('\n收下了但值得看一眼的怪值（不是當機，是資料品質）：');
    for (const v of 收下的怪值) console.log('  · ' + v);
  }
  if (failures.length) {
    console.log('\n失敗項目：');
    for (const f of failures.slice(0, 40)) console.log('  ✗ ' + f);
    if (failures.length > 40) console.log('  …還有 ' + (failures.length - 40) + ' 項');
  }
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('稽核中斷：', e);
  try { await cleanup(); } catch {}
  process.exit(2);
});

