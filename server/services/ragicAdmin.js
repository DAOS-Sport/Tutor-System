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
const parentSync = require('./parentSync');
// Ragic 表單 / 欄位對應唯一來源（凍結點）：H01 LINE UID 候選、場館欄位、角色關鍵字
const { H01 } = require('../config/ragicSchema');

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

// ─────────────────────────────────────────────────────────────
// Task #66：staging 共用 helpers
// 改造後 sync 不再直接 UPSERT 正式表，而是把差異寫進 ragic_staging_changes，
// 由 admin 在「Ragic 待審核」頁面手動 approve / reject 後才真正套用。
// ─────────────────────────────────────────────────────────────

/** Upsert 一筆 staging：以 UID（entity_type, entity_id）為真相，同一人永遠只有一筆、就地更新。
 *  不論該筆現況是 approved/auto_resolved/rejected，只要這輪 sync 仍有差異，一律覆寫回 pending
 *  並清掉上一輪的審核痕跡（reviewed_by/at、reject_reason）。
 *  注意：依 spec，rejected 不抑制 — 下次 Ragic 同步若仍有差異，會重新進待審區。 */
async function _stageIfNotRejected(formCode, entityType, entityId, changeType, payload, diff) {
  await pool.query(
    `INSERT INTO ragic_staging_changes
       (form_code, entity_type, entity_id, change_type, payload_json, diff_json, fetched_at, status)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, NOW(), 'pending')
     ON CONFLICT (entity_type, entity_id)
     DO UPDATE SET form_code = EXCLUDED.form_code,
                   change_type = EXCLUDED.change_type,
                   payload_json = EXCLUDED.payload_json,
                   diff_json = EXCLUDED.diff_json,
                   fetched_at = NOW(),
                   status = 'pending',
                   reviewed_by = NULL,
                   reviewed_at = NULL,
                   reject_reason = NULL`,
    [formCode, entityType, entityId, changeType, JSON.stringify(payload), diff ? JSON.stringify(diff) : null]
  );
  return true;
}

/** 已無差異 → 把舊的 pending 標 auto_resolved（管理員可能已手動同步過）。 */
async function _markPendingResolved(entityType, entityId) {
  await pool.query(
    `UPDATE ragic_staging_changes
       SET status = 'auto_resolved', reviewed_at = NOW()
       WHERE entity_type = $1 AND entity_id = $2 AND status = 'pending'`,
    [entityType, entityId]
  );
}

/**
 * 員工 Ragic 同步：H01 全員工 vs admin_staff，差異寫進 staging（不直接寫表）。
 * - 偵測 name / phone / role / active 任一不同 → stage（active 在 overridden 時忽略）
 * - 不在 Ragic 但 active 中 + 未 override → stage 'deactivate'
 */
/**
 * Task #90：從 Ragic H01 record 抽出該員工的所屬場館清單（去重、保序）。
 * 支援多種欄位來源：
 *   - env RAGIC_FIELD_H01_VENUE_PRIMARY / RAGIC_FIELD_H01_VENUE_SUPPORT（可逗號分隔多 field id）
 *   - 中文欄位名：主場館 / 主要場館 / 支援場館 / 服務場館 / 場館 / 部門
 * 值若包含逗號或頓號，會自動拆成多筆；空字串忽略。
 */
function _extractStaffVenueIds(r) {
  const ids = [];
  const seen = new Set();
  const push = (v) => {
    if (v === null || v === undefined) return;
    const arr = Array.isArray(v) ? v : String(v).split(/[,，、\s]+/);
    for (const raw of arr) {
      const s = String(raw || '').trim();
      if (!s || seen.has(s)) continue;
      seen.add(s);
      ids.push(s);
    }
  };
  const envKeys = H01.VENUE_FIELD_ENV.flatMap(k => k.split(','));
  for (const k of envKeys) push(r[k.trim()]);
  for (const k of H01.VENUE_NAME_KEYS) {
    push(r[k]);
  }
  return ids;
}

// H01「部門」回傳的是場館「名稱」（如「新北高中」），但 venues.id / coach_venues 是「代碼」（如「B」）。
// 直接拿名稱去比對 venues.id 會全數對不到 → 教練場館同步永遠是空的。
// 這裡建一個「名稱或代碼 → venue id」解析器：
//   - 同時用 id / name / full_name 比對；
//   - venues.name 可能帶後綴（如「三重商工 (test)」「三民高中 (tx)」），故額外用「去括號後綴」base name 比對；
//   - 非場館的部門（如公司名、處室）對不到 → 自動略過，不噴錯。
async function _buildVenueResolver() {
  const r = await pool.query(`SELECT id, name, full_name FROM venues`);
  const map = new Map();
  const base = (s) => String(s == null ? '' : s).split(' (')[0].trim();
  const add = (k, id) => { const s = String(k == null ? '' : k).trim(); if (s && !map.has(s)) map.set(s, id); };
  for (const v of r.rows) {
    add(v.id, v.id);
    add(v.name, v.id); add(base(v.name), v.id);
    if (v.full_name) { add(v.full_name, v.id); add(base(v.full_name), v.id); }
  }
  return (rawValues) => {
    const out = [];
    for (const raw of (rawValues || [])) {
      const s = String(raw == null ? '' : raw).trim();
      if (!s) continue;
      const id = map.get(s) || map.get(base(s));
      if (id && !out.includes(id)) out.push(id);
    }
    return out;
  };
}

/**
 * Task #95：場館自動套用（Ragic 權威）。
 * H01「部門/主場館」欄位值經 _extractStaffVenueIds（拆逗號/頓號）+ _buildVenueResolver
 * （處理「三重商工 (test)」括號後綴、名稱→代碼）清洗後，直接寫入
 * admin_staff_venues / coach_venues / admin_staff.venue_id（**不經待審核**）——
 * 場館即權限可見範圍，依 Ragic 即時生效；後台員工編輯彈窗對 Ragic 來源員工已鎖定此欄。
 * 僅落地實際存在的場館代碼，避免 FK violation；codes 為空時不呼叫（caller 把關）。
 */
async function _applyStaffVenuesDirect(staffId, venueCodes) {
  const codes = [...new Set((venueCodes || []).map((s) => String(s).trim()).filter(Boolean))];
  if (!codes.length) return false;
  const vr = await pool.query(`SELECT id FROM admin_venues WHERE id = ANY($1::text[])`, [codes]);
  const validIds = vr.rows.map((x) => x.id);
  if (!validIds.length) return false;
  await pool.query(`DELETE FROM admin_staff_venues WHERE staff_id = $1`, [staffId]);
  for (const vid of validIds) {
    await pool.query(
      `INSERT INTO admin_staff_venues (staff_id, venue_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [staffId, vid]
    );
  }
  // admin_staff.venue_id 維持「第一筆」fallback（向下相容舊讀取路徑）
  await pool.query(
    `UPDATE admin_staff SET venue_id = $2, updated_at = NOW() WHERE id = $1`,
    [staffId, validIds[0]]
  );
  // 教練 1:1 行存在 → coach_venues 一併套用（FK 對 venues，僅取啟用中場館）
  const c = await pool.query(`SELECT id FROM coaches WHERE ragic_employee_id = $1`, [staffId]);
  const coachId = c.rows[0]?.id;
  if (coachId) {
    const cv = await pool.query(
      `SELECT id FROM venues WHERE id = ANY($1::text[]) AND is_active = TRUE`,
      [validIds]
    );
    await pool.query(`DELETE FROM coach_venues WHERE coach_id = $1`, [coachId]);
    for (const row of cv.rows) {
      await pool.query(
        `INSERT INTO coach_venues (coach_id, venue_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [coachId, row.id]
      );
    }
  }
  return true;
}

// Task #92：normalize 員工編號比對 key。
// admin 手建員工可能輸入 'c001' / ' C001 '，Ragic 回 'C001'，
// 用原值比對會比不到 → 整筆被當 'new' 重新 stage，員工就會出現「已建檔卻又進待審核」。
// 一律 trim + toUpperCase 做比對 key；DB 上的 PK 仍以實際儲存值為準。
function _normalizeStaffId(v) {
  return String(v == null ? '' : v).trim().toUpperCase();
}

