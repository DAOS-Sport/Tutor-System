/**
 * Demo 測試資料 bootstrap（給「正式部署 DB」用）。
 *
 * 背景：`executeSql({environment:"production"})` 唯讀，agent 無法直接寫正式 DB；
 * 一般使用者也難以對正式 DB 跑 psql。但部署後的 app 本身對正式 DB 有讀寫權，
 * 因此沿用既有 bootstrap 模式（admin.js / coreSchema.js 啟動時 idempotent seed），
 * 以環境變數開關在啟動時執行 `scripts/demo_seed_prod.sql` / `demo_cleanup_prod.sql`。
 *
 * 開關（Replit Secrets）：
 *   DEMO_SEED=seed     → 跑 demo_seed_prod.sql（idempotent，可重複）
 *   DEMO_SEED=cleanup  → 跑 demo_cleanup_prod.sql（marker-scoped 清除）
 *   未設 / 其他值        → 不動作
 *
 * 注意：兩支 SQL 皆為單一 BEGIN…COMMIT，透過 pool.query 一次送出（無參數、不可內插使用者輸入）。
 * 測試完務必把 DEMO_SEED 改成 cleanup 跑一次、再移除此 flag 與 ALLOW_DEMO_LOGIN。
 */
const fs = require('fs');
const path = require('path');
const { pool } = require('../models/db');

const SCRIPTS = {
  seed: path.join(__dirname, '..', 'scripts', 'demo_seed_prod.sql'),
  cleanup: path.join(__dirname, '..', 'scripts', 'demo_cleanup_prod.sql'),
};

async function bootstrap() {
  const raw = (process.env.DEMO_SEED || '').trim().toLowerCase();
  const mode = raw === '1' ? 'seed' : raw; // 容許 DEMO_SEED=1 當 seed
  if (mode !== 'seed' && mode !== 'cleanup') return;

  const file = SCRIPTS[mode];
  let sql;
  try {
    sql = fs.readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`[demoSeed] 找不到 SQL 檔 ${file}：`, err.message);
    return;
  }

  console.log(`[demoSeed] DEMO_SEED=${raw} → 執行 ${path.basename(file)} …`);
  await pool.query(sql);
  console.log(`[demoSeed] ${mode} 完成。`);
}

module.exports = { bootstrap };
