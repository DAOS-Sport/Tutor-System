/**
 * 模擬 LINE 登入，走到家長真正會看到的畫面狀態。
 *
 *   ALLOW_DEMO_LOGIN=1 PORT=3001 node server/index.js &
 *   node server/scripts/lineLoginSim.js
 *
 * 只在 dev 跑。它不改任何資料，只讀。
 *
 * LINE 的 id_token 驗證沒有、也不該有 dev 旁路（verifyLineIdToken 一律打
 * LINE 的 API，這是對的，不要為了測試在那裡開門），所以這裡分兩段：
 *   1. 用系統內建的 demo-login 取得真正的家長 JWT，走完 LIFF 開機會做的呼叫
 *   2. 用真實家長的 line_uid 直接簽 token，模擬「LINE 驗證通過之後」那一段
 * 並在每一步把 AuthContext 實際會存進 localStorage 的物件餵給橫幅的判斷式，
 * 看它到底會不會亮。
 */
const path = require('path');
const { signParentToken } = require('../middlewares/parentAuth');
const { pool } = require('../models/db');

const BASE = process.env.SIM_BASE || 'http://localhost:3001';

// 與 client/liff/src/context/AuthContext.jsx 的 _stripSensitive 同步
const stripSensitive = (o) => {
  if (!o || typeof o !== 'object') return o;
  const { line_uid, lineUid, ...rest } = o;
  return rest;
};

async function post(path, body, token) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body || {}),
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}

function 橫幅(needsEmailPrompt, parent, 說明) {
  const on = needsEmailPrompt(parent);
  console.log('   橫幅：' + (on ? '★ 會亮（提醒補 Email）' : '不亮') + '   ← ' + 說明);
  return on;
}

(async () => {
  const needsEmailUrl = 'file://'
    + path.resolve(__dirname, '../../client/liff/src/utils/needsEmail.js').replace(/\\/g, '/');
  const { needsEmailPrompt } = await import(needsEmailUrl);
  let pass = 0, fail = 0;
  const ok = (label, cond, detail) => {
    if (cond) { pass++; console.log('  ok   ' + label); }
    else { fail++; console.log('  FAIL ' + label + (detail ? ' -> ' + detail : '')); }
  };

  console.log('══ 1. 假的 id_token 應該被打回（證明驗證是真的在跑）══');
  const bogus = await post('/api/auth/parent-line-login', { id_token: 'not.a.real.token' });
  console.log('   ' + bogus.status + ' ' + JSON.stringify(bogus.body));
  ok('偽造的 id_token 被拒絕', bogus.status === 401, bogus.status + '');

  console.log('\n══ 2. 模擬登入：有 Email 的家長（demo custom / 0912345678）══');
  const a = await post('/api/auth/demo-login', { username: 'custom', password: 'custom' });
  ok('登入成功', a.status === 200 && !!a.body?.token, a.status + ' ' + JSON.stringify(a.body).slice(0, 160));
  const storedA = stripSensitive(a.body);
  console.log('   登入當下 AuthContext 存的欄位：' + Object.keys(storedA).join(', '));
  const 登入當下A = 橫幅(needsEmailPrompt, storedA,
    'demo-login 的回應沒有 email 這個欄位，判斷式看不出來 → 不誤報');
  ok('看不出來的時候不誤報', 登入當下A === false);

  const syncA = await post('/api/parents/me/sync', {}, a.body.token);
  const pA = stripSensitive(syncA.body?.parent || syncA.body);
  console.log('   開機同步後：email=' + JSON.stringify(pA?.email));
  const 同步後A = 橫幅(needsEmailPrompt, pA, '這位有填 Email');
  ok('有 Email 的家長不會被打擾', 同步後A === false, JSON.stringify(pA?.email));

  console.log('\n══ 3. 模擬登入：沒有 Email 的家長（demo custom2 / 0922222222）══');
  const b = await post('/api/auth/demo-login', { username: 'custom2', password: 'custom2' });
  ok('登入成功', b.status === 200 && !!b.body?.token, b.status + ' ' + JSON.stringify(b.body).slice(0, 160));
  const syncB = await post('/api/parents/me/sync', {}, b.body.token);
  const pB = stripSensitive(syncB.body?.parent || syncB.body);
  console.log('   開機同步後：email=' + JSON.stringify(pB?.email));
  const 同步後B = 橫幅(needsEmailPrompt, pB, '這位沒填 Email —— 就是那 59 位的處境');
  ok('缺 Email 的家長會被提醒', 同步後B === true, JSON.stringify(pB?.email));

  console.log('\n══ 4. 模擬「LINE 驗證通過之後」：拿真實家長的 line_uid 簽 token ══');
  const real = (await pool.query(
    `SELECT id,name,phone,email,line_uid FROM parents
      WHERE is_active AND line_uid IS NOT NULL
        AND line_uid NOT LIKE 'demo:%' AND line_uid NOT LIKE 'DEMOTEST%'
        AND NULLIF(TRIM(COALESCE(email,'')),'') IS NOT NULL
      ORDER BY id LIMIT 1`)).rows[0];
  const realNoMail = (await pool.query(
    `SELECT id,name,phone,email,line_uid FROM parents
      WHERE is_active AND line_uid IS NOT NULL
        AND line_uid NOT LIKE 'demo:%' AND line_uid NOT LIKE 'DEMOTEST%'
        AND NULLIF(TRIM(COALESCE(email,'')),'') IS NULL
      ORDER BY id LIMIT 1`)).rows[0];

  for (const [label, p] of [['有 Email 的真實家長', real], ['缺 Email 的真實家長', realNoMail]]) {
    if (!p) { console.log('   （dev 上沒有這種樣本：' + label + '）'); continue; }
    const token = signParentToken({ parentId: p.id, phone: p.phone, lineUid: p.line_uid });
    const s = await post('/api/parents/me/sync', {}, token);
    const stored = stripSensitive(s.body?.parent || s.body);
    console.log('   ' + label + '：' + p.name + '  email=' + JSON.stringify(stored?.email));
    ok(label + ' 的 line_uid 沒有外洩到前端', !('line_uid' in stored) && !('lineUid' in stored));
    const on = 橫幅(needsEmailPrompt, stored, label);
    ok(label + ' 的橫幅判斷正確',
       on === !String(p.email || '').trim(), 'email=' + JSON.stringify(p.email) + ' 橫幅=' + on);
  }

  console.log('\n' + pass + ' 通過 / ' + fail + ' 失敗');
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('模擬中斷：', e); process.exit(2); });

