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

const MAIL_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_SECURE', 'MAIL_DRY_RUN', 'MAIL_TEST_RECIPIENT'];
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
  assert.ok(html.includes('報名筆數'), '多筆應顯示報名筆數');
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

await check('不含發票圖片、不含家長報名網址（Owner 決定：圖片引導上系統看）', () => {
  const { html, text } = templates.reconcileSuccess(BASE);
  // /uploads/* 是完全公開無認證的路徑，發票圖連結轉寄出去等同發票外流。
  assert.ok(!/\/uploads\//.test(html), 'html 出現 /uploads/ 連結');
  assert.ok(!/<img/i.test(html), 'html 出現 <img>，本信不放圖');
  assert.ok(!html.includes('報名網址'), 'html 仍有「報名網址」');
  assert.ok(!/\/uploads\//.test(text), 'text 出現 /uploads/ 連結');
});

await check('HTML escape：家長姓名含標籤不會注入', () => {
  const { html } = templates.reconcileSuccess({ ...BASE, parentName: '<script>alert(1)</script>' });
  assert.ok(!html.includes('<script>alert(1)</script>'), '家長姓名沒有被 escape');
  assert.ok(html.includes('&lt;script&gt;'), '應被 escape 成實體');
});

await check('缺欄位不會爆，也不會印出 undefined / null', () => {
  const { subject, html, text } = templates.reconcileSuccess({ orders: [{}] });
  assert.ok(subject.length > 0, '主旨不該是空的');
  for (const [name, s] of [['html', html], ['text', text]]) {
    assert.ok(!/undefined/.test(s), name + ' 印出了 undefined');
    assert.ok(!/\bnull\b/.test(s), name + ' 印出了 null');
  }
});

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

if (failures) {
  console.error('\nreconcile_email_test: ' + failures + ' failed');
  process.exit(1);
}
console.log('reconcile_email_test: all passed');

})();
