const { Pool } = require('pg');
// PostgreSQL startup option applies before the connection is handed to any
// caller. This avoids a race between pool.on('connect') SET TIME ZONE and the
// caller's first query, while still enforcing Taipei on every pooled session.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: '-c timezone=Asia/Taipei',
});

// 閒置中的連線死掉時由 pool 自己接住。
pool.on('error', (err) => console.error('[DB] unexpected error:', err));

// ── 借出中的連線死掉，不可以殺掉整個 process ────────────────────────────
//
// pg-pool 在 client 被借出的那一刻會拿掉自己的 error listener
// （pg-pool/index.js:344 `client.removeListener('error', idleListener)`），
// 理由是那段期間的錯誤該由借用者負責。但 pg 是從 socket callback 發出這個
// 事件的，不在任何 promise 鏈上 —— 借用者的 try/catch 與 .catch() 都接不到。
// EventEmitter 對沒有聽眾的 'error' 的行為是直接 throw，於是整個伺服器死掉。
//
// 這不是理論問題：2026-08-25 05:01:16 正式站就是這樣掛的。Neon 會自動休眠與
// 重啟 compute，57P01（terminating connection due to administrator command）
// 是那裡的常態；只要重啟撞上執行中的查詢，伺服器就跟著倒。當下 enrollments
// 的查詢有好好回報錯誤，緊接著同一個 client 補發的第二個事件才是致命的那個。
//
// 所以在借出期間補一個聽眾。它只做一件事：讓事件有人接。查詢本身的 promise
// 仍然照常 reject，呼叫端該看到的錯誤一個都不會少 —— 這裡不吞任何東西，
// 只是把「沒人聽」這個會炸掉 process 的狀態補起來。
// 抽成獨立函式而不是寫在 connect 裡，是為了讓它能被測 —— 這個守衛
// 一旦被拿掉，症狀是「偶爾整台伺服器重啟」，不會有任何測試自然變紅。
function guardCheckedOutClient(client) {
  const onError = (err) => {
    console.error('[DB] 借出中的連線發生錯誤（已接住，不影響 process）：',
      err && err.code ? `${err.code} ${err.message}` : err);
  };
  client.on('error', onError);

  // 歸還時就把聽眾拿掉，否則同一條實體連線被重複借出會愈疊愈多。
  // pg-pool 的 release 被呼叫第二次時會 throw（_releaseOnce），這裡照原樣
  // 轉呼叫以保留那個保護，只有「移除聽眾」這件事做一次。
  const _release = client.release;
  let cleaned = false;
  client.release = function releaseOnceGuarded(...rest) {
    if (!cleaned) {
      cleaned = true;
      client.removeListener('error', onError);
    }
    return _release.apply(this, rest);
  };
  return client;
}

const _connect = pool.connect.bind(pool);
pool.connect = function guardedConnect(...args) {
  // 回呼式用法交還給原本的實作：它的 client 生命週期不由這裡管。
  if (typeof args[0] === 'function') return _connect(...args);
  return _connect(...args).then(guardCheckedOutClient);
};

module.exports = { pool, guardCheckedOutClient };
