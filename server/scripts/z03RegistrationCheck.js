/**
 * 註冊入口對「有沒有 Z03 記錄」的行為驗證。
 *
 * 以前 verify-phone 的 z03_pending 分支引用了未宣告的 studentName，
 * 只要電話命中 Z03 待處理記錄就必定 ReferenceError → 500「查詢失敗」。
 * 正式站有 873 支這種電話。這支測試就是要證明那條路現在通了。
 *
 * 只讀，不建立任何資料。
 */
const { signFlowToken } = require('../middlewares/flowAuth');
const { pool } = require('../models/db');

const BASE = process.env.Z03_BASE || 'http://localhost:3001';
const uid = (t) => 'DEMOTEST_Z03CHECK_' + t;

async function post(path, body, token) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body || {}),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text: text.slice(0, 200) };
}

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? ' -> ' + detail : '')); }
};

(async () => {
  const z03 = (await pool.query(
    `SELECT COALESCE(phone_canonical, phone) AS phone
       FROM ragic_z03_records
      WHERE status='pending'
        AND COALESCE(phone_canonical, phone) ~ '^09[0-9]{8}$'
      ORDER BY id LIMIT 3`)).rows.map(r => r.phone);

  const noZ03 = (await pool.query(
    `SELECT p.phone FROM parents p
      WHERE p.is_active AND p.phone ~ '^09[0-9]{8}$'
        AND NOT EXISTS (
          SELECT 1 FROM ragic_z03_records z
           WHERE COALESCE(z.phone_canonical, z.phone) = p.phone AND z.status='pending')
      ORDER BY p.id LIMIT 2`)).rows.map(r => r.phone);

  console.log('=== A. 有 Z03 待處理記錄的電話（以前必定 500）===');
  if (!z03.length) console.log('  （dev 上找不到 pending Z03 樣本，略過）');
  for (const phone of z03) {
    const res = await post('/api/auth/verify-phone', { phone },
      signFlowToken({ lineUid: uid(phone.slice(-4) + '_' + Date.now()) }));
    const masked = phone.slice(0, 4) + '****' + phone.slice(-2);
    console.log('  ' + masked + ' → HTTP ' + res.status + '  ' + JSON.stringify(res.json));
    ok(masked + ' 沒有 500', res.status < 500, res.text);
    ok(masked + ' 有回得出 status', !!res.json?.status, res.text);
    ok(masked + ' 沒有被擋下（不是錯誤碼）', !res.json?.code || res.status === 200,
       JSON.stringify(res.json));
  }

  console.log('');
  console.log('=== B. 沒有 Z03 記錄的既有電話 ===');
  for (const phone of noZ03) {
    const res = await post('/api/auth/verify-phone', { phone },
      signFlowToken({ lineUid: uid('no_' + phone.slice(-4) + '_' + Date.now()) }));
    const masked = phone.slice(0, 4) + '****' + phone.slice(-2);
    console.log('  ' + masked + ' → HTTP ' + res.status + '  ' + JSON.stringify(res.json));
    ok(masked + ' 沒有 500', res.status < 500, res.text);
  }

  console.log('');
  console.log('=== C. 全新電話（新戶）===');
  const res = await post('/api/auth/verify-phone', { phone: '0900000177' },
    signFlowToken({ lineUid: uid('new_' + Date.now()) }));
  console.log('  0900****77 → HTTP ' + res.status + '  ' + JSON.stringify(res.json));
  ok('全新電話走註冊分支', res.status === 200 && res.json?.status === 'not_found', res.text);

  console.log('');
  console.log(pass + ' 通過 / ' + fail + ' 失敗');
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('中斷：', e.message); process.exit(2); });