async function _syncStaffImpl() {
  if (!ragicEnabled()) return { synced: 0, skipped: true };
  try {
    const records = await ragic.getAllStaff();
    // Task #95 fix：H01「部門」存的是場館「名稱」（或公司/處室名），DB 存「代碼」。
    // 先前 diff 直接拿名稱比代碼 → 永遠不相等 → 全員每輪都 stage venue_ids 假差異，
    // 且 approve 套用（apply 時才 resolve 成代碼）後下一輪又再生成，待審區清不完。
    // 改為「比對前」就 resolve 成代碼（與 apply 同一套 resolver）；
    // 解析不到的值（公司名、內勤處室）一律忽略，不視為場館差異。
    const resolveVenues = await _buildVenueResolver();
    const dbRows = (await pool.query(
      `SELECT id, name, phone, role, active, active_overridden_at FROM admin_staff`
    )).rows;
    // key 用 normalize 過的值，value 保留 DB 原始 row（含 PK 原始大小寫）
    const dbMap = new Map(dbRows.map(r => [_normalizeStaffId(r.id), r]));
    // Perf（修「H01 同步偶發逾時 / 同步失敗」的根因）：原本在每筆員工迴圈裡各打 2 次 DB
    // （coaches 的 email/line_uid + admin_staff_venues），262 筆 ≈ 500+ 次序列往返 →
    // 同步要跑 78–116 秒。真正瓶頸不是 Ragic API（一次就撈得完，遠在 1000 筆/次上限內），
    // 而是這個 N+1。改成「迴圈前一次撈齊」兩張表、用 Map 查；同步降到秒級，
    // 重開機後那段長時間視窗（最容易撞到逾時 / DB 連線抖動 → 同步失敗）也跟著消失。
    const coachByEmp = new Map(
      (await pool.query(
        `SELECT ragic_employee_id, email, line_uid FROM coaches WHERE ragic_employee_id IS NOT NULL`
      )).rows.map(c => [c.ragic_employee_id, c])
    );
    const venuesByStaff = new Map();
    for (const vr of (await pool.query(
      `SELECT staff_id, venue_id FROM admin_staff_venues ORDER BY staff_id, venue_id`
    )).rows) {
      const list = venuesByStaff.get(vr.staff_id);
      if (list) list.push(vr.venue_id);
      else venuesByStaff.set(vr.staff_id, [vr.venue_id]);
    }
    const seenKeys = new Set();
    let staged = 0;
    let venuesApplied = 0; // Task #95：場館自動套用筆數（不經待審核）

    for (const r of records) {
      const ragicId = r['員工編號'] || r['工號'] || r['3000935'];
      if (!ragicId) continue;
      const rawId = String(ragicId).trim();
      const id = _normalizeStaffId(rawId);
      if (!id) continue;
      seenKeys.add(id);
      const name = r['姓名'] || r['3000933'] || '';
      const phone = r['手機'] || r['手機（公司）'] || r['3001424'] || r['手機（個人）'] || r['3000941'] || '';
      // Task #91 後續：Ragic H01 公司 E-mail（field 3000940）也納入 staff sync，
      // 套用時若該員工有對應的 coaches 列，會把 email 寫入 coaches.email
      // （保留後台手動編輯：只在現值為空時覆寫）。
      const email = r['E-mail'] || r['Email'] || r['email'] || r['信箱'] || r['3000940'] || '';
      const role = r['應徵職務'];
      const roleStr = Array.isArray(role) ? role.join(',') : (role || '');
      const roleText = `${roleStr},${r['職稱'] || ''}`;
      const isCoach = roleText.includes(H01.ROLE_MATCH.COACH);
      const isCounter = H01.ROLE_MATCH.COUNTER.test(roleText);
      const roleVal = isCounter ? 'staff' : (isCoach ? 'coach' : 'staff');
      const isActive = (r['在職狀態'] || r['3000945']) === '在職';
      // Task #90：解析 Ragic H01 多場館欄位（主場館 + 支援場館），合併為陣列
      // Task #95：立即 resolve 成 venue 代碼再比對 / 入 payload（見上方註解）
      const venueIds = resolveVenues(_extractStaffVenueIds(r));
      // H01「個人LINE ID」(Field 1003633)；apply 時只在 coaches.line_uid 為空才補
      const lineUid = extractLineUid(r);
      const cur = dbMap.get(id);
      // 套用至正式表時 entity_id 必須對到實際 DB PK（保留原始大小寫），
      // 新增則以 normalized 形式落地，避免日後再被當成新人。
      const entityId = cur ? cur.id : id;
      const payload = {
        id: entityId, name, phone, email, role: roleVal,
        is_active: isActive, venue_ids: venueIds,
        line_uid: lineUid,
      };

      // 查目前 coaches.email / line_uid 作為 diff 比對基準（admin_staff 本身沒有這兩個欄位）
      // ——改用迴圈前一次撈齊的 coachByEmp Map，避免每筆各打一次 DB（見上方 Perf 註解）。
      const coachRow = coachByEmp.get(entityId);
      const curCoachEmail = coachRow?.email || '';
      const curCoachLineUid = coachRow?.line_uid || '';
      // email / line_uid 只存在於 coaches 表；apply 也只寫得進 coaches 列。
      // 因此唯有「已有 coaches 列」或「這次會被建成教練（role=coach 且有手機 → apply 會建列）」
      // 時，套用才寫得進去。純後勤員工（role=staff、無 coaches 列）若硬 stage 這兩欄，
      // approve 後無處可寫 → 下一輪 sync 又偵測到 coaches 仍為空 → 永遠重 stage、待審區清不掉。
      const coachFieldsPersistable = !!coachRow || (roleVal === 'coach' && !!phone);

      if (!cur) {
        if (await _stageIfNotRejected('H01_STAFF', 'staff', entityId, 'new', payload, null)) staged++;
        continue;
      }
      const diff = {};
      if ((cur.name || '') !== name) diff.name = { from: cur.name || '', to: name };
      if ((cur.phone || '') !== phone) diff.phone = { from: cur.phone || '', to: phone };
      // role 為系統內部欄位（admin 可改 staff/coach/manager）— 不從 Ragic 同步
      // email：apply 端只在 DB 空值時補（保留後台手動編輯）→ diff 也只在「DB 空 + Ragic 有值」
      // 才 stage（Task #95：先前「值不同就 diff」會讓 admin 自填信箱後，同一筆差異每輪重現、
      // approve 又套不進去（fill-empty-only），待審區永遠清不掉）
      if (coachFieldsPersistable && email && !curCoachEmail) {
        diff.email = { from: '', to: email };
      }
      // line_uid：只在「DB 為空 + Ragic 有值」才 diff，避免覆寫已綁定的教練 LINE
      // （apply 路徑使用 COALESCE 雙重保險；這裡同樣不顯示「Ragic 空 → 蓋掉」的 diff）。
      // 同上 coachFieldsPersistable 把關：非教練的 line_uid 套用無處可寫，不再 stage。
      if (coachFieldsPersistable && lineUid && !curCoachLineUid) {
        diff.line_uid = { from: '', to: lineUid };
      }
      if (cur.active_overridden_at == null && cur.active !== isActive) {
        diff.active = { from: cur.active, to: isActive };
      }
      // Task #95（取代 Task #90 的 venue_ids 差異 stage）：場館改為「自動套用」不經待審核 —
      // Ragic 部門即權威，清洗後的代碼與 DB 不同就直接寫入授權館別（admin_staff_venues +
      // coach_venues）。解析為空（部門是公司名/內勤處室）→ 不動 DB，避免清空既有場館。
      // 同上：改查迴圈前撈齊的 venuesByStaff Map（已依 staff_id, venue_id 排序）。
      const curVenues = venuesByStaff.get(entityId) || [];
      const newVenues = [...venueIds].sort();
      const curVenuesSorted = [...curVenues].sort();
      if (newVenues.length > 0 && (newVenues.length !== curVenuesSorted.length
          || newVenues.some((v, i) => v !== curVenuesSorted[i]))) {
        if (await _applyStaffVenuesDirect(entityId, venueIds)) venuesApplied++;
      }
      if (Object.keys(diff).length > 0) {
        if (await _stageIfNotRejected('H01_STAFF', 'staff', entityId, 'update', payload, diff)) staged++;
      } else {
        await _markPendingResolved('staff', entityId);
      }
    }

    // Ragic 名單外 + 仍 active + 未 override → deactivate stage
    for (const r of dbRows) {
      if (!r.active || r.active_overridden_at != null || seenKeys.has(_normalizeStaffId(r.id))) continue;
      const payload = { id: r.id, name: r.name, is_active: false };
      const diff = { active: { from: true, to: false } };
      if (await _stageIfNotRejected('H01_STAFF', 'staff', r.id, 'deactivate', payload, diff)) staged++;
    }
    if (venuesApplied > 0) {
      console.log(`[Ragic sync] staff：場館自動套用 ${venuesApplied} 位（Ragic 部門 → 授權館別）`);
    }
    return { synced: staged, staged, venues_applied: venuesApplied, skipped: false };
  } catch (err) {
    console.warn('[Ragic sync] staff failed:', err.message);
    return { synced: 0, error: err.message };
  }
}

/**
 * 從 H01 員工列抽出「個人LINE ID」(LINE UID, sub)。
 * 優先順序：
 *   1. env RAGIC_FIELD_H01_LINE_UID 指定的 Field ID
 *   2. 預設 Field ID 1003633（H01 個人LINE ID 欄位）
 *   3. 中文 / 英文 fallback key（避免 Ragic 欄位更名）
 *   4. 模糊比對：key 含 "line" + ("userid"|"uid")
 * 任一拿到非空字串即回傳；都拿不到回 ''。
 */
function extractLineUid(r) {
  // 候選 key 來自凍結點 ragicSchema.H01.LINE_UID_CANDIDATES（env 覆寫優先 → 凍結 Field ID → 中英文欄名）
  for (const k of H01.LINE_UID_CANDIDATES) {
    if (r[k]) return String(r[k]).trim();
  }

  // 最後才做模糊搜尋，且排除「Line是否綁定完成」「400Line訊息」這種狀態/訊息欄位。
  for (const k of Object.keys(r)) {
    if (!/line/i.test(k) && !k.includes('LINE') && !k.includes('Line')) continue;
    if (/是否|完成|訊息|message|status/i.test(k)) continue;
    if (/(user.?id|uid|個人LINE ID)/i.test(k) && r[k]) {
      return String(r[k]).trim();
    }
  }
  return '';
}


// Task #94：F-C-Admin 已併入員工帳號管理（Task #91），coaches 獨立 sync 已下架。
// _syncCoachesImpl / syncCoachesFromRagic / kickoffSyncCoachesAsync 三個入口一併移除，
// 避免外部誤呼叫後落到 _runWithLog('coaches') → 'unknown ragic sync job: coaches'。
// 教練 1:1 行的 upsert 由 staff 流程透過 ensureCoachRow 自動處理。

/**
 * 場館 Ragic 同步（H05 vs admin_venues，差異寫進 staging）。
 * - 比對 VENUE_SYNC_FIELDS + is_active；尊重各欄位的 *_overridden_at
 */
