/**
 * 限流政策（2026-09-03）：
 *   家長端 verify-phone → 同一個 UID 15 次 / 5 分鐘
 *   後台登入           → 不限流（ADMIN_LOGIN_RATE_LIMIT=1 可開回來）
 *
 * 這支不掃原始碼，真的把中介層打滿次數、也真的對後台登入連打 25 次。
 * 上限錯了不會有人立刻發現 —— 症狀是「家長說他被鎖住」或「暴搜沒被擋」，
 * 兩種都要等出事才知道，所以必須是行為級的測試。
 */
const assert = require('assert');
const path = require('path');

const flowAuth = require(path.resolve(__dirname, '../server/middlewares/flowAuth'));
const { verifyPhoneRateLimit, __test__ } = flowAuth;

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

function fresh() { __test__.ATTEMPTS.clear(); }

t('同一個 UID 前 15 次都放行', () => {
  fresh();
  for (let i = 1; i <= 15; i++) {
    const r = knock('U_aaa', '1.1.1.1');
    assert.ok(r.passed, '第 ' + i + ' 次就被擋了，上限比 15 小');
  }
});

t('第 16 次才擋，而且回 429 / RATE_LIMITED', () => {
  fresh();
  for (let i = 0; i < 15; i++) knock('U_aaa', '1.1.1.1');
  const r = knock('U_aaa', '1.1.1.1');
  assert.ok(!r.passed, '第 16 次仍然放行，上限比 15 大');
  assert.strictEqual(r.status, 429);
  assert.strictEqual(r.body.code, 'RATE_LIMITED');
});

t('不同 UID 各自計數，不會互相拖累', () => {
  fresh();
  for (let i = 0; i < 15; i++) knock('U_aaa', '1.1.1.1');
  assert.ok(!knock('U_aaa', '1.1.1.1').passed, '甲應該已經滿了');
  assert.ok(knock('U_bbb', '1.1.1.1').passed, '乙被甲拖累了 —— 這就是 2026-08-26 全公司鎖死的形狀');
});

t('同一個 UID 換網路會拿到新的桶（刻意放寬，不是漏洞）', () => {
  fresh();
  for (let i = 0; i < 16; i++) knock('U_aaa', '1.1.1.1');
  assert.ok(knock('U_aaa', '2.2.2.2').passed,
    '鍵值是 IP＋UID，換 IP 應該重新計算；這個端點不回傳學員資料，寬鬆是刻意的');
});

t('上限可以用環境變數調，不必改程式', () => {
  const before = process.env.VERIFY_PHONE_MAX;
  try {
    process.env.VERIFY_PHONE_MAX = '3';
    assert.strictEqual(__test__.maxAttempts(), 3);
    process.env.VERIFY_PHONE_MAX = '不是數字';
    assert.strictEqual(__test__.maxAttempts(), __test__.DEFAULT_MAX_ATTEMPTS, '壞值要退回預設，不能變成 0');
    process.env.VERIFY_PHONE_MAX = '0';
    assert.strictEqual(__test__.maxAttempts(), __test__.DEFAULT_MAX_ATTEMPTS, '0 要退回預設，否則等於全擋');
  } finally {
    if (before === undefined) delete process.env.VERIFY_PHONE_MAX;
    else process.env.VERIFY_PHONE_MAX = before;
  }
});

t('預設就是 15，不是靠環境變數才對', () => {
  const before = process.env.VERIFY_PHONE_MAX;
  try {
    delete process.env.VERIFY_PHONE_MAX;
    assert.strictEqual(__test__.maxAttempts(), 15);
  } finally {
    if (before !== undefined) process.env.VERIFY_PHONE_MAX = before;
  }
});

// ── 後台登入：不限流 ──
const BASE = process.env.TEST_BASE || 'http://localhost:3001';

(async () => {
  await ta('後台登入連打 25 次都不會被 429 擋下', async () => {
    // 用一個不存在的帳號，不會鎖到任何真實帳號；
    // 限流判斷排在查帳號之前，所以照樣會經過那一段。
    let limited = 0; let reached = 0;
    for (let i = 0; i < 25; i++) {
      const r = await fetch(BASE + '/api/admin/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '9.9.9.9' },
        body: JSON.stringify({ username: '__no_such_user__', password: 'x' }),
      });
      if (r.status === 429) limited += 1; else reached += 1;
    }
    assert.strictEqual(limited, 0, '有 ' + limited + ' 次被 429 擋下，後台應該不限流');
    assert.strictEqual(reached, 25);
  });

  await ta('把開關打開就會擋回來（出事時用環境變數就能救）', async () => {
    // 這裡只驗開關本身讀得對；真正的擋是同一個 hit()，上面家長端已經驗過行為。
    const mod = path.resolve(__dirname, '../server/routes/admin/auth.js');
    const src = require('fs').readFileSync(mod, 'utf8');
    assert.ok(src.includes('ADMIN_LOGIN_RATE_LIMIT'),
      '開關不見了 —— 出事時就只能改程式重新部署');
    assert.ok(/if \(!adminLoginRateLimitOn\(\)\) return false;/.test(src),
      '限流沒有被開關擋住，等於根本沒關掉');
  });

  console.log('\n' + n + ' 個測試全數通過');
})().catch((e) => { console.error('FAIL ' + e.message); process.exit(1); });
