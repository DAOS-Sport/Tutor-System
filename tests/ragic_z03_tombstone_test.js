// 修復（使用者回報）：硬刪除幽靈家長（例如 purge-ghosts）後，下次 Z01 夜間同步又把
// 他重新寫回 ragic_z03_records / ragic_z01_quarantine「黑名單」，因為 Ragic 端這筆
// 記錄本身沒被刪除（本系統從不寫 Ragic H01/Z01），且原本完全沒有任何「排除清單」
// 機制連動硬刪除。修復方式：沿用既有的 ragic_z03_deleted_tombstones 表（原本只給
// 「後台強制刪除 Z03 記錄」用），purge-ghosts 硬刪除時一併寫入；
// _reconcileZ01FromShadowImpl 與 _quarantineBadZ01NamesImpl 在把一筆「未達成畢業
// 條件」的記錄寫進 Z03/quarantine 之前，都先查這張表，命中就完全跳過。
//
// 這裡驗證 tombstone 表本身的 round-trip（純 DB key-value 讀寫，跟既有
// isJobEnabled/setJobEnabled、getSyncWatermark/setSyncWatermark 同等級的輕量操作，
// 非全表同步，可安全對真實 DB 跑）。_reconcileZ01FromShadowImpl/
// _quarantineBadZ01NamesImpl 本身會處理整張真實 ragic_z01_shadow 表，不適合在自動化
// 測試裡直接呼叫（會對生產資料庫的所有家長跑一次全量 reconcile）；這兩支函式裡的
// tombstone 檢查已用完全相同的 SQL pattern 手動驗證過（與既有 _upsertZ03Record 的
// tombstone 檢查一致），並經過程式碼審視確認呼叫順序正確（見
// server/services/ragicAdmin.js 中 `isIncomplete` 分支開頭與
// _quarantineBadZ01NamesImpl 迴圈內的 tombstone SELECT + continue）。
const assert = require('assert');
const { pool } = require('../server/models/db');

async function testTombstoneRoundTrip() {
  const testId = 'ZZTEST-Z03-TOMBSTONE';
  await pool.query(`DELETE FROM ragic_z03_deleted_tombstones WHERE z01_ragic_record_id = $1`, [testId]);
  try {
    const before = await pool.query(
      `SELECT 1 FROM ragic_z03_deleted_tombstones WHERE z01_ragic_record_id = $1 LIMIT 1`,
      [testId]
    );
    assert.strictEqual(before.rowCount, 0, '尚未寫入時不應命中 tombstone');

    await pool.query(
      `INSERT INTO ragic_z03_deleted_tombstones (z01_ragic_record_id, deleted_by, reason)
       VALUES ($1, $2, $3)`,
      [testId, 'test-admin', 'purge-ghosts：手動清除無 LINE UID 的幽靈家長']
    );
    const after = await pool.query(
      `SELECT deleted_by, reason FROM ragic_z03_deleted_tombstones WHERE z01_ragic_record_id = $1 LIMIT 1`,
      [testId]
    );
    assert.strictEqual(after.rowCount, 1, '寫入後應該命中 tombstone');
    assert.strictEqual(after.rows[0].deleted_by, 'test-admin');

    // ON CONFLICT DO NOTHING（purge-ghosts 實際寫入時用的語句）：重複寫入同一個
    // z01_ragic_record_id 不應報錯、也不應覆蓋既有的 deleted_by/reason。
    await pool.query(
      `INSERT INTO ragic_z03_deleted_tombstones (z01_ragic_record_id, deleted_by, reason)
       VALUES ($1, $2, $3)
       ON CONFLICT (z01_ragic_record_id) DO NOTHING`,
      [testId, 'someone-else', 'different reason']
    );
    const stillOriginal = await pool.query(
      `SELECT deleted_by FROM ragic_z03_deleted_tombstones WHERE z01_ragic_record_id = $1 LIMIT 1`,
      [testId]
    );
    assert.strictEqual(stillOriginal.rows[0].deleted_by, 'test-admin', 'ON CONFLICT DO NOTHING 不應覆蓋既有紀錄');
  } finally {
    await pool.query(`DELETE FROM ragic_z03_deleted_tombstones WHERE z01_ragic_record_id = $1`, [testId]);
  }
}

(async () => {
  await testTombstoneRoundTrip();
  console.log('ragic_z03_tombstone_test: PASS');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