async function _syncVenuesImpl() {
  if (!ragicEnabled()) return { synced: 0, skipped: true };
  try {
    const records = await ragic.getActiveVenues();
    const ragicMap = new Map();
    for (const r of records) {
      const v = _mapRagicVenue(r);
      if (v) ragicMap.set(v.code, v);
    }
    const dbRows = (await pool.query(`SELECT * FROM admin_venues`)).rows;
    const dbMap = new Map(dbRows.map(r => [r.id, r]));
    let staged = 0;

    for (const [code, rv] of ragicMap) {
      const cur = dbMap.get(code);
      const payload = { code, ...rv, is_active: true };
      if (!cur) {
        if (await _stageIfNotRejected('H05_VENUES', 'venue', code, 'new', payload, null)) staged++;
        continue;
      }
      const diff = {};
      // Task #66：銀行欄位 (bank_*, account_*) 為系統內部欄位，不從 Ragic 同步
      // 只 stage name / address / is_active
      for (const f of ['name', 'address']) {
        if (cur[`${f}_overridden_at`] != null) continue;
        const from = cur[f] || '';
        const to = rv[f] || '';
        if (from !== to) diff[f] = { from, to };
      }
      if (cur.is_active_overridden_at == null && !cur.is_active) {
        diff.is_active = { from: false, to: true };
      }
      if (Object.keys(diff).length > 0) {
        if (await _stageIfNotRejected('H05_VENUES', 'venue', code, 'update', payload, diff)) staged++;
      } else {
        await _markPendingResolved('venue', code);
      }
    }

    // 不在 Ragic 但 active 中 + 未 override → deactivate stage
    for (const r of dbRows) {
      if (!r.is_active || r.is_active_overridden_at != null || ragicMap.has(r.id)) continue;
      const payload = { code: r.id, name: r.name, is_active: false };
      const diff = { is_active: { from: true, to: false } };
      if (await _stageIfNotRejected('H05_VENUES', 'venue', r.id, 'deactivate', payload, diff)) staged++;
    }
    return { synced: staged, staged, skipped: false };
  } catch (err) {
    console.warn('[Ragic sync] venues failed:', err.message);
    return { synced: 0, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────
// Task #66：Apply staged change（admin approve 後執行的真正 UPSERT）
// 仍尊重 *_overridden_at 欄位保護（防呆：approve 後也不覆蓋人工設定）
// ─────────────────────────────────────────────────────────────
async function _applyStaffChange(row, client) {
  const p = row.payload_json || {};
  if (row.change_type === 'deactivate') {
    await client.query(
      `UPDATE admin_staff SET active = FALSE, last_synced_at = NOW()
         WHERE id = $1 AND active_overridden_at IS NULL`,
      [row.entity_id]
    );
    if (p.name) {
      await client.query(
        `UPDATE admin_users SET is_active = FALSE
           WHERE name = $1 AND is_active = TRUE AND active_overridden_at IS NULL`,
        [p.name]
      );
    }
    return;
  }
  await client.query(
    `INSERT INTO admin_staff (id, name, role, phone, is_senior, multiplier, active, ragic_record_id, last_synced_at)
     VALUES ($1, $2, $3, $4, FALSE, 1.00, $5, $1, NOW())
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       phone = EXCLUDED.phone,
       active = CASE WHEN admin_staff.active_overridden_at IS NULL THEN EXCLUDED.active ELSE admin_staff.active END,
       ragic_record_id = EXCLUDED.ragic_record_id,
       last_synced_at = NOW()`,
    [row.entity_id, p.name || '', p.role || 'staff', p.phone || '', !!p.is_active]
  );
  if (p.is_active === false && p.name) {
    await client.query(
      `UPDATE admin_users SET is_active = FALSE
         WHERE name = $1 AND is_active = TRUE AND active_overridden_at IS NULL`,
      [p.name]
    );
  }
  // Task #91 後續：Ragic 同步的 email 寫入 coaches.email（若 coach row 已存在）。
  // 保留後台手動編輯優先：只在現值為空時才覆寫，避免蓋掉 admin 在彈窗改過的私人信箱。
  if (p.email) {
    await client.query(
      `UPDATE coaches
          SET email = $2, updated_at = NOW()
        WHERE ragic_employee_id = $1
          AND (email IS NULL OR email = '')`,
      [row.entity_id, String(p.email).trim()]
    );
  }
  // ── 教練 1:1 維護：staff↔coach invariant ──
  // 當這次 apply 後的 staff 是教練（role=coach 或 DB 已有 coach 兼任 row），
  // 必須確保 coaches 表存在對應 row，否則 LIFF /api/coaches/by-line-uid 找不到、
  // 教練永遠無法登入。此處做 idempotent UPSERT (ragic_employee_id 為 key)。
  //
  // line_uid 寫入規則（防誤蓋本地已綁定值）：
  //   1) Ragic 有值 + 本地空 → 寫入
  //   2) 本地已有值 → 不被空值覆蓋 (COALESCE)
  //   3) Ragic 與本地不同 → 保留本地，console.warn（人工確認後可用 staging 強制覆蓋）
  const existingCoach = await client.query(
    `SELECT id, line_uid, is_active FROM coaches WHERE ragic_employee_id = $1`,
    [row.entity_id]
  );
  const isCoachRole = String(p.role || '') === 'coach';
  const hasCoachProfile = existingCoach.rowCount > 0;
  const incomingLineUid = p.line_uid ? String(p.line_uid).trim() : '';

  if (hasCoachProfile && incomingLineUid && existingCoach.rows[0].line_uid
      && existingCoach.rows[0].line_uid !== incomingLineUid) {
    console.warn(
      `[ragicAdmin] line_uid mismatch for coach=${row.entity_id}: `
      + `local=${existingCoach.rows[0].line_uid} ragic=${incomingLineUid} → 保留本地值`
    );
  }

  if (isCoachRole && (p.phone || '').trim()) {
    // 新教練：建 coaches row + 同步 venues + 寫入 line_uid（若有）
    const inserted = await client.query(
      `INSERT INTO coaches
         (ragic_employee_id, name, phone, email, line_uid,
          is_senior, pricing_multiplier, specialties, bio_rich_text,
          is_active, intro_review_status, active_overridden_at)
       VALUES ($1, $2, $3, $4, NULLIF($5, ''),
               FALSE, 1.00, ARRAY[]::text[], '',
               $6, 'draft', NOW())
       ON CONFLICT (ragic_employee_id) DO UPDATE SET
         name = EXCLUDED.name,
         phone = EXCLUDED.phone,
         email = COALESCE(NULLIF(EXCLUDED.email, ''), coaches.email),
         line_uid = COALESCE(coaches.line_uid, NULLIF($5, '')),
         is_active = CASE WHEN coaches.active_overridden_at IS NULL
                          THEN EXCLUDED.is_active ELSE coaches.is_active END,
         updated_at = NOW()
       RETURNING id`,
      [row.entity_id, p.name || '', String(p.phone || '').trim(),
       String(p.email || '').trim(), incomingLineUid, !!p.is_active]
    );
    const coachId = inserted.rows[0]?.id;
    if (coachId && Array.isArray(p.venue_ids) && p.venue_ids.length > 0) {
      const venueIds = [...new Set(p.venue_ids.map(String).map(s => s.trim()).filter(Boolean))];
      if (venueIds.length > 0) {
        // 部門可能是「名稱」（新北高中）或「代碼」（B）→ 統一解析成 venue id
        const resolve = await _buildVenueResolver();
        const validIds = resolve(venueIds);
        if (validIds.length > 0) {
          await client.query(`DELETE FROM coach_venues WHERE coach_id = $1`, [coachId]);
          for (const vid of validIds) {
            await client.query(
              `INSERT INTO coach_venues (coach_id, venue_id) VALUES ($1, $2)
               ON CONFLICT DO NOTHING`,
              [coachId, vid]
            );
          }
        }
      }
    }
  } else if (hasCoachProfile && incomingLineUid) {
    // dual-role 兼任教練 或 既有 coach row：只補 line_uid（不覆蓋）
    await client.query(
      `UPDATE coaches
          SET line_uid = COALESCE(line_uid, NULLIF($2, '')),
              updated_at = NOW()
        WHERE ragic_employee_id = $1`,
      [row.entity_id, incomingLineUid]
    );
  }
  // Task #90：同步 admin_staff_venues（多場館），並把第一筆寫回 admin_staff.venue_id 作 fallback
  if (Array.isArray(p.venue_ids) && p.venue_ids.length > 0) {
    const venueIds = [...new Set(p.venue_ids.map(String).map(s => s.trim()).filter(Boolean))];
    if (venueIds.length > 0) {
      // 僅針對 Ragic 上實際存在的 admin_venues 落地，避免 FK violation
      const vr = await client.query(
        `SELECT id FROM admin_venues WHERE id = ANY($1::text[])`,
        [venueIds]
      );
      const validIds = vr.rows.map(x => x.id);
      if (validIds.length > 0) {
        await client.query(`DELETE FROM admin_staff_venues WHERE staff_id = $1`, [row.entity_id]);
        for (const vid of validIds) {
          await client.query(
            `INSERT INTO admin_staff_venues (staff_id, venue_id) VALUES ($1, $2)
             ON CONFLICT DO NOTHING`,
            [row.entity_id, vid]
          );
        }
        // 保留 admin_staff.venue_id 為第一筆 fallback（向下相容舊讀取路徑）
        await client.query(
          `UPDATE admin_staff SET venue_id = $2 WHERE id = $1`,
          [row.entity_id, validIds[0]]
        );
      }
    }
  }
}

async function _applyCoachChange(row, client) {
  const p = row.payload_json || {};
  if (row.change_type === 'deactivate') {
    await client.query(
      `UPDATE coaches SET is_active = FALSE, updated_at = NOW()
         WHERE ragic_employee_id = $1 AND active_overridden_at IS NULL`,
      [row.entity_id]
    );
    return;
  }
  await client.query(
    `INSERT INTO coaches (ragic_employee_id, name, phone, email, line_uid, is_active)
     VALUES ($1, $2, $3, $4, NULLIF($5, ''), TRUE)
     ON CONFLICT (ragic_employee_id) DO UPDATE SET
       name = EXCLUDED.name,
       phone = EXCLUDED.phone,
       email = COALESCE(NULLIF(EXCLUDED.email, ''), coaches.email),
       line_uid = COALESCE(coaches.line_uid, NULLIF($5, '')),
       is_active = CASE WHEN coaches.active_overridden_at IS NULL THEN TRUE ELSE coaches.is_active END,
       updated_at = NOW()`,
    [row.entity_id, p.name || '', p.phone || '', p.email || '', p.line_uid || '']
  );
}

async function _applyVenueChange(row, client) {
  const p = row.payload_json || {};
  const code = row.entity_id;
  if (row.change_type === 'deactivate') {
    await client.query(
      `UPDATE admin_venues SET is_active = FALSE, updated_at = NOW()
         WHERE id = $1 AND is_active_overridden_at IS NULL`,
      [code]
    );
    await client.query(
      `UPDATE venues SET is_active = FALSE, updated_at = NOW() WHERE id = $1`,
      [code]
    );
    return;
  }
  // Task #66：銀行欄位 / line_token 為系統內部欄位，apply 也不從 Ragic 寫入
  // (新 row 用空值佔位；既有 row 完全保留原值)
  await client.query(
    `INSERT INTO admin_venues (id, code, name, address, line_token,
        bank_institution_name, bank_branch_name, account_holder, account_number,
        is_active, last_synced_at)
     VALUES ($1,$1,$2,$3,'','','','','',TRUE,NOW())
     ON CONFLICT (id) DO UPDATE SET
       name = CASE WHEN admin_venues.name_overridden_at IS NULL THEN EXCLUDED.name ELSE admin_venues.name END,
       address = CASE WHEN admin_venues.address_overridden_at IS NULL THEN EXCLUDED.address ELSE admin_venues.address END,
       is_active = CASE WHEN admin_venues.is_active_overridden_at IS NULL THEN TRUE ELSE admin_venues.is_active END,
       last_synced_at = NOW()`,
    [code, p.name || code, p.address || '']
  );
  await client.query(
    `INSERT INTO venues (id, name, full_address, is_active)
     VALUES ($1, $2, $3, TRUE)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       full_address = COALESCE(NULLIF(venues.full_address, ''), EXCLUDED.full_address),
       is_active = TRUE,
       updated_at = NOW()`,
    [code, p.name || code, p.address || '']
  );
}

async function applyStagedChange(stagingId, byUserId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // FOR UPDATE 防併發 approve 同一 row
    const r = await client.query(`SELECT * FROM ragic_staging_changes WHERE id = $1 FOR UPDATE`, [stagingId]);
    if (!r.rowCount) throw new Error('staging row not found');
    const row = r.rows[0];
    if (row.status !== 'pending') throw new Error(`status=${row.status}, only pending can be approved`);
    if (row.entity_type === 'staff')      await _applyStaffChange(row, client);
    else if (row.entity_type === 'coach') await _applyCoachChange(row, client);
    else if (row.entity_type === 'venue') await _applyVenueChange(row, client);
    else throw new Error(`unknown entity_type=${row.entity_type}`);
    await client.query(
      `UPDATE ragic_staging_changes
         SET status = 'approved', reviewed_by = $2, reviewed_at = NOW()
         WHERE id = $1`,
      [stagingId, byUserId]
    );
    await client.query('COMMIT');
    return row;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function rejectStagedChange(stagingId, byUserId, reason) {
  if (!reason || !reason.trim()) throw new Error('reject_reason required');
  const r = await pool.query(`SELECT status FROM ragic_staging_changes WHERE id = $1`, [stagingId]);
  if (!r.rowCount) throw new Error('staging row not found');
  if (r.rows[0].status !== 'pending') throw new Error(`status=${r.rows[0].status}, only pending can be rejected`);
  await pool.query(
    `UPDATE ragic_staging_changes
       SET status = 'rejected', reviewed_by = $2, reviewed_at = NOW(), reject_reason = $3
       WHERE id = $1`,
    [stagingId, byUserId, reason.trim()]
  );
}

async function listStagingChanges({ status = 'pending', form, search } = {}) {
  const where = [];
  const vals = [];
  if (status && status !== 'all') {
    vals.push(status);
    where.push(`status = $${vals.length}`);
  }
  if (form) {
    vals.push(form);
    where.push(`form_code = $${vals.length}`);
  }
  if (search) {
    vals.push(`%${search}%`);
    where.push(`(entity_id ILIKE $${vals.length} OR payload_json::text ILIKE $${vals.length})`);
  }
  const sql = `SELECT s.*, u.name AS reviewer_name
                 FROM ragic_staging_changes s
                 LEFT JOIN admin_users u ON u.id = s.reviewed_by
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY (status = 'pending') DESC, fetched_at DESC
                 LIMIT 500`;
  const r = await pool.query(sql, vals);
  return r.rows;
}

async function countStagingPending() {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM ragic_staging_changes WHERE status = 'pending'`
  );
  return r.rows[0].n;
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

function kickoffSyncStaffAsync()  { _kickoff('staff',  syncStaffFromRagic); }
function kickoffSyncVenuesAsync() { _kickoff('venues', syncVenuesFromRagic); }

// ─────────────────────────────────────────────────────────────
// Task #65：同步紀錄 + 健康檢查 helpers
// 對外暴露的 syncXxxFromRagic 都是「impl + 寫一筆 ragic_sync_log」的 wrapper。
// Z01 / Z02 是「按請求查詢」，沒有 bulk sync；用 getParentByPhone / getStudentByIdNumber
// 對一個不存在的 key 發 where=eq 查詢當「ping」，驗證端點可用 + 回傳筆數（通常 0）。
// ─────────────────────────────────────────────────────────────
async function _pingZ01Impl() {
  if (!ragicEnabled()) return { synced: 0, skipped: true };
  if (!process.env.RAGIC_FORM_Z01) return { synced: 0, error: 'RAGIC_FORM_Z01 未設定' };
  try {
    const r = await ragic.getParentByPhone('__healthcheck__');
    return { synced: r ? 1 : 0, skipped: false };
  } catch (err) {
    return { synced: 0, error: err.message };
  }
}
async function _pingZ02Impl() {
  if (!ragicEnabled()) return { synced: 0, skipped: true };
  if (!process.env.RAGIC_FORM_Z02) return { synced: 0, error: 'RAGIC_FORM_Z02 未設定' };
  try {
    const r = await ragic.getStudentByIdNumber('__healthcheck__');
    return { synced: r ? 1 : 0, skipped: false };
  } catch (err) {
    return { synced: 0, error: err.message };
  }
}

// 每日備份同步：把本地 parents/students 中「尚未同步到 Ragic」的列（新建於後台手動建檔、
// 或 best-effort 即時同步失敗殘留的 last_synced_at IS NULL）補寫回 Ragic Z01/Z02，
// 讓 Ragic 成為本地資料的存續備份，同時修補既有的已知缺口：
//   1) server/routes/admin/customerParents.js 的 POST / 、PATCH /:id 目前只寫本地鏡像，
//      從未同步 Ragic（見該檔案內 TODO(Option A 寫回 Ragic)）。
//   2) server/routes/parents.js 的學員新增/編輯採「本地優先」+ best-effort 即時同步，
//      即時同步失敗時 last_synced_at 留 NULL，但先前沒有任何機制回頭重試。
// 批次上限：避免單輪跑太久／一次打爆 Ragic；跑不完的下一輪（隔天）會繼續處理。
const BACKUP_BATCH_LIMIT = 200;

async function _backupParentToRagic(row) {
  const venueName = await ragic.venueLabel(row.primary_venue_id);
  const payload = {
    [ragic.FIELD.Z01.PARENT_NAME]: row.name || '',
    [ragic.FIELD.Z01.VENUE]: venueName || row.primary_venue_id || '',
    [ragic.FIELD.Z01.PHONE]: row.phone || '',
    [ragic.FIELD.Z01.IDENTITY]: row.identity || '一般身分',
    [ragic.FIELD.Z01.GENDER]: ragic.normalizeGender(row.gender),
    [ragic.FIELD.Z01.EMAIL]: row.email || '',
    [ragic.FIELD.Z01.HOME_PHONE]: row.home_phone || '',
    [ragic.FIELD.Z01.LINE_ID]: row.line_id || '',
    [ragic.FIELD.Z01.HOME_ADDRESS]: row.home_address || '',
  };
  const ragicRecordId = await ragic.syncParentProfileStrict(row, payload);
  await pool.query(
    `UPDATE parents SET ragic_record_id = $2, last_synced_at = NOW() WHERE id = $1`,
    [row.id, ragicRecordId]
  );
  return ragicRecordId;
}

async function _backupStudentToRagic(row) {
  // line_uid 必帶：createStudentZ01Z02Strict 的自我修復在 Z01 找不到家長時會建新家長列，
  // 沒帶 UID 建出來的就是未綁殘留。
  const parent = {
    id: row.parent_id, name: row.p_name, phone: row.p_phone, gender: row.p_gender,
    email: row.p_email, identity: row.p_identity, primary_venue_id: row.p_venue,
    ragic_record_id: row.p_ragic_record_id, line_uid: row.p_line_uid,
  };
  const student = {
    name: row.name, id_number: row.id_number, birth_date: row.birth_date,
    gender: row.gender, blood_type: row.blood_type, student_code: row.student_code,
  };
  let sync;
  if (row.ragic_record_id) {
    sync = await ragic.updateStudentZ01Z02Strict({ parent, student });
  } else {
    const startIndex = Number(
      (await pool.query(`SELECT COUNT(*)::int AS n FROM students WHERE parent_id = $1`, [row.parent_id])).rows[0]?.n || 0
    );
    sync = await ragic.createStudentZ01Z02Strict({ parent, student, startIndex });
  }
  const z02Id = sync?.z02?.ragicRecordId || null;
  await pool.query(
    `UPDATE students SET ragic_record_id = COALESCE($2, ragic_record_id), last_synced_at = NOW() WHERE id = $1`,
    [row.id, z02Id]
  );
  if (sync?.parentRagicRecordId) {
    await pool.query(
      `UPDATE parents SET ragic_record_id = COALESCE(ragic_record_id, $2) WHERE id = $1`,
      [row.parent_id, sync.parentRagicRecordId]
    );
  }
}

async function _backupParentsStudentsImpl() {
  if (!ragicEnabled()) return { synced: 0, skipped: true };
  let synced = 0;
  const errors = [];

  // 政策：Z01 只收「已綁 LINE UID」的會員資料。未綁列（admin 手建/歷史殘留）絕不推上
  // Ragic Z01 —— 推了會在 01:30 pull 被分流進 Z03 佇列，形成「清了又長回來」的殘留循環。
  // `demo:` 哨兵 UID（bootstrap demo 帳號）視為本地測試資料，同樣不推。
  // SELECT 必須帶 line_uid：syncParentProfileStrict 自我修復「重建」Z01 列時
  // （ragic.createParentRagicRecord 依 parent.line_uid 決定要不要寫 UID 欄），
  // 少了它連已綁定家長重建出來的列都會變成未綁殘留。
  const pendingParents = await pool.query(
    `SELECT id, name, phone, gender, email, identity, primary_venue_id,
            home_phone, line_id, home_address, ragic_record_id, line_uid
       FROM parents
      WHERE is_active = TRUE AND line_uid IS NOT NULL AND line_uid <> ''
        AND line_uid NOT LIKE 'demo:%'
        AND line_uid NOT LIKE 'DEMOTEST_%'
        AND (ragic_record_id IS NULL OR last_synced_at IS NULL)
      ORDER BY updated_at ASC LIMIT $1`,
    [BACKUP_BATCH_LIMIT]
  );
  for (const row of pendingParents.rows) {
    try {
      await _backupParentToRagic(row);
      synced++;
    } catch (err) {
      errors.push(err.message);
      console.warn('[ragic-backup] parent sync failed (id=%s):', row.id, err.message);
    }
  }

  // 學員同樣只推「家長已綁 UID」的列：createStudentZ01Z02Strict 的自我修復會在 Z01
  // 找不到家長時建新家長列，未綁家長的學員推上去等於從側門把未綁資料塞進 Z01。
  const pendingStudents = await pool.query(
    `SELECT s.id, s.parent_id, s.name, s.id_number, s.birth_date, s.gender, s.blood_type,
            s.student_code, s.ragic_record_id,
            p.name AS p_name, p.phone AS p_phone, p.gender AS p_gender, p.email AS p_email,
            p.identity AS p_identity, p.primary_venue_id AS p_venue, p.ragic_record_id AS p_ragic_record_id,
            p.line_uid AS p_line_uid
       FROM students s
       JOIN parents p ON p.id = s.parent_id
      WHERE s.is_active = TRUE AND p.is_active = TRUE
        AND p.line_uid IS NOT NULL AND p.line_uid <> ''
        AND p.line_uid NOT LIKE 'demo:%'
        AND p.line_uid NOT LIKE 'DEMOTEST_%'
        AND (s.ragic_record_id IS NULL OR s.last_synced_at IS NULL)
      ORDER BY s.updated_at ASC LIMIT $1`,
    [BACKUP_BATCH_LIMIT]
  );
  for (const row of pendingStudents.rows) {
    try {
      await _backupStudentToRagic(row);
      synced++;
    } catch (err) {
      errors.push(err.message);
      console.warn('[ragic-backup] student sync failed (id=%s):', row.id, err.message);
    }
  }

  return errors.length
    ? { synced, error: `${errors.length} 筆同步失敗（詳見伺服器 log）：${errors[0]}` }
    : { synced };
}

async function backupParentsStudentsToRagic(triggeredBy = 'cron') { return _singleflight('backup', triggeredBy); }

// 每日全量同步：把 Ragic Z01（家長）+ 內嵌子表 Z02（學員）整份清單「拉」進本地
// parents/students，補上既有缺口——目前 Z01/Z02 只有 (a) 登入/註冊時的即時單筆查詢、
// (b) 上面 backup 是反方向（本地→Ragic）。任何被 HR/Ragic 手動異動、但客戶本人
// 從未重新登入過的資料，過去永遠不會回流到本地鏡像；這支排程補上這個缺口。
//
// 刻意不走 parentSync.syncFromRagicRecord()/_syncWithLock：那組防護（advisory lock +
// BindConflictError 409）是設計給「剛驗證身分的即時 LIFF request」用的，背景排程沒有
// activate 使用者可以 409。真正的安全網已內建在 upsertLocalParent 的 SQL 裡——
// line_uid = COALESCE(parents.line_uid, EXCLUDED.line_uid)，本來就不會拿新值覆蓋既有綁定；
// 唯一可能出錯的情況（Ragic 上兩筆不同電話卻同一個 line_uid，撞 parents.line_uid UNIQUE）
// 用逐筆自己的 transaction + catch 處理，失敗記錄後繼續下一筆，不影響其他筆。
//
// 效能：1300+ 家長直接逐筆呼叫 upsertLocalParent/upsertLocalStudents（各自最多 2+3 次
// SELECT）會產生數千次序列 DB 往返，比照 H01 當年的效能事故（262 筆/500+ 往返/78-116秒）
// 換算恐達 20-45 分鐘。這裡跑迴圈前先用 parentSync.loadVenuesMap/loadStudentsByParentPhone
// 一次撈好場館代碼表跟「電話→現有學員列」表，讓 _resolveVenueId 跟三層學員比對都改查
// 記憶體裡的 Map，把大部分序列 SELECT 省掉。
//
// reactivate:false（背景刷新，不復活本地已軟刪的家長，語意同 routes/parents.js /me/sync）。
// 刻意不做「Ragic 沒有的本地家長 → 自動停用」：一來 RAGIC_MAX_PAGES 上限若靜默截斷會
// 誤殺還在的人，二來這個方向本來就該跟 H01/H05 一樣先進待審核，不在這次範圍。
function _pickZ01Raw(z01Row, keys) {
  for (const k of keys) {
    const v = z01Row?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

// 把一筆壞姓名（或已是真人但姓名仍壞）的 Z01 記錄，連同底下學員子表格，整份原始值
// upsert 進 Z03 人工整理表。刻意不經 mapZ01Parent/normalizeGender 之外的任何轉換
// （mapped.* 本身只有 trim + fallback key，沒有語意轉換，可以直接當「原始值」使用；
// 學員子表格改用 parseZ01StudentsRaw，避開 parseZ01Students 的 normalizeDate/toUpperCase）。
// status 只在非 'dismissed' 時重置為 'pending'：一旦人工判定誤判並忽略，往後排程刷新
// 不會又把它翻回待處理，除非真的重新指定。
async function _upsertZ03Record(client, ragicRecordId, mapped, z01Row) {
  if (!ragicRecordId) return;
  const lineChatUrlRaw = _pickZ01Raw(z01Row, ['1002390', 'line對話網址']);
  const studentCountRaw = _pickZ01Raw(z01Row, ['1001138', '名下有幾位學生']);
  const r = await client.query(
    `INSERT INTO ragic_z03_records
       (z01_ragic_record_id, raw_name, venue_raw, phone, identity_raw, gender_raw,
        email_raw, home_phone_raw, home_address_raw, line_id_raw, line_chat_url_raw,
        line_uid_raw, student_count_raw, status, fetched_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending',NOW())
     ON CONFLICT (z01_ragic_record_id) DO UPDATE SET
       raw_name = EXCLUDED.raw_name, venue_raw = EXCLUDED.venue_raw, phone = EXCLUDED.phone,
       identity_raw = EXCLUDED.identity_raw, gender_raw = EXCLUDED.gender_raw,
       email_raw = EXCLUDED.email_raw, home_phone_raw = EXCLUDED.home_phone_raw,
       home_address_raw = EXCLUDED.home_address_raw, line_id_raw = EXCLUDED.line_id_raw,
       line_chat_url_raw = EXCLUDED.line_chat_url_raw, line_uid_raw = EXCLUDED.line_uid_raw,
       student_count_raw = EXCLUDED.student_count_raw,
       status = CASE WHEN ragic_z03_records.status = 'dismissed' THEN 'dismissed' ELSE 'pending' END,
       fixed_name  = CASE WHEN ragic_z03_records.status = 'dismissed' THEN ragic_z03_records.fixed_name  ELSE NULL END,
       resolved_at = CASE WHEN ragic_z03_records.status = 'dismissed' THEN ragic_z03_records.resolved_at ELSE NULL END,
       resolved_by = CASE WHEN ragic_z03_records.status = 'dismissed' THEN ragic_z03_records.resolved_by ELSE NULL END,
       fetched_at = NOW()
     RETURNING id`,
    [ragicRecordId, mapped.name || '', mapped.primary_venue_id || '', mapped.phone || '',
     mapped.identity || '', mapped.gender || '', mapped.email || '', mapped.home_phone || '',
     mapped.home_address || '', mapped.line_id || '', lineChatUrlRaw,
     mapped.line_uid || '', studentCountRaw]
  );
  const z03Id = r.rows[0].id;
  await client.query(`DELETE FROM ragic_z03_students WHERE z03_record_id = $1`, [z03Id]);
  for (const s of ragic.parseZ01StudentsRaw(z01Row)) {
    await client.query(
      `INSERT INTO ragic_z03_students
         (z03_record_id, seq_raw, student_status_raw, name_raw, birth_date_raw,
          gender_raw, id_number_raw, blood_type_raw, age_raw, student_code_raw, registered_phone_raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [z03Id, s.seq_raw, s.student_status_raw, s.name_raw, s.birth_date_raw, s.gender_raw,
       s.id_number_raw, s.blood_type_raw, s.age_raw, s.student_code_raw, s.registered_phone_raw]
    );
  }
}

// 姓名在 Ragic 端已經被改好（人工在 Z03 頁面寫回、或直接在 Ragic 後台改）→ 幫這筆
// Z03 追蹤列畢業。只動 status='pending' 的列，'dismissed' 的忽略列不受影響。
async function _resolveZ03IfPending(client, ragicRecordId, currentRawName) {
  if (!ragicRecordId) return;
  await client.query(
    `UPDATE ragic_z03_records SET status = 'resolved', resolved_at = NOW(), fixed_name = $2
       WHERE z01_ragic_record_id = $1 AND status = 'pending'`,
    [ragicRecordId, currentRawName || '']
  );
}

async function _pullParentsStudentsImpl() {
  if (!ragicEnabled()) return { synced: 0, skipped: true };
  let records;
  try {
    records = await ragic.getAllParents();
  } catch (err) {
    return { synced: 0, error: `Ragic Z01 全量查詢失敗：${err.message}` };
  }

  let synced = 0;
  let quarantinedZ03 = 0;
  const errors = [];
  const client = await pool.connect();
  try {
    const venuesMap = await parentSync.loadVenuesMap(client);
    const studentsByPhone = await parentSync.loadStudentsByParentPhone(client);
    const boundPhones = await parentSync.loadBoundPhones(client);

    // lazy require：parentRefresh 頂層 require ragicAdmin，這裡不可反向頂層 require（避免循環）。
    const { getZ01MissingFields } = require('./parentRefresh');

    for (const z01Row of records) {
      const mapped = ragic.mapZ01Parent(z01Row);
      if (!mapped.phone) continue; // 沒電話無法比對，且 upsertLocalParent 本身也會拒絕
      const ragicRecordId = mapped.ragic_record_id ? String(mapped.ragic_record_id) : String(z01Row._ragicId || '');
      // ── 分流規則（Z01＝登入核心來源）──────────────────────────────────
      // 本地 Z01/Z02 鏡像只收「必填齊全 ＋ LINE UID 已綁定」的完成記錄；
      // 其餘（缺 UID、或任一必填殘缺、或姓名為電話佔位）一律只進 Z03 整理佇列，
      // 不進 parents/students。完整性定義與登入閘門用同一套
      // （parentRefresh.getZ01MissingFields，requireLineUid: true），兩邊不會漂移。
      // 註冊頁以電話比對這個「Z03 池」（= Ragic 端未開通記錄）：對上→回寫 UID，
      // 等客戶補齊必填 → 下輪 pull 自動從 Z03 畢業、落入 Z01。
      const missingFields = getZ01MissingFields(mapped, { rejectPlaceholderName: true, requireLineUid: true });
      const isIncomplete = missingFields.length > 0;
      // 已綁定 line_uid（本地）＝有真人正在使用；殘缺時照樣分流進 Z03（不進 Z01 鏡像），
      // 但「不」軟拆除其既有本地列——登入本來就由 Ragic 完整性閘門（z01_incomplete）把關，
      // 拆掉列只會多害使用中 session 找不到資料。
      const alreadyBound = boundPhones.has(mapped.phone);

      try {
        if (isIncomplete) {
          // 殘缺/未開通 → 只進 Z03，不建立/更新 parents/students。
          // 順手軟拆除舊鏡射殘留：只清「從未綁定」(line_uid IS NULL) 的本地列，
          // 不動任何已綁定的真人使用者列。
          await client.query('BEGIN');
          await _upsertZ03Record(client, ragicRecordId, mapped, z01Row);
          if (!alreadyBound) {
            // 硬刪除無真實 LINE UID 的本地殘留（有業務 FK 者跳過）
            const stale = await client.query(
              `SELECT id FROM parents
                WHERE phone = $1
                  AND (line_uid IS NULL OR line_uid = '' OR line_uid LIKE 'DEMOTEST_%')`,
              [mapped.phone]
            );
            for (const row of stale.rows) {
              await parentSync.hardDeleteParentIfSafe(client, row.id);
            }
          }
          await client.query('COMMIT');
          quarantinedZ03++;
          continue;
        }

        // 完成記錄（必填齊全＋已綁 UID）→ 同步進本地 Z01/Z02 鏡像。
        await client.query('BEGIN');
        const local = await parentSync.upsertLocalParent(client, mapped, mapped.line_uid || null, {
          reactivate: false,
          venuesMap,
        });
        const students = ragic.parseZ01Students(z01Row);
        await parentSync.upsertLocalStudents(client, local.id, students, {
          authoritative: true,
          existingStudents: studentsByPhone.get(mapped.phone) || [],
        });
        // 已完成 → 若先前卡在 Z03 待處理，這裡自動畢業（dismissed 忽略列不受影響）。
        await _resolveZ03IfPending(client, ragicRecordId, mapped.name);
        await client.query('COMMIT');
        synced++;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        errors.push(err.message);
        console.warn('[ragic-pull] parent sync failed (ragicId=%s):', z01Row._ragicId, err.message);
      }
    }

    // ── 不變量掃尾：本地鏡像「只准」已綁 LINE UID 的列 ──
    // 不管未綁列是從哪條路徑漏進來的（歷史殘留、手建、匯入），這裡一律硬刪除。
    // 有業務 FK（課程/簽到/轉讓）的記錄跳過不動，保留業務資料完整性。
    // 硬邊界：只動本地 DB，Ragic 端完全不碰。
    try {
      await client.query('BEGIN');
      const sweep = await client.query(
        `SELECT id FROM parents
          WHERE line_uid IS NULL OR line_uid = '' OR line_uid LIKE 'DEMOTEST_%'`
      );
      let deletedCount = 0;
      for (const row of sweep.rows) {
        const deleted = await parentSync.hardDeleteParentIfSafe(client, row.id);
        if (deleted) deletedCount++;
      }
      if (deletedCount) {
        console.log('[ragic-pull] 掃尾：硬刪除未綁 LINE UID 的殘留列 %d 筆（有 FK 者保留）', deletedCount);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      errors.push(`未綁殘留掃尾失敗：${err.message}`);
      console.warn('[ragic-pull] 未綁殘留掃尾失敗:', err.message);
    }
  } finally {
    client.release();
  }

  return errors.length
    ? { synced, quarantined: quarantinedZ03, error: `${errors.length} 筆同步失敗（詳見伺服器 log）：${errors[0]}` }
    : { synced, quarantined: quarantinedZ03 };
}

async function pullParentsStudentsFromRagic(triggeredBy = 'cron') { return _singleflight('pull', triggeredBy); }

// ─────────────────────────────────────────────────────────────
// Z03 人工整理表 — 後台 API 用（列表 / 本地修正草稿 / 升級 Z01 / 忽略）
// 資料本身由 _pullParentsStudentsImpl 的 Z03 分流邏輯灌入，這裡只負責讀取與人工動作。
// ─────────────────────────────────────────────────────────────
const Z03_RECORD_UPDATE_FIELDS = [
  'raw_name',
  'venue_raw',
  'phone',
  'identity_raw',
  'gender_raw',
  'email_raw',
  'home_phone_raw',
  'home_address_raw',
  'line_id_raw',
  'line_chat_url_raw',
  'line_uid_raw',
  'student_count_raw',
];

const Z03_STUDENT_UPDATE_FIELDS = [
  'seq_raw',
  'student_status_raw',
  'name_raw',
  'birth_date_raw',
  'gender_raw',
  'id_number_raw',
  'blood_type_raw',
  'age_raw',
  'student_code_raw',
  'registered_phone_raw',
];

function _cleanText(v, max = 500) {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : '';
}

function _likePattern(v) {
  return `%${String(v || '').replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

function _digits(v) {
  return String(v || '').replace(/\D/g, '');
}

function _normalizeDateLike(value) {
  const s = _cleanText(value, 30);
  if (!s) return '';
  const m = s.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
  if (!m) return s;
  return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
}

function _z03ParentFromRow(row) {
  return {
    ragic_record_id: String(row.z01_ragic_record_id || '').trim(),
    name: _cleanText(row.raw_name, 120),
    phone: _cleanText(row.phone, 30),
    gender: _cleanText(row.gender_raw, 30),
    email: _cleanText(row.email_raw, 255),
    primary_venue_id: _cleanText(row.venue_raw, 120),
    identity: _cleanText(row.identity_raw, 80),
    home_phone: _cleanText(row.home_phone_raw, 50),
    home_address: _cleanText(row.home_address_raw, 500),
    line_id: _cleanText(row.line_id_raw, 120),
    line_uid: _cleanText(row.line_uid_raw, 160),
    line_chat_url: _cleanText(row.line_chat_url_raw, 500),
  };
}

function _z03StudentFromRow(row) {
  return {
    name: _cleanText(row.name_raw, 100),
    birth_date: _normalizeDateLike(row.birth_date_raw) || null,
    gender: _cleanText(row.gender_raw, 30),
    id_number: _cleanText(row.id_number_raw, 30).toUpperCase(),
    blood_type: _cleanText(row.blood_type_raw, 20) || '不清楚',
    student_code: _cleanText(row.student_code_raw, 80),
  };
}

function getZ03UpgradeMissingFields(row) {
  const parent = _z03ParentFromRow(row);
  const missing = [];
  const required = [
    ['name', '家長姓名'],
    ['identity', '角色身份'],
    ['primary_venue_id', '場館'],
    ['phone', '電話'],
    ['email', 'Email'],
    ['line_uid', 'LINE UID'],
    ['gender', '性別'],
  ];
  for (const [key, label] of required) {
    if (!String(parent[key] || '').trim()) missing.push({ key, label });
  }
  if (
    parent.line_uid &&
    (parent.line_uid.startsWith('demo:') || parent.line_uid.startsWith('DEMOTEST_')) &&
    !missing.some((m) => m.key === 'line_uid')
  ) {
    missing.push({ key: 'line_uid', label: '真實 LINE UID' });
  }
  if (parent.primary_venue_id === '待補登' && !missing.some((m) => m.key === 'primary_venue_id')) {
    missing.push({ key: 'primary_venue_id', label: '場館' });
  }
  if (parent.name && isPlaceholderParentName(parent.name) && !missing.some((m) => m.key === 'name')) {
    missing.push({ key: 'name', label: '家長姓名' });
  }
  const validStudents = (row.students || []).map(_z03StudentFromRow).filter((s) => s.name);
  if (!validStudents.length) missing.push({ key: 'students', label: '至少一位學員姓名' });
  validStudents.forEach((s, idx) => {
    if (!s.id_number && !s.student_code) {
      missing.push({ key: `students.${idx}.student_code`, label: `第 ${idx + 1} 位學員編號或身分證字號` });
    }
  });
  return missing;
}

async function _loadZ03RecordById(id, clientOrPool = pool) {
  const record = (await clientOrPool.query(`SELECT * FROM ragic_z03_records WHERE id = $1`, [id])).rows[0];
  if (!record) return null;
  const students = (await clientOrPool.query(
    `SELECT * FROM ragic_z03_students WHERE z03_record_id = $1 ORDER BY seq_raw, id`,
    [record.id]
  )).rows;
  return { ...record, students };
}

async function listZ03Records({ status = 'pending', q = '' } = {}) {
  const where = [];
  const vals = [];
  if (status && status !== 'all') {
    vals.push(status);
    where.push(`status = $${vals.length}`);
  }
  const query = String(q || '').trim();
  if (query) {
    const parts = [];
    const phoneDigits = _digits(query);
    if (phoneDigits) {
      vals.push(`%${phoneDigits}%`);
      parts.push(`regexp_replace(COALESCE(phone,''), '\\D', '', 'g') LIKE $${vals.length}`);
    }
    vals.push(_likePattern(query));
    parts.push(`EXISTS (
      SELECT 1 FROM ragic_z03_students zs
       WHERE zs.z03_record_id = ragic_z03_records.id
         AND COALESCE(zs.name_raw, '') ILIKE $${vals.length} ESCAPE '\\'
    )`);
    where.push(`(${parts.join(' OR ')})`);
  }
  const records = (await pool.query(
    `SELECT * FROM ragic_z03_records
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY (status = 'pending') DESC, fetched_at DESC`,
    vals
  )).rows;
  if (!records.length) return records;

  const students = (await pool.query(
    `SELECT * FROM ragic_z03_students WHERE z03_record_id = ANY($1) ORDER BY seq_raw`,
    [records.map((r) => r.id)]
  )).rows;
  const byRecord = new Map();
  for (const s of students) {
    const list = byRecord.get(s.z03_record_id);
    if (list) list.push(s); else byRecord.set(s.z03_record_id, [s]);
  }
  return records.map((r) => ({ ...r, students: byRecord.get(r.id) || [] }));
}

async function _upgradeZ03RecordToZ01(row, adminUsername) {
  if (row.status === 'dismissed') {
    return { upgraded: false, skipped: 'dismissed', missing: [] };
  }
  const missing = getZ03UpgradeMissingFields(row);
  if (missing.length) return { upgraded: false, missing };

  const parent = _z03ParentFromRow(row);
  const students = (row.students || []).map(_z03StudentFromRow).filter((s) => s.name);

  const venueName = await ragic.venueLabel(parent.primary_venue_id);
  const payload = {
    [ragic.FIELD.Z01.PARENT_NAME]: parent.name,
    [ragic.FIELD.Z01.VENUE]: venueName || parent.primary_venue_id,
    [ragic.FIELD.Z01.PHONE]: parent.phone,
    [ragic.FIELD.Z01.IDENTITY]: parent.identity,
    [ragic.FIELD.Z01.GENDER]: parent.gender,
    [ragic.FIELD.Z01.EMAIL]: parent.email,
    [ragic.FIELD.Z01.HOME_PHONE]: parent.home_phone,
    [ragic.FIELD.Z01.HOME_ADDRESS]: parent.home_address,
    [ragic.FIELD.Z01.LINE_ID]: parent.line_id,
    [ragic.FIELD.Z01.LINE_UID]: parent.line_uid,
  };
  if (parent.line_chat_url) payload[ragic.FIELD.Z01.LINE_CHAT_URL] = parent.line_chat_url;

  // Z01 不再允許未綁 LINE UID 的資料寫入：人工升級時先把既有 Z01 主表補成
  // 已綁定狀態，再寫學員，避免升級途中把新學員資料掛到未綁家長列。
  await ragic.upsertParentStrict(payload, parent.ragic_record_id);

  for (const student of students) {
    await ragic.updateStudentZ01Z02Strict({ parent, student });
  }

  const parentRefresh = require('./parentRefresh');
  const refreshed = await parentRefresh.refreshParentMirrorFromRagic({
    lineUid: parent.line_uid,
    phone: parent.phone,
    minStudents: students.length,
    reason: 'admin-z03-upgrade',
  });

  await pool.query(
    `UPDATE ragic_z03_records
        SET status = 'resolved', fixed_name = $2, resolved_at = NOW(), resolved_by = $3
      WHERE id = $1`,
    [row.id, parent.name, adminUsername || null]
  );

  return { upgraded: true, missing: [], refreshed };
}

async function saveZ03RecordDraft(id, payload = {}, adminUsername = null) {
  const recordIn = payload.record && typeof payload.record === 'object' ? payload.record : {};
  const studentsIn = Array.isArray(payload.students) ? payload.students : [];
  const client = await pool.connect();
  let saved;
  try {
    await client.query('BEGIN');
    const current = (await client.query(`SELECT * FROM ragic_z03_records WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!current) throw new Error('找不到這筆 Z03 記錄');

    const set = [];
    const vals = [id];
    for (const field of Z03_RECORD_UPDATE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(recordIn, field)) {
        vals.push(_cleanText(recordIn[field], field === 'home_address_raw' || field === 'line_chat_url_raw' ? 500 : 255));
        set.push(`${field} = $${vals.length}`);
      }
    }
    if (set.length) {
      await client.query(
        `UPDATE ragic_z03_records SET ${set.join(', ')} WHERE id = $1`,
        vals
      );
    }

    if (studentsIn.length) {
      const existing = (await client.query(
        `SELECT id FROM ragic_z03_students WHERE z03_record_id = $1`,
        [id]
      )).rows.map((r) => String(r.id));
      const existingIds = new Set(existing);
      for (const student of studentsIn) {
        const sid = String(student?.id || '').trim();
        if (!sid || !existingIds.has(sid)) {
          throw new Error('學員資料不屬於這筆 Z03 記錄，請重新整理後再試');
        }
        const sSet = [];
        const sVals = [sid, id];
        for (const field of Z03_STUDENT_UPDATE_FIELDS) {
          if (Object.prototype.hasOwnProperty.call(student, field)) {
            sVals.push(_cleanText(student[field], 255));
            sSet.push(`${field} = $${sVals.length}`);
          }
        }
        if (sSet.length) {
          await client.query(
            `UPDATE ragic_z03_students SET ${sSet.join(', ')}
              WHERE id = $1 AND z03_record_id = $2`,
            sVals
          );
        }
      }
    }

    saved = await _loadZ03RecordById(id, client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  let upgrade;
  try {
    upgrade = await _upgradeZ03RecordToZ01(saved, adminUsername);
  } catch (err) {
    err.z03Saved = true;
    err.z03Item = await _loadZ03RecordById(id).catch(() => saved);
    throw err;
  }
  const item = await _loadZ03RecordById(id);
  return { item, ...upgrade };
}

// 人工確認正確姓名 → 只寫回 Ragic Z01 的姓名欄位（Field ID，partial update，
// 不動同一筆的其他欄位），成功才標記本地 resolved；下一輪 01:00 pull 會依
// _resolveZ03IfPending 的邏輯自然把這筆同步進 parents/students。
async function resolveZ03Record(id, fixedName, adminUsername) {
  const name = String(fixedName || '').trim();
  if (!name) throw new Error('請輸入正確姓名');
  const row = (await pool.query(`SELECT * FROM ragic_z03_records WHERE id = $1`, [id])).rows[0];
  if (!row) throw new Error('找不到這筆 Z03 記錄');
  // 修正後的姓名不能還是純數字（電話號碼），否則下一輪 pull 會依同一條線又把它分流回 Z03。
  if (isPlaceholderParentName(name)) throw new Error('這個姓名看起來仍是電話號碼，請確認後再送出');

  await ragic.upsertParentStrict({ [ragic.FIELD.Z01.PARENT_NAME]: name }, row.z01_ragic_record_id);

  const updated = (await pool.query(
    `UPDATE ragic_z03_records
        SET status = 'resolved', fixed_name = $2, resolved_at = NOW(), resolved_by = $3
      WHERE id = $1
      RETURNING *`,
    [id, name, adminUsername || null]
  )).rows[0];
  return updated;
}

async function dismissZ03Record(id, adminUsername) {
  const updated = (await pool.query(
    `UPDATE ragic_z03_records
        SET status = 'dismissed', resolved_at = NOW(), resolved_by = $2
      WHERE id = $1
      RETURNING *`,
    [id, adminUsername || null]
  )).rows[0];
  if (!updated) throw new Error('找不到這筆 Z03 記錄');
  return updated;
}

// 家長「即時綁定當下」把佔位電話姓名改成真實姓名（同時回寫 Ragic Z01 + 綁 UID）時呼叫：
// 讓對應的 Z03 追蹤列與 ragic_z01_quarantine 追蹤列立即畢業，不必等下一輪 01:00 pull 的
// _resolveZ03IfPending 自然收尾。best-effort 用途：caller 應 .catch 吞掉錯誤——Ragic/本地
// 寫入才是綁定主流程，這裡的追蹤表收尾失敗不該擋使用者登入。
async function markPlaceholderNameResolved(ragicRecordId, fixedName) {
  if (!ragicRecordId) return;
  const id = String(ragicRecordId);
  const name = String(fixedName || '').trim();
  await _resolveZ03IfPending(pool, id, name);
  await pool.query(
    `UPDATE ragic_z01_quarantine SET resolved_at = NOW(), resolved_name = $2
       WHERE z01_ragic_record_id = $1 AND resolved_at IS NULL`,
    [id, name]
  );
}

// ─────────────────────────────────────────────────────────────
// Z01 家長姓名資料品質偵測（Z01↔Z03 機制的可先做部分）
//
// 背景：2026-06-30 匯入的舊系統學生資料批次，511 筆 Z01 記錄裡有 433 筆（85%）的
// 「家長姓名」欄位其實是電話號碼（例如姓名欄=行動電話欄=「0926332176」），不是真實姓名。
// Z03（另一新表單，供人工整理新舊資料用）與「壞姓名寫進 Z03、家長改對名字後回頭清理」
// 這兩塊，卡在 Z03 表單是否已建好、實際欄位 ID 尚未確認，暫緩實作（見下方 TODO）。
// 這裡先做「偵測 + 本地追蹤」，不依賴 Z03 就能先跑：可以先掌握目前還有多少筆爛資料、
// 且已內建「治癒後標記解決」的掛勾點（見 server/routes/parents.js `PATCH /me`）。
// ─────────────────────────────────────────────────────────────

// 佔位電話姓名偵測（＝「拿電話號碼頂替姓名」的孤兒資料，觸發進 Z03 清洗、且不可當畢業姓名）。
// 兩條規則（皆先去除常見電話格式符號 空白/-/()/．後再判斷）：
//   Tier 1：整串是純數字（任何長度）→ 幾乎可以肯定是佔位電話（已知真實案例：「0926332176」）。
//   Tier 1b：去符號後長度落在電話號碼區間（8–11 碼）且「數字佔過半」→ 視同佔位電話
//            （涵蓋電話字串誤黏一兩個字、或夾雜非標準分隔字元的情形，如「0926332176王」）。
//            真實中文/英文姓名極少同時「8–11 字長」又「過半是數字」，誤判率仍低。
// 兩條都不中 → 視為正常姓名（含短姓名、英文名如「Mandy」），照常同步、可當畢業姓名。
function isPlaceholderParentName(name) {
  const stripped = String(name || '').trim().replace(/[\s\-()（）.]/g, '');
  if (!stripped) return false; // 空姓名是另一個問題（Z01 姓名為必填），不併入這條規則判斷
  if (/^\d+$/.test(stripped)) return true;               // Tier 1：純數字
  const digitCount = (stripped.match(/\d/g) || []).length; // Tier 1b：電話長度 + 數字過半
  return stripped.length >= 8 && stripped.length <= 11 && digitCount * 2 > stripped.length;
}

// Tier 2：完全不含中文字——範圍更寬，但這個系統從沒驗證過姓名格式，不能排除真的有
// 非中文姓名的家長。先只回傳判斷結果供統計/記錄用，暫不接自動觸發追蹤，等實際抽樣
// 確認這類資料真的都是垃圾資料後，才考慮升級成跟 Tier 1 一樣的觸發條件。
function hasNoCjkCharacters(name) {
  return !/[㐀-鿿豈-﫿]/.test(String(name || ''));
}

// 偵測 + 維護本地追蹤表（不依賴 Z03，可獨立跑）。目前只掃 Tier 1（純數字姓名）。
async function _quarantineBadZ01NamesImpl() {
  if (!ragicEnabled()) return { synced: 0, skipped: true };
  let records;
  try {
    records = await ragic.getAllParents();
  } catch (err) {
    return { synced: 0, error: `Ragic Z01 全量查詢失敗：${err.message}` };
  }

  let tier1Count = 0, tier2Count = 0, tracked = 0;
  const errors = [];
  for (const z01Row of records) {
    const mapped = ragic.mapZ01Parent(z01Row);
    if (!mapped.name || !z01Row._ragicId) continue;
    if (hasNoCjkCharacters(mapped.name)) tier2Count++; // 純統計，不觸發追蹤
    if (!isPlaceholderParentName(mapped.name)) continue;
    tier1Count++;
    try {
      await pool.query(
        `INSERT INTO ragic_z01_quarantine (z01_ragic_record_id, phone, bad_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (z01_ragic_record_id) DO UPDATE SET
           phone = EXCLUDED.phone, bad_name = EXCLUDED.bad_name
           WHERE ragic_z01_quarantine.resolved_at IS NULL`,
        [String(z01Row._ragicId), mapped.phone || '', mapped.name]
      );
      tracked++;
    } catch (err) {
      errors.push(err.message);
      console.warn('[ragic-quarantine] track failed (ragicId=%s):', z01Row._ragicId, err.message);
    }
  }

  // TODO(Z03)：等 Z03 表單確認存在 + 拿到真實欄位 ID 後，這裡補上「把 tracked 未推送過的
  // 記錄寫進 Z03」；ragicSchema.js 需補 FORMS.Z03/Z03_FIELDS/FIELD.Z03。
  // 在那之前，本 job 只維護本地 ragic_z01_quarantine 追蹤表，供後續人工查閱有多少筆待處理。
  const note = `偵測到 ${tier1Count} 筆姓名疑似為電話號碼（另有 ${tier2Count} 筆不含中文字，僅統計未觸發）；Z03 推送待 Z03 表單確認後補上`;
  return errors.length
    ? { synced: tracked, error: `${errors.length} 筆追蹤寫入失敗（詳見伺服器 log）：${errors[0]}`, note }
    : { synced: tracked, note };
}

async function quarantineBadZ01Names(triggeredBy = 'cron') { return _singleflight('quarantine', triggeredBy); }

// Task #91：F-C-Admin 已合併至員工帳號管理；coaches 不再列為獨立 sync job。
// staff sync 已會順帶 upsert coaches 1:1 行（透過 ragic_employee_id 對應），
// 因此 FORM_META 移除 coaches 入口，避免後台「Ragic 狀態」頁顯示一張無法觸發的卡片。
// Task #94：kind 區分「bulk sync 全表同步」與「healthcheck 連線 ping」。
// 前者真的會把 Ragic 差異寫進 staging 區；後者只發一筆 where=eq 驗證端點可用，
// last_count 通常 0—1，並非「同步多少筆資料」。前端依此切換 UI 文案。
const FORM_META = {
  staff:    { code: 'H01_STAFF',    label: 'H01 員工 + 教練 (admin_staff + coaches)', kind: 'sync',        impl: _syncStaffImpl,  env: 'RAGIC_FORM_H01' },
  venues:   { code: 'H05_VENUES',   label: 'H05 場館 (venues)',                       kind: 'sync',        impl: _syncVenuesImpl, env: 'RAGIC_FORM_H05' },
  parents:  { code: 'Z01_PARENTS',  label: 'Z01 家長 (按請求查詢)',                   kind: 'healthcheck', impl: _pingZ01Impl,    env: 'RAGIC_FORM_Z01' },
  students: { code: 'Z02_STUDENTS', label: 'Z02 學員 (按請求查詢)',                   kind: 'healthcheck', impl: _pingZ02Impl,    env: 'RAGIC_FORM_Z02' },
  // 夜間同步鏈：backup（00:30 推）→ pull（01:30 拉，Ragic→Z03 分流）→ quarantine（01:45 掃描）。
  // 標籤依使用者指定：backup 維持原名；pull 明示「從 Ragic 拉到 Z03」以與 backup 區隔。
  backup:   { code: 'Z01_Z02_BACKUP', label: 'Z01/Z02 本地→Ragic 每日備份同步',       kind: 'sync',        impl: _backupParentsStudentsImpl, env: 'RAGIC_FORM_Z01' },
  pull:     { code: 'Z01_Z02_PULL',   label: 'Ragic Z01 → Z03 每日拉回整理（完成者入 Z01 鏡像）', kind: 'sync', impl: _pullParentsStudentsImpl,   env: 'RAGIC_FORM_Z01' },
  quarantine: { code: 'Z01_BAD_NAME_QUARANTINE', label: 'Z01 姓名品質掃描（Z03 追蹤）', kind: 'sync', impl: _quarantineBadZ01NamesImpl, env: 'RAGIC_FORM_Z01' },
};

// ── 每個 Ragic sync job 可由 admin 在「Ragic 連線狀態」頁手動開關 ──
// 存 admin_settings（key=ragic_sync_enabled_<job>，value 1/0；NUMERIC 欄位不能存布林/字串）。
// 缺該 key 一律視為「啟用」，維持既有行為，不需要額外 migration/seed。
function _toggleKey(jobName) { return `ragic_sync_enabled_${jobName}`; }

async function isJobEnabled(jobName) {
  const r = await pool.query(`SELECT value FROM admin_settings WHERE key = $1`, [_toggleKey(jobName)]);
  return r.rows.length ? Number(r.rows[0].value) !== 0 : true;
}

async function setJobEnabled(jobName, enabled) {
  if (!FORM_META[jobName]) throw new Error(`unknown ragic sync job: ${jobName}`);
  await pool.query(
    `INSERT INTO admin_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [_toggleKey(jobName), enabled ? 1 : 0]
  );
}

async function getJobToggles() {
  const jobs = Object.keys(FORM_META);
  const r = await pool.query(
    `SELECT key, value FROM admin_settings WHERE key = ANY($1)`,
    [jobs.map(_toggleKey)]
  );
  const byKey = new Map(r.rows.map((row) => [row.key, Number(row.value) !== 0]));
  const out = {};
  for (const j of jobs) out[j] = byKey.has(_toggleKey(j)) ? byKey.get(_toggleKey(j)) : true;
  return out;
}

/**
 * 夜間排程順序閘門：#1（00:30 本地→Ragic 回寫）最近一次是否成功。
 * 給 #2（01:30 Ragic Z01→本地/Z03 拉回）與 #3（01:45 品質掃描）當前置條件——
 * 回寫沒成功就拉回，會把「本地已修正、還沒推上去」的舊 Ragic 狀態灌回 Z03（堵塞 Z03）。
 * 以 DB 的 ragic_sync_log 判定（非記憶體旗標），伺服器半夜重啟不影響判斷。
 * 'skipped'（admin 手動停用 backup job）視為放行：管理者刻意停推送時，不該把拉回也卡死。
 */
async function hasRecentBackupSuccess(windowHours = 3) {
  const r = await pool.query(
    `SELECT 1 FROM ragic_sync_log
      WHERE form_code = 'Z01_Z02_BACKUP'
        AND status IN ('ok', 'skipped')
        AND created_at >= NOW() - ($1 || ' hours')::interval
      LIMIT 1`,
    [windowHours]
  );
  return r.rowCount > 0;
}

async function _logSyncResult(jobName, formCode, result, durationMs, triggeredBy) {
  const status = result?.skipped ? 'skipped' : (result?.error ? 'error' : 'ok');
  try {
    await pool.query(
      `INSERT INTO ragic_sync_log (form_code, job_name, status, synced_count, error_message, duration_ms, triggered_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [formCode, jobName, status, result?.synced || 0, result?.error || null, durationMs, triggeredBy]
    );
  } catch (e) {
    console.warn('[ragic_sync_log] insert failed:', e.message);
  }
}

async function _runWithLog(jobName, triggeredBy = 'cron') {
  const meta = FORM_META[jobName];
  if (!meta) throw new Error(`unknown ragic sync job: ${jobName}`);
  // admin 手動關閉的 job：cron 觸發和手動「立即同步」都在這裡統一擋下
  // （所有觸發路徑最終都走 _runWithLog，單一把關點，不用個別改 cron.schedule）。
  if (!(await isJobEnabled(jobName))) {
    const result = { synced: 0, skipped: true, disabled: true };
    await _logSyncResult(jobName, meta.code, result, 0, triggeredBy);
    return result;
  }
  const t0 = Date.now();
  let result;
  try {
    result = await meta.impl();
  } catch (err) {
    result = { synced: 0, error: err.message };
  }
  const dur = Date.now() - t0;
  await _logSyncResult(jobName, meta.code, result, dur, triggeredBy);
  return result;
}

// Task #83：in-memory single-flight mutex（同一個 job 同時只跑一個 Promise）
// 解決：cron + 手動「立即同步全部」雙擊 → Ragic 同一筆查詢被打多次造成更慢、更易 timeout。
// 後到者直接 reuse 進行中的 Promise，等同一份結果。
const _inflight = new Map(); // jobName -> Promise
function _singleflight(jobName, triggeredBy) {
  const existing = _inflight.get(jobName);
  if (existing) return existing;
  const p = _runWithLog(jobName, triggeredBy).finally(() => {
    if (_inflight.get(jobName) === p) _inflight.delete(jobName);
  });
  _inflight.set(jobName, p);
  return p;
}
function isJobRunning(jobName) { return _inflight.has(jobName); }
function getRunningJobs() { return Array.from(_inflight.keys()); }

async function syncStaffFromRagic(triggeredBy = 'cron')    { return _singleflight('staff',    triggeredBy); }
async function syncVenuesFromRagic(triggeredBy = 'cron')   { return _singleflight('venues',   triggeredBy); }
async function pingParentsFromRagic(triggeredBy = 'cron')  { return _singleflight('parents',  triggeredBy); }
async function pingStudentsFromRagic(triggeredBy = 'cron') { return _singleflight('students', triggeredBy); }
function getRagicJobNames() { return Object.keys(FORM_META); }

function getRagicEnvFlags() {
  return {
    RAGIC_API_KEY:  !!process.env.RAGIC_API_KEY,
    RAGIC_BASE_URL: !!process.env.RAGIC_BASE_URL,
    RAGIC_FORM_H01: !!process.env.RAGIC_FORM_H01,
    RAGIC_FORM_H05: !!process.env.RAGIC_FORM_H05,
    RAGIC_FORM_Z01: !!process.env.RAGIC_FORM_Z01,
    RAGIC_FORM_Z02: !!process.env.RAGIC_FORM_Z02,
  };
}

/**
 * 各 form 的同步狀態：最後一次執行 + 最後一次成功 + 最近錯誤。
 * 給 GET /api/admin/ragic-status 用。
 */
async function getSyncStatusSnapshot() {
  const toggles = await getJobToggles();
  const out = {};
  for (const [job, meta] of Object.entries(FORM_META)) {
    const latest = await pool.query(
      `SELECT status, synced_count, error_message, duration_ms, created_at, triggered_by
         FROM ragic_sync_log WHERE form_code = $1 ORDER BY created_at DESC LIMIT 1`,
      [meta.code]
    );
    const lastOk = await pool.query(
      `SELECT synced_count, duration_ms, created_at
         FROM ragic_sync_log WHERE form_code = $1 AND status = 'ok'
         ORDER BY created_at DESC LIMIT 1`,
      [meta.code]
    );
    out[job] = {
      form_code: meta.code,
      label: meta.label,
      kind: meta.kind || 'sync',
      admin_enabled:         toggles[job],
      in_progress:           isJobRunning(job),
      last_run_at:           latest.rows[0]?.created_at      || null,
      last_status:           latest.rows[0]?.status          || null,
      last_triggered_by:     latest.rows[0]?.triggered_by    || null,
      last_error:            latest.rows[0]?.error_message   || null,
      last_run_count:        latest.rows[0]?.synced_count ?? null,
      last_run_duration_ms:  latest.rows[0]?.duration_ms  ?? null,
      last_success_at:       lastOk.rows[0]?.created_at      || null,
      last_success_count:    lastOk.rows[0]?.synced_count ?? null,
      last_success_duration_ms: lastOk.rows[0]?.duration_ms  ?? null,
      // 向後相容欄位（保留舊鍵；前端持續可用，含義仍以 success 為準）
      last_count:       lastOk.rows[0]?.synced_count ?? null,
      last_duration_ms: lastOk.rows[0]?.duration_ms  ?? null,
    };
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Task #54：兩階段場館同步（dry-run diff + 使用者確認後再寫入）
// ─────────────────────────────────────────────────────────────
const VENUE_SYNC_FIELDS = [
  'name', 'address',
  'bank_institution_name', 'bank_branch_name',
  'account_holder', 'account_number',
];

function _mapRagicVenue(r) {
  const code = (r['部門編號'] || r['場館代號'] || r['館別代碼'] || r['1000253'] || '').toString().trim();
  if (!code) return null;
  return {
    code,
    name:                  r['部門名稱'] || r['場館名稱'] || r['館別名稱'] || r['1000254'] || code,
    address:               r['完整地址'] || r['場館地址'] || r['地址'] || r['1000271'] || '',
    bank_institution_name: r['總機構名稱'] || r['1001013'] || '',
    bank_branch_name:      r['分支機構名稱'] || r['1001015'] || '',
    account_holder:        r['戶名'] || r['1001016'] || '',
    account_number:        (r['帳號'] || r['1001017'] || '').toString(),
  };
}

/**
 * dry-run：撈 H05 + 比對 admin_venues，回傳 {added, updated, removed}。
 * - added：Ragic 有但 DB 沒有（或 DB is_active=false）→ 第二階段會 INSERT / 重新啟用
 * - updated：兩邊都有，但有任一同步欄位值不同 → changes 內標 overridden 旗標
 * - removed：DB 有 active 場館但 Ragic 沒有 → 第二階段軟刪除
 */
async function diffVenuesFromRagic() {
  if (!ragicEnabled()) {
    return { skipped: true, reason: 'Ragic 未設定 (RAGIC_API_KEY / RAGIC_BASE_URL)', added: [], updated: [], removed: [] };
  }
  const records = await ragic.getActiveVenues();
  const ragicMap = new Map();
  for (const r of records) {
    const v = _mapRagicVenue(r);
    if (v) ragicMap.set(v.code, v);
  }
  const dbRows = (await pool.query(`SELECT * FROM admin_venues`)).rows;
  const dbMap = new Map(dbRows.map(r => [r.id, r]));

  const added = [], updated = [], removed = [];
  for (const [code, rv] of ragicMap) {
    const cur = dbMap.get(code);
    if (!cur || cur.is_active === false) {
      added.push({ code, ...rv, reactivate: !!cur });
      continue;
    }
    const changes = {};
    for (const f of VENUE_SYNC_FIELDS) {
      const from = cur[f] || '';
      const to = rv[f] || '';
      if (from !== to) {
        changes[f] = { from, to, overridden: cur[`${f}_overridden_at`] != null };
      }
    }
    if (Object.keys(changes).length > 0) {
      updated.push({ code, name: cur.name, changes });
    }
  }
  for (const r of dbRows) {
    if (r.is_active && !ragicMap.has(r.id)) {
      removed.push({ code: r.id, name: r.name, overridden: r.is_active_overridden_at != null });
    }
  }
  return { skipped: false, added, updated, removed };
}

/**
 * 第二階段：依 selections 套用 diff。
 * selections = { added:[code], updated:[code], removed:[code] }
 * - 跳過 *_overridden_at != null 的欄位（updated）/ 整列（is_active_overridden_at；removed）
 */
async function applyVenueSync(selections = {}) {
  const want = {
    added: new Set(selections.added || []),
    updated: new Set(selections.updated || []),
    removed: new Set(selections.removed || []),
  };
  const records = await ragic.getActiveVenues();
  const ragicMap = new Map();
  for (const r of records) {
    const v = _mapRagicVenue(r);
    if (v) ragicMap.set(v.code, v);
  }

  // Atomic：所有 add / update / remove + 跨表 mirror 寫入包在同一筆 transaction，
  // 避免中途失敗導致 admin_venues vs venues 兩表分歧或部分套用。
  const client = await pool.connect();
  let addedCount = 0, updatedCount = 0, removedCount = 0;
  try {
    await client.query('BEGIN');
    const dbRows = (await client.query(`SELECT * FROM admin_venues`)).rows;
    const dbMap = new Map(dbRows.map(r => [r.id, r]));

    for (const code of want.added) {
      const rv = ragicMap.get(code);
      if (!rv) continue;
      const cur = dbMap.get(code);
      if (cur) {
        // 後台手動覆寫過 is_active（is_active_overridden_at != null）→ 跳過重新啟用，
        // 與 removed 路徑同樣尊重覆寫保護，避免 sync 蓋掉操作者明確意圖。
        if (cur.is_active_overridden_at != null) continue;
        // 重新啟用：admin_venues + LIFF venues 同步 active=TRUE，並把所有同步欄位
        // 從 Ragic 最新值刷新（仍尊重 *_overridden_at 個別欄位覆寫）。
        await client.query(
          `UPDATE admin_venues SET
             is_active = TRUE,
             name = CASE WHEN name_overridden_at IS NULL THEN $2 ELSE name END,
             address = CASE WHEN address_overridden_at IS NULL THEN $3 ELSE address END,
             bank_institution_name = CASE WHEN bank_institution_name_overridden_at IS NULL THEN $4 ELSE bank_institution_name END,
             bank_branch_name = CASE WHEN bank_branch_name_overridden_at IS NULL THEN $5 ELSE bank_branch_name END,
             account_holder = CASE WHEN account_holder_overridden_at IS NULL THEN $6 ELSE account_holder END,
             account_number = CASE WHEN account_number_overridden_at IS NULL THEN $7 ELSE account_number END,
             last_synced_at = NOW(), updated_at = NOW()
             WHERE id = $1`,
          [code, rv.name, rv.address, rv.bank_institution_name, rv.bank_branch_name, rv.account_holder, rv.account_number]
        );
        await client.query(
          `INSERT INTO venues (id, name, full_address, is_active)
           VALUES ($1,$2,$3,TRUE)
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name,
             full_address = COALESCE(NULLIF(venues.full_address, ''), EXCLUDED.full_address),
             is_active = TRUE, updated_at = NOW()`,
          [code, rv.name, rv.address]
        );
      } else {
        await client.query(
          `INSERT INTO admin_venues (id, code, name, address, line_token,
              bank_institution_name, bank_branch_name, account_holder, account_number,
              is_active, last_synced_at)
           VALUES ($1,$1,$2,$3,'',$4,$5,$6,$7,TRUE,NOW())`,
          [code, rv.name, rv.address, rv.bank_institution_name, rv.bank_branch_name, rv.account_holder, rv.account_number]
        );
        await client.query(
          `INSERT INTO venues (id, name, full_address, is_active)
           VALUES ($1,$2,$3,TRUE)
           ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name,
             full_address = COALESCE(NULLIF(venues.full_address, ''), EXCLUDED.full_address),
             is_active = TRUE, updated_at = NOW()`,
          [code, rv.name, rv.address]
        );
      }
      addedCount += 1;
    }

    for (const code of want.updated) {
      const rv = ragicMap.get(code);
      const cur = dbMap.get(code);
      if (!rv || !cur) continue;
      const sets = [];
      const vals = [code];
      let i = 2;
      let touchesNameOrAddr = false;
      for (const f of VENUE_SYNC_FIELDS) {
        const from = cur[f] || '';
        const to = rv[f] || '';
        if (from === to) continue;
        if (cur[`${f}_overridden_at`] != null) continue; // 跳過手動覆寫
        sets.push(`${f} = $${i}`);
        vals.push(to);
        i += 1;
        if (f === 'name' || f === 'address') touchesNameOrAddr = true;
      }
      if (sets.length === 0) continue;
      sets.push(`last_synced_at = NOW()`, `updated_at = NOW()`);
      await client.query(
        `UPDATE admin_venues SET ${sets.join(', ')} WHERE id = $1`,
        vals
      );
      if (touchesNameOrAddr) {
        await client.query(
          `UPDATE venues SET name = $2,
             full_address = COALESCE(NULLIF($3, ''), full_address),
             updated_at = NOW()
             WHERE id = $1`,
          [code, rv.name, rv.address]
        );
      }
      updatedCount += 1;
    }

    for (const code of want.removed) {
      const cur = dbMap.get(code);
      if (!cur || !cur.is_active) continue;
      if (cur.is_active_overridden_at != null) continue; // 後台已手動標 active → 不被 sync 軟刪除
      await client.query(
        `UPDATE admin_venues SET is_active = FALSE, last_synced_at = NOW(), updated_at = NOW()
           WHERE id = $1`,
        [code]
      );
      await client.query(
        `UPDATE venues SET is_active = FALSE, updated_at = NOW() WHERE id = $1`,
        [code]
      );
      removedCount += 1;
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  return { added: addedCount, updated: updatedCount, removed: removedCount };
}

module.exports = {
  syncStaffFromRagic,
  syncVenuesFromRagic,
  diffVenuesFromRagic,
  applyVenueSync,
  VENUE_SYNC_FIELDS,
  kickoffSyncStaffAsync,
  kickoffSyncVenuesAsync,
  ragicEnabled,
  getRagicEnvFlags,
  getSyncStatusSnapshot,
  pingParentsFromRagic,
  pingStudentsFromRagic,
  backupParentsStudentsToRagic,
  pullParentsStudentsFromRagic,
  quarantineBadZ01Names,
  hasRecentBackupSuccess,
  isPlaceholderParentName,
  hasNoCjkCharacters,
  getRagicJobNames,
  // Task #83 single-flight helpers
  isJobRunning,
  getRunningJobs,
  // admin 手動開關（Ragic 連線狀態頁）
  setJobEnabled,
  getJobToggles,
  // Z03 人工整理表
  listZ03Records,
  getZ03UpgradeMissingFields,
  saveZ03RecordDraft,
  resolveZ03Record,
  dismissZ03Record,
  markPlaceholderNameResolved,
  // Task #66 staging
  applyStagedChange,
  rejectStagedChange,
  listStagingChanges,
  countStagingPending,
};
