'use strict';
// e2e 只能連拋棄式測試庫（比照 scripts/run-tests.js 的 db 層，fail-closed）。
//
// e2e 會建立、修改、刪除資料。原本直接吃 DATABASE_URL，在正式環境的 shell
// 跑一次就會寫進正式庫。這裡只認 TEST_DATABASE_URL，沒設或與 DATABASE_URL
// 相同就拒絕，而且在任何 DB 連線之前就結束。
//
// run_all.js 檢查通過後，把子行程的 DATABASE_URL 換成測試庫再傳進去，各路徑檔
// （含凍結的 path_c／admin_manual_deduction／group_partner_checkin）不用改。
// 子行程裡兩者本來就相同，所以帶一個標記，讓 _accounts.js 不會把它誤判成「相同而拒絕」。
const VERIFIED = 'E2E_TEST_DATABASE_VERIFIED';

function resolveTestDatabaseUrl(env = process.env) {
  const url = String(env.TEST_DATABASE_URL || '').trim();
  if (!url) {
    return { error: 'e2e 需要 TEST_DATABASE_URL（指向拋棄式測試庫）。刻意不沿用 DATABASE_URL：e2e 會建立與刪除資料，對正式庫執行會毀資料。' };
  }
  const verifiedByRunner = env[VERIFIED] === url;
  if (!verifiedByRunner && url === String(env.DATABASE_URL || '').trim()) {
    return { error: 'TEST_DATABASE_URL 與 DATABASE_URL 相同，拒絕執行 e2e。' };
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

module.exports = { resolveTestDatabaseUrl, requireTestDatabaseUrl, childEnv };
