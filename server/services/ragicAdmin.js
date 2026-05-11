/**
 * Ragic 同步：後台員工 / 教練 / 場館（best-effort）
 *
 * 對照來源：docs/ragic_api.md
 *  - H01 員工 (在職 + 應徵職務含「教練」) → employees + roles=['coach']  (syncCoachesFromRagic)
 *  - H01 員工 (全部在職)                  → employees + roles=[] 待派    (syncStaffFromRagic, Task #51)
 *  - H05 場館 (履約中、非內勤單位)        → admin_venues + venues        (兩側鏡寫保持一致)
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

// Startup self-check（避免日後再次靜默失敗）：載入時印一次 enabled 狀態 + 缺哪個 env
(function logRagicStatus() {
  const hasKey = !!process.env.RAGIC_API_KEY;
  const hasBase = !!process.env.RAGIC_BASE_URL;
  if (hasKey && hasBase) {
    let host = process.env.RAGIC_BASE_URL;
    try { host = new URL(process.env.RAGIC_BASE_URL).host; } catch (_) {}
    console.log(`[Ragic] sync enabled=true (base=${host})`);
  } else {
    const missing = [!hasKey && 'RAGIC_API_KEY', !hasBase && 'RAGIC_BASE_URL']
      .filter(Boolean).join(', ');
    console.warn(`[Ragic] sync DISABLED — missing ${missing}`);
  }
})();

/**
 * 員工 Ragic 同步（Task #51 已遷移到 employees）：H01 全部在職員工 → employees。
 * - key = ragic_employee_id（H01 工號 3000935）
 * - 第一次 INSERT：roles=[] 待 admin 在 F-A02 手動指派（非教練不自動推 'coach' 避免錯派）
 *   employees.roles 預設 NOT NULL DEFAULT '{}'，這裡顯式寫 '{}'::text[] 維持可讀性
 * - ON CONFLICT (ragic_employee_id)：只更新從 Ragic 同步的「人事資料」
 *   （name / phone / is_active / last_synced_at / updated_at），絕對不覆蓋系統內部欄位：
 *   roles / password_hash / is_senior / pricing_multiplier / venue_id /
 *   bio_rich_text / specialties / intro_review_* / line_uid / email
 *   （email/line_uid 由 syncCoachesFromRagic 處理；此處不動以免兩個 sync 互相覆蓋）
 * - 不在 Ragic 在職名單的 → 軟下架 is_active=FALSE，但範圍鎖在「非教練」員工
 *   （ragic_employee_id IS NOT NULL AND NOT 'coach'=ANY(roles)）
 *   coach 軟下架交給 syncCoachesFromRagic 處理，避免兩個 sweep 邏輯打架
 */
