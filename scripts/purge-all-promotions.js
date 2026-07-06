#!/usr/bin/env node
/**
 * 優惠活動資料清空（Workstream D，一次性維運腳本）
 *
 * 使用者已明確確認：這是「一次性資料清除操作」，非模組重構；且明確選擇
 * 「永久硬刪除」（非封存）目前系統內全部 promotions 及其 promotion_usages
 * 使用紀錄，清除後無法復原。
 *
 * 刪除順序（FK-safe）：因 promotion_usages.promotion_id 對 promotions 有
 * ON DELETE RESTRICT FK（見 db/migrations/006_promotions.sql:41），必須先刪
 * promotion_usages 再刪 promotions，否則會被 RESTRICT 擋下。
 * （promotion_audit_logs.promotion_id 是 ON DELETE CASCADE，刪 promotions 時
 *  會自動一併清掉，不需要另外處理，但仍在下方摘要一併印出供人工確認。）
 *
 * ⚠️ 這支腳本會永久刪除資料，且不可復原。即使已在計畫中取得使用者同意，
 * 實際執行前仍須在當下再次確認要對哪個環境（dev/正式）執行——不可在部署
 * 流程中自動跑，不可排程執行。
 *
 * 用法：
 *   node scripts/purge-all-promotions.js            # dry-run，只印出將被刪除的資料，不動資料庫
 *   node scripts/purge-all-promotions.js --confirm   # 實際執行刪除
 */
const path = require('path');
// 環境變數已由 Replit Secrets 或外層 shell 注入；不依賴 dotenv（server 也沒裝）
const { pool } = require(path.join(__dirname, '..', 'server', 'models', 'db'));

const CONFIRM = process.argv.includes('--confirm');

async function main() {
  const promos = await pool.query(
    `SELECT id, name, status, current_uses FROM promotions ORDER BY created_at`
  );
  const usageCount = await pool.query(`SELECT COUNT(*)::int AS n FROM promotion_usages`);
  const auditCount = await pool.query(`SELECT COUNT(*)::int AS n FROM promotion_audit_logs`);

  console.log(`[purge-all-promotions] 目前 promotions 共 ${promos.rowCount} 筆：`);
  for (const p of promos.rows) {
    console.log(`  - ${p.id}  "${p.name}"  status=${p.status}  current_uses=${p.current_uses}`);
  }
  console.log(`[purge-all-promotions] 關聯 promotion_usages 共 ${usageCount.rows[0].n} 筆`);
  console.log(`[purge-all-promotions] 關聯 promotion_audit_logs 共 ${auditCount.rows[0].n} 筆（ON DELETE CASCADE，刪 promotions 時自動清除）`);

  if (!CONFIRM) {
    console.log('\n[purge-all-promotions] Dry-run 模式（未加 --confirm），以上為將被刪除的資料，尚未做任何變更。');
    console.log('  → 確認要永久刪除以上資料後，重新執行：node scripts/purge-all-promotions.js --confirm');
    await pool.end();
    return;
  }

  if (promos.rowCount === 0) {
    console.log('\n[purge-all-promotions] promotions 目前已經是空的，無需刪除。');
    await pool.end();
    return;
  }

  const client = await pool.connect();
  let deletedUsages = 0;
  let deletedPromos = 0;
  try {
    await client.query('BEGIN');

    const usagesRes = await client.query(
      `DELETE FROM promotion_usages WHERE promotion_id IN (SELECT id FROM promotions)`
    );
    deletedUsages = usagesRes.rowCount;

    const promosRes = await client.query(`DELETE FROM promotions`);
    deletedPromos = promosRes.rowCount;

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[purge-all-promotions] 執行失敗，已 ROLLBACK：', e.message);
    client.release();
    await pool.end();
    process.exitCode = 1;
    return;
  }
  client.release();

  console.log(`\n[purge-all-promotions] 完成。已刪除 promotion_usages ${deletedUsages} 筆、promotions ${deletedPromos} 筆。`);
  console.log('  （promotion_audit_logs 已隨 ON DELETE CASCADE 自動清除）');

  await pool.end();
}

main().catch(async (e) => {
  console.error('[purge-all-promotions] 未預期錯誤：', e);
  process.exitCode = 1;
  try { await pool.end(); } catch (_) { /* ignore */ }
});
