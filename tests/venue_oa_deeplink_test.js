'use strict';
/**
 * 報名成功信的「點擊登入家教系統」按鈕 → 該場館的 LINE 官方帳號深連結。
 *
 * 為什麼這條路走得通、而推播走不通（兩者常被混為一談）：
 *   推播 = 我方主動送給某個 uid，跨 provider 認不得對方的 uid → 實測 0/60，必死。
 *   深連結 = 使用者在自己的 LINE App 裡點開一個聊天視窗，我方不需要 uid、
 *            不需要 token → 場館 OA 屬於別的 provider 完全不影響。
 * 所以「該館推播是關的」不能拿來當「該館不該有深連結」的理由。
 *
 * 另一件必須鎖住的事：oaMessage 只會把文字**帶入輸入欄**，不會自動送出。
 * 這是 LINE 的行為，沒有參數可繞（2026-08-12 查證：官方文件自 2017 年文件化
 * 至今九年措辭一致，且 2018／2022 兩筆開發者實測回報同樣結論）。信裡少了
 * 「請按送出」那句，家長就會停在一個已經打好字卻沒動靜的畫面上 —— 所以
 * 那句說明文字本身也是功能的一部分，一併測。
 */
const assert = require('assert');

const routing = require('../server/services/lineRouting');
const templates = require('../server/services/emailTemplates');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failed += 1; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

// 與 reconcileNotify.loginCta 同一套規則。這裡重算而不是 require 那支 ——
// 那支會連帶拉起 db pool 與 objectStorage，unit 層不碰外部相依。
function cta(venueId, fallback) {
  const oa = routing.venueOaDeepLink(venueId, routing.OA_LOGIN_KEYWORD);
  return oa
    ? { loginUrl: oa, loginVia: 'oa', loginKeyword: routing.OA_LOGIN_KEYWORD }
    : { loginUrl: fallback, loginVia: 'liff', loginKeyword: routing.OA_LOGIN_KEYWORD };
}

const ORDERS = [{
  students: ['測試學員'], course_type: 2, coach: '測試教練',
  period_number: 1, period_count: 1, final_price: 3375,
  submitted_at: '2026-08-10T07:30:00Z',
}];

function render(venueId, venueName, fallback = 'https://liff.line.me/2009958451-fallback') {
  return templates.reconcileSuccess({
    parentName: '測試家長', venueName, orders: ORDERS,
    invoiceNumber: 'DL02996195', totalAmount: 3375,
    issuedAt: '2026-08-10T07:30:00Z', guideImageCid: 'parent-guide',
    ...cta(venueId, fallback),
  });
}

/** 抓出按鈕真正的 href —— 只認那顆按鈕，不掃全信（信裡還有別的連結）。 */
function buttonHref(html) {
  const m = html.match(/<a href="([^"]+)"[^>]*>點擊登入家教系統<\/a>/);
  assert.ok(m, '信裡找不到「點擊登入家教系統」按鈕 —— 掃描失效或按鈕被改名');
  return m[1];
}

// ── 1. 對照表本身 ──────────────────────────────────────────────
// 場館代號取自 admin_venues（2026-08-12 實查：B 新北高中 / K 三重商工 /
// L 三民高中 / C 松山國小）。四組 OA ID 同日經 owner 逐一覆核確認無誤 ——
// 所以下面那條 deepStrictEqual 是「已知正確答案」的比對，不是快照式的
// 「現在長怎樣就記怎樣」。要改就是先問 owner，不是先改測試。
const EXPECTED = { B: '@597kqtbz', K: '@703sndbg', L: '@642fcufc', C: '@318wjncz' };

check('四個場館各自對到不同的 OA，一個都沒漏、也沒有兩館共用', () => {
  const ids = Object.keys(EXPECTED).map((v) => routing.venueOaId(v));
  assert.deepStrictEqual(ids, Object.values(EXPECTED),
    '場館 → OA 對照表與預期不符。改動這張表等於改變家長會被帶到哪個官方帳號，'
    + '要先跟 owner 確認再改測試');
  assert.strictEqual(new Set(ids).size, ids.length,
    '有兩個場館共用同一個 OA ID —— 幾乎確定是複製貼上時漏改');
});

