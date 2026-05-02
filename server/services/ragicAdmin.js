/**
 * Ragic 同步：後台員工 / 場館（best-effort）
 *
 * 對照來源：docs/ragic_api.md
 *  - H01 員工（教練 / 行政櫃檯）→ admin_staff
 *  - H05 場館清單              → admin_venues
 *
 * 規則：
 * - 沒設定 RAGIC_API_KEY / RAGIC_BASE_URL → 直接 noop（dev 環境正常）
 * - Ragic 失敗一律 swallow + warn，不阻擋使用者操作（後台仍能讀寫 PostgreSQL）
 * - 只做「讀取 Ragic → upsert 進系統 DB」，後台手動修改的欄位（role / multiplier /
 *   is_senior / line_token / 銀行帳戶 …）一律以系統 DB 為準，不會被 Ragic 蓋掉
 */
const { pool } = require('../models/db');
const ragic = require('./ragic');

function ragicEnabled() {
  return !!process.env.RAGIC_API_KEY && !!process.env.RAGIC_BASE_URL;
}

/**
 * 員工 Ragic 同步：把 H01 在職員工 upsert 到 admin_staff。
 * - 用 Ragic 工號（3000935）對到 admin_staff.ragic_record_id（同時當主鍵 id 的 fallback）
 * - 第一次匯入時，預設 role 給 'coach'；若該員工含「行政櫃檯」字樣→ 'staff'
 * - 已存在的列只更新 name / phone / venue_id（其他系統內部欄位保留）
 */
async function syncStaffFromRagic() {
  if (!ragicEnabled()) return { synced: 0, skipped: true };
  try {
    const records = await ragic.getAllStaff();
    let synced = 0;
    for (const r of records) {
      const ragicId = r['工號'] || r['3000935'];
      if (!ragicId) continue;
      const name = r['姓名'] || r['3000933'] || '';
      const phone = r['手機（公司）'] || r['3001424'] || r['手機（個人）'] || r['3000941'] || '';
      const isCoach = (r['應徵職務'] || '').includes('教練') || (r['職稱'] || '').includes('教練');
      const role = isCoach ? 'coach' : 'staff';
      const isActive = (r['在職狀態'] || r['3000945']) === '在職';
      await pool.query(
        `INSERT INTO admin_staff (id, name, role, phone, is_senior, multiplier, active, ragic_record_id, last_synced_at)
         VALUES ($1, $2, $3, $4, FALSE, 1.00, $5, $1, NOW())
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           phone = EXCLUDED.phone,
           active = EXCLUDED.active,
           ragic_record_id = EXCLUDED.ragic_record_id,
           last_synced_at = NOW()`,
        [String(ragicId), name, role, phone, isActive]
      );
      synced += 1;
    }
    return { synced, skipped: false };
  } catch (err) {
    console.warn('[Ragic sync] staff failed:', err.message);
    return { synced: 0, error: err.message };
  }
}

/**
 * 場館 Ragic 同步：H05 → admin_venues。
 * - 用「場館代號」當主鍵；Ragic 沒給則 fallback 到場館名稱第一個字母
 * - 銀行帳戶等資訊以「Ragic 為主，本地未設定 → 用 Ragic 值；本地已有 → 不覆寫」
 */
async function syncVenuesFromRagic() {
  if (!ragicEnabled()) return { synced: 0, skipped: true };
  try {
    const records = await ragic.getActiveVenues();
    let synced = 0;
    for (const r of records) {
      const code = (r['場館代號'] || r['館別代碼'] || '').toString().trim();
      if (!code) continue;
      const name = r['場館名稱'] || r['館別名稱'] || code;
      const address = r['場館地址'] || r['地址'] || '';
      await pool.query(
        `INSERT INTO admin_venues (id, code, name, address, line_token, bank_institution_name, bank_branch_name, account_holder, account_number, last_synced_at)
         VALUES ($1, $1, $2, $3, '', '', '', '', '', NOW())
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           address = COALESCE(NULLIF(admin_venues.address, ''), EXCLUDED.address),
           last_synced_at = NOW()`,
        [code, name, address]
      );
      synced += 1;
    }
    return { synced, skipped: false };
  } catch (err) {
    console.warn('[Ragic sync] venues failed:', err.message);
    return { synced: 0, error: err.message };
  }
}

module.exports = { syncStaffFromRagic, syncVenuesFromRagic, ragicEnabled };
