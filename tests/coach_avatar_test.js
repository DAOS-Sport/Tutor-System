/**
 * 教練大頭照（2026-08-17 owner 要求）
 *
 * 這支測試存在的理由是 2026-07-13 那張 404 的介紹圖：檔案落在容器本機磁碟，
 * Autoscale 換實例就沒了。正式站現在還看得到那個破圖
 * （/uploads/2026-07/df4b4cbdf98d9b88cb33fbaf.jpeg → 404）。
 *
 * 要守住的四件事：
 *   1. 上傳一定走 objectStorage，不准碰 fs
 *   2. DB 只存相對路徑，不存絕對網址（存了網域，dev 上傳的圖在正式站就是破圖）
 *   3. 端點要驗身分，而且只能改自己的
 *   4. 前端一定要有 fallback —— 檔案哪天讀不到，家長看到的不能是破圖框
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failures++; console.error('  FAIL ' + name + '\n       ' + e.message); }
}
function stripComments(src) {
  return src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

const API = path.join(ROOT, 'server/routes/coaches.js');
const SCHEMA = path.join(ROOT, 'server/bootstrap/coreSchema.js');
const CARD = path.join(ROOT, 'client/liff/src/components/CoachCard.jsx');
const PAGE = path.join(ROOT, 'client/liff/src/pages/CoachProfilePage.jsx');
const CROP = path.join(ROOT, 'client/liff/src/components/coach/AvatarCropper.jsx');

check('欄位存在，而且是可為空的 TEXT', () => {
  const src = stripComments(fs.readFileSync(SCHEMA, 'utf8'));
  assert.ok(/ALTER TABLE coaches ADD COLUMN IF NOT EXISTS avatar_url TEXT;/.test(src),
    'coreSchema 沒有 avatar_url 遷移 —— 正式站部署後欄位不存在，上傳會 500');
  assert.ok(!/avatar_url TEXT NOT NULL/.test(src),
    'avatar_url 不可以是 NOT NULL —— 212 位教練裡絕大多數沒有頭像');
});

check('上傳走 objectStorage，不碰檔案系統', () => {
  const src = stripComments(fs.readFileSync(API, 'utf8'));
  const i = src.indexOf("router.post('/:id/avatar'");
  assert.ok(i > 0, '找不到大頭照上傳端點');
  const block = src.slice(i, i + 1200);

  assert.ok(/saveBuffer\(/.test(block),
    '沒有走 objectStorage.saveBuffer —— 這是唯一會在 production 落 bucket／Postgres 的路徑');
  // 自己寫檔＝重演 2026-07-13。整支檔案都不該出現 fs 寫入。
  assert.ok(!/require\(['"]fs['"]\)/.test(src) && !/writeFileSync|createWriteStream/.test(src),
    'coaches.js 出現檔案系統寫入 —— Autoscale 換實例就會弄丟，2026-07 已經掉過一張');

  // 存進 DB 的必須是 saveBuffer 回傳的相對路徑。
  assert.ok(/SET avatar_url = \$1/.test(block) && /saved\.url/.test(block),
    '寫進 DB 的不是 saveBuffer 回傳的 url');
  assert.ok(!/REPLIT_DOMAINS|https?:\/\//.test(block),
    '端點裡出現網域或絕對網址 —— dev 上傳的圖在正式站會是破圖');
});

check('端點要登入，而且只能改自己的', () => {
  const src = stripComments(fs.readFileSync(API, 'utf8'));
  for (const verb of ["router.post('/:id/avatar'", "router.delete('/:id/avatar'"]) {
    const i = src.indexOf(verb);
    assert.ok(i > 0, '找不到 ' + verb);
    const head = src.slice(i, i + 200);
    assert.ok(/requireCoach\b/.test(head), verb + ' 沒有 requireCoach');
    assert.ok(/requireCoachOwner\('id'\)/.test(head), verb + ' 沒有 requireCoachOwner —— 可以改別人的頭像');
  }
  // 移除只清欄位，不刪 object：同一個 key 可能被別處引用，刪錯救不回來。
  const del = src.slice(src.indexOf("router.delete('/:id/avatar'"), src.indexOf("router.delete('/:id/avatar'") + 700);
  assert.ok(/avatar_url = NULL/.test(del), '移除沒有清欄位');
  assert.ok(!/deleteObject|removeObject|unlink/.test(del), '移除時去刪了實體檔案');
});

check('公開欄位白名單含 avatar_url', () => {
  const src = stripComments(fs.readFileSync(API, 'utf8'));
  const m = /const PUBLIC_COACH_FIELDS = \[([\s\S]*?)\];/.exec(src);
  assert.ok(m, '掃描已失效：找不到 PUBLIC_COACH_FIELDS');
  assert.ok(/'avatar_url'/.test(m[1]),
    'avatar_url 不在白名單 —— 家長端永遠拿不到，頭像等於沒做');
  // 白名單是刻意的資安設計，不可退回黑名單（2026-08-11 曾外洩 165 支手機）。
  assert.ok(!/'phone'|'email'|'line_uid'|'staff_no'/.test(m[1]),
    '白名單混進了個資欄位');
});

check('白名單欄位必須真的被 SELECT（靜態測試漏掉、端到端才抓到）', () => {
  // 2026-08-17 實測踩到：avatar_url 加進 PUBLIC_COACH_FIELDS 了，但 SQL 沒 SELECT
  // 那個欄位。publicCoach 只複製「不是 undefined」的鍵，所以整個欄位被無聲跳過 ——
  // 上傳成功、DB 有值、家長端永遠拿不到。所有靜態斷言都是綠的。
  //
  // 白名單式檢查：拿白名單去比對 SQL，新增欄位忘了改 SQL 一樣會被抓到。
  const api = stripComments(fs.readFileSync(API, 'utf8'));
  const scope = fs.readFileSync(path.join(ROOT, 'server/services/coachVenueScope.js'), 'utf8');
  const sel = /const COACH_STAFF_PROFILE_SELECT = `([\s\S]*?)`;/.exec(scope);
  assert.ok(sel, '掃描已失效：找不到 COACH_STAFF_PROFILE_SELECT');
  const sql = sel[1].replace(/^\s*--.*$/gm, '');   // 剝 SQL 註解，免得註解提到欄位名就算數

  const m = /const PUBLIC_COACH_FIELDS = \[([\s\S]*?)\];/.exec(api);
  assert.ok(m, '掃描已失效：找不到 PUBLIC_COACH_FIELDS');
  const fields = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.ok(fields.length >= 8, '白名單只解析到 ' + fields.length + ' 個欄位 —— 掃描已失效');

  // normalizeCoach 會另外組出來的衍生欄位，不必出現在 SQL。
  const DERIVED = new Set(['bio', 'multiplier', 'venue_ids', 'venues']);
  const missing = fields.filter((f) => !DERIVED.has(f) && !new RegExp('\\b' + f + '\\b').test(sql));
  assert.deepStrictEqual(missing, [],
    '這些欄位在白名單裡但 SQL 沒 SELECT，publicCoach 會無聲跳過：' + missing.join('、'));
});

check('SQL 模板字串裡不可以有反引號', () => {
  // 2026-08-17 踩到：在 COACH_STAFF_PROFILE_SELECT 的 SQL 註解裡寫了反引號，
  // 直接把 JS 模板字串提前關掉 → SyntaxError，整個 server 起不來。
  const scope = fs.readFileSync(path.join(ROOT, 'server/services/coachVenueScope.js'), 'utf8');
  const sel = /const COACH_STAFF_PROFILE_SELECT = `([\s\S]*?)`;/.exec(scope);
  assert.ok(sel, '掃描已失效：找不到 SELECT 模板字串');
  assert.ok(/c\.id/.test(sel[1]) && /c\.name|s\.name/.test(sel[1]),
    '抓到的模板字串內容不像 SQL —— 可能已經被反引號截斷過');
});

check('前端：讀不到圖要退回姓名首字，不是破圖框', () => {
  const card = stripComments(fs.readFileSync(CARD, 'utf8'));
  assert.ok(/coach\.avatar_url/.test(card), '家長端小卡沒有畫頭像');
  assert.ok(/onError=/.test(card),
    '沒有 onError fallback —— 檔案哪天讀不到，家長看到的是破圖框');
  assert.ok(/avatarFailed/.test(card) && /\{initial\}|: initial/.test(card),
    '失敗時沒有退回姓名首字');
  assert.ok(/object-cover/.test(card) && /overflow-hidden/.test(card),
    '頭像沒有裁切樣式，非正方形的圖會把圓圈撐變形');
});

check('裁切器：輸出正方形、夾住邊界、JPEG 要填白底', () => {
  const src = stripComments(fs.readFileSync(CROP, 'utf8'));
  assert.ok(/canvas\.width = OUT/.test(src) && /canvas\.height = OUT/.test(src),
    '輸出不是正方形');
  assert.ok(/toBlob\(res, 'image\/jpeg'/.test(src), '沒有輸出 JPEG');
  // JPEG 沒有 alpha，透明區不填白會變黑塊。
  assert.ok(/fillStyle = '#ffffff'/.test(src) && /fillRect\(0, 0, OUT, OUT\)/.test(src),
    '輸出 JPEG 前沒有填白底 —— 透明區域會變成黑色');
  // 位移必須夾住，否則會裁到圖片外面（輸出留白邊）。
  assert.ok(/function clamp\(/.test(src) && /Math\.min\(maxX, Math\.max\(-maxX/.test(src),
    '位移沒有夾在「圖片仍覆蓋取景框」的範圍內');
  // 縮小後要用新倍率重夾，不然原本的位移會露邊。
  assert.ok(/clamp\(o, base \* z\)/.test(src), '縮放後沒有用新倍率重夾位移');
});

if (failures) { console.error('\ncoach_avatar_test: ' + failures + ' failed'); process.exit(1); }
console.log('coach_avatar_test: all passed');
