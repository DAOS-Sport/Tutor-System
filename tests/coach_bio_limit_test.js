/**
 * 教練自介長度上限（2026-08-17 owner 要求）
 *
 * 起因：正式庫 212 位教練只有 8 位寫了自介，其中 3 位寫了 201～268 字
 * （劉仁崇 268、駱明正 220、鄭琳魿 201）。家長端小卡是 line-clamp-2，
 * 約兩行 40 字 —— 後面全被吃掉，教練卻不知道。
 *
 * 要守住的：
 *   1. 前後端上限一致，且後端真的擋（原本後端完全沒有驗證）
 *   2. 不做靜默截斷 —— 替教練決定砍哪一段，錯了他也不會知道
 *   3. 預覽卡與正式家長端小卡在視覺上要切乾淨（價格是假的）
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
const PAGE = path.join(ROOT, 'client/liff/src/pages/CoachProfilePage.jsx');
const CARD = path.join(ROOT, 'client/liff/src/components/CoachCard.jsx');

check('後端真的擋長度，而且不靜默截斷', () => {
  const src = stripComments(fs.readFileSync(API, 'utf8'));
  assert.ok(/router\.put\('\/:id\/bio'/.test(src), '掃描已失效：找不到 bio 路由');

  const m = /const BIO_MAX = (\d+);/.exec(src);
  assert.ok(m, '後端沒有定義 BIO_MAX —— 上限只擋在前端，繞過去就沒了');
  const max = Number(m[1]);

  assert.ok(/BIO_TOO_LONG/.test(src), '超長沒有回可辨識的錯誤碼');
  assert.ok(/status\(400\)/.test(src), '超長應回 400');
  assert.ok(/bio\.length > BIO_MAX/.test(src), '沒有實際比對長度');

  // 靜默截斷是最糟的處理：教練以為存了全文，家長看到半句。
  assert.ok(!/bio_rich_text[^\n]*\.slice\(0,\s*BIO_MAX/.test(src) && !/bio\.slice\(0,\s*BIO_MAX/.test(src),
    '偵測到靜默截斷 —— 應該回 400 請教練自己刪，不是替他砍');

  // 擋在寫入之前，不是寫完才驗。
  const guard = src.indexOf('BIO_TOO_LONG');
  const update = src.indexOf('UPDATE coaches SET bio_rich_text');
  assert.ok(guard > 0 && update > 0 && guard < update, '長度守門在 UPDATE 之後才跑');

  // 後端擋的是「防呆上限」，必須與前端的 BIO_HARD_MAX 同一個數字。
  // 若後端擋在 40（＝建議長度），畫面說可以存、送出卻被打回，那是最難查的不一致。
  const page = stripComments(fs.readFileSync(PAGE, 'utf8'));
  const ph = /const BIO_HARD_MAX = (\d+);/.exec(page);
  assert.ok(ph, '前端沒有定義 BIO_HARD_MAX');
  assert.strictEqual(Number(ph[1]), max,
    '前端防呆上限 ' + ph[1] + ' 與後端 ' + max + ' 不一致 —— 教練會在存檔時才發現存不進去');

  const soft = /const BIO_MAX = (\d+);/.exec(page);
  assert.ok(soft && Number(soft[1]) < max,
    '前端的建議長度應小於防呆上限');
  assert.ok(Number(soft[1]) === 40, '建議長度應為 40（家長端 line-clamp-2 約兩行）');
});

check('前端：超過建議長度給警語，但不擋儲存', () => {
  const src = stripComments(fs.readFileSync(PAGE, 'utf8'));
  assert.ok(/handleSaveBio/.test(src), '掃描已失效：找不到 handleSaveBio');

  assert.ok(/maxLength=\{BIO_HARD_MAX\}/.test(src), '輸入框沒有套用防呆上限');
  assert.ok(/bioState\(/.test(src), '沒有字數狀態判定');

  // 超過建議長度要警告「會被截斷」，而且不擋儲存。
  const state = src.slice(src.indexOf('function bioState'), src.indexOf('function bioState') + 900);
  assert.ok(/len > BIO_MAX/.test(state), 'bioState 沒有判斷超過建議長度');
  assert.ok(/截斷/.test(state), '超過時的警語沒有講「會被截斷」—— 那是教練唯一需要知道的後果');
  assert.ok(/brand-amber/.test(state), '警語不是警示色');

  // 儲存只擋防呆上限，不擋 40 —— 擋了就與「只給警語」自相矛盾。
  const save = src.slice(src.indexOf('async function handleSaveBio'), src.indexOf('async function handleSaveBio') + 700);
  assert.ok(/bio\.length > BIO_HARD_MAX/.test(save), 'handleSaveBio 沒有擋防呆上限');
  assert.ok(!/bio\.length > BIO_MAX\b/.test(save),
    'handleSaveBio 擋了建議長度 —— 畫面只說「會被截斷」卻存不進去，自相矛盾');
});

check('預覽已移除，不得留下殘骸', () => {
  const src = stripComments(fs.readFileSync(PAGE, 'utf8'));
  // owner 2026-08-17 決定拿掉預覽卡。留著半截元件比沒有更糟 ——
  // 下一個人會以為它還在用，然後去維護一段永遠不會渲染的程式。
  assert.ok(/handleSaveBio/.test(src), '掃描已失效：找不到 handleSaveBio');
  assert.ok(!/BioPreviewCard/.test(src), '預覽卡仍在（已決定移除）');
  assert.ok(!/NT\$ 9,000/.test(src), '假的示意價格仍留在頁面上');
  assert.ok(!/import CoachCard/.test(src), '教練端頁面引用了家長端小卡');

  // 家長端小卡仍必須是 line-clamp-2 —— BIO_MAX=40 這個數字是從它算出來的。
  const card = stripComments(fs.readFileSync(CARD, 'utf8'));
  assert.ok(/line-clamp-2/.test(card),
    '家長端小卡已不是 line-clamp-2 —— 建議長度 40 是從兩行推算的，要跟著重算');
});

check('詳細介紹：與短簡介是兩個欄位，各自儲存', () => {
  const api = stripComments(fs.readFileSync(API, 'utf8'));
  const page = stripComments(fs.readFileSync(PAGE, 'utf8'));

  // 兩個欄位不可以互相覆蓋 —— 它們在不同的摺疊區塊，只送其中一個是常態。
  assert.ok(/bio_detail = COALESCE\(\$3, bio_detail\)/.test(api),
    'bio_detail 沒有用 COALESCE —— 只儲存短簡介時會把詳細介紹清空');
  assert.ok(/BIO_DETAIL_TOO_LONG/.test(api), '詳細介紹沒有長度守門');

  // 前後端上限要一致，否則畫面說可以存、送出卻被打回。
  const a = /const BIO_DETAIL_MAX = (\d+);/.exec(api);
  const b = /const BIO_DETAIL_MAX = (\d+);/.exec(page);
  assert.ok(a && b, '前後端沒有各自定義 BIO_DETAIL_MAX');
  assert.strictEqual(a[1], b[1], '詳細介紹上限前後端不一致：' + a[1] + ' vs ' + b[1]);

  // 展開時帶入短簡介只是畫面預設值，不可自動寫進 DB ——
  // DB 為空代表「他還沒補充」，那個事實要留著。
  assert.ok(/if \(!detail\.trim\(\) && bio\.trim\(\)\) setDetail\(bio\)/.test(page),
    '展開詳細介紹時沒有帶入個人介紹當起點');
});

check('家長端詳細頁：優先顯示詳細介紹，退回短簡介', () => {
  const modal = stripComments(fs.readFileSync(
    path.join(ROOT, 'client/liff/src/components/CoachDetailModal.jsx'), 'utf8'));
  assert.ok(/coach\.bio_detail\?\.trim\(\) \|\| coach\.bio\?\.trim\(\)/.test(modal),
    '沒有「詳細介紹優先、退回短簡介」的順序');
  assert.ok(/尚未填寫介紹/.test(modal), '兩段都空時沒有提示');
});

check('「看詳細介紹」只在家長真的看得到圖時出現', () => {
  const card = stripComments(fs.readFileSync(
    path.join(ROOT, 'client/liff/src/components/CoachCard.jsx'), 'utf8'));
  assert.ok(/coach\.has_public_media/.test(card),
    '沒有用 has_public_media 把關 —— 沒圖的教練也會出現按鈕，點開是空的');
  assert.ok(/e\.stopPropagation\(\)/.test(card),
    '沒有擋冒泡 —— 整張卡是一顆 button，點介紹會直接把教練選下去');

  // 旗標必須把「未發布」算進去，否則按鈕會開出一個沒有照片的空詳細頁。
  const scope = fs.readFileSync(path.join(ROOT, 'server/services/coachVenueScope.js'), 'utf8');
  assert.ok(/intro_review_status = 'published'[\s\S]{0,140}coach_bio_media/.test(scope),
    'has_public_media 沒有卡發布狀態');
});


if (failures) { console.error('\ncoach_bio_limit_test: ' + failures + ' failed'); process.exit(1); }
console.log('coach_bio_limit_test: all passed');