'use strict';
/**
 * 對帳成功通知信：模板與 mailer 的行為鎖。
 *
 * 這支測試不連 DB、不出網路。mailer 的「真的寄出」那條路徑本來就需要外部 SMTP，
 * 不在 UNIT 層驗；這裡驗的是**沒設定時的行為**——那才是預設狀態，也是最容易
 * 被寫成「安靜地假裝寄成功」的地方。
 */
const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const templates = require(path.join(ROOT, 'server/services/emailTemplates'));
const mailer = require(path.join(ROOT, 'server/services/mailer'));

let failures = 0;
function check(label, fn) {
  const run = () => {
    console.log('  ok   ' + label);
  };
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(run, (e) => { failures += 1; console.error('  FAIL ' + label + '\n       ' + e.message); });
    }
    run();
  } catch (e) {
    failures += 1;
    console.error('  FAIL ' + label);
    console.error('       ' + e.message);
  }
  return Promise.resolve();
}

const MAIL_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_SECURE', 'MAIL_DRY_RUN', 'MAIL_TEST_RECIPIENT',
  // 別名也要納入清理範圍，否則前一個案例設的密碼會漏到下一個案例，
  // 讓「什麼都沒設」那項假性通過。
  'Tutor_gmail', 'TUTOR_GMAIL', 'tutor_gmail'];
async function withEnv(vars, fn) {
  const old = {};
  MAIL_KEYS.forEach((k) => { old[k] = process.env[k]; delete process.env[k]; });
  Object.keys(vars).forEach((k) => { process.env[k] = vars[k]; });
  try {
    return await fn();
  } finally {
    MAIL_KEYS.forEach((k) => {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    });
  }
}

const ORDER = {
  id: 'E1',
  students: ['王小明'],
  course_type: 2,
  coach: '陳慈揚',
  final_price: 3375,
  period_number: 1,
  period_count: 1,
  submitted_at: '2026-08-09T08:32:54.892Z',
};
const BASE = {
  parentName: '王大明',
  venueName: '三重商工',
  orders: [ORDER],
  invoiceNumber: 'DL02996134',
  totalAmount: 3375,
  liffUrl: 'https://liff.line.me/2009958451-NmGZ4135',
  issuedAt: '2026-08-09T13:41:16.794Z',
};

console.log('reconcile_email_test');

(async () => {

await check('主旨＝【家教班報名成功通知】夢想體育-{館別}（發票號碼：{號碼}）', () => {
  const { subject } = templates.reconcileSuccess(BASE);
  assert.strictEqual(subject, '【家教班報名成功通知】夢想體育-三重商工（發票號碼：DL02996134）');
});

await check('發票號碼不加破折號（DB 實測 492/492 皆為 10 碼無破折號）', () => {
  const { subject, html, text } = templates.reconcileSuccess(BASE);
  for (const [name, s] of [['subject', subject], ['html', html], ['text', text]]) {
    assert.ok(s.includes('DL02996134'), name + ' 少了發票號碼');
    assert.ok(!/DL-\d{8}/.test(s), name + ' 出現破折號版本（LINE 模板才那樣顯示，Email 要與主旨一致）');
  }
});

await check('單筆訂單：八個欄位平鋪，不出現明細表', () => {
  const { html, text } = templates.reconcileSuccess(BASE);
  ['狀態', '項目', '館別', '報名日期', '教練名稱', '費用', '期數', '發票號碼'].forEach((label) => {
    assert.ok(html.includes(label), 'html 少了欄位「' + label + '」');
  });
  assert.ok(html.includes('一對多'), '狀態應為一對多（course_type=2）');
  assert.ok(html.includes('1對2'), '項目應為 1對2');
  assert.ok(html.includes('2026/08/09'), '報名日期應為台北時區的 2026/08/09');
  assert.ok(html.includes('陳慈揚') && html.includes('NT$ 3,375'), '教練或費用沒帶到');
  assert.ok(!html.includes('報名筆數'), '單筆不應出現多筆才有的「報名筆數」');
  assert.ok(text.includes('項目：1對2'), '純文字版少了項目');
});

await check('狀態欄：1 對 1 → 一對一', () => {
  const { html } = templates.reconcileSuccess({ ...BASE, orders: [{ ...ORDER, course_type: 1 }] });
  assert.ok(html.includes('一對一'), 'course_type=1 應顯示一對一');
  assert.ok(html.includes('1對1'), '項目應為 1對1');
});

await check('多筆訂單：出現明細表與費用合計，不硬湊成單一教練/項目', () => {
  const orders = [ORDER, { ...ORDER, id: 'E2', students: ['王小美'], course_type: 1, coach: '林教練', final_price: 6000 }];
  const { html, text } = templates.reconcileSuccess({ ...BASE, orders, totalAmount: 9375 });
  // Owner 2026-08-11 把這一格從「報名筆數 N 筆」改成「報名期數 N 期」——
  // 數列會把同一筆訂單的兄弟姊妹算成兩筆。
  assert.ok(html.includes('報名期數'), '多筆應顯示報名期數');
  assert.ok(html.includes('NT$ 9,375'), '應顯示費用合計');
  assert.ok(html.includes('王小美') && html.includes('林教練'), '明細表應列出每一筆');
  assert.ok(text.includes('王小美'), '純文字版也要有明細');
});

await check('提醒事項與 CTA 文案', () => {
  const { html, text } = templates.reconcileSuccess(BASE);
  assert.ok(html.includes('上課當日請務必至系統完成簽到'), '提醒事項文案不符');
  assert.ok(html.includes('點擊登入家教系統'), 'CTA 文案不符');
  assert.ok(html.includes(BASE.liffUrl), 'CTA 沒有指向 LIFF URL');
  assert.ok(text.includes(BASE.liffUrl), '純文字版也要有連結');
});

await check('信裡完全沒有圖片；若日後加圖必須是 cid:，且不得有 /uploads 連結', () => {
  const { html, text } = templates.reconcileSuccess({ ...BASE, hasInvoiceAttachment: true });
  const srcs = Array.from(html.matchAll(/<img[^>]*\bsrc="([^"]*)"/gi)).map((m) => m[1]);
  // 2026-08-12 起海報已移除，正常情況這裡就是 0 張。
  assert.strictEqual(srcs.length, 0,
    '信裡出現了圖片：' + srcs.join(', ') + '。海報已於 2026-08-12 移除，'
    + '若是刻意加回來，請一併更新這條斷言');
  // 下面兩條是安全邊界，與有沒有圖無關，必須永遠成立：
  // /uploads/* 是完全公開無認證的路徑（server/index.js），放連結等於任何拿到
  // 網址的人都看得到發票。附件只跟著這封信走。
  assert.ok(!/\/uploads\//.test(html), 'html 出現 /uploads/ 連結');
  assert.ok(!/\/uploads\//.test(text), 'text 出現 /uploads/ 連結');
  assert.ok(!html.includes('報名網址'), 'html 仍有「家長報名網址」');
  // 外部網址的圖會被大多數郵件客戶端預設擋掉，變成破圖框；也會洩漏開信行為。
  assert.ok(!/<img[^>]*src="https?:/i.test(html), '出現外部網址的圖片，必須改用 cid: 內嵌');
});

await check('使用說明海報已移除：HTML 與純文字版都不得殘留', () => {
  // 海報教的是「加入場館官方帳號 → 圖文選單」，而登入按鈕現在就直接開該館
  // 官方帳號、關鍵字也打好了。兩邊只清一邊的話，純文字版會留下一句
  //「本信附有圖解說明」指向一個不存在的附件。
  const { html, text } = templates.reconcileSuccess({ ...BASE, hasInvoiceAttachment: true });
  for (const needle of ['parent-guide', 'cid:', '圖解說明', '圖文選單', '如何進入家教系統', '依下圖']) {
    assert.ok(!html.includes(needle), `HTML 仍殘留海報相關內容：${needle}`);
    assert.ok(!text.includes(needle), `純文字版仍殘留海報相關內容：${needle}`);
  }
  // 掃描失效偵測：信本身要還是完整的，不能因為樣板整個壞掉而「什麼都找不到」。
  assert.ok(html.length > 1000 && text.length > 200, '信的內容短得不合理，樣板可能壞了');
  assert.ok(html.includes('點擊登入家教系統'), '海報拿掉了，登入按鈕更不能跟著不見');
});

await check('登入按鈕仍在，且是 CTA 區唯一的東西', () => {
  const { html } = templates.reconcileSuccess({ ...BASE });
  assert.ok(html.includes('點擊登入家教系統'), '登入按鈕不見了');
  assert.ok(html.includes(BASE.liffUrl), '按鈕沒有指向 LIFF URL');
});

await check('有發票附件 → 信裡要講；沒有 → 不可以說有', () => {
  const withAtt = templates.reconcileSuccess({ ...BASE, hasInvoiceAttachment: true });
  const without = templates.reconcileSuccess({ ...BASE, hasInvoiceAttachment: false });
  assert.ok(withAtt.html.includes('發票影本已附於本信附件'), '有附件卻沒說明');
  assert.ok(withAtt.text.includes('發票影本已附於本信附件'), '純文字版沒說明');
  assert.ok(!without.html.includes('發票影本已附於本信附件'),
    '沒附件卻說有 —— 家長會去翻一個不存在的附件，然後打電話問櫃檯');
});

await check('純文字版：登入連結要給，且在結尾聲明之前', () => {
  const { text } = templates.reconcileSuccess({ ...BASE });
  assert.ok(text.includes(BASE.liffUrl), '純文字版少了直接登入的連結');
  assert.ok(text.includes('點擊登入家教系統：'), '純文字版少了連結的標籤');
  const tail = '本信件由系統自動發送';
  assert.ok(text.includes(tail), '結尾聲明不見了 —— 掃描失效');
  assert.ok(text.indexOf(BASE.liffUrl) < text.indexOf(tail),
    '連結被排到結尾聲明之後，家長會看不到');
});

await check('HTML escape：使用者可控欄位含標籤不會注入', () => {
  const PAYLOAD = '<script>alert(1)</script>';

  // 2026-08-18 起稱謂固定「親愛的家長」，parentName 不再進 HTML。
  // 那條注入面消失了，但姓名也不該從別的縫漏出去 —— 兩件事都驗。
  const byName = templates.reconcileSuccess({ ...BASE, parentName: PAYLOAD });
  assert.ok(!byName.html.includes(PAYLOAD), '家長姓名原樣進了 HTML');
  assert.ok(!/親愛的\s*&lt;script/.test(byName.html), '稱謂又把家長姓名帶進去了');

  // 覆蓋不能因為稱謂改版而流失：改驗仍然會被渲染的使用者可控欄位。
  // 場館名與學員名都來自 Ragic／家長填寫，是真正的注入來源。
  for (const [label, payload] of [
    ['場館名', { ...BASE, venueName: PAYLOAD }],
    // 學員名只在「多筆訂單」的明細表裡渲染；單筆走 single 版面沒有那張表，
    // 用一筆訂單測等於什麼都沒測（第一版就踩到，assert 直接紅）。
    ['學員名', { ...BASE, orders: [BASE.orders[0], { ...BASE.orders[0], students: [PAYLOAD] }] }],
  ]) {
    const { html } = templates.reconcileSuccess(payload);
    assert.ok(!html.includes(PAYLOAD), label + ' 沒有被 escape，原樣進了 HTML');
    assert.ok(html.includes('&lt;script&gt;'), label + ' 應被 escape 成實體');
  }
});

await check('缺欄位不會爆，也不會印出 undefined / null', () => {
  const { subject, html, text } = templates.reconcileSuccess({ orders: [{}] });
  assert.ok(subject.length > 0, '主旨不該是空的');
  for (const [name, s] of [['html', html], ['text', text]]) {
    assert.ok(!/undefined/.test(s), name + ' 印出了 undefined');
    assert.ok(!/\bnull\b/.test(s), name + ' 印出了 null');
  }
});

// 這裡用假的 16 碼假密碼，格式與 Gmail 應用程式密碼相同（4 組 4 碼、空格分隔）。
// 這支測試要驗的是「帶空格的密碼會被去掉空格」，跟值是不是真的無關。
// 曾經有人把正式站真的那組貼進來 —— 測試檔進版控，等於把 Secret 推上去。
await check('只設 Tutor_gmail（專案既有命名）就足以視為已設定', () => withEnv({
  Tutor_gmail: 'abcd efgh ijkl mnop',
}, async () => {
  assert.strictEqual(mailer.isConfigured(), true,
    '只有 Tutor_gmail 時仍判為未設定 —— 那正是「Secrets 有值但 mail.configured=false」的成因');
  const c = mailer.config();
  assert.strictEqual(c.pass, 'abcdefghijklmnop',
    'Gmail 顯示的應用程式密碼帶空格，沒去掉的話認證必定失敗（且錯誤訊息看不出原因）');
  assert.strictEqual(c.host, 'smtp.gmail.com', '密碼來自 Gmail 別名時應自動用 Gmail 主機');
  assert.ok(c.user.includes('@'), '應有預設寄件位址');
  assert.strictEqual(c.from, c.user, 'from 未設時應等於 user');
}));

await check('SMTP_* 明確設定時優先於別名', () => withEnv({
  Tutor_gmail: 'aaaa bbbb cccc dddd',
  SMTP_PASS: 'explicit-pass',
  SMTP_HOST: 'smtp.other.com',
  SMTP_USER: 'other@example.com',
}, async () => {
  const c = mailer.config();
  assert.strictEqual(c.pass, 'explicit-pass', 'SMTP_PASS 應優先於 Tutor_gmail');
  assert.strictEqual(c.host, 'smtp.other.com');
  assert.strictEqual(c.user, 'other@example.com');
}));

await check('什麼都沒設仍然是未設定（不可因為有預設值就誤判為已設定）', () => withEnv({}, async () => {
  assert.strictEqual(mailer.isConfigured(), false,
    '沒有任何密碼時必須是未設定 —— 主機與寄件位址的預設值不該讓它看起來像設好了');
  const c = mailer.config();
  assert.strictEqual(c.host, '', '沒密碼時不該填入預設主機');
  assert.strictEqual(c.user, '', '沒密碼時不該填入預設寄件位址');
}));

await check('mailer：沒設定 SMTP → dry_run，且明確不是 sent', () => withEnv({}, async () => {
  const r = await mailer.sendMail({ to: 'a@b.com', subject: 'x', html: '<p>x</p>' });
  assert.strictEqual(r.status, 'dry_run');
  assert.strictEqual(r.sent, false, 'dry_run 絕不能回報 sent —— 那會讓 outbox 記成已寄出');
  assert.strictEqual(r.dryRun, true);
  assert.strictEqual(r.reason, 'SMTP_NOT_CONFIGURED');
  assert.strictEqual(mailer.isConfigured(), false);
}));

await check('mailer：設定完整但 MAIL_DRY_RUN=1 → dry_run', () => withEnv({
  SMTP_HOST: 'smtp.example.com', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'f@example.com', MAIL_DRY_RUN: '1',
}, async () => {
  assert.strictEqual(mailer.isConfigured(), true, '四個變數都在就該算已設定');
  const r = await mailer.sendMail({ to: 'a@b.com', subject: 'x', html: '<p>x</p>' });
  assert.strictEqual(r.status, 'dry_run');
  assert.strictEqual(r.reason, 'MAIL_DRY_RUN');
}));

await check('mailer：收件人無效 → skipped，不 throw', () => withEnv({}, async () => {
  for (const bad of ['', '   ', 'not-an-email', null, undefined]) {
    const r = await mailer.sendMail({ to: bad, subject: 'x', html: 'x' });
    assert.strictEqual(r.status, 'skipped', '收件人 ' + JSON.stringify(bad) + ' 應為 skipped');
    assert.strictEqual(r.sent, false);
  }
}));

await check('mailer：MAIL_TEST_RECIPIENT 會攔截收件人（上線前安全閥）', () => withEnv({
  MAIL_TEST_RECIPIENT: 'me@example.com',
}, async () => {
  const r = await mailer.sendMail({ to: 'parent@example.com', subject: 'x', html: 'x' });
  assert.strictEqual(r.to, 'me@example.com', '沒有被導向測試收件人');
}));

await check('mailer：設定不完整（只有 host）仍算未設定，不會嘗試連線', () => withEnv({
  SMTP_HOST: 'smtp.example.com',
}, async () => {
  assert.strictEqual(mailer.isConfigured(), false, '缺 user/pass/from 就不該算已設定');
  const r = await mailer.sendMail({ to: 'a@b.com', subject: 'x', html: 'x' });
  assert.strictEqual(r.status, 'dry_run', '未設定完整時應 dry-run，不該去連一個不存在的 SMTP');
}));

// ── Owner 2026-08-11 指定的四項文案／欄位修改 ──────────────────────────────
// 這封信是家長對「我報了什麼」的唯一書面依據，寫錯就是對外講錯話，
// 所以四項都各鎖一條，而且 HTML 與純文字兩版一起驗（只改一邊過去發生過）。
const ORDERS_2 = [
  { id: 'a', students: ['陳依凱'], course_type: 2, coach: '林芷瑩', final_price: 3375,
    period_number: 1, period_count: 1, submitted_at: '2026-08-10T07:30:00Z' },
  { id: 'b', students: ['陳依萍'], course_type: 2, coach: '林芷瑩', final_price: 3375,
    period_number: 1, period_count: 1, submitted_at: '2026-08-10T07:30:00Z' },
];
const build2 = () => templates.reconcileSuccess({
  parentName: '陳依凱', venueName: '三重商工', orders: ORDERS_2,
  invoiceNumber: 'DL02996195', totalAmount: 6750,
});

await check('內文不再說「款項已完成對帳」（HTML＋純文字）', () => {
  const { html, text } = build2();
  for (const [name, s] of [['html', html], ['text', text]]) {
    assert.ok(/您的報名已完成，課程已為您開通。以下為本次報名資訊：/.test(s), name + ' 沒有新文案');
    assert.ok(!/款項已完成對帳/.test(s), name + ' 仍有舊文案');
  }
});

await check('館別用全名（主旨維持短名，避免手機列表截斷）', () => {
  const { html, text, subject } = build2();
  assert.ok(/夢想體育學院-三重商工游泳池/.test(html), 'HTML 館別不是全名');
  assert.ok(/夢想體育學院-三重商工游泳池/.test(text), '純文字館別不是全名');
  assert.ok(!/夢想體育學院-.*游泳池/.test(subject),
    '主旨也被改成全名了 —— 主旨變長會在手機信件列表被截斷，發票號碼就看不到');
  const nameless = templates.reconcileSuccess({ orders: ORDERS_2, venueName: null });
  assert.ok(!/undefined|null/.test(nameless.html), '缺館別時組出了 undefined/null');
});

await check('報名日期含時分（同日多筆才分得出先後）', () => {
  const { html, text } = build2();
  assert.ok(/2026\/08\/10 15:30/.test(html), 'HTML 日期沒有時分（或時區算錯）');
  assert.ok(/2026\/08\/10 15:30/.test(text), '純文字日期沒有時分');
});

await check('「報名筆數 N 筆」改成「報名期數 N 期」，且值是相異期次數', () => {
  const { html, text } = build2();
  for (const [name, s] of [['html', html], ['text', text]]) {
    assert.ok(/報名期數/.test(s), name + ' 沒有改成「報名期數」');
    assert.ok(!/報名筆數/.test(s), name + ' 仍有「報名筆數」');
  }
  // 兩個小孩、都是第 1 期 → 1 期（不是 2 筆）。這正是 Owner 抓到的那封信。
  assert.ok(/1 期（明細見下表）/.test(html),
    '兩列同期卻沒算成 1 期 —— 那會與下方明細表的期數欄對不起來');
  const twoPeriods = templates.reconcileSuccess({
    venueName: '三重商工', invoiceNumber: 'X',
    orders: [{ ...ORDERS_2[0], period_number: 1 }, { ...ORDERS_2[1], period_number: 2 }],
  });
  assert.ok(/2 期（明細見下表）/.test(twoPeriods.html), '跨兩期沒算成 2 期');
  const dirty = templates.reconcileSuccess({
    venueName: '三重商工', invoiceNumber: 'X',
    orders: ORDERS_2.map((o) => ({ ...o, period_number: null })),
  });
  assert.ok(!/0 期/.test(dirty.html), '期次全為 NULL 時顯示了「0 期」');
});

await check('明細表仍列出每一位學員（併期不等於併人）', () => {
  const { html, text } = build2();
  for (const [name, s] of [['html', html], ['text', text]]) {
    assert.ok(/陳依凱/.test(s) && /陳依萍/.test(s),
      name + ' 少了學員 —— 家長要看到兩個小孩都在，期數併掉的是期不是人');
  }
});

if (failures) {
  console.error('\nreconcile_email_test: ' + failures + ' failed');
  process.exit(1);
}
console.log('reconcile_email_test: all passed');

})();

// ── 稱謂（2026-08-18 owner：一律「親愛的家長」，不帶名字）──
// 這支樣板有 HTML 與純文字兩份，稱謂各寫一次。8/12 改四項時就漏改過純文字版一次，
// 所以這裡兩份都驗 —— 只驗其中一邊等於沒驗。
{
  const out = templates.reconcileSuccess({
    parentName: '王大明', venueName: '三重商工',
    orders: [{ students: ['王小明'], course_type: 2, period_number: 1, total_sessions: 6 }],
    invoiceNumber: 'DL00000001', totalAmount: 6900, issuedAt: '2026-08-18T10:00:00+08:00',
  });
  for (const [label, body] of [['HTML', out.html], ['純文字', out.text]]) {
    assert.ok(/親愛的家長，您好：/.test(body), label + ' 版稱謂不是「親愛的家長」');
    assert.ok(!/親愛的\s*王大明/.test(body), label + ' 版仍把家長姓名放進稱謂');
    assert.ok(!/親愛的.{0,8}家長 家長/.test(body), label + ' 版出現重複的「家長」');
  }
  // 掃描失效偵測：兩份都必須是真的信件內容，不是空字串。
  // 門檻只是「不是空字串」的下限。單筆訂單的純文字版實測 189 字元 ——
  // 訂太高會變成假紅（我第一版寫 200 就踩到了）。
  assert.ok(out.html.length > 500 && out.text.length > 100, '樣板輸出過短，上面的斷言不可信');
  console.log('  ok   稱謂：HTML 與純文字兩版都是「親愛的家長」');
}
