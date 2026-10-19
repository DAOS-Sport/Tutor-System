'use strict';
// 共用交易工具（#35）。新程式一律用它，不要再各自手寫 BEGIN／COMMIT／ROLLBACK。
//
//   const { withTransaction } = require('../models/tx');
//   const order = await withTransaction(async (client) => { ...; return row; });
//
// fn 拋錯 → ROLLBACK 後把原錯誤往上丟；ROLLBACK 本身失敗時仍丟原錯誤（原錯誤才是要查的）。
// 不論成功或失敗，連線一定歸還。

async function withTransaction(fn, db = require('./db').pool) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* 連線已斷，原錯誤較重要 */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { withTransaction };
