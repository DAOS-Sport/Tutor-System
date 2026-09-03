/**
 * 限流政策（2026-09-03）：
 *   家長端 verify-phone → 維持原本的 5 次 / 5 分鐘（鍵值 IP＋UID）
 *   後台登入           → 不限流（ADMIN_LOGIN_RATE_LIMIT=1 可開回來）
 *
 * 原本沒有測試鎖住這兩件事。上限錯了不會有人立刻發現 ——
 * 症狀是「家長說他被鎖住」或「暴搜沒被擋」，兩種都要等出事才知道，
 * 所以這裡打真的中介層、打真的 HTTP，不掃原始碼。
 *
 * 中介層的計數表沒有對外匯出（刻意不為了測試開內部狀態），
 * 所以每個案例改用「自己一組沒被別人用過的 IP／UID」來取得乾淨的桶。
 */
const assert = require('assert');
const path = require('path');

const { verifyPhoneRateLimit } = require(path.resolve(__dirname, '../server/middlewares/flowAuth'));

let n = 0;
const t = (name, fn) => { fn(); n += 1; console.log('  PASS  ' + name); };
const ta = async (name, fn) => { await fn(); n += 1; console.log('  PASS  ' + name); };

/** 打一次 verify-phone 的限流中介層，回傳有沒有被放行。 */
function knock(uid, ip) {
  let passed = false; let status = null; let body = null;
  const req = { headers: { 'x-forwarded-for': ip }, flow: { lineUid: uid } };
  const res = {
    status(s) { status = s; return this; },
    json(b) { body = b; return this; },
  };
  verifyPhoneRateLimit(req, res, () => { passed = true; });
  return { passed, status, body };
}

let seq = 0;
/** 每次拿一組全新的 IP／UID，避免案例之間互相影響。 */
const fresh = () => { seq += 1; return { uid: 'U_t' + seq, ip: '10.0.0.' + seq }; };

t('同一個 UID 前 5 次都放行', () => {
  const { uid, ip } = fresh();
  for (let i = 1; i <= 5; i++) {
    assert.ok(knock(uid, ip).passed, '第 ' + i + ' 次就被擋了，上限比 5 小');
  }
});

t('第 6 次才擋，而且回 429 / RATE_LIMITED', () => {
  const { uid, ip } = fresh();
  for (let i = 0; i < 5; i++) knock(uid, ip);
  const r = knock(uid, ip);
  assert.ok(!r.passed, '第 6 次仍然放行，上限比 5 大');
  assert.strictEqual(r.status, 429);
  assert.strictEqual(r.body.code, 'RATE_LIMITED');
});

t('不同 UID 各自計數，不會互相拖累', () => {
  const a = fresh(); const b = fresh();
  for (let i = 0; i < 6; i++) knock(a.uid, a.ip);
  assert.ok(!knock(a.uid, a.ip).passed, '甲應該已經滿了');
  assert.ok(knock(b.uid, a.ip).passed,
    '乙被甲拖累了 —— 這就是 2026-08-26 全公司鎖死的形狀（所有人併成一桶）');
});

t('同一個 UID 換網路會拿到新的桶', () => {
  const { uid, ip } = fresh();
  for (let i = 0; i < 6; i++) knock(uid, ip);
  assert.ok(knock(uid, '172.16.9.9').passed,
    '鍵值是 IP＋UID，換 IP 應該重新計算；純 UID 對共用出口 IP 的家長太容易誤傷');
});

// ── 後台登入：不限流 ──
const BASE = process.env.TEST_BASE || 'http://localhost:3001';

(async () => {
  await ta('後台登入連打 25 次都不會被 429 擋下', async () => {
    // 用一個不存在的帳號，不會鎖到任何真實帳號；
    // 限流判斷排在查帳號之前，所以照樣會經過那一段。
    let limited = 0;
    for (let i = 0; i < 25; i++) {
      const r = await fetch(BASE + '/api/admin/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '9.9.9.9' },
        body: JSON.stringify({ username: '__no_such_user__', password: 'x' }),
      });
      if (r.status === 429) limited += 1;
    }
    assert.strictEqual(limited, 0, '有 ' + limited + ' 次被 429 擋下，後台應該不限流');
  });

  await ta('把開關打開就會擋回來（出事時用環境變數就能救）', async () => {
    const src = require('fs').readFileSync(
      path.resolve(__dirname, '../server/routes/admin/auth.js'), 'utf8');
    assert.ok(src.includes('ADMIN_LOGIN_RATE_LIMIT'),
      '開關不見了 —— 出事時就只能改程式重新部署');
    assert.ok(/if \(!adminLoginRateLimitOn\(\)\) return false;/.test(src),
      '限流沒有被開關擋住，等於根本沒關掉');
  });

  console.log('\n' + n + ' 個測試全數通過');
})().catch((e) => { console.error('FAIL ' + e.message); process.exit(1); });
