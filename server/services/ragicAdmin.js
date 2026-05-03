/**
 * Ragic 同步：後台員工 / 教練 / 場館（best-effort）
 *
 * 對照來源：docs/ragic_api.md
 *  - H01 員工 (在職 + 應徵職務含「教練」) → coaches              (Task #32 新增)
 *  - H01 員工 (全部在職)                  → admin_staff           (角色指派用，原本就有)
 *  - H05 場館 (履約中、非內勤單位)        → admin_venues + venues  (兩側鏡寫保持一致)
 *
 * 規則：
 * - 沒設定 RAGIC_API_KEY / RAGIC_BASE_URL → 直接 noop（dev 環境正常）
 * - Ragic 失敗一律 swallow + warn，不阻擋使用者操作（後台仍能讀寫 PostgreSQL）
 * - 只做「讀取 Ragic → upsert 進系統 DB」，後台手動修改的欄位（role / multiplier /
 *   is_senior / specialties / bio_rich_text / line_token / 銀行帳戶 …）一律以系統 DB
 *   為準，不會被 Ragic 蓋掉
 * - 在 Ragic 找不到的列：標 is_active = FALSE（不 hard delete，避免影響歷史 FK）
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
 * 教練 Ragic 同步（Task #32）：H01 (在職 + 應徵職務含「教練」) → coaches。
 * - key = ragic_employee_id（即 H01 工號 3000935）
 * - 第一次匯入：填 name / phone / email；is_senior=false / multiplier=1.00 / intro=draft
 * - 後續同步：只更新 name / phone / email / is_active；
 *   系統內部欄位（is_senior / pricing_multiplier / bio_rich_text / specialties / intro_review_status / line_uid）
 *   一律以後台手動編輯為準，不被覆寫
 * - 不在 Ragic 在職教練名單中的現有 coaches → is_active = FALSE（軟刪除）
 *
 * 注意：H01 沒有「教練可教場館」欄位，coach_venues (M:N) 只能由後台手動勾。
 */
async function syncCoachesFromRagic() {
  if (!ragicEnabled()) return { synced: 0, skipped: true };
  try {
    const records = await ragic.getActiveCoaches();
    const seenIds = new Set();
    let synced = 0;
    for (const r of records) {
      const ragicId = r['工號'] || r['3000935'];
      if (!ragicId) continue;
      const name = r['姓名'] || r['3000933'] || '';
      const phone = r['手機（公司）'] || r['3001424'] || r['手機（個人）'] || r['3000941'] || '';
      const email = r['Email'] || r['email'] || r['信箱'] || '';
      if (!name || !phone) continue;
      seenIds.add(String(ragicId));
      // upsert：第一次插入填全部，後續只更新 name/phone/email/is_active，保留其餘
      await pool.query(
        `INSERT INTO coaches (ragic_employee_id, name, phone, email, is_active)
         VALUES ($1, $2, $3, $4, TRUE)
         ON CONFLICT (ragic_employee_id) DO UPDATE SET
           name = EXCLUDED.name,
           phone = EXCLUDED.phone,
           email = COALESCE(NULLIF(EXCLUDED.email, ''), coaches.email),
           is_active = TRUE,
           updated_at = NOW()`,
        [String(ragicId), name, phone, email]
      );
      synced += 1;
    }
    // 不在 Ragic 在職教練名單中的 → 標 is_active = FALSE
    if (seenIds.size > 0) {
      await pool.query(
        `UPDATE coaches SET is_active = FALSE, updated_at = NOW()
         WHERE ragic_employee_id IS NOT NULL
           AND ragic_employee_id <> ALL($1::text[])
           AND is_active = TRUE`,
        [Array.from(seenIds)]
      );
    }
    return { synced, skipped: false };
  } catch (err) {
    console.warn('[Ragic sync] coaches failed:', err.message);
    return { synced: 0, error: err.message };
  }
}

/**
 * 場館 Ragic 同步：H05 → admin_venues + venues（LIFF 用同一份 id 對齊）。
 * - 用「場館代號」當主鍵；Ragic 沒給則 fallback 到場館名稱第一個字母
 * - 銀行帳戶等資訊以「Ragic 為主，本地未設定 → 用 Ragic 值；本地已有 → 不覆寫」
 * - 不在 Ragic 履約中名單的場館 → admin_venues / venues 雙邊都標 is_active=false（軟下架）
 */
async function syncVenuesFromRagic() {
  if (!ragicEnabled()) return { synced: 0, skipped: true };
  try {
    const records = await ragic.getActiveVenues();
    const seenCodes = new Set();
    let synced = 0;
    for (const r of records) {
      const code = (r['場館代號'] || r['館別代碼'] || '').toString().trim();
      if (!code) continue;
      const name = r['場館名稱'] || r['館別名稱'] || code;
      const address = r['場館地址'] || r['地址'] || '';
      seenCodes.add(code);

      // admin_venues（後台 F-A03 + 機敏資料）
      await pool.query(
        `INSERT INTO admin_venues (id, code, name, address, line_token, bank_institution_name, bank_branch_name, account_holder, account_number, last_synced_at)
         VALUES ($1, $1, $2, $3, '', '', '', '', '', NOW())
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           address = COALESCE(NULLIF(admin_venues.address, ''), EXCLUDED.address),
           last_synced_at = NOW()`,
        [code, name, address]
      );

      // venues（LIFF 業務面：教練選課、報名、coach_venues FK 都吃這張）
      // 與 admin_venues 同 id 對齊；FK 也跟著生效。
      await pool.query(
        `INSERT INTO venues (id, name, full_address, is_active)
         VALUES ($1, $2, $3, TRUE)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           full_address = COALESCE(NULLIF(venues.full_address, ''), EXCLUDED.full_address),
           is_active = TRUE,
           updated_at = NOW()`,
        [code, name, address]
      );
      synced += 1;
    }
    // 不在 Ragic 履約中名單的 → 標 is_active=false（admin_venues 用 last_synced_at + 沒被本輪更新隱含；venues 直接標）
    if (seenCodes.size > 0) {
      await pool.query(
        `UPDATE venues SET is_active = FALSE, updated_at = NOW()
         WHERE id <> ALL($1::text[]) AND is_active = TRUE`,
        [Array.from(seenCodes)]
      );
    }
    return { synced, skipped: false };
  } catch (err) {
    console.warn('[Ragic sync] venues failed:', err.message);
    return { synced: 0, error: err.message };
  }
}

module.exports = {
  syncStaffFromRagic,
  syncCoachesFromRagic,
  syncVenuesFromRagic,
  ragicEnabled,
};
