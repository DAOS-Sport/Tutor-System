/**
 * Ragic 同步：後台員工 / 教練 / 場館（best-effort）
 *
 * 對照來源：docs/ragic_api.md
 *  - H01 員工 (在職 + 應徵職務含「教練」) → coaches
 *  - H01 員工 (全部，含離職)              → admin_staff（角色指派用）
 *  - H05 場館 (履約中、非內勤單位)        → admin_venues + venues
 *
 * 規則：
 * - 沒設定 RAGIC_API_KEY / RAGIC_BASE_URL → noop（dev 環境正常）
 * - Ragic 失敗一律 swallow + warn，不阻擋使用者操作
 * - 系統內部欄位（role / multiplier / is_senior / specialties / bio_rich_text /
 *   line_token / 銀行帳戶）不被 Ragic 覆蓋
 * - is_active：H01「離職」→ active=false，並停用對應 admin_users login；
 *   後台手動翻轉 active 後會記錄 `active_overridden_at`，下一輪同步不再覆蓋。
 *
 * 對外另暴露 `kickoffSync*Async()` —— fire-and-forget + 10 分鐘節流，
 * 用於 GET 列表時觸發背景刷新（不阻塞回應）。實際排程由 server/cron 跑。
 */
const { pool } = require('../models/db');
const ragic = require('./ragic');

function ragicEnabled() {
  return !!process.env.RAGIC_API_KEY && !!process.env.RAGIC_BASE_URL;
}

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
 * 員工 Ragic 同步：H01 全員工 → admin_staff。
 * - active = (在職狀態==='在職')
 * - 若該列在 admin_staff 已有 active_overridden_at（後台手動勾過啟用 / 停用），
 *   則本次同步「不覆蓋 active」；name / phone / role 仍會更新
 * - active 變更為 false 時，連動把 admin_users (依 name 比對) is_active 設 false，
 *   讓該帳號無法登入；同樣尊重 admin_users.active_overridden_at
 */
async function syncStaffFromRagic() {
  if (!ragicEnabled()) return { synced: 0, skipped: true };
  try {
    const records = await ragic.getAllStaff();
    let synced = 0;
    let deactivatedLogins = 0;
    const seenIds = new Set();
    for (const r of records) {
      const ragicId = r['員工編號'] || r['工號'] || r['3000935'];
      if (!ragicId) continue;
      seenIds.add(String(ragicId));
      const name = r['姓名'] || r['3000933'] || '';
      const phone = r['手機'] || r['手機（公司）'] || r['3001424'] || r['手機（個人）'] || r['3000941'] || '';
      const role = r['應徵職務'];
      const roleStr = Array.isArray(role) ? role.join(',') : (role || '');
      const isCoach = roleStr.includes('教練') || (r['職稱'] || '').includes('教練');
      const roleVal = isCoach ? 'coach' : 'staff';
      const isActive = (r['在職狀態'] || r['3000945']) === '在職';

      // 先讀目前覆寫狀態（避免覆蓋管理員手動設定）
      const cur = await pool.query(
        `SELECT active, active_overridden_at FROM admin_staff WHERE id = $1`,
        [String(ragicId)]
      );
      const overridden = cur.rowCount && cur.rows[0].active_overridden_at != null;

      await pool.query(
        `INSERT INTO admin_staff (id, name, role, phone, is_senior, multiplier, active, ragic_record_id, last_synced_at)
         VALUES ($1, $2, $3, $4, FALSE, 1.00, $5, $1, NOW())
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           phone = EXCLUDED.phone,
           active = CASE
             WHEN admin_staff.active_overridden_at IS NULL THEN EXCLUDED.active
             ELSE admin_staff.active
           END,
           ragic_record_id = EXCLUDED.ragic_record_id,
           last_synced_at = NOW()`,
        [String(ragicId), name, roleVal, phone, isActive]
      );

      // 連動 admin login：當「Ragic 離職 + 後台未覆寫 active」時，停用對應 admin_users
      if (!isActive && !overridden && name) {
        const upd = await pool.query(
          `UPDATE admin_users SET is_active = FALSE
            WHERE name = $1
              AND is_active = TRUE
              AND (active_overridden_at IS NULL)
            RETURNING id`,
          [name]
        );
        deactivatedLogins += upd.rowCount;
      }
      synced += 1;
    }

    // 不在 H01 名單中的 admin_staff → 也標 active=false（尊重 override）
    if (seenIds.size > 0) {
      await pool.query(
        `UPDATE admin_staff SET active = FALSE, last_synced_at = NOW()
          WHERE id <> ALL($1::text[])
            AND active = TRUE
            AND active_overridden_at IS NULL`,
        [Array.from(seenIds)]
      );
    }
    if (deactivatedLogins > 0) {
      console.log(`[Ragic sync] staff synced=${synced} login_deactivated=${deactivatedLogins}`);
    }
    return { synced, deactivatedLogins, skipped: false };
  } catch (err) {
    console.warn('[Ragic sync] staff failed:', err.message);
    return { synced: 0, error: err.message };
  }
}

