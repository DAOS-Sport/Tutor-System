'use strict';
// e2e 只能連拋棄式測試庫（比照 scripts/run-tests.js 的 db 層，fail-closed）。
//
// e2e 會建立、修改、刪除資料。原本直接吃 DATABASE_URL，在正式環境的 shell
// 跑一次就會寫進正式庫。這裡只認 TEST_DATABASE_URL，沒設或與 DATABASE_URL
// 指向同一個資料庫就拒絕，而且在任何 DB 連線之前就結束。
//
// 兩個入口都會走到這裡：
//   - run_all.js：檢查後自己用測試庫起 server，再把子行程的 DATABASE_URL 換成測試庫。
//   - _lib.js：單獨執行某一支路徑檔時，載入就檢查並把 DATABASE_URL 換成測試庫。
// 各路徑檔（含凍結的 path_c／admin_manual_deduction／group_partner_checkin）不用改。
const VERIFIED = 'E2E_TEST_DATABASE_VERIFIED';
const EXTERNAL_SERVER = 'E2E_EXTERNAL_SERVER';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// 同一個資料庫可以有很多種寫法（postgres:// vs postgresql://、帳密、查詢參數不同），
// 只比主機＋埠＋庫名。解析不了就回 null，呼叫端一律當成「無法證明不同」而拒絕。
function databaseIdentity(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    if (!/^postgres(ql)?:$/.test(u.protocol)) return null;
    const host = u.hostname.toLowerCase();
    const db = decodeURIComponent(u.pathname.replace(/^\//, ''));
    if (!host || !db) return null;
    return `${LOOPBACK.has(host) ? 'loopback' : host}:${u.port || '5432'}/${db}`;
  } catch {
    return null;
  }
}

function resolveTestDatabaseUrl(env = process.env) {
  const url = String(env.TEST_DATABASE_URL || '').trim();
  if (!url) {
    return { error: 'e2e 需要 TEST_DATABASE_URL（指向拋棄式測試庫）。刻意不沿用 DATABASE_URL：e2e 會建立與刪除資料，對正式庫執行會毀資料。' };
  }
  const testId = databaseIdentity(url);
  if (!testId) return { error: 'TEST_DATABASE_URL 無法解析成 postgres://主機:埠/庫名，拒絕執行 e2e。' };
  if (env[VERIFIED] === url) return { url };
  const current = String(env.DATABASE_URL || '').trim();
  if (current && (current === url || databaseIdentity(current) === testId || !databaseIdentity(current))) {
    return { error: 'TEST_DATABASE_URL 與 DATABASE_URL 指向同一個資料庫（或 DATABASE_URL 無法解析），拒絕執行 e2e。' };
  }
  return { url };
}

function requireTestDatabaseUrl(env = process.env) {
  const { url, error } = resolveTestDatabaseUrl(env);
  if (error) {
    console.error(error);
    process.exit(1);
  }
  return url;
}

function childEnv(url, env = process.env) {
  return { ...env, DATABASE_URL: url, [VERIFIED]: url };
}

// 單獨執行路徑檔（不經 run_all）時：只連測試庫，而且要確認打的 server 也是測試庫。
// run_all 起的 server 已經連測試庫；自己起的 server 程式這裡驗不到，所以要明確聲明。
function useTestDatabase(env = process.env) {
  const underRunner = Boolean(env[VERIFIED]) && env[VERIFIED] === env.DATABASE_URL;
  const url = requireTestDatabaseUrl(env);
  if (!underRunner && env[EXTERNAL_SERVER] !== '1') {
    console.error(`單獨執行 e2e 路徑時，請先確認 BASE_URL 的 server 連的是測試庫，再設 ${EXTERNAL_SERVER}=1；`
      + '或改用 node tests/e2e/run_all.js（會自己用測試庫起 server）。');
    process.exit(1);
  }
  env.DATABASE_URL = url;
  env[VERIFIED] = url;
  return url;
}

module.exports = {
  resolveTestDatabaseUrl, requireTestDatabaseUrl, childEnv, useTestDatabase, databaseIdentity,
  VERIFIED, EXTERNAL_SERVER,
};