check('沒有對應 OA 的場館回 null，而不是硬湊一個', () => {
  // E 新竹科學園區、M 士東國小…等 21 個場館沒有自己的 OA。
  for (const v of ['E', 'M', 'AC', 'Z']) {
    assert.strictEqual(routing.venueOaId(v), null, `場館 ${v} 不該對到任何 OA`);
  }
  assert.strictEqual(routing.venueOaId(null), null, 'venue_id 為 null 時不該爆、也不該對到東西');
  assert.strictEqual(routing.venueOaId(''), null, '空字串同上');
  assert.strictEqual(routing.venueOaId(undefined), null, 'undefined 同上');
});

// ── 2. 連結格式 ────────────────────────────────────────────────
check('深連結是官方現行格式：https://line.me/R/ + percent-encoded ID', () => {
  const url = routing.venueOaDeepLink('B');
  assert.ok(url.startsWith('https://line.me/R/oaMessage/'),
    '必須用 https://line.me/R/ —— line:// 已被官方列為不建議（2020-03-25，'
    + '會被第三方 App 劫持），且沒裝 LINE 的手機會直接看到錯誤頁');
  assert.ok(!url.includes('line://'), '不得出現 line:// scheme');
  assert.ok(url.includes('%40597kqtbz'), 'basic ID 的 @ 必須 percent-encode 成 %40');
  assert.ok(!/oaMessage\/@/.test(url), '@ 沒編碼，部分郵件客戶端會把網址切斷');
});

check('帶入的關鍵字是「新家教系統登入」，且有 encode', () => {
  // 這是官方帳號那端自動回應的觸發字。錯一個字＝家長按了送出但沒有任何回應，
  // 而且我方這端看不出來（訊息進的是對方的 OA，不是我們的 channel）。
  // 所以這條是逐字比對，不是「有中文就好」。
  const url = routing.venueOaDeepLink('K');
  const q = url.split('/?')[1];
  assert.strictEqual(decodeURIComponent(q), '新家教系統登入',
    '關鍵字必須解得回「新家教系統登入」—— owner 2026-08-12 指定，與各館 OA 的自動回應設定一致');
  assert.strictEqual(routing.OA_LOGIN_KEYWORD, '新家教系統登入',
    '匯出的常數與實際帶入的字必須是同一個，否則信裡的說明文字會跟網址講不同的話');
  assert.ok(!/[一-鿿]/.test(url), '網址裡不得有未編碼的中文');
});

// ── 3. env 覆寫（owner 之後給正式 ID 時，不必改 code）──────────
check('LINE_OA_ID_<代號> 可覆寫，別名也吃', () => {
  const restore = { ...process.env };
  try {
    process.env.LINE_OA_ID_B = '@override1';
    assert.ok(routing.venueOaDeepLink('B').includes('%40override1'), '場館代號覆寫沒生效');
    delete process.env.LINE_OA_ID_B;

    process.env.LINE_OA_ID_SANCHONG = '@viaalias';
    assert.ok(routing.venueOaDeepLink('K').includes('%40viaalias'),
      'VENUE_ENV_ALIAS 的館名別名也要能覆寫（與 token 設定方式一致，否則兩套規則會打架）');
  } finally {
    process.env = restore;
  }
});

check('env 設了但格式不合 → 退回 null，不偷用內建值', () => {
  const restore = { ...process.env };
  try {
    for (const bad of ['亂打的', 'no-at-sign', '@有中文', '@a b', 'https://line.me/R/oaMessage/@x/?y']) {
      process.env.LINE_OA_ID_B = bad;
      assert.strictEqual(routing.venueOaId('B'), null,
        `LINE_OA_ID_B="${bad}" 應視為未設定。悄悄退回內建值會讓「我明明改了設定」`
        + '變成一個查不出來的問題，而錯的 ID 是把家長帶到別人的帳號');
    }
  } finally {
    process.env = restore;
  }
});

// ── 4. 信裡實際長出來的東西 ────────────────────────────────────
check('有 OA 的場館：按鈕連到該館 OA，且附上「請按送出」', () => {
  const b = render('K', '三重商工');
  assert.strictEqual(buttonHref(b.html), routing.venueOaDeepLink('K'),
    '按鈕沒有連到三重商工的 OA');
  assert.ok(b.html.includes('直接按送出'),
    'HTML 版少了「請按送出」—— oaMessage 不會自動送出，少這句家長會卡住');
  assert.ok(b.html.includes('三重商工'), '說明文字要指名是哪一館的官方帳號');
  assert.ok(b.text.includes('請按送出取得登入入口'), '純文字版也要有，不能只改 HTML');
  assert.ok(b.text.includes(routing.venueOaDeepLink('K')), '純文字版的連結要跟按鈕同一條');

  // 說明文字裡引述的關鍵字，必須就是網址真的帶進去的那個字。
  // 兩者是分開傳的參數，很容易只改一邊 —— 那會變成信上寫「已帶好 A」、
  // 實際輸入欄跳出 B，家長照著信上的字重打一次反而更亂。
  const inUrl = decodeURIComponent(buttonHref(b.html).split('/?')[1]);
  assert.ok(b.html.includes('「' + inUrl + '」'),
    `說明文字沒有引述網址實際帶入的「${inUrl}」`);
  assert.ok(b.text.includes('「' + inUrl + '」'), '純文字版同上');
});

