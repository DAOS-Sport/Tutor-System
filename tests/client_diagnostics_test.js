/**
 * 前端診斷回報端點的安全性質。
 *
 * 這是全系統唯一「不需要登入就能寫進資料庫」的端點 —— 它必須這樣，
 * 因為註冊流程本來就還沒有身分，要求登入等於收不到最需要的那些回報。
 *
 * 代價是它必須是有界的。這支測試盯的就是那些界線，因為它們很容易在
 * 之後的重構裡被拿掉，而拿掉之後不會有任何人立刻發現 —— 直到有人灌爆它。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const src = strip(fs.readFileSync(path.join(ROOT, 'server/routes/diagnostics.js'), 'utf8'));

let n = 0;
const t = (name, fn) => { fn(); n += 1; console.log('  PASS  ' + name); };

t('every diagnostic emitted by the picker is accepted by the backend', () => {
  const picker = fs.readFileSync(path.join(ROOT, 'client/shared/DateTimePicker.jsx'), 'utf8');
  const emitted = [...picker.matchAll(/reportPickerAnomaly\('([^']+)'/g)].map(m => m[1]);
  const kinds = src.match(/const KINDS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(kinds && emitted.length > 0);
  const allowed = [...kinds[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  assert.deepStrictEqual([...new Set(emitted)].filter(kind => !allowed.includes(kind)), []);
});

t('kind 走白名單，不是照單全收', () => {
  assert.ok(/const KINDS = new Set\(\[/.test(src), '缺少 kind 白名單');
  assert.ok(/KINDS\.has\(kind\)/.test(src), '沒有檢查白名單');
});

t('每個欄位都有長度上限', () => {
  assert.ok(/const cut = /.test(src), '缺少截斷函式');
  for (const field of ['body.kind', 'body.reason', 'body.path', "req.get\\('user-agent'\\)"]) {
    const re = new RegExp('cut\\(' + field);
    assert.ok(re.test(src), field + ' 沒有經過長度上限');
  }
});

t('事件筆數有上限', () => {
  assert.ok(/events[\s\S]{0,120}\.slice\(0,\s*\d+\)/.test(src),
    '事件陣列沒有筆數上限 —— 一次請求就能塞爆一列');
});

t('有限流', () => {
  assert.ok(/hit\(BUCKET/.test(src), '沒有限流：對外開放的寫入端點必須有');
  assert.ok(/clientIp\(req\)/.test(src), '限流要以 clientIp 為鍵，不是裸的 req.ip');
});

t('一律回 204，不給呼叫端任何線索', () => {
  assert.ok(/status\(204\)/.test(src), '應該回 204');
  assert.ok(!/status\(4\d\d\)/.test(src) && !/status\(5\d\d\)/.test(src),
    '不該回 4xx/5xx：這是回報通道，讓呼叫端知道成敗只會招來探測與重試');
});

t('出錯要吞掉，不可以連累正在註冊的人', () => {
  const i = src.indexOf('catch');
  assert.ok(i > 0, '沒有 try/catch');
  const tail = src.slice(i, i + 400);
  assert.ok(!/throw/.test(tail), '診斷回報失敗不可以往外拋');
  assert.ok(/done\(\)/.test(src), '不論成敗都要回應');
});

t('資料表有保留期，不會無上限成長', () => {
  const boot = strip(fs.readFileSync(path.join(ROOT, 'server/bootstrap/coreSchema.js'), 'utf8'));
  const i = boot.indexOf('client_diagnostics');
  assert.ok(i > 0, '找不到建表');
  const seg = boot.slice(i, i + 1200);
  assert.ok(/DELETE FROM client_diagnostics WHERE created_at < NOW\(\) - INTERVAL/.test(seg),
    '對外開放端點寫入的表沒有保留期 —— 只會一直長');
});

t('前端只送分類，不送使用者填的內容', () => {
  const picker = strip(fs.readFileSync(path.join(ROOT, 'client/shared/DateTimePicker.jsx'), 'utf8'));
  const i = picker.indexOf('function reportPickerAnomaly');
  assert.ok(i > 0, '找不到回報函式');
  const body = picker.slice(i, picker.indexOf('\n}', i));
  assert.ok(!/\bvalue\b/.test(body), '回報內容不可以帶 value（那是使用者填的東西）');
  assert.ok(/window\.location\.pathname/.test(body) && !/location\.search|location\.href/.test(body),
    '只送 pathname —— query string 可能夾帶參數');
  assert.ok(/_reportsLeft/.test(picker), '沒有回報次數上限：診斷不該變成另一個問題');
});

console.log('\n' + n + ' 個測試全數通過');
