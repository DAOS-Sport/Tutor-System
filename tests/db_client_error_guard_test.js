/**
 * 借出中的連線死掉，不可以殺掉整個 process。
 *
 * 2026-08-25 05:01:16 正式站就是這樣掛的：Neon 重啟 compute（57P01），
 * 撞上執行中的查詢；enrollments 那支查詢有好好回報錯誤，但緊接著同一個
 * client 補發的第二個 'error' 事件沒有任何聽眾 —— EventEmitter 對無人聽的
 * 'error' 的行為是直接 throw，伺服器就倒了。
 *
 * 起因在 pg-pool：client 一被借出，它就拿掉自己的 idle error listener
 * （pg-pool/index.js:344），把那段期間的錯誤交給借用者。但 pg 是從 socket
 * callback 發出事件的，不在任何 promise 鏈上，借用者的 try/catch 根本接不到。
 *
 * 這個守衛被拿掉的話，症狀是「伺服器偶爾自己重啟」，沒有任何測試會自然變紅
 * —— 所以這裡直接盯住行為本身。
 */
const assert = require('assert');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');

const { guardCheckedOutClient } = require(
  path.resolve(__dirname, '../server/models/db'));

let failures = 0;
function check(label, fn) {
  try { fn(); console.log('  ok  ' + label); }
  catch (e) { failures++; console.error('  FAIL ' + label + ' → ' + e.message); }
}

// pg client 的最小替身：EventEmitter + release。不連 DB。
function fakeClient() {
  const c = new EventEmitter();
  c.released = [];
  c.release = function (...args) {
    if (c.released.length) throw new Error('Release called on client which has already been released');
    c.released.push(args);
  };
  return c;
}

check('借出後 error 事件有聽眾（沒有的話 emit 會炸掉 process）', () => {
  const c = guardCheckedOutClient(fakeClient());
  assert.strictEqual(c.listenerCount('error'), 1);
});

check('連線死掉時 emit error 不會 throw', () => {
  const c = guardCheckedOutClient(fakeClient());
  assert.doesNotThrow(() => {
    c.emit('error', Object.assign(new Error('Connection terminated unexpectedly'), { code: '57P01' }));
  }, '這一個 throw 在正式站就是整台伺服器重啟');
});

check('歸還後聽眾要移除（否則同一條連線重複借出會愈疊愈多）', () => {
  const c = guardCheckedOutClient(fakeClient());
  c.release();
  assert.strictEqual(c.listenerCount('error'), 0);
});

check('歸還之後就不再接住 —— 那時該由 pool 的 handler 負責', () => {
  const c = guardCheckedOutClient(fakeClient());
  c.release();
  assert.throws(() => c.emit('error', new Error('boom')));
});

check('release 的參數原樣傳遞（帶 err 代表銷毀連線，不能被吃掉）', () => {
  const c = guardCheckedOutClient(fakeClient());
  const err = new Error('destroy me');
  c.release(err);
  assert.deepStrictEqual(c.released[0], [err]);
});

check('重複歸還仍然 throw（pg-pool 的保護不能被包裝弄丟）', () => {
  const c = guardCheckedOutClient(fakeClient());
  c.release();
  assert.throws(() => c.release(), /already been released/);
});

check('pool.connect 真的有用上這個守衛', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../server/models/db.js'), 'utf8');
  const i = src.indexOf('pool.connect = ');
  assert.ok(i >= 0, '找不到 pool.connect 的包裝');
  assert.ok(src.slice(i).includes('guardCheckedOutClient'),
    '守衛存在但沒有接到 pool.connect 上，等於沒做');
});

console.log(failures ? `\n${failures} FAILED` : '\ndb_client_error_guard: ALL PASS');
process.exitCode = failures ? 1 : 0;

