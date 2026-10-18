/**
 * 限流的失效方向必須是「放行」，不能是「把所有人併成一桶」。
 *
 * 2026-08-26 正式站全體無法登入後台。原因不是上限太低，而是後台登入以
 * req.ip 為 key，而 app 從未設過 trust proxy —— 在反向代理後面那是代理位址，
 * 對所有使用者都一樣。「5 分鐘 5 次」於是變成「整個系統 5 分鐘 5 次」。
 *
 * 只把上限調高不能消除這個失效模式，只是讓它晚一點發生。所以這裡盯的是
 * 結構性質，不只是數字：
 *   1. 認不出用戶 → clientIp 回 null → hit() 放行（不可併成一桶）
 *   2. 已超限時不再累加（否則重試會無限延長冷卻，永遠解不開）
 *   3. 成功登入清零
 *   4. 後台登入用 clientIp 而不是裸的 req.ip
 *   5. app.set('trust proxy') 有設 —— req.ip 還被稽核與 log 使用
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const rl = require(path.join(ROOT, 'server/middlewares/rateLimit'));

let failures = 0;
function check(label, fn) {
  try { fn(); console.log('  ok  ' + label); }
  catch (e) { failures++; console.error('  FAIL ' + label + ' → ' + e.message); }
}

check('x-forwarded-for 有值時取第一段（真正的用戶）', () => {
  const ip = rl.clientIp({ headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }, ip: '10.0.0.1' });
  assert.strictEqual(ip, '203.0.113.7');
});

check('認不出用戶時回 null，而不是某個共用字串', () => {
  assert.strictEqual(rl.clientIp({ headers: {} }), null);
  assert.strictEqual(rl.clientIp({ headers: {}, ip: 'unknown' }), null);
  assert.strictEqual(rl.clientIp(null), null);
});

check('key 為 null 時一律放行（失效方向是放行，不是鎖死）', () => {
  const bucket = new Map();
  for (let i = 0; i < 200; i++) {
    assert.strictEqual(rl.hit(bucket, null, { max: 3, windowMs: 60_000 }), false,
      '認不出用戶卻擋下來，等於把所有人算成同一個人 —— 那正是 08/26 全公司鎖死的成因');
  }
  assert.strictEqual(bucket.size, 0, '不該為 null 建立計數桶');
});

check('同一個 IP 超過上限會被擋', () => {
  const bucket = new Map();
  const opts = { max: 3, windowMs: 60_000 };
  assert.strictEqual(rl.hit(bucket, '1.2.3.4', opts), false);
  assert.strictEqual(rl.hit(bucket, '1.2.3.4', opts), false);
  assert.strictEqual(rl.hit(bucket, '1.2.3.4', opts), false);
  assert.strictEqual(rl.hit(bucket, '1.2.3.4', opts), true);
});

check('不同 IP 互不影響', () => {
  const bucket = new Map();
  const opts = { max: 2, windowMs: 60_000 };
  rl.hit(bucket, 'a', opts); rl.hit(bucket, 'a', opts);
  assert.strictEqual(rl.hit(bucket, 'a', opts), true, 'a 應已超限');
  assert.strictEqual(rl.hit(bucket, 'b', opts), false, 'b 不該被 a 影響');
});

check('已超限之後再試，不會把冷卻往後延長', () => {
  const bucket = new Map();
  const opts = { max: 2, windowMs: 60_000 };
  rl.hit(bucket, 'x', opts); rl.hit(bucket, 'x', opts);
  const before = [...bucket.get('x')];
  for (let i = 0; i < 50; i++) rl.hit(bucket, 'x', opts);
  assert.deepStrictEqual(bucket.get('x'), before,
    '被擋下的請求也計數的話，使用者每按一次就把冷卻往後推，永遠解不開');
});

check('成功之後清零', () => {
  const bucket = new Map();
  const opts = { max: 2, windowMs: 60_000 };
  rl.hit(bucket, 'y', opts); rl.hit(bucket, 'y', opts);
  assert.strictEqual(rl.hit(bucket, 'y', opts), true);
  rl.reset(bucket, 'y');
  assert.strictEqual(rl.hit(bucket, 'y', opts), false, '清零後應可重新開始');
});

check('預設啟用，上限 30 次 / 5 分鐘', () => {
  assert.strictEqual(rl.rateLimitEnabled(), true, '預設應啟用');
  assert.strictEqual(rl.maxAttempts(), 30);
  assert.strictEqual(rl.windowMs(), 5 * 60 * 1000);
});

check('後台登入用 clientIp，不是裸的 req.ip', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server/routes/admin/auth.js'), 'utf8');
  const i = src.indexOf("router.post('/login'");
  assert.ok(i >= 0, '找不到登入路由');
  const body = src.slice(i, i + 900).replace(/\/\/[^\n]*/g, '');
  assert.ok(/clientIp\(req\)/.test(body), '必須用 clientIp');
  assert.ok(!/req\.ip\s*\|\|\s*req\.socket/.test(body),
    '裸讀 req.ip 在反向代理後面拿到的是代理位址 —— 這就是全公司鎖死的成因');
});

check("app.set('trust proxy') 有設", () => {
  const src = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
  assert.ok(/app\.set\(\s*'trust proxy'/.test(src),
    'req.ip 還被稽核與 log 使用，在這個部署環境不該是代理位址');
});

console.log(failures ? `\n${failures} FAILED` : '\nrate_limit: ALL PASS');
process.exitCode = failures ? 1 : 0;