async function syncStaffFromRagic() {
  if (!ragicEnabled()) return { synced: 0, skipped: true };
  try {
    const records = await ragic.getAllStaff();
    const seenIds = new Set();
    let synced = 0;
    for (const r of records) {
      const ragicId = r['員工編號'] || r['工號'] || r['3000935'];
      if (!ragicId) continue;
      const name = r['姓名'] || r['3000933'] || '';
      if (!name) continue;
      const phone = r['手機'] || r['手機（公司）'] || r['3001424'] || r['手機（個人）'] || r['3000941'] || '';
      const isActive = (r['在職狀態'] || r['3000945']) === '在職';
      seenIds.add(String(ragicId));
      await pool.query(
        `INSERT INTO employees
            (ragic_employee_id, name, phone, roles, is_active, last_synced_at)
         VALUES ($1, $2, NULLIF($3, ''), '{}'::text[], $4, NOW())
         ON CONFLICT (ragic_employee_id) DO UPDATE SET
           name = EXCLUDED.name,
           phone = COALESCE(NULLIF($3, ''), employees.phone),
           is_active = EXCLUDED.is_active,
           last_synced_at = NOW(),
           updated_at = NOW()`,
        [String(ragicId), name, phone, isActive]
      );
      synced += 1;
    }
    if (seenIds.size > 0) {
      await pool.query(
        `UPDATE employees SET is_active = FALSE, updated_at = NOW()
         WHERE ragic_employee_id IS NOT NULL
           AND ragic_employee_id <> ALL($1::text[])
           AND NOT ('coach' = ANY(roles))
           AND is_active = TRUE`,
        [Array.from(seenIds)]
      );
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
 * - 第一次匯入：填 name / phone / email / line_uid（若 Ragic 有設）；
 *   is_senior=false / multiplier=1.00 / intro=draft
 * - 後續同步：name/phone/email/is_active 強制覆寫；line_uid 用 COALESCE 不覆蓋已綁定值
 *   （避免 Ragic 端打字錯誤把現有綁定洗掉）；
 *   系統內部欄位（is_senior / pricing_multiplier / bio_rich_text / specialties / intro_review_status）
 *   一律以後台手動編輯為準，不被覆寫
 * - 不在 Ragic 在職教練名單中的現有 coaches → is_active = FALSE（軟刪除）
 *
 * 注意：H01 沒有「教練可教場館」欄位，coach_venues (M:N) 只能由後台手動勾。
 *
 * LINE userid 欄位（Task #34）：
 *   - 由管理員在 Ragic H01 手動維護「LINE userid」欄
 *   - 實際欄位 ID 由 user 自行命名；以下用多重 fallback 鍵名 + 啟發式比對 + env 覆寫支援
 *     env: RAGIC_FIELD_H01_LINE_UID（可填中文鍵名或 Ragic 數字 Field ID）
 */
function extractLineUid(r) {
  const explicit = process.env.RAGIC_FIELD_H01_LINE_UID;
  if (explicit && r[explicit]) return String(r[explicit]).trim();
  // 常見鍵名 fallback
  const candidates = ['LINE userid', 'LINE userId', 'LINE UID', 'LINE uid',
                      'LINE_USER_ID', 'lineUid', 'line_uid', 'Line userid'];
  for (const k of candidates) {
    if (r[k]) return String(r[k]).trim();
  }
  // 啟發式：scan keys 找包含 line + (user|uid) 的欄位
  for (const k of Object.keys(r)) {
    if (/line/i.test(k) && /(user.?id|uid)/i.test(k) && r[k]) {
      return String(r[k]).trim();
    }
  }
  return '';
}

async function syncCoachesFromRagic() {
  if (!ragicEnabled()) return { synced: 0, skipped: true };
  try {
    const records = await ragic.getActiveCoaches();
    const seenIds = new Set();
    let synced = 0;
    let linked = 0;
    for (const r of records) {
      const ragicId = r['員工編號'] || r['工號'] || r['3000935'];
      if (!ragicId) continue;
      const name = r['姓名'] || r['3000933'] || '';
      const phone = r['手機'] || r['手機（公司）'] || r['3001424'] || r['手機（個人）'] || r['3000941'] || '';
      const email = r['E-mail'] || r['Email'] || r['email'] || r['信箱'] || '';
      const lineUid = extractLineUid(r);
      if (!name || !phone) continue;
      seenIds.add(String(ragicId));
      if (lineUid) linked += 1;
      // Task #51：寫入 employees（coaches view 不可寫）。
      // 第一次 INSERT 時建立 employee row 並標記 roles=ARRAY['coach']。
      // ON CONFLICT (ragic_employee_id) → 只更新從 Ragic 同步的「人事資料」欄位
      // （name / phone / email / line_uid / is_active / last_synced_at / updated_at），
      // 絕對不覆蓋系統內部欄位：roles / password_hash / is_senior / pricing_multiplier /
      // bio_rich_text / specialties / intro_review_*（避免後台手動設定被 Ragic 蓋掉）。
      // line_uid 用 COALESCE(employees.line_uid, NULLIF($5,'')) — 已綁的值不會被空字串/換值洗掉。
      await pool.query(
        `INSERT INTO employees
            (ragic_employee_id, name, phone, email, line_uid, roles, is_active, last_synced_at)
         VALUES ($1, $2, $3, $4, NULLIF($5, ''), ARRAY['coach']::text[], TRUE, NOW())
         ON CONFLICT (ragic_employee_id) DO UPDATE SET
           name = EXCLUDED.name,
           phone = EXCLUDED.phone,
           email = COALESCE(NULLIF(EXCLUDED.email, ''), employees.email),
           line_uid = COALESCE(employees.line_uid, NULLIF($5, '')),
           is_active = TRUE,
           last_synced_at = NOW(),
           updated_at = NOW()`,
        [String(ragicId), name, phone, email, lineUid]
      );
      synced += 1;
    }
    // 不在 Ragic 在職教練名單中的 → 標 is_active = FALSE。
    // 範圍鎖在「ragic 同步來的 coach role 員工」(ragic_employee_id IS NOT NULL +
    // 'coach' = ANY(roles))，避免誤關閉手動建立的 admin/manager/counter 帳號。
    if (seenIds.size > 0) {
      await pool.query(
        `UPDATE employees SET is_active = FALSE, updated_at = NOW()
         WHERE ragic_employee_id IS NOT NULL
           AND ragic_employee_id <> ALL($1::text[])
           AND 'coach' = ANY(roles)
           AND is_active = TRUE`,
        [Array.from(seenIds)]
      );
    }
    console.log(`[Ragic sync] coaches synced=${synced} linked=${linked}`);
    return { synced, linked, skipped: false };
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
      // H05 實際欄位：部門編號 / 部門名稱 / 完整地址 / 總機構名稱 / 分支機構名稱 / 戶名 / 帳號
      // (舊欄位名 場館代號 / 場館名稱 / 場館地址 為 fallback，避免 Ragic UI 改名後同步失效)
      const code = (r['部門編號'] || r['場館代號'] || r['館別代碼'] || r['1000253'] || '').toString().trim();
      if (!code) continue;
      const name = r['部門名稱'] || r['場館名稱'] || r['館別名稱'] || r['1000254'] || code;
      const address = r['完整地址'] || r['場館地址'] || r['地址'] || r['1000271'] || '';
      const bankInst = r['總機構名稱'] || r['1001013'] || '';
      const bankBranch = r['分支機構名稱'] || r['1001015'] || '';
      const acctHolder = r['戶名'] || r['1001016'] || '';
      const acctNumber = (r['帳號'] || r['1001017'] || '').toString();
      seenCodes.add(code);

      // admin_venues（後台 F-A03 + 機敏資料）
      // 銀行 4 欄：本地未填則用 Ragic 值，本地已填則保留（後台手動修改優先）
      await pool.query(
        `INSERT INTO admin_venues (id, code, name, address, line_token, bank_institution_name, bank_branch_name, account_holder, account_number, is_active, last_synced_at)
         VALUES ($1, $1, $2, $3, '', $4, $5, $6, $7, TRUE, NOW())
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           address = COALESCE(NULLIF(admin_venues.address, ''), EXCLUDED.address),
           bank_institution_name = COALESCE(NULLIF(admin_venues.bank_institution_name, ''), EXCLUDED.bank_institution_name),
           bank_branch_name = COALESCE(NULLIF(admin_venues.bank_branch_name, ''), EXCLUDED.bank_branch_name),
           account_holder = COALESCE(NULLIF(admin_venues.account_holder, ''), EXCLUDED.account_holder),
           account_number = COALESCE(NULLIF(admin_venues.account_number, ''), EXCLUDED.account_number),
           is_active = TRUE,
           last_synced_at = NOW()`,
        [code, name, address, bankInst, bankBranch, acctHolder, acctNumber]
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
    // 不在 Ragic 履約中名單的 → admin_venues / venues 兩表一致軟下架
    if (seenCodes.size > 0) {
      const codes = Array.from(seenCodes);
      await pool.query(
        `UPDATE venues SET is_active = FALSE, updated_at = NOW()
         WHERE id <> ALL($1::text[]) AND is_active = TRUE`,
        [codes]
      );
      await pool.query(
        `UPDATE admin_venues SET is_active = FALSE, updated_at = NOW()
         WHERE id <> ALL($1::text[]) AND is_active = TRUE`,
        [codes]
      );
    }
    console.log(`[Ragic sync] venues synced=${synced}`);
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
