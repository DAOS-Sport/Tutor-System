/**
 * Demo 測試資料 bootstrap，僅限開發環境；正式環境禁止 seed 與 cleanup。
 * 開發環境開關：
 *   DEMO_SEED=seed     → 跑 demo_seed_prod.sql（idempotent，可重複）
 *   DEMO_SEED=cleanup  → 跑 demo_cleanup_prod.sql（marker-scoped 清除）
 *   未設 / 其他值        → 不動作
 *
 * seed 也會刪除並重建測試課程／時段，不可用於保留正式資料的啟動流程。
 */
const fs = require('fs');
const path = require('path');
const { pool } = require('../models/db');

const SCRIPTS = {
  seed: path.join(__dirname, '..', 'scripts', 'demo_seed_prod.sql'),
  cleanup: path.join(__dirname, '..', 'scripts', 'demo_cleanup_prod.sql'),
};

async function bootstrap() {
  if (process.env.NODE_ENV === 'production' || process.env.REPLIT_DEPLOYMENT === '1') {
    console.log('[demoSeed] SKIPPED seed/cleanup in production');
    return;
  }
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
