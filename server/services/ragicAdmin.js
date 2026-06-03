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

/** Upsert 一筆 pending staging（同 entity 已有 pending → 更新該 row 而非新增）。
 *  注意：依 spec，rejected 不抑制 — 下次 Ragic 同步若仍有差異，會重新進待審區。 */
async function _stageIfNotRejected(formCode, entityType, entityId, changeType, payload, diff) {
  await pool.query(
    `INSERT INTO ragic_staging_changes
       (form_code, entity_type, entity_id, change_type, payload_json, diff_json, fetched_at, status)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, NOW(), 'pending')
     ON CONFLICT (entity_type, entity_id) WHERE status = 'pending'
     DO UPDATE SET form_code = EXCLUDED.form_code,
                   change_type = EXCLUDED.change_type,
                   payload_json = EXCLUDED.payload_json,
                   diff_json = EXCLUDED.diff_json,
                   fetched_at = NOW()`,
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
    const dbRows = (await pool.query(
      `SELECT id, name, phone, role, active, active_overridden_at FROM admin_staff`
    )).rows;
    // key 用 normalize 過的值，value 保留 DB 原始 row（含 PK 原始大小寫）
    const dbMap = new Map(dbRows.map(r => [_normalizeStaffId(r.id), r]));
    const seenKeys = new Set();
    let staged = 0;

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
      const venueIds = _extractStaffVenueIds(r);
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
      const coachRowRes = await pool.query(
        `SELECT email, line_uid FROM coaches WHERE ragic_employee_id = $1`, [entityId]
      );
      const curCoachEmail = coachRowRes.rows[0]?.email || '';
      const curCoachLineUid = coachRowRes.rows[0]?.line_uid || '';

      if (!cur) {
        if (await _stageIfNotRejected('H01_STAFF', 'staff', entityId, 'new', payload, null)) staged++;
        continue;
      }
      const diff = {};
      if ((cur.name || '') !== name) diff.name = { from: cur.name || '', to: name };
      if ((cur.phone || '') !== phone) diff.phone = { from: cur.phone || '', to: phone };
      // role 為系統內部欄位（admin 可改 staff/coach/manager）— 不從 Ragic 同步
      // email：Ragic 有值且與目前 coaches.email 不同才視為 diff（呈現給 admin 確認；apply 時只在 DB 空值時覆寫）
      if (email && curCoachEmail !== email) {
        diff.email = { from: curCoachEmail, to: email };
      }
      // line_uid：只在「DB 為空 + Ragic 有值」才 diff，避免覆寫已綁定的教練 LINE
      // （apply 路徑使用 COALESCE 雙重保險；這裡同樣不顯示「Ragic 空 → 蓋掉」的 diff）
      if (lineUid && !curCoachLineUid) {
        diff.line_uid = { from: '', to: lineUid };
      }
      if (cur.active_overridden_at == null && cur.active !== isActive) {
        diff.active = { from: cur.active, to: isActive };
      }
      // Task #90：venue_ids 差異偵測（純場館異動也要 stage）
      const curVenuesRes = await pool.query(
        `SELECT venue_id FROM admin_staff_venues WHERE staff_id = $1 ORDER BY venue_id`,
        [entityId]
      );
      const curVenues = curVenuesRes.rows.map(x => x.venue_id);
      const newVenues = [...venueIds].sort();
      const curVenuesSorted = [...curVenues].sort();
      if (newVenues.length > 0 && (newVenues.length !== curVenuesSorted.length
          || newVenues.some((v, i) => v !== curVenuesSorted[i]))) {
        diff.venue_ids = { from: curVenuesSorted, to: newVenues };
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
    return { synced: staged, staged, skipped: false };
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
        const vr = await client.query(
          `SELECT id FROM venues WHERE id = ANY($1::text[])`, [venueIds]
        );
        const validIds = vr.rows.map(x => x.id);
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
};

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
  getRagicJobNames,
  // Task #83 single-flight helpers
  isJobRunning,
  getRunningJobs,
  // Task #66 staging
  applyStagedChange,
  rejectStagedChange,
  listStagingChanges,
  countStagingPending,
};