/**
 * 教練 Ragic 同步（H01 在職 + 應徵職務含「教練」→ coaches）
 * - 系統內部欄位（is_senior / pricing_multiplier / specialties / bio / intro_review_status）不覆寫
 * - is_active：尊重 active_overridden_at（後台手動勾啟用 → 下一輪不被覆蓋）
 */
function extractLineUid(r) {
  const explicit = process.env.RAGIC_FIELD_H01_LINE_UID;
  if (explicit && r[explicit]) return String(r[explicit]).trim();
  const candidates = ['LINE userid', 'LINE userId', 'LINE UID', 'LINE uid',
                      'LINE_USER_ID', 'lineUid', 'line_uid', 'Line userid'];
  for (const k of candidates) {
    if (r[k]) return String(r[k]).trim();
  }
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
      // is_active 尊重覆寫旗標
      await pool.query(
        `INSERT INTO coaches (ragic_employee_id, name, phone, email, line_uid, is_active)
         VALUES ($1, $2, $3, $4, NULLIF($5, ''), TRUE)
         ON CONFLICT (ragic_employee_id) DO UPDATE SET
           name = EXCLUDED.name,
           phone = EXCLUDED.phone,
           email = COALESCE(NULLIF(EXCLUDED.email, ''), coaches.email),
           line_uid = COALESCE(coaches.line_uid, NULLIF($5, '')),
           is_active = CASE
             WHEN coaches.active_overridden_at IS NULL THEN TRUE
             ELSE coaches.is_active
           END,
           updated_at = NOW()`,
        [String(ragicId), name, phone, email, lineUid]
      );
      synced += 1;
    }
    // 不在 Ragic 在職教練名單 → 標 is_active = FALSE（尊重 override）
    if (seenIds.size > 0) {
      await pool.query(
        `UPDATE coaches SET is_active = FALSE, updated_at = NOW()
         WHERE ragic_employee_id IS NOT NULL
           AND ragic_employee_id <> ALL($1::text[])
           AND is_active = TRUE
           AND active_overridden_at IS NULL`,
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
 * 場館 Ragic 同步（H05 → admin_venues + venues）
 */
async function syncVenuesFromRagic() {
  if (!ragicEnabled()) return { synced: 0, skipped: true };
  try {
    const records = await ragic.getActiveVenues();
    const seenCodes = new Set();
    let synced = 0;
    for (const r of records) {
      const code = (r['部門編號'] || r['場館代號'] || r['館別代碼'] || r['1000253'] || '').toString().trim();
      if (!code) continue;
      const name = r['部門名稱'] || r['場館名稱'] || r['館別名稱'] || r['1000254'] || code;
      const address = r['完整地址'] || r['場館地址'] || r['地址'] || r['1000271'] || '';
      const bankInst = r['總機構名稱'] || r['1001013'] || '';
      const bankBranch = r['分支機構名稱'] || r['1001015'] || '';
      const acctHolder = r['戶名'] || r['1001016'] || '';
      const acctNumber = (r['帳號'] || r['1001017'] || '').toString();
      seenCodes.add(code);

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

// ─────────────────────────────────────────────────────────────
// Fire-and-forget kickoff helpers（10 分鐘節流）
// 解決：以前 GET 列表 await sync*FromRagic() 阻塞 1–3 秒的問題。
// 現在改為背景刷新，下一次 GET 就能拿到新資料。
// ─────────────────────────────────────────────────────────────
const KICKOFF_THROTTLE_MS = 10 * 60 * 1000;
const _lastKickoff = new Map(); // key -> timestamp
let _runningJobs = new Set();    // key -> bool（同時只跑一個）

function _kickoff(key, fn) {
  if (!ragicEnabled()) return;
  if (_runningJobs.has(key)) return;
  const last = _lastKickoff.get(key) || 0;
  if (Date.now() - last < KICKOFF_THROTTLE_MS) return;
  _lastKickoff.set(key, Date.now());
  _runningJobs.add(key);
  setImmediate(() => {
    fn()
      .catch((e) => console.warn(`[Ragic kickoff/${key}] failed:`, e.message))
      .finally(() => _runningJobs.delete(key));
  });
}

function kickoffSyncStaffAsync()   { _kickoff('staff',   syncStaffFromRagic); }
function kickoffSyncCoachesAsync() { _kickoff('coaches', syncCoachesFromRagic); }
function kickoffSyncVenuesAsync()  { _kickoff('venues',  syncVenuesFromRagic); }

module.exports = {
  syncStaffFromRagic,
  syncCoachesFromRagic,
  syncVenuesFromRagic,
  kickoffSyncStaffAsync,
  kickoffSyncCoachesAsync,
  kickoffSyncVenuesAsync,
  ragicEnabled,
};