check('四館各自連到自己的 OA，不會全部指到同一館', () => {
  const seen = new Map();
  for (const [vid, vname] of [['B', '新北高中'], ['K', '三重商工'], ['L', '三民高中'], ['C', '松山國小']]) {
    const href = buttonHref(render(vid, vname).html);
    assert.ok(href.includes(encodeURIComponent(EXPECTED[vid])),
      `${vname} 的信連到的不是它自己的 OA：${href}`);
    seen.set(vid, href);
  }
  assert.strictEqual(new Set(seen.values()).size, 4,
    '四館的按鈕出現重複網址 —— venueId 很可能沒被真的傳進去，全部落到同一個預設值');
});

check('沒有 OA 的場館：退回 LIFF，按鈕不會變成死連結', () => {
  const fallback = 'https://liff.line.me/2009958451-fallback';
  const b = render('E', '新竹科學園區', fallback);
  assert.strictEqual(buttonHref(b.html), fallback, '沒有 OA 時應退回 LIFF 連結');
  assert.ok(!b.html.includes('直接按送出'),
    'LIFF 那條不需要按送出，出現這句是說明文字跟實際行為對不上');
  assert.ok(b.html.includes('無法直接登入嗎'), 'LIFF 那條要保留原本的海報導引說明');
});

check('venue_id 是 null（舊 outbox 補寄）不會壞掉', () => {
  // venueId 是 2026-08-12 才加進 payload 的欄位，在那之前排隊的信沒有這格。
  const fallback = 'https://liff.line.me/2009958451-fallback';
  const b = render(null, '某館', fallback);
  assert.strictEqual(buttonHref(b.html), fallback, '舊資料補寄應與改版前行為相同');
});

check('連 LIFF 都沒設定時，整顆按鈕不出現（而不是連到空字串）', () => {
  const b = templates.reconcileSuccess({
    parentName: '測試家長', venueName: '新竹科學園區', orders: ORDERS,
    invoiceNumber: 'DL02996195', totalAmount: 3375,
    issuedAt: '2026-08-10T07:30:00Z', guideImageCid: 'parent-guide',
    loginUrl: '', loginVia: 'liff',
  });
  assert.ok(!/點擊登入家教系統<\/a>/.test(b.html),
    '沒有可用連結時不該渲染按鈕 —— href="" 會讓家長點了跳到自己的信箱網域');
  assert.ok(!b.html.includes('直接按送出'), '沒有按鈕就不該有按鈕的說明文字');
  assert.ok(b.html.includes('cid:parent-guide'), '按鈕沒了，海報導引更要在');
});

check('舊參數名 liffUrl 仍然有效（既有呼叫端與測試沒被打斷）', () => {
  const b = templates.reconcileSuccess({
    parentName: '測試家長', venueName: '三重商工', orders: ORDERS,
    invoiceNumber: 'DL02996195', totalAmount: 3375,
    issuedAt: '2026-08-10T07:30:00Z',
    liffUrl: 'https://liff.line.me/legacy-param',
  });
  assert.strictEqual(buttonHref(b.html), 'https://liff.line.me/legacy-param');
});

// ── 5. 掃描失效偵測 ────────────────────────────────────────────
// 上面幾條都靠字串比對。萬一樣板整段被改寫、關鍵字再也不出現，
// 那些 assert 會「因為找不到而通過」。這條反過來確認掃描本身還活著。
check('掃描沒有失效：改一個字就要能被抓到', () => {
  const b = render('K', '三重商工');
  assert.ok(b.html.length > 1000, '信的 HTML 短得不合理，樣板可能壞了');
  assert.ok(b.html.includes('點擊登入家教系統'), '按鈕文案不見了 —— 上面的比對全部會變成空轉');
  assert.throws(
    () => buttonHref(b.html.replace('點擊登入家教系統', '點擊登入家教系統X')),
    /找不到/,
    'buttonHref 對改動不敏感，等於沒在測',
  );
});

console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exit(failed ? 1 : 0);
