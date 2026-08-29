/**
 * 註冊路徑的四道防線 —— 2026-08-29 健壯性稽核（824 項）抓出來的實際缺口。
 *
 * 這四個都不是「使用者填錯」，是我們自己沒接住：家長看到的是 500「查詢失敗」
 * 或「註冊失敗」，而後台只有一行沒頭沒尾的例外。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

let n = 0;
const t = (name, fn) => { fn(); n += 1; console.log('  PASS  ' + name); };

// ── 1. NUL 位元組（真行為測試）─────────────────────────────────────────
const { hasNulString, rejectNulBytes, MAX_DEPTH } =
  require(path.join(ROOT, 'server/middlewares/rejectNulBytes'));

t('字串裡的 NUL 認得出來', () => {
  assert.strictEqual(hasNulString('abc\u0000def'), true);
  assert.strictEqual(hasNulString('乾淨的字串'), false);
});

t('巢狀結構裡的 NUL 也認得出來', () => {
  assert.strictEqual(hasNulString({ parent: { name: 'a\u0000b' } }), true);
  assert.strictEqual(hasNulString({ students: [{ id_number: 'A1\u000023' }] }), true);
  assert.strictEqual(hasNulString({ parent: { name: '王小明' }, students: [{ name: '王小華' }] }), false);
});

t('非字串不會誤判', () => {
  for (const v of [null, undefined, 0, 123, true, false, [], {}, new Date(0)]) {
    assert.strictEqual(hasNulString(v), false, String(v));
  }
});

t('深度有上限，不會被巢狀 payload 拖垮', () => {
  let deep = 'a\u0000b';
  for (let i = 0; i < MAX_DEPTH + 5; i++) deep = { x: deep };
  assert.strictEqual(hasNulString(deep), false, '超過上限就不再往下挖，寧可放過也不吃掉 CPU');
  let shallow = 'a\u0000b';
  for (let i = 0; i < MAX_DEPTH - 2; i++) shallow = { x: shallow };
  assert.strictEqual(hasNulString(shallow), true, '上限之內必須抓到');
});

t('擋下來的回應是 400 而且帶 code', () => {
  let sent = null;
  const res = { status(c) { this._c = c; return this; }, json(b) { sent = { code: this._c, body: b }; } };
  let nexted = false;
  rejectNulBytes({ body: { name: 'a\u0000b' } }, res, () => { nexted = true; });
  assert.strictEqual(nexted, false, '含 NUL 不可以放行到 SQL');
  assert.strictEqual(sent.code, 400, '這是使用者輸入問題，不是 500');
  assert.strictEqual(sent.body.code, 'INPUT_INVALID', '前端靠 code 顯示訊息');
});

t('乾淨的 body 照常放行', () => {
  let nexted = false;
  rejectNulBytes({ body: { parent: { name: '王小明' } } }, {}, () => { nexted = true; });
  assert.strictEqual(nexted, true);
});

// ── 2. verify-phone 不可以再引用不存在的 studentName ────────────────────
t('S2 verify-phone 的 z03_pending 分支不引用未宣告的 studentName', () => {
  const src = stripComments(read('server/routes/auth.js'));
  const i = src.indexOf("router.post('/verify-phone'");
  assert.ok(i > 0, '找不到 verify-phone 路由');
  const body = src.slice(i, src.indexOf("router.post('/verify-student'", i));
  assert.ok(/z03_pending/.test(body), '抓錯區塊：這段裡應該有 z03_pending 分支');
  assert.ok(!/studentName/.test(body),
    'S2 只驗電話，學員姓名要到 S3 才問 —— 這個 scope 裡沒有 studentName。'
    + '引用它會拋 ReferenceError，讓所有「有 Z03 待處理記錄」的家庭（正式站 873 支電話）'
    + '卡在註冊第一關，畫面只顯示「查詢失敗」');
});

// ── 2b. /bind 不可以再引用不存在的 sourceIds ────────────────────────────
t('S3b bind 的 uid_conflict 分支不引用未宣告的 sourceIds', () => {
  const src = stripComments(read('server/routes/auth.js'));
  const i = src.indexOf("router.post('/bind'");
  assert.ok(i > 0, '找不到 bind 路由');
  const body = src.slice(i, src.indexOf("router.post('/parent-bind-phone'", i));
  assert.ok(/MULTIPLE_UID_SOURCE_NO_WINNER/.test(body), '抓錯區塊：這段裡應該有 uid_conflict 分支');
  assert.ok(!/\bsourceIds\b/.test(body),
    'sourceIds 宣告在 _registerParentCore 裡，這個 scope 沒有。引用它會拋 ReferenceError，'
    + '換手機／換 LINE 想找回帳號的家長會拿到 500，而且那張「請後台協助」的工單'
    + '根本不會被建立 —— 沒有人知道他們卡住了');
});

// ── 3. body 解析失敗要帶 code ───────────────────────────────────────────
t('JSON 解析失敗 / 內容過大 的回應帶得出 code', () => {
  const src = stripComments(read('server/index.js'));
  // 用 entity.too.large 當錨點：entity.parse.failed 在檔案裡出現兩次，
  // 第一次是「空 body 視為 {}」的寬鬆解析包裝，不是這裡要驗的錯誤處理。
  const i = src.indexOf('entity.too.large');
  assert.ok(i > 0, '找不到 body 解析錯誤處理');
  const body = src.slice(i, i + 900);
  assert.ok(/code:\s*tooLarge\s*\?\s*'PAYLOAD_TOO_LARGE'\s*:\s*'BAD_JSON'/.test(body),
    '沒有 code 的錯誤在前端會變成一片空白或籠統的「資料載入失敗」');
});

// ── 4. 未來的生日要擋 ───────────────────────────────────────────────────
t('學員生日不接受未來日期', () => {
  const src = stripComments(read('server/routes/auth.js'));
  const i = src.indexOf('STUDENT_BIRTH_DATE_REQUIRED');
  assert.ok(i > 0, '找不到生日驗證');
  const body = src.slice(i, i + 1500);
  assert.ok(/getTime\(\)\s*>\s*Date\.now\(\)/.test(body),
    '只驗格式的話，年份手滑打成 21xx 會被原封不動收下，'
    + '錯誤要等到分齡分班或保險資料才被發現');
});

console.log('\n' + n + ' 個測試全數通過');

