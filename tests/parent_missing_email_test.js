/**
 * 建檔缺 Email 不可以是無聲的。
 *
 * 2026-08-29 盤點：555 位在職家長裡 59 位沒有 Email（10.6%），牽連 75 位學員。
 * 這些人寫不回 Ragic（Z01「(報)Email」是必填欄）、加不了學員、每次開 App 都
 * 看到「Ragic Z01 查無剛寫入的會員資料」—— 而且累積了六週沒有人知道。
 *
 * 成因是驗證放錯層：系統有十二處會建立本地家長，Email 必填只有註冊表單那一道
 * 在擋（auth.js 的 EMAIL_REQUIRED）。手機綁定、Z03 認領、Ragic 拉回、備份同步、
 * 後台建檔都是直接拿 Ragic 資料建檔，Ragic 沒有就跟著沒有。
 * 證據：Email 於 08-03 改必填之後，08-28 仍有一位（Z01#126）以綁定路徑進來。
 *
 * 這裡盯兩件事：
 *   1. upsertLocalParent（十二條路徑的收斂點）會對缺 Email 留下明確痕跡
 *   2. 它「不擋」—— Ragic 上本來就沒 Email 的舊生若被擋就綁不了帳號，
 *      那是把資料品質問題換成一個新的停擺
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'server/services/parentSync.js'), 'utf8');

let failures = 0;
function check(label, fn) {
  try { fn(); console.log('  ok  ' + label); }
  catch (e) { failures++; console.error('  FAIL ' + label + ' → ' + e.message); }
}

function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

check('收斂點會對缺 Email 留下痕跡', () => {
  const code = stripComments(src);
  assert.ok(/function _warnMissingEmail/.test(code), '找不到 _warnMissingEmail');
  assert.ok(/_warnMissingEmail\(/.test(code.replace(/function _warnMissingEmail/, '')),
    '定義了但沒有呼叫 —— 等於沒做');
});

check('痕跡要說得出後果與該做什麼', () => {
  const i = src.indexOf('function _warnMissingEmail');
  const body = src.slice(i, src.indexOf('\n}', i));
  assert.ok(/補齊 Email|需請櫃檯/.test(body),
    '訊息要指出「請櫃檯補 Email」，否則看到的人不知道要幹嘛');
  assert.ok(/Ragic/.test(body), '要說明後果（寫不回 Ragic）');
});

check('缺 Email 不擋建檔', () => {
  const i = src.indexOf('function _warnMissingEmail');
  const body = src.slice(i, src.indexOf('\n}', i));
  assert.ok(!/throw /.test(body),
    '這裡不可以 throw：Ragic 上本來就沒 Email 的舊生會因此綁不了帳號，'
    + '等於把資料品質問題換成一個新的停擺');
});

check('電話有遮罩，不把完整號碼寫進 log', () => {
  const i = src.indexOf('function _warnMissingEmail');
  const body = src.slice(i, src.indexOf('\n}', i));
  assert.ok(/\*\*\*\*/.test(body), 'log 不該出現完整手機號');
});

console.log(failures ? `\n${failures} FAILED` : '\nparent_missing_email: ALL PASS');
process.exitCode = failures ? 1 : 0;

