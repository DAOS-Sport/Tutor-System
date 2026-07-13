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
 *   line_token / 銀行帳戶）原則上不被 Ragic 覆蓋；H01 文字明確命中「管理員」時，
 *   只允許單向升級為 admin，不做降級覆蓋。
 * - is_active：H01「離職」→ active=false，並停用對應 admin_users login；
 *   後台手動翻轉 active 後會記錄 `active_overridden_at`，下一輪同步不再覆蓋。
 *
 * 對外另暴露 `kickoffSync*Async()` —— fire-and-forget + 10 分鐘節流，
 * 用於 GET 列表時觸發背景刷新（不阻塞回應）。實際排程由 server/cron 跑。
 */
const { pool } = require('../models/db');
const ragic = require('./ragic');
const parentSync = require('./parentSync');
const line = require('./line');
const { maskPhone } = require('../utils/piiMask');
const { cleanVenueList } = require('./coachVenueScope');
const { normalizePhone, normalizeStudentName, isCanonicalMobilePhone } = require('./identityNormalizer');
const { createParentIdentityBackofficeTask } = require('./parentIdentityBackoffice');
// Ragic 表單 / 欄位對應唯一來源（凍結點）：H01 LINE UID 欄位、場館欄位、角色關鍵字
const {
  H01,
  H23,
  FORMS,
  getTrueRagicLineUid,
  STABILITY_FLAGS,
} = require('../config/ragicSchema');
// DB 租約層（launch-20260707 B 段既有基礎建設，先前未被任何呼叫端接上）：
// 用同一把鎖名 'ragic_sync' 讓所有實際會打 Ragic 的 job（staff/venues/backup/
// pull/parents/students）共用單一租約，確保「同一時間對 Ragic 帳號只有一個
// in-flight 請求」，不論觸發來源是 cron、admin 手動、或不同 job name——
// _singleflight 只擋「同一個 job name 重複觸發」，擋不住 staff 與 backup
// 這種不同 job 同時打 Ragic（見 docs/ragic_sync_audit.md §1 root cause #4）。
const cronLock = require('../cron/lock');

function ragicEnabled() {
  return !!process.env.RAGIC_API_KEY && !!process.env.RAGIC_BASE_URL;
}

const FRESHNESS_ALERT_THRESHOLD_MS = Number(process.env.RAGIC_FRESHNESS_ALERT_THRESHOLD_MS) || 120000;
const FRESH_SHADOW_MAX_AGE_HOURS = Number(process.env.RAGIC_FRESH_SHADOW_MAX_AGE_HOURS) || 24;

function _withFreshness(result = {}, freshness = {}) {
  return {
    ...result,
    freshness_verified: freshness.freshness_verified,
    freshness_latency_ms: freshness.freshness_latency_ms,
    stale_retries: freshness.stale_retries || 0,
    freshness_nonce: freshness.canary_nonce || freshness.freshness_nonce || null,
  };
}

function _freshnessFromResult(result = {}) {
  return {
    freshness_verified: result.freshness_verified,
    freshness_latency_ms: result.freshness_latency_ms,
    stale_retries: result.stale_retries || 0,
    freshness_nonce: result.freshness_nonce || null,
  };
}

async function _alertFreshnessIfNeeded(sheetCode, freshness, staleError = '') {
  if (!freshness) return;
  if (freshness.freshness_verified === false || staleError) {
    await _alertAdmins(
      `【Ragic stale_read】${sheetCode} canary 讀取新鮮度驗證失敗，已中止本輪、不寫入 shadow / 不進 apply / 不跑 ghost。${staleError || ''}`
    );
    return;
  }
  if (freshness.freshness_latency_ms != null && freshness.freshness_latency_ms > FRESHNESS_ALERT_THRESHOLD_MS) {
    await _alertAdmins(
      `【Ragic 同步告警】${sheetCode} canary write→read latency=${freshness.freshness_latency_ms}ms，超過閾值 ${FRESHNESS_ALERT_THRESHOLD_MS}ms`
    );
  }
}

// P1.1 決策4：完整性/schema-drift hard-fail 時通知 admin/manager（比照
// cron/index.js eval-threshold 告警的既有寫法：查 admin_users 找有綁 LINE 的
// admin/manager，補場館以解析 channel token，逐一 push；純 best-effort，
// 告警本身失敗不影響 hard-fail 判斷已生效（run 仍然中止、不寫入）。
async function _alertAdmins(text) {
  try {
    const mgrs = await pool.query(
      `SELECT line_uid, venue_id FROM admin_users
        WHERE role IN ('admin','manager') AND line_uid IS NOT NULL`
    );
    let fallbackVenue = null;
    if (mgrs.rows.some((m) => !m.venue_id)) {
      const v = await pool.query(`SELECT id FROM venues WHERE is_active = TRUE ORDER BY id LIMIT 1`);
      fallbackVenue = v.rows[0]?.id || null;
    }
    const targets = mgrs.rows
      .map((m) => ({ uid: m.line_uid, venueId: m.venue_id || fallbackVenue }))
      .filter((t) => t.uid && t.venueId);
    for (const t of targets) {
      try {
        await line.pushMessage(t.uid, [{ type: 'text', text }], t.venueId);
      } catch (e) {
        console.warn('[ragic-alert] push failed:', e.message);
      }
    }
  } catch (err) {
    console.warn('[ragic-alert] 查詢告警對象失敗:', err.message);
  }
}

// P1.1 決策4：完整性/schema-drift 共用閘門。回傳 null 代表可放行；
// 回傳字串代表應 hard-fail（caller 據此中止 run、不寫入任何本地變更），
// 字串內容即為要記錄進 ragic_sync_log.error_message 的原因。
// 兩種失敗都會觸發 LINE 告警——避免嫌疑3 那種欄位改名 CONFIRMED bug 在
// 告警的同時繼續跑、又造成一批誤刪/解綁。
async function _checkZ01IntegrityGate(integrityResult) {
  if (integrityResult.truncated) {
    const msg = `Ragic Z01 全量拉取疑似遭截斷（撞到 RAGIC_MAX_PAGES 上限，非自然結尾），已中止本輪、不寫入任何本地變更`;
    await _alertAdmins(`【Ragic 同步告警】${msg}`);
    return msg;
  }
  if (integrityResult.boundaryMismatch) {
    const msg = `Ragic Z01 全量拉取邊界複查不一致（疑似拉取期間有並發修改導致分頁位移），已中止本輪、不寫入任何本地變更`;
    await _alertAdmins(`【Ragic 同步告警】${msg}`);
    return msg;
  }
  let drift;
  try {
    drift = await ragic.checkZ01SchemaDrift();
  } catch (err) {
    const msg = `Ragic Z01 schema-drift 偵測本身失敗：${err.message}`;
    await _alertAdmins(`【Ragic 同步告警】${msg}`);
    return msg;
  }
  if (drift.drifted) {
    const detail = drift.mismatches
      .map((m) => `${m.group}:${m.fieldId} 預期「${m.expectedName}」實際「${m.liveName ?? '(欄位消失)'}」`)
      .join('；');
    const msg = `Ragic Z01 欄位顯示名稱已變更（schema-drift）：${detail}，已中止本輪、不寫入任何本地變更，請更新 server/config/ragicSchema.js 後再重試`;
    await _alertAdmins(`【Ragic 同步告警】${msg}`);
    return msg;
  }
  return null;
}

async function _checkPagedIntegrityGate(sheetCode, integrityResult) {
  const code = String(sheetCode || 'Ragic').toUpperCase();
  if (integrityResult?.truncated) {
    const msg = `Ragic ${code} 全量拉取疑似遭截斷（撞到 RAGIC_MAX_PAGES 上限，非自然結尾），已中止本輪、不寫入 shadow / 不進 apply`;
    await _alertAdmins(`【Ragic 同步告警】${msg}`);
    return msg;
  }
  if (integrityResult?.boundaryMismatch) {
    const msg = `Ragic ${code} 全量拉取邊界複查不一致（疑似拉取期間有並發修改導致分頁位移），已中止本輪、不寫入 shadow / 不進 apply`;
    await _alertAdmins(`【Ragic 同步告警】${msg}`);
    return msg;
  }
  return null;
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

function _syncErrorMessage(err, context = {}) {
  const parts = [];
  if (context.ragicId) parts.push(`ragicId=${context.ragicId}`);
  if (context.localId) parts.push(`localId=${context.localId}`);

  if (err?.code === '23505') {
    parts.push(`資料唯一鍵衝突${err.constraint ? ` (${err.constraint})` : ''}`);
  } else if (err?.code) {
    parts.push(`${err.code}: ${err.message || '同步失敗'}`);
  } else {
    parts.push(err?.message || String(err || '同步失敗'));
  }
  return parts.filter(Boolean).join(' — ');
}

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

async function _resolveVenueIdList(rawValues) {
  const values = cleanVenueList(rawValues);
  if (!values.length) return [];
  const resolve = await _buildVenueResolver();
  return cleanVenueList(resolve(values));
}

async function _syncCoachVenueIds(client, coachId, rawVenueIds) {
  if (!coachId) return [];
  const venueIds = await _resolveVenueIdList(rawVenueIds);
  if (!venueIds.length) return [];
  const r = await client.query(
    `SELECT id FROM venues WHERE id = ANY($1::text[]) AND is_active = TRUE`,
    [venueIds]
  );
  const validIds = cleanVenueList(r.rows.map((row) => row.id));
  if (!validIds.length) return [];
  await client.query(`DELETE FROM coach_venues WHERE coach_id = $1`, [coachId]);
  for (const vid of validIds) {
    await client.query(
      `INSERT INTO coach_venues (coach_id, venue_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [coachId, vid]
    );
  }
  return validIds;
}

async function _syncStaffVenueIds(client, staffId, rawVenueIds) {
  const venueIds = await _resolveVenueIdList(rawVenueIds);
  if (!venueIds.length) return [];
  const r = await client.query(
    `SELECT id FROM admin_venues WHERE id = ANY($1::text[])`,
    [venueIds]
  );
  const validIds = cleanVenueList(r.rows.map((row) => row.id));
  if (!validIds.length) return [];
  await client.query(`DELETE FROM admin_staff_venues WHERE staff_id = $1`, [staffId]);
  for (const vid of validIds) {
    await client.query(
      `INSERT INTO admin_staff_venues (staff_id, venue_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [staffId, vid]
    );
  }
  await client.query(
    `UPDATE admin_staff SET venue_id = $2 WHERE id = $1`,
    [staffId, validIds[0]]
  );
  return validIds;
}

// P1.1 決策3（2026-07-07）：原 Task #95「場館自動套用」_applyStaffVenuesDirect
// 已移除——場館指派改回待審核，見 _syncStaffImpl 的 diff.venue_ids 與
// _applyStaffChange 內既有的 admin_staff_venues/coach_venues 套用邏輯（Task #90）。

// Task #92：normalize 員工編號比對 key。
// admin 手建員工可能輸入 'c001' / ' C001 '，Ragic 回 'C001'，
// 用原值比對會比不到 → 整筆被當 'new' 重新 stage，員工就會出現「已建檔卻又進待審核」。
// 一律 trim + toUpperCase 做比對 key；DB 上的 PK 仍以實際儲存值為準。
function _normalizeStaffId(v) {
  return String(v == null ? '' : v).trim().toUpperCase();
}

function _ragicLastUpdateValue(r) {
  return String(
    r?.['109'] ||
    r?.['Last Update Date'] ||
    r?.['最後修改日期'] ||
    r?.['最後異動日期'] ||
    ''
  ).trim();
}

function _h01DataNo(r) {
  return String(r?.[H01.DATA_NO] || r?.['資料編號'] || '').trim();
}

function _h01NodeId(r) {
  return String(r?.[H01.NODE_ID] || r?._ragicId || r?.ragicId || '').trim();
}

function _h01Name(r) {
  return String(r?.[H01.NAME] || r?.['姓名'] || '').trim();
}

function _h01EmployeeId(r) {
  return _normalizeStaffId(r?.['員工編號'] || r?.['工號'] || r?.['3000935'] || '');
}

function _h01Phone(r) {
  return String(r?.['手機'] || r?.['手機（公司）'] || r?.['3001424'] || r?.['手機（個人）'] || r?.['3000941'] || '').trim();
}

function _staffNameKey(name) {
  return String(name || '').trim();
}

function _staffNaturalKey(name, lineUid) {
  return `${_staffNameKey(name)}\u0001${String(lineUid || '').trim()}`;
}

function _splitFieldIds(value) {
  return String(value || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function _h01IgnoredRawFieldIds() {
  return new Set([
    ..._splitFieldIds(process.env.RAGIC_FIELD_H01_400LINE_MESSAGE),
    ..._splitFieldIds(process.env.RAGIC_H01_BLOCKED_FIELD_IDS),
  ]);
}

function _isIgnoredH01RawField(key, value) {
  const fieldKey = String(key || '');
  if (_h01IgnoredRawFieldIds().has(fieldKey)) return true;
  const normalizedKey = fieldKey.replace(/\s+/g, '').toLowerCase();
  if (/400(line|v).*訊息/i.test(fieldKey)) return true;
  if (/400(line|v).*message/i.test(normalizedKey)) return true;
  if (/chat\.line\.biz/i.test(String(value || '')) && /400|line/i.test(fieldKey)) return true;
  return false;
}

function _sanitizeH01RawRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (_isIgnoredH01RawField(key, value)) continue;
    out[key] = value;
  }
  return out;
}

function _ragicRecordId(row) {
  return row && row._ragicId != null
    ? String(row._ragicId)
    : (row && row.ragicId != null ? String(row.ragicId) : '');
}

function _buildDuplicateSet(values) {
  const seen = new Set();
  const dup = new Set();
  for (const value of values.filter(Boolean)) {
    if (seen.has(value)) dup.add(value);
    else seen.add(value);
  }
  return dup;
}

function _h01ShadowKey(row, idx) {
  const rid = _h01NodeId(row);
  if (rid) return `node:${rid}`;
  const dataNo = _h01DataNo(row);
  if (dataNo) return `legacy-data:${dataNo}:row:${idx}`;
  return `row:${idx}`;
}

function _h23ShadowKey(row, idx, duplicateKeys = new Set()) {
  const ragicKey = _h23Value(row, H23.KEY_FIELD, '資料編號');
  if (ragicKey && !duplicateKeys.has(ragicKey)) return `key:${ragicKey}`;
  const rid = _ragicRecordId(row);
  if (rid) return `ragic:${rid}`;
  if (ragicKey) return `key:${ragicKey}:row:${idx}`;
  return `row:${idx}`;
}

function _staffHaltEntityId(r, fallback = '') {
  const rid = r?._ragicId != null ? String(r._ragicId) : '';
  const staffId = _normalizeStaffId(r?.['員工編號'] || r?.['工號'] || r?.['3000935'] || '');
  return `h01-halt:${rid || staffId || fallback || 'unknown'}`;
}

function _redactStaffGovernancePayload(payload = {}) {
  if (!payload || typeof payload !== 'object') return payload;
  const out = { ...payload };
  delete out.ragic_data_no;
  return out;
}

function _redactStaffGovernanceDiff(diff = {}) {
  if (!diff || typeof diff !== 'object') return diff;
  const out = { ...diff };
  delete out.ragic_data_no;
  delete out.ragic_data_no_duplicate;
  delete out.ragic_data_no_changed;
  delete out.ragic_data_no_missing;
  return out;
}

function _publicStagingRow(row) {
  if (!row || row.entity_type !== 'staff') return row;
  return {
    ...row,
    payload_json: _redactStaffGovernancePayload(row.payload_json),
    diff_json: _redactStaffGovernanceDiff(row.diff_json),
  };
}

function _staffPayloadFromRagicRow(r, resolveVenues) {
  const nodeId = _h01NodeId(r);
  const id = _h01EmployeeId(r) || (nodeId ? `H01-${nodeId}` : '');
  const name = _h01Name(r);
  const phone = _h01Phone(r);
  const email = r?.['E-mail'] || r?.['Email'] || r?.['email'] || r?.['信箱'] || r?.['3000940'] || '';
  const role = r?.['應徵職務'];
  const roleStr = Array.isArray(role) ? role.join(',') : (role || '');
  const roleText = `${roleStr},${r?.['職稱'] || ''}`;
  const isAdmin = H01.ROLE_MATCH.ADMIN.test(roleText);
  const isCoach = roleText.includes(H01.ROLE_MATCH.COACH);
  const isCounter = H01.ROLE_MATCH.COUNTER.test(roleText);
  const isLifeguard = H01.ROLE_MATCH.LIFEGUARD.test(roleText);
  const roleVal = isAdmin ? 'admin' : (isCounter ? 'staff' : (isCoach ? 'coach' : 'staff'));
  return {
    id,
    name,
    phone,
    email,
    role: roleVal,
    is_active: (r?.['在職狀態'] || r?.['3000945']) === '在職',
    venue_ids: resolveVenues(_extractStaffVenueIds(r)),
    line_uid: extractLineUid(r),
    ragic_data_no: _h01DataNo(r),
    ragic_record_id: nodeId || null,
    ragic_last_update_at: _ragicLastUpdateValue(r),
    is_coach: isCoach,
    is_counter: isCounter,
    is_lifeguard: isLifeguard,
  };
}

function _sameScalar(a, b) {
  return String(a == null ? '' : a).trim() === String(b == null ? '' : b).trim();
}

function _sameArray(a, b) {
  const aa = cleanVenueList(a).sort();
  const bb = cleanVenueList(b).sort();
  return aa.length === bb.length && aa.every((v, i) => v === bb[i]);
}

function _payloadMismatch(snapshot, live, fields) {
  for (const f of fields) {
    const ok = Array.isArray(snapshot?.[f]) || Array.isArray(live?.[f])
      ? _sameArray(snapshot?.[f], live?.[f])
      : _sameScalar(snapshot?.[f], live?.[f]);
    if (!ok) return { field: f, snapshot: snapshot?.[f], live: live?.[f] };
  }
  return null;
}

async function _assertStagedRagicStillFresh(row) {
  const p = row.payload_json || {};
  if (row.entity_type === 'staff') {
    if (row.change_type === 'deactivate') return;
    if (p.halt_reason) {
      const err = new Error(`H01 staff staging 已被資料治理 tripwire 中止：${p.halt_message || p.halt_reason}`);
      err.code = 'RAGIC_STAFF_HALTED';
      throw err;
    }
    if (!p.ragic_record_id) {
      const err = new Error('staging payload 缺少 H01 ragic_record_id，無法執行單筆二次讀；請先重新同步產生新版待審資料');
      err.code = 'RAGIC_SECOND_READ_REQUIRED';
      throw err;
    }
    const live = await ragic.getRecordByRagicId(
      process.env.RAGIC_FORM_H01,
      p.ragic_record_id,
      { ignoreFixedFilter: process.env.RAGIC_IGNORE_FIXED_FILTER === 'false' ? undefined : 'true' },
      { noCache: true }
    );
    if (!live || ragic.isCanaryRecord(live, 'H01')) {
      const err = new Error(`Ragic H01 record ${p.ragic_record_id} 已不存在或不可讀，請重新同步後再套用`);
      err.code = 'RAGIC_SECOND_READ_MISSING';
      throw err;
    }
    const resolveVenues = await _buildVenueResolver();
    const current = _staffPayloadFromRagicRow(live, resolveVenues);
    const mismatch = _payloadMismatch(p, current, [
      'id', 'name', 'phone', 'email', 'is_active', 'venue_ids',
      'line_uid', 'ragic_data_no', 'ragic_record_id', 'is_coach', 'is_counter', 'is_lifeguard',
    ]);
    if (mismatch) {
      const err = new Error(
        `Ragic H01 單筆二次讀與 staging snapshot 不一致（${mismatch.field}），已中止此筆套用，請重新同步`
      );
      err.code = 'RAGIC_SECOND_READ_MISMATCH';
      err.detail = mismatch;
      throw err;
    }
  } else if (row.entity_type === 'venue') {
    if (row.change_type === 'deactivate') return;
    if (!p.ragic_record_id) {
      const err = new Error('staging payload 缺少 H05 ragic_record_id，無法執行單筆二次讀；請先重新同步產生新版待審資料');
      err.code = 'RAGIC_SECOND_READ_REQUIRED';
      throw err;
    }
    const live = await ragic.getRecordByRagicId(
      process.env.RAGIC_FORM_H05,
      p.ragic_record_id,
      { ignoreFixedFilter: process.env.RAGIC_IGNORE_FIXED_FILTER === 'false' ? undefined : 'true' },
      { noCache: true }
    );
    if (!live || ragic.isCanaryRecord(live, 'H05')) {
      const err = new Error(`Ragic H05 record ${p.ragic_record_id} 已不存在或不可讀，請重新同步後再套用`);
      err.code = 'RAGIC_SECOND_READ_MISSING';
      throw err;
    }
    const mapped = _mapRagicVenue(live);
    const current = { ...mapped, is_active: true };
    const mismatch = _payloadMismatch(p, current, ['code', 'name', 'address', 'ragic_record_id']);
    if (mismatch) {
      const err = new Error(
        `Ragic H05 單筆二次讀與 staging snapshot 不一致（${mismatch.field}），已中止此筆套用，請重新同步`
      );
      err.code = 'RAGIC_SECOND_READ_MISMATCH';
      err.detail = mismatch;
      throw err;
    }
  }
}

// P1.1 決策9：無腦 shadow 寫入——唯一打 Ragic H01 全量查詢的地方，不跑任何比對/
// 清洗邏輯。key 只使用 Ragic node id（3000942；目前 listing 常 fallback _ragicId）。
// 3000934「資料編號」已確認會重複，僅保存為 raw/debug，不參與 shadow 主鍵或 skip。
// Phase 5：incremental=true 時只拉 watermark 之後有變更的列（見 ragic.js
// getAllStaffChangedSinceWithFreshness），且：
//   (a) 不跑「shadowCount===rawTotal」全集校驗——增量本來就只是子集，這條校驗
//       只對「宣稱拿到全部」的全量快照有意義。
//   (b) 不做 DELETE-not-present 清理——增量沒有全集可比對「已刪除」，刪除偵測
//       留給每日仍會跑的全量 reconcile（cron）負責。
async function _shadowPullH01Impl({ incremental = false, watermark = null } = {}) {
  if (!ragicEnabled()) return { synced: 0, skipped: true };
  const useIncremental = !!(incremental && watermark);
  let records;
  let freshness = null;
  try {
    const pull = useIncremental
      ? await ragic.getAllStaffChangedSinceWithFreshness(watermark)
      : await ragic.getAllStaffWithIntegrityAndFreshness();
    freshness = pull.freshness || null;
    if (pull.stale_read) {
      await _alertFreshnessIfNeeded('H01', freshness, pull.error);
      return _withFreshness({ synced: 0, stale_read: true, error: pull.error }, freshness);
    }
    if (!useIncremental) {
      const gateError = await _checkPagedIntegrityGate('H01', pull);
      if (gateError) return _withFreshness({ synced: 0, error: gateError }, freshness);
    }
    records = (pull.raw_records || pull.records || []).filter((row) => !ragic.isCanaryRecord(row, 'H01'));
    await _alertFreshnessIfNeeded('H01', freshness);
  } catch (err) {
    return { synced: 0, error: `Ragic H01 ${useIncremental ? '增量' : '全量'}查詢失敗：${err.message}` };
  }
  const client = await pool.connect();
  let synced = 0;
  const rawTotal = records.length;
  try {
    await client.query('BEGIN');
    const presentKeys = [];
    for (const [idx, row] of records.entries()) {
      const shadowKey = _h01ShadowKey(row, idx);
      const ragicRecordId = _h01NodeId(row) || null;
      const ragicDataNo = _h01DataNo(row) || null;
      presentKeys.push(shadowKey);
      await client.query(
        `INSERT INTO ragic_h01_shadow (ragic_record_id, ragic_data_no, raw_data, fetched_at)
         VALUES ($1, $2, $3::jsonb, NOW())
         ON CONFLICT (ragic_record_id) DO UPDATE SET
           ragic_data_no = EXCLUDED.ragic_data_no,
           raw_data = EXCLUDED.raw_data,
           fetched_at = NOW()`,
        [shadowKey, ragicDataNo, JSON.stringify(row)]
      );
      synced++;
    }
    if (!useIncremental) {
      await client.query(
        `DELETE FROM ragic_h01_shadow WHERE NOT (ragic_record_id = ANY($1::text[]))`,
        [presentKeys]
      );
      const countRes = await client.query(`SELECT COUNT(*)::int AS n FROM ragic_h01_shadow`);
      const shadowCount = countRes.rows[0]?.n || 0;
      if (shadowCount !== rawTotal) {
        throw new Error(`H01 shadow count mismatch: ragic_raw_total=${rawTotal}, shadow_count=${shadowCount}`);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // ROLLBACK 已撤銷整個交易——回報實際持久化筆數 0，不要沿用 rollback 前迴圈累加的
    // in-memory synced 計數，否則會誤報「已同步 N 筆」但其實一筆都沒真的落地 shadow。
    return _withFreshness({ synced: 0, raw_total: rawTotal, error: `Shadow 寫入失敗：${err.message}` }, freshness);
  } finally {
    client.release();
  }
  return _withFreshness({ synced, raw_total: rawTotal, shadow_count: synced, incremental: useIncremental }, freshness);
}

async function _readShadowH01(client) {
  const r = await client.query(`SELECT raw_data FROM ragic_h01_shadow ORDER BY ragic_data_no NULLS LAST, ragic_record_id`);
  return r.rows.map((row) => row.raw_data).filter((row) => !ragic.isCanaryRecord(row, 'H01'));
}

function _h23Value(row, fieldId, ...names) {
  for (const key of [fieldId, ...names]) {
    const value = row?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return '';
}

function _h23StaffEmpId(row) {
  return _normalizeStaffId(_h23Value(row, H23.STAFF_EMP_ID, '員工編號', '工號'));
}

function _h23StaffName(row) {
  return _h23Value(row, H23.STAFF_NAME, '姓名');
}

function _h23CourseCoefficient(row) {
  return parseFloat(_h23Value(
    row,
    H23.COURSE_COEFFICIENT,
    '家教班倍率(目前)',
    '家教班倍率',
    '家家班倍率(目前)',
    '家家班倍率',
    '修課係數(目前)',
    '修課係數',
  )) || 1.00;
}

async function _shadowPullH23Impl() {
  if (!ragicEnabled()) return { synced: 0, skipped: true };
  if (!FORMS.H23) return { synced: 0, skipped: true, error: 'RAGIC_FORM_H23 未設定' };

  let records;
  try {
    records = await ragic.getAllStaffCoefficientRowsRaw();
  } catch (err) {
    return { synced: 0, error: `Ragic H23 全量查詢失敗：${err.message}` };
  }

  const client = await pool.connect();
  let synced = 0;
  const rawRows = (records || []).filter((row) => !ragic.isCanaryRecord(row, 'H23'));
  const rawTotal = rawRows.length;
  try {
    await client.query('BEGIN');
    const duplicateKeys = _buildDuplicateSet(rawRows.map((row) => _h23Value(row, H23.KEY_FIELD, '資料編號')));
    const presentKeys = [];
    for (const [idx, row] of rawRows.entries()) {
      const shadowKey = _h23ShadowKey(row, idx, duplicateKeys);
      const ragicKey = _h23Value(row, H23.KEY_FIELD, '資料編號');
      const empId = _h23StaffEmpId(row);
      const name = _h23StaffName(row);
      presentKeys.push(shadowKey);
      await client.query(
        `INSERT INTO ragic_h23_shadow
           (ragic_record_id, ragic_key, staff_emp_id, staff_name, raw_data, fetched_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
         ON CONFLICT (ragic_record_id) DO UPDATE SET
           ragic_key = EXCLUDED.ragic_key,
           staff_emp_id = EXCLUDED.staff_emp_id,
           staff_name = EXCLUDED.staff_name,
           raw_data = EXCLUDED.raw_data,
           fetched_at = NOW()`,
        [shadowKey, ragicKey || null, empId || null, name || null, JSON.stringify(row)]
      );
      synced++;
    }
    await client.query(
      `DELETE FROM ragic_h23_shadow WHERE NOT (ragic_record_id = ANY($1::text[]))`,
      [presentKeys]
    );
    const countRes = await client.query(`SELECT COUNT(*)::int AS n FROM ragic_h23_shadow`);
    const shadowCount = countRes.rows[0]?.n || 0;
    if (shadowCount !== rawTotal) {
      throw new Error(`H23 shadow count mismatch: ragic_raw_total=${rawTotal}, shadow_count=${shadowCount}`);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // ROLLBACK 已撤銷整個交易——回報實際持久化筆數 0，理由同 H01 shadow-pull 的同款修復。
    return { synced: 0, raw_total: rawTotal, error: `H23 shadow 寫入失敗：${err.message}` };
  } finally {
    client.release();
  }
  return { synced, raw_total: rawTotal, shadow_count: synced };
}

// 去空白（含全形空白）比對用：H23/H01 姓名偶有半形/全形空白差異導致精確比對失手，
// normalized_name 讓人工一眼看出「其實是同一個人，只是格式不同」。
function _normalizeStaffNameForDiag(name) {
  return String(name || '').replace(/[\s　]+/g, '');
}

async function _reconcileH23FromShadowImpl() {
  const client = await pool.connect();
  let scanned = 0;
  let updated = 0;
  let unmatched = 0;
  let failed = 0;
  const warnings = [];
  const errors = [];
  const matchedStaffIds = new Set();
  let h01MissingWarnings = [];
  try {
    const rows = (await client.query(
      `SELECT ragic_record_id, staff_emp_id, staff_name, raw_data
         FROM ragic_h23_shadow
        ORDER BY staff_emp_id NULLS LAST, staff_name NULLS LAST`
    )).rows;

    // 每筆獨立 BEGIN/COMMIT（比照 H01/H05/Z01 reconcile 既有的「嫌疑4 CONFIRMED 修復」
    // 寫法）：舊版把整個迴圈包在單一 BEGIN/COMMIT，任何一筆中途拋錯就 ROLLBACK 整輪，
    // 但函式仍回傳 rollback 前累加的 `updated` 計數——等於回報「已同步 N 筆」卻其實
    // 一筆都沒真的落地（比嫌疑4 原版塌成 synced:0 更誤導）。改成逐筆各自提交，
    // 回傳的 updated/synced 才會等於實際寫進 DB 的筆數；單筆失敗只累計 failed，
    // 不影響其餘筆數已提交的結果。
    for (const row of rows) {
      scanned++;
      try {
        const raw = row.raw_data || {};
        const empId = _normalizeStaffId(row.staff_emp_id || _h23StaffEmpId(raw));
        const name = String(row.staff_name || _h23StaffName(raw) || '').trim();
        const courseCoefficient = _h23CourseCoefficient(raw);
        const warningRecordId = _ragicRecordId(raw) || row.ragic_record_id;
        if (!name) {
          unmatched++;
          warnings.push({
            ragic_record_id: warningRecordId, shadow_key: row.ragic_record_id,
            employee_no: empId, name, normalized_name: _normalizeStaffNameForDiag(name),
            source_form: 'H23', reason: 'missing_composite_key',
          });
          continue;
        }

        await client.query('BEGIN');
        const matched = await client.query(
          `SELECT id, active, line_uid
	             FROM admin_staff
	            WHERE TRIM(name) = $1
	            FOR UPDATE`,
          [name]
        );
        let staffId = null;
        if (matched.rowCount === 1) {
          staffId = matched.rows[0].id;
        } else if (matched.rowCount > 1) {
          const activeLineRows = matched.rows.filter((r) => r.active === true && String(r.line_uid || '').trim());
          if (activeLineRows.length === 1) staffId = activeLineRows[0].id;
        }
        if (!staffId) {
          await client.query('ROLLBACK');
          unmatched++;
          warnings.push({
            ragic_record_id: warningRecordId,
            shadow_key: row.ragic_record_id,
            employee_no: empId,
            name,
            normalized_name: _normalizeStaffNameForDiag(name),
            source_form: 'H23',
            reason: matched.rowCount === 0
              ? 'no_name_staff_match'
              : (matched.rowCount > 1 ? 'duplicate_name_no_unique_line_uid' : 'no_exact_staff_match'),
          });
          continue;
        }

        matchedStaffIds.add(staffId);
        await client.query(
          `UPDATE admin_staff
              SET multiplier = $2,
                  is_senior = ($2::numeric <> 1.00),
                  updated_at = NOW(),
                  last_synced_at = NOW()
            WHERE id = $1`,
          [staffId, courseCoefficient]
        );
        await client.query(
          `UPDATE coaches
              SET pricing_multiplier = $2,
                  is_senior = ($2::numeric <> 1.00),
                  updated_at = NOW()
            WHERE ragic_employee_id = $1`,
          [staffId, courseCoefficient]
        );
        await client.query('COMMIT');
        updated++;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        failed++;
        errors.push(`H23 ${row.ragic_record_id}：${err.message}`);
        console.warn('[Ragic sync] H23 coefficient per-record reconcile failed (ragic_record_id=%s): %s', row.ragic_record_id, err.message);
      }
    }

    // docs/ragic_sync_audit.md §4：H23 unmatched_staff_warning 目前只涵蓋「H23 有這筆，
    // 但 admin_staff 找不到精確對應」的單向情況；反向（H01 教練確實存在，但從沒有任何
    // H23 列精確配對到過，multiplier 永遠停在舊值也不會有人被提醒）同樣要開警告，
    // 只是不能拋錯中止（H23 表本來就未必涵蓋每一位教練——只警告，不阻斷）。
    // 範圍限縮在「教練身分」的在職員工：非教練員工本來就不預期有 H23 列，全開警告只會洗版。
    const uncoveredCoaches = (await client.query(
      `SELECT id, name, phone FROM admin_staff
        WHERE active = TRUE AND is_coach = TRUE
          AND NOT (id = ANY($1::text[]))
        ORDER BY id`,
      [[...matchedStaffIds]]
    )).rows;
    h01MissingWarnings = uncoveredCoaches.map((r) => ({
      employee_no: r.id,
      name: r.name,
      normalized_name: _normalizeStaffNameForDiag(r.name),
      phone: maskPhone(r.phone),
      source_form: 'H01',
      reason: 'no_h23_coefficient_row',
    }));

    // H23（薪資倍率表）本身沒有手機欄位；最多只給 admin 看 10 筆樣本，用員工編號
    // best-effort 查一次 admin_staff.phone 補上（僅供人工核對是哪一位，不因這步
    // 失敗而讓整個 reconcile 掛掉——查不到就留空）。
    const sampleSlice = warnings.slice(0, 10);
    for (const w of sampleSlice) {
      if (!w.employee_no) { w.phone = null; continue; }
      try {
        const r = await client.query(
          `SELECT phone FROM admin_staff WHERE UPPER(TRIM(id)) = $1 LIMIT 1`,
          [w.employee_no]
        );
        w.phone = maskPhone(r.rows[0]?.phone || '') || null;
      } catch (_) {
        w.phone = null;
      }
    }
  } catch (err) {
    return { synced: updated, scanned, updated, unmatched_staff_warning: unmatched, error: `H23 reconcile 失敗：${err.message}` };
  } finally {
    client.release();
  }
  const result = {
    synced: updated,
    scanned,
    updated,
    unmatched_staff_warning: unmatched,
    unmatched_staff_warning_samples: warnings.slice(0, 10),
    h01_missing_h23_warning: h01MissingWarnings.length,
    h01_missing_h23_warning_samples: h01MissingWarnings.slice(0, 10),
  };
  if (failed > 0) {
    result.partial = true;
    result.failed = failed;
    result.error = `${failed} 筆 H23 係數同步失敗（詳見伺服器 log，其餘 ${updated} 筆已正常套用）：${errors[0]}`;
  }
  return result;
}

async function _syncStaffCoefficientImpl() {
  const shadowResult = await _shadowPullH23Impl();
  if (shadowResult.skipped) return shadowResult;
  if (shadowResult.error) return { synced: 0, error: `[h23-shadow-pull] ${shadowResult.error}` };
  const reconciled = await _reconcileH23FromShadowImpl();
  return {
    ...reconciled,
    synced: shadowResult.synced,
    shadow_synced: shadowResult.synced,
    raw_total: shadowResult.raw_total,
    shadow_count: shadowResult.shadow_count,
  };
}

// 既有 diff/staging 邏輯，資料來源改讀 ragic_h01_shadow（由 _shadowPullH01Impl
// 維護），不再直接呼叫 Ragic API。
async function _reconcileH01FromShadowImpl() {
  let applyClient = null;
  try {
    const client0 = await pool.connect();
    let records;
    try {
      records = await _readShadowH01(client0);
    } finally {
      client0.release();
    }
    // Task #95 fix：H01「部門」存的是場館「名稱」（或公司/處室名），DB 存「代碼」。
    // 先前 diff 直接拿名稱比代碼 → 永遠不相等 → 全員每輪都 stage venue_ids 假差異，
    // 且 approve 套用（apply 時才 resolve 成代碼）後下一輪又再生成，待審區清不完。
    // 改為「比對前」就 resolve 成代碼（與 apply 同一套 resolver）；
    // 解析不到的值（公司名、內勤處室）一律忽略，不視為場館差異。
    const resolveVenues = await _buildVenueResolver();
	    const dbRows = (await pool.query(
	      `SELECT id, name, phone, role, active, active_overridden_at,
	              is_coach, is_counter, is_lifeguard, lifeguard_active, lifeguard_active_overridden_at,
	              ragic_record_id, ragic_data_no, line_uid
	         FROM admin_staff`
	    )).rows;
	    // Legacy lookup maps are fallback only. H01 business reconciliation is now name + LINE UID.
	    const dbMap = new Map(dbRows.map(r => [_normalizeStaffId(r.id), r]));
	    const dbByRagicId = new Map(
	      dbRows.filter(r => r.ragic_record_id).map(r => [String(r.ragic_record_id), r])
	    );
	    const dbByLineUid = new Map(
	      dbRows.filter(r => r.line_uid).map(r => [String(r.line_uid).trim(), r])
	    );
	    const dbByNameLine = new Map();
	    const dbByName = new Map();
	    for (const row of dbRows) {
	      const nameKey = _staffNameKey(row.name);
	      if (!nameKey) continue;
	      if (row.line_uid) dbByNameLine.set(_staffNaturalKey(row.name, row.line_uid), row);
	      const list = dbByName.get(nameKey) || [];
	      list.push(row);
	      dbByName.set(nameKey, list);
	    }
	    const findCurrentStaff = (name, lineUid, ragicRecordId, staffId) => {
	      const nameKey = _staffNameKey(name);
	      const cleanLineUid = String(lineUid || '').trim();
	      if (nameKey && cleanLineUid) {
	        const byNameLine = dbByNameLine.get(_staffNaturalKey(nameKey, cleanLineUid));
	        if (byNameLine) return { row: byNameLine, matchedBy: 'name_line' };
	      }
	      if (nameKey) {
	        const sameName = dbByName.get(nameKey) || [];
	        if (sameName.length === 1) return { row: sameName[0], matchedBy: 'name_unique' };
	        if (sameName.length > 1 && cleanLineUid) {
	          const byLineWithinName = sameName.filter((r) => String(r.line_uid || '').trim() === cleanLineUid);
	          if (byLineWithinName.length === 1) return { row: byLineWithinName[0], matchedBy: 'name_line_disambiguated' };
	        }
	        if (sameName.length > 1) return { row: null, matchedBy: 'ambiguous_name' };
	      }
	      if (cleanLineUid && dbByLineUid.has(cleanLineUid)) return { row: dbByLineUid.get(cleanLineUid), matchedBy: 'line_uid_fallback' };
	      if (ragicRecordId && dbByRagicId.has(ragicRecordId)) return { row: dbByRagicId.get(ragicRecordId), matchedBy: 'ragic_record_fallback' };
	      if (staffId && dbMap.has(staffId)) return { row: dbMap.get(staffId), matchedBy: 'staff_id_fallback' };
	      return { row: null, matchedBy: 'new' };
	    };
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
    let applied = 0;
    let failed = 0;
    let h01Unmatched = 0;
    const staffErrors = [];
    const h01Warnings = [];
	    applyClient = await pool.connect();
	    for (const [idx, r] of records.entries()) {
	     try {
	      const ragicRecordId = _h01NodeId(r) || null;
	      let id = _h01EmployeeId(r) || (ragicRecordId ? `H01-${ragicRecordId}` : '');
	      const ragicDataNo = _h01DataNo(r);
	      const name = _h01Name(r);
	      const lineUid = extractLineUid(r);
	      const match = findCurrentStaff(name, lineUid, ragicRecordId, id);
	      let cur = match.row;
	      if (!id && cur?.id) id = _normalizeStaffId(cur.id);
	      const warnH01 = (reason) => {
	        h01Unmatched++;
	        h01Warnings.push({
	          ragic_record_id: ragicRecordId,
	          ragic_data_no: ragicDataNo,
	          emp_id: id,
	          name,
	          reason,
	        });
	      };
	      if (name) seenKeys.add(_staffNameKey(name));
	      if (cur?.name) seenKeys.add(_staffNameKey(cur.name));
	      if (!name) {
	        warnH01('missing_staff_name');
	        continue;
	      }
	      if (match.matchedBy === 'ambiguous_name') {
	        warnH01('ambiguous_name_without_line_uid');
	        continue;
	      }
	      if (!id) {
	        warnH01('missing_staff_emp_id');
	        continue;
	      }
	      const phone = _h01Phone(r);
      // Task #91 後續：Ragic H01 公司 E-mail（field 3000940）也納入 staff sync，
      // 套用時若該員工有對應的 coaches 列，會把 email 寫入 coaches.email
      // （保留後台手動編輯：只在現值為空時覆寫）。
      const email = r['E-mail'] || r['Email'] || r['email'] || r['信箱'] || r['3000940'] || '';
      const role = r['應徵職務'];
      const roleStr = Array.isArray(role) ? role.join(',') : (role || '');
      const roleText = `${roleStr},${r['職稱'] || ''}`;
      const isAdmin = H01.ROLE_MATCH.ADMIN.test(roleText);
      const isCoach = roleText.includes(H01.ROLE_MATCH.COACH);
      const isCounter = H01.ROLE_MATCH.COUNTER.test(roleText);
      const isLifeguard = H01.ROLE_MATCH.LIFEGUARD.test(roleText);
      // A0 修法：isCoach/isCounter/isLifeguard 都各自獨立算出來，不能讓 roleVal 這個
      // DB enum 欄位的三元運算式吃掉任一個信號——roleVal 僅作為 admin_staff.role 這個
      // CHECK constraint 欄位的保底值（fallback），三個真正的身份判斷改走各自獨立的
      // is_coach / is_counter / is_lifeguard（見下方 payload），互不覆蓋。
      const roleVal = isAdmin ? 'admin' : (isCounter ? 'staff' : (isCoach ? 'coach' : 'staff'));
      const isActive = (r['在職狀態'] || r['3000945']) === '在職';
      // Task #90：解析 Ragic H01 多場館欄位（主場館 + 支援場館），合併為陣列
      // Task #95：立即 resolve 成 venue 代碼再比對 / 入 payload（見上方註解）
      const venueIds = resolveVenues(_extractStaffVenueIds(r));
	      if (cur && ((!cur.ragic_record_id && ragicRecordId)
	          || (!cur.line_uid && lineUid))) {
	        try {
	          await pool.query(
	            `UPDATE admin_staff
	                SET ragic_record_id = COALESCE(ragic_record_id, $1),
	                    line_uid = COALESCE(NULLIF(line_uid, ''), NULLIF($3, '')),
	                    last_synced_at = NOW()
	              WHERE id = $2`,
	            [ragicRecordId || null, cur.id, lineUid || '']
	          );
	          await pool.query(
	            `UPDATE coaches
	                SET ragic_record_id = COALESCE(ragic_record_id, $1),
	                    updated_at = NOW()
	              WHERE ragic_employee_id = $2`,
	            [ragicRecordId || null, cur.id]
	          );
	          cur.ragic_record_id = cur.ragic_record_id || ragicRecordId;
	          cur.line_uid = cur.line_uid || lineUid;
	        } catch (err) {
	          console.warn('[Ragic sync] H01 governance key backfill skipped:', err.message);
	        }
      }
      // 套用至正式表時 entity_id 是 staging 卡片的穩定身份（保留原始大小寫），員工編號
      // 變更時故意維持舊值不變——避免同一人在編號變更當下憑空多出一張新 staging 卡，
      // 真正要寫入的新編號改放 payload.id，由 _applyStaffChange 以 ragic_record_id
      // 為準 UPDATE 既有列（含 PK）。
	      const entityId = cur ? cur.id : id;
      const payload = {
        id, name, phone, email, role: roleVal,
        is_active: isActive, venue_ids: venueIds,
        line_uid: lineUid,
        ragic_data_no: ragicDataNo,
        ragic_record_id: ragicRecordId,
        ragic_last_update_at: _ragicLastUpdateValue(r),
        // A0 / A0.5 / 救生員：三個獨立追蹤旗標，各自反映 Ragic 應徵職務關鍵字命中情形，
        // 不受 roleVal 三元運算式影響（同一員工可以三者皆為 true）。
        is_coach: isCoach,
        is_counter: isCounter,
        is_lifeguard: isLifeguard,
      };

      // 查目前 coaches.email / line_uid 作為 diff 比對基準（admin_staff 本身沒有這兩個欄位）
      // ——改用迴圈前一次撈齊的 coachByEmp Map，避免每筆各打一次 DB（見上方 Perf 註解）。
	      const coachRow = coachByEmp.get(entityId);
	      const curCoachEmail = coachRow?.email || '';
	      const curCoachLineUid = coachRow?.line_uid || cur?.line_uid || '';
      // email / line_uid 只存在於 coaches 表；apply 也只寫得進 coaches 列。
      // 因此唯有「已有 coaches 列」或「這次會被建成教練（role=coach 且有手機 → apply 會建列）」
      // 時，套用才寫得進去。純後勤員工（role=staff、無 coaches 列）若硬 stage 這兩欄，
      // approve 後無處可寫 → 下一輪 sync 又偵測到 coaches 仍為空 → 永遠重 stage、待審區清不掉。
      // A0 修法：改依 payload.is_coach（獨立信號）判斷，不再依賴已被 roleVal 三元運算式
      // 吃掉 isCoach 之後的 roleVal === 'coach'——雙重身份（櫃檯+教練）員工的 is_coach
      // 為 true 但 roleVal 仍會是 'staff'，用舊條件永遠不會成立。
      const coachFieldsPersistable = !!coachRow || (payload.is_coach && !!phone);

      if (!cur) {
        try {
          await applyClient.query('BEGIN');
          await _applyStaffChange({ entity_id: entityId, change_type: 'new', payload_json: payload }, applyClient);
          await applyClient.query('COMMIT');
          applied++;
        } catch (applyErr) {
          await applyClient.query('ROLLBACK').catch(() => {});
          failed++;
          staffErrors.push(`新員工 ${entityId}：${applyErr.message}`);
          console.warn('[Ragic sync] new staff direct-apply failed (id=%s): %s', entityId, applyErr.message);
        }
        continue;
      }
      const diff = {};
      // P1.1「熊韋程 staff 事故」修復：員工編號變更本身也要讓人看一眼再套用，不無聲
      // 改 PK——透過 ragic_record_id 對到同一人、但這輪員工編號跟本地現值不同時，才會
      // 出現這個 diff（一般情況編號沒變，_normalizeStaffId(cur.id) === id，不會觸發）。
      if (_normalizeStaffId(cur.id) !== id) diff.id = { from: cur.id, to: id };
      if ((cur.name || '') !== name) diff.name = { from: cur.name || '', to: name };
      if ((cur.phone || '') !== phone) diff.phone = { from: cur.phone || '', to: phone };
      // role 為系統內部欄位（admin 可改 staff/coach/manager）— 原則上不從 Ragic 同步。
      // 唯一例外：H01 應徵職務/職稱明確命中「管理員」時，單向升級為 admin；
      // 不做反向降級，避免把後台手動指派洗掉。
      if (isAdmin && cur.role !== 'admin') {
        diff.role = { from: cur.role || 'staff', to: 'admin' };
      }
      // email：apply 端只在 DB 空值時補（保留後台手動編輯）→ diff 也只在「DB 空 + Ragic 有值」
      // 才 stage（Task #95：先前「值不同就 diff」會讓 admin 自填信箱後，同一筆差異每輪重現、
      // approve 又套不進去（fill-empty-only），待審區永遠清不掉）
      if (coachFieldsPersistable && email && !curCoachEmail) {
        diff.email = { from: '', to: email };
      }
      // line_uid：H01 有合法 UID 時以 Ragic 為權威校正；Ragic 空值不清掉本地已綁定值。
      // 同上 coachFieldsPersistable 把關：非教練的 line_uid 套用無處可寫，不再 stage。
	      if (lineUid && curCoachLineUid !== lineUid) {
	        diff.line_uid = { from: curCoachLineUid || '', to: lineUid };
	      }
      if (cur.active_overridden_at == null && cur.active !== isActive) {
        diff.active = { from: cur.active, to: isActive };
      }
      // A0（既有員工回填，關鍵既有 bug 修復）：isCoach===true 但目前沒有 coaches 資料列
      // → 產生一筆待審 is_coach diff，讓「已同步過、但當初被舊三元運算式 bug 漏掉教練身份」
      // 的既有員工（如 S001 小林）能在下次同步時被抓出來進入待審核佇列，不再只對「新進
      // 員工」生效（apply 時的建立邏輯見 _applyStaffChange 的 A0 dual-coach 分支）。
      if (isCoach && !coachRow) {
        diff.is_coach = { from: false, to: true };
      }
      // A0.5：is_counter 單純的布林狀態差異（比照 name/phone 既有寫法），讓既有員工的
      // 「行政櫃檯」旗標也能被回填校正（不影響 admin_staff.role 本身，那仍是 roleVal fallback）。
      if (!!cur.is_counter !== isCounter) {
        diff.is_counter = { from: !!cur.is_counter, to: isCounter };
      }
      // 救生員：is_lifeguard 同樣是單純的布林狀態差異。lifeguard_active 本身不受 Ragic
      // 同步影響（見 _applyStaffChange 註解），這裡只偵測「是否為救生員」這個身份信號。
      if (!!cur.is_lifeguard !== isLifeguard) {
        diff.is_lifeguard = { from: !!cur.is_lifeguard, to: isLifeguard };
      }
      // 場館差異直接套用（移除 staging 流程，全量直接 apply）
	      const curVenues = venuesByStaff.get(entityId) || [];
      const newVenues = [...venueIds].sort();
      const curVenuesSorted = [...curVenues].sort();
      if (newVenues.length > 0 && (newVenues.length !== curVenuesSorted.length
          || newVenues.some((v, i) => v !== curVenuesSorted[i]))) {
        diff.venue_ids = { from: curVenuesSorted, to: newVenues };
      }
      if (Object.keys(diff).length > 0) {
        try {
          await applyClient.query('BEGIN');
          await _applyStaffChange({ entity_id: entityId, change_type: 'update', payload_json: payload }, applyClient);
          await applyClient.query('COMMIT');
          applied++;
        } catch (applyErr) {
          await applyClient.query('ROLLBACK').catch(() => {});
          failed++;
          staffErrors.push(`員工 ${entityId}：${applyErr.message}`);
          console.warn('[Ragic sync] staff update direct-apply failed (id=%s): %s', entityId, applyErr.message);
        }
      }
     } catch (err) {
      // 嫌疑4 CONFIRMED 修復：單筆壞資料不再中止整批（原本 function-level try 會讓
      // 一筆毒資料炸掉整輪、回 {synced:0} 掩蓋已完成的進度）。失敗筆數獨立累計，
      // 該筆下一輪同步再重試。
      failed++;
      const ragicIdForLog = r?.['員工編號'] || r?.['工號'] || r?.['3000935'] || '(unknown)';
      staffErrors.push(`員工 ${ragicIdForLog}：${err.message}`);
      console.warn('[Ragic sync] staff per-record failed (id=%s): %s', ragicIdForLog, err.message);
     }
    }

    if (h01Unmatched > 0) {
      const sampleText = h01Warnings.slice(0, 3)
        .map((w) => `${w.reason}:${w.emp_id || w.ragic_data_no || w.ragic_record_id || 'unknown'}`)
        .join('；');
      await _alertAdmins(`【Ragic H01 對齊警告】h01_unmatched_staff_warning=${h01Unmatched}${sampleText ? `（sample: ${sampleText}）` : ''}`);
    }

	    // Ragic 名單外 + 仍 active + 未 override → 依姓名停用（不做 hard delete）
	    for (const r of dbRows) {
	      if (!r.active || r.active_overridden_at != null || seenKeys.has(_staffNameKey(r.name))) continue;
      const payload = { id: r.id, name: r.name, is_active: false };
      try {
        await applyClient.query('BEGIN');
        await _applyStaffChange({ entity_id: r.id, change_type: 'deactivate', payload_json: payload }, applyClient);
        await applyClient.query('COMMIT');
        applied++;
      } catch (deactivateErr) {
        await applyClient.query('ROLLBACK').catch(() => {});
        console.warn('[Ragic sync] staff deactivate direct-apply failed (id=%s): %s', r.id, deactivateErr.message);
      }
    }
    if (failed > 0) {
      return {
        synced: applied, applied, failed, partial: true,
        h01_unmatched_staff_warning: h01Unmatched,
        h01_unmatched_staff_warning_samples: h01Warnings.slice(0, 10),
        error: `${failed} 筆員工同步失敗（詳見伺服器 log，其餘 ${applied} 筆已正常套用）：${staffErrors[0]}`,
        skipped: false,
      };
    }
    return {
      synced: applied,
      applied,
      h01_unmatched_staff_warning: h01Unmatched,
      h01_unmatched_staff_warning_samples: h01Warnings.slice(0, 10),
      skipped: false,
    };
  } catch (err) {
    console.warn('[Ragic sync] staff failed:', err.message);
    return { synced: 0, error: err.message };
  } finally {
    if (applyClient) applyClient.release();
  }
}

// 對外維持原函式名/簽名不變（FORM_META.staff.impl、cron、admin 手動觸發皆呼叫這支，
// 完全不需要跟著改）：內部改為「先無腦寫 shadow，再從 shadow 清洗」兩步驟，比照
// _pullParentsStudentsImpl（Z01）已驗證過的模式。
// Phase 5：手動觸發（triggeredBy==='manual'）且已有前一輪成功的 watermark 時走增量；
// cron（每日/每 10 分鐘排程）或首次執行（尚無 watermark）一律全量——「每天仍會跑
// 一次全量」由既有 cron 排程自然滿足，不需要另外加一個「強制全量」的旗標。
// watermark 只在整輪「無 error、非 partial、非 stale_read」才推進，且推進到「這輪
// 開始拉取的時間點」而非完成時間，避免拉取期間的新變更被漏掉。
async function _syncStaffImpl(triggeredBy = 'cron') {
  const watermark = await getSyncWatermark(FORM_META.staff.code);
  const useIncremental = triggeredBy === 'manual' && !!watermark;
  const runStartedAt = new Date();
  const shadowResult = await _shadowPullH01Impl({ incremental: useIncremental, watermark });
  if (shadowResult.skipped) return shadowResult;
  if (shadowResult.error) {
    return _withFreshness(
      { synced: 0, stale_read: !!shadowResult.stale_read, error: `[shadow-pull] ${shadowResult.error}`, incremental: useIncremental },
      _freshnessFromResult(shadowResult)
    );
  }
  const reconciled = await _reconcileH01FromShadowImpl();
  const coefficient = await _syncStaffCoefficientImpl();
  const combined = {
    ...reconciled,
    synced: Number(shadowResult.shadow_count ?? shadowResult.synced) || 0,
    incremental: useIncremental,
    h01_raw_total: Number(shadowResult.raw_total) || 0,
    h01_shadow_count: Number(shadowResult.shadow_count ?? shadowResult.synced) || 0,
    h01_applied: Number(reconciled.applied ?? reconciled.synced) || 0,
    staff_staged: Number(reconciled.staged ?? reconciled.applied ?? reconciled.synced) || 0,
    coefficient_updated: Number(coefficient.updated ?? coefficient.synced) || 0,
    coefficient_scanned: Number(coefficient.scanned) || 0,
    coefficient_shadow_synced: Number(coefficient.shadow_synced) || 0,
    coefficient_raw_total: Number(coefficient.raw_total) || 0,
    coefficient_shadow_count: Number(coefficient.shadow_count ?? coefficient.shadow_synced) || 0,
    h01_unmatched_staff_warning: Number(reconciled.h01_unmatched_staff_warning) || 0,
    h01_unmatched_staff_warning_samples: reconciled.h01_unmatched_staff_warning_samples || [],
    unmatched_staff_warning: Number(coefficient.unmatched_staff_warning) || 0,
    unmatched_staff_warning_samples: coefficient.unmatched_staff_warning_samples || [],
    // 反向警告：H01 教練確實存在，但沒有任何 H23 列精確配對到過（multiplier 停在舊值）。
    h01_missing_h23_warning: Number(coefficient.h01_missing_h23_warning) || 0,
    h01_missing_h23_warning_samples: coefficient.h01_missing_h23_warning_samples || [],
  };
  if (reconciled.partial || coefficient.error) combined.partial = true;
  if (reconciled.error || coefficient.error) {
    combined.error = [reconciled.error, coefficient.error].filter(Boolean).join('；');
  }
  if (!combined.error && !combined.partial && !shadowResult.stale_read) {
    await setSyncWatermark(FORM_META.staff.code, runStartedAt).catch((err) => {
      console.warn('[Ragic sync] H01 watermark 寫入失敗（不影響本輪同步結果）:', err.message);
    });
  }
  return _withFreshness(combined, _freshnessFromResult(shadowResult));
}

/**
 * H01 教練登入只認「個人LINE ID」Field ID 1003633，以及 Ragic API 實機會回傳的
 * 精準中文欄名「個人LINE ID」。禁止模糊搜尋，避免把「400Line訊息」或其它訊息欄位
 * 誤當成 LINE Login userId。LINE userId 目前格式為 U + 32 hex；不符合即視為未綁定。
 */
function normalizeLineUserId(value) {
  const uid = String(value || '').trim();
  if (!uid) return '';
  return /^U[0-9A-Fa-f]{32}$/.test(uid) ? uid : '';
}

function extractLineUid(r) {
  const fieldIdValue = normalizeLineUserId(r?.[H01.LINE_UID]);
  if (fieldIdValue) return fieldIdValue;
  for (const key of H01.LINE_UID_DISPLAY_KEYS || []) {
    const displayValue = normalizeLineUserId(r?.[key]);
    if (displayValue) return displayValue;
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
// P1.1 決策9：無腦 shadow 寫入——唯一打 Ragic H05 全量查詢的地方，不跑任何比對/
// 清洗邏輯。場館代碼本身穩定（不像員工編號會被改），key 直接用 _mapRagicVenue(r).code。
async function _shadowPullH05Impl() {
  if (!ragicEnabled()) return { synced: 0, skipped: true };
  let records;
  let freshness = null;
  try {
    const pull = await ragic.getActiveVenuesWithFreshness();
    freshness = pull.freshness || null;
    if (pull.stale_read) {
      await _alertFreshnessIfNeeded('H05', freshness, pull.error);
      return _withFreshness({ synced: 0, stale_read: true, error: pull.error }, freshness);
    }
    records = pull.records || [];
    await _alertFreshnessIfNeeded('H05', freshness);
  } catch (err) {
    return { synced: 0, error: `Ragic H05 全量查詢失敗：${err.message}` };
  }
  const client = await pool.connect();
  let synced = 0;
  try {
    await client.query('BEGIN');
    const presentCodes = [];
    for (const row of records) {
      if (ragic.isCanaryRecord(row, 'H05')) continue;
      const v = _mapRagicVenue(row);
      if (!v || !v.code) continue;
      presentCodes.push(v.code);
      await client.query(
        `INSERT INTO ragic_h05_shadow (venue_code, raw_data, fetched_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (venue_code) DO UPDATE SET raw_data = EXCLUDED.raw_data, fetched_at = NOW()`,
        [v.code, JSON.stringify(row)]
      );
      synced++;
    }
    await client.query(
      `DELETE FROM ragic_h05_shadow WHERE NOT (venue_code = ANY($1::text[]))`,
      [presentCodes]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // ROLLBACK 已撤銷整個交易——回報實際持久化筆數 0，理由同 H01 shadow-pull 的同款修復。
    return _withFreshness({ synced: 0, error: `Shadow 寫入失敗：${err.message}` }, freshness);
  } finally {
    client.release();
  }
  return _withFreshness({ synced }, freshness);
}

async function _readShadowH05(client) {
  const r = await client.query(`SELECT raw_data FROM ragic_h05_shadow`);
  return r.rows.map((row) => row.raw_data).filter((row) => !ragic.isCanaryRecord(row, 'H05'));
}

// 既有 diff/staging 邏輯，資料來源改讀 ragic_h05_shadow（由 _shadowPullH05Impl
// 維護），不再直接呼叫 Ragic API。
async function _reconcileH05FromShadowImpl() {
  try {
    const client0 = await pool.connect();
    let records;
    try {
      records = await _readShadowH05(client0);
    } finally {
      client0.release();
    }
    const ragicMap = new Map();
    for (const r of records) {
      const v = _mapRagicVenue(r);
      if (v) ragicMap.set(v.code, v);
    }
    const dbRows = (await pool.query(`SELECT * FROM admin_venues`)).rows;
    const dbMap = new Map(dbRows.map(r => [r.id, r]));
    let staged = 0;
    let failed = 0;
    const venueErrors = [];

    for (const [code, rv] of ragicMap) {
     try {
      const cur = dbMap.get(code);
      const payload = { code, ...rv, is_active: true };
      if (!cur) {
        await pool.query(
          `INSERT INTO admin_venues (id, name, address, is_active)
           VALUES ($1, $2, $3, TRUE)
           ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, address=EXCLUDED.address, is_active=TRUE`,
          [code, rv.name || '', rv.address || '']
        );
        staged++;
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
        if ('name' in diff) await pool.query(`UPDATE admin_venues SET name=$1 WHERE id=$2 AND name_overridden_at IS NULL`, [rv.name || '', code]);
        if ('address' in diff) await pool.query(`UPDATE admin_venues SET address=$1 WHERE id=$2 AND address_overridden_at IS NULL`, [rv.address || '', code]);
        if ('is_active' in diff) await pool.query(`UPDATE admin_venues SET is_active=TRUE WHERE id=$1 AND is_active_overridden_at IS NULL`, [code]);
        staged++;
      }
     } catch (err) {
      // 嫌疑4 CONFIRMED 修復：單筆壞資料不再中止整批（原本 function-level try 會讓
      // 一筆毒資料炸掉整輪、回 {synced:0} 掩蓋已完成的進度）。
      failed++;
      venueErrors.push(`場館 ${code}：${err.message}`);
      console.warn('[Ragic sync] venue per-record failed (code=%s): %s', code, err.message);
     }
    }

    // 不在 Ragic 但 active 中 + 未 override → 直接停用（無 staging）
    for (const r of dbRows) {
      if (!r.is_active || r.is_active_overridden_at != null || ragicMap.has(r.id)) continue;
      await pool.query(`UPDATE admin_venues SET is_active=FALSE WHERE id=$1 AND is_active_overridden_at IS NULL`, [r.id]);
      staged++;
    }
    if (failed > 0) {
      return {
        synced: staged, staged, failed, partial: true,
        error: `${failed} 筆場館同步失敗（詳見伺服器 log，其餘 ${staged} 筆已正常完成）：${venueErrors[0]}`,
        skipped: false,
      };
    }
    return { synced: staged, staged, skipped: false };
  } catch (err) {
    console.warn('[Ragic sync] venues failed:', err.message);
    return { synced: 0, error: err.message };
  }
}

// 對外維持原函式名/簽名不變（FORM_META.venues.impl、cron、admin 手動觸發皆呼叫這支，
// 完全不需要跟著改）：內部改為「先無腦寫 shadow，再從 shadow 清洗」兩步驟。
async function _syncVenuesImpl() {
  const shadowResult = await _shadowPullH05Impl();
  if (shadowResult.skipped) return shadowResult;
  if (shadowResult.error) {
    return _withFreshness(
      { synced: 0, stale_read: !!shadowResult.stale_read, error: `[shadow-pull] ${shadowResult.error}` },
      _freshnessFromResult(shadowResult)
    );
  }
  const reconciled = await _reconcileH05FromShadowImpl();
  return _withFreshness(reconciled, _freshnessFromResult(shadowResult));
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
         WHERE id = $1 AND active_overridden_at IS NULL
           AND COALESCE(is_placeholder, FALSE) = FALSE`,
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
  const staffId = p.id || row.entity_id;
  const ragicRecordId = p.ragic_record_id || null;
  const incomingLineUid = p.line_uid ? String(p.line_uid).trim() : '';
  const incomingName = String(p.name || '').trim();
  let existingStaffId = null;
  if (incomingName && incomingLineUid) {
    const byNameLine = await client.query(
      `SELECT id FROM admin_staff
        WHERE TRIM(name) = $1 AND NULLIF(TRIM(line_uid), '') = $2
        LIMIT 2`,
      [incomingName, incomingLineUid]
    );
    if (byNameLine.rowCount === 1) existingStaffId = byNameLine.rows[0].id;
  }
  if (!existingStaffId && incomingName) {
    const byName = await client.query(
      `SELECT id FROM admin_staff WHERE TRIM(name) = $1 LIMIT 2`,
      [incomingName]
    );
    if (byName.rowCount === 1) existingStaffId = byName.rows[0].id;
    else if (byName.rowCount > 1 && !incomingLineUid) {
      throw new Error(`H01 同名員工「${incomingName}」缺少 LINE ID，無法安全套用`);
    }
  }
  if (!existingStaffId && incomingLineUid) {
    const byLine = await client.query(
      `SELECT id FROM admin_staff WHERE NULLIF(TRIM(line_uid), '') = $1 LIMIT 2`,
      [incomingLineUid]
    );
    if (byLine.rowCount === 1) existingStaffId = byLine.rows[0].id;
  }
  if (!existingStaffId && ragicRecordId) {
    const byRid = await client.query(`SELECT id FROM admin_staff WHERE ragic_record_id = $1`, [ragicRecordId]);
    existingStaffId = byRid.rows[0]?.id || null;
  }
  if (!existingStaffId) {
    const byId = await client.query(`SELECT id FROM admin_staff WHERE id = $1`, [staffId]);
    existingStaffId = byId.rows[0]?.id || null;
  }
  if (existingStaffId) {
    await client.query(
	      `UPDATE admin_staff SET
	         id = $1, name = $2, phone = $3,
	         role = CASE WHEN $11::text = 'admin' THEN 'admin' ELSE role END,
	         active = CASE WHEN active_overridden_at IS NULL THEN $4 ELSE active END,
         -- A0/A0.5/救生員：is_coach / is_counter / is_lifeguard 皆為 Ragic 來源、唯讀信號
         -- （比照 role 的性質，但各自獨立追蹤、不互相覆蓋），每次 apply 一律以 Ragic 這次
         -- 送來的值為準。救生員不另設啟用狀態，lifeguard_active 舊欄位不再參與同步。
	         is_coach = $5, is_counter = $6, is_lifeguard = $7,
         -- COALESCE：ragic_record_id 若這次 payload 沒帶（舊版 payload 過渡期）
         -- 就保留既有值，不要用 NULL 蓋掉已經有的紀錄。
	         ragic_record_id = COALESCE($8, ragic_record_id),
	         line_uid = CASE WHEN NULLIF($9, '') IS NOT NULL THEN NULLIF($9, '') ELSE line_uid END,
	         last_synced_at = NOW()
	       WHERE id = $10`,
	      [staffId, p.name || '', p.phone || '', !!p.is_active,
	       !!p.is_coach, !!p.is_counter, !!p.is_lifeguard, ragicRecordId, incomingLineUid, existingStaffId, p.role || '']
	    );
	  } else {
	    await client.query(
	      `INSERT INTO admin_staff (id, name, role, phone, is_senior, multiplier, active,
	          is_coach, is_counter, is_lifeguard, ragic_record_id, line_uid, last_synced_at)
	       VALUES ($1, $2, $3, $4, FALSE, 1.00, $5, $6, $7, $8, $9, NULLIF($10, ''), NOW())`,
	      [staffId, p.name || '', p.role || 'staff', p.phone || '', !!p.is_active,
	       !!p.is_coach, !!p.is_counter, !!p.is_lifeguard, ragicRecordId, incomingLineUid]
	    );
	  }
  if (p.role === 'admin') {
    await client.query(
      `UPDATE admin_users
          SET role = 'admin', updated_at = NOW()
        WHERE staff_id = $1 OR staff_id = $2`,
      [staffId, existingStaffId || staffId]
    );
  }
  if (p.is_active === false && p.name) {
    await client.query(
      `UPDATE admin_users SET is_active = FALSE
         WHERE name = $1 AND is_active = TRUE AND active_overridden_at IS NULL`,
      [p.name]
    );
  }
  // 教練連動同樣退出 3000934 資料編號；先用 LINE UID / Ragic node，再 fallback
  // 到員工編號與手機，避免髒資料編號把 coach row 對到錯人。
  let existingCoachRow = null;
  if (incomingLineUid) {
    const byLine = await client.query(
      `SELECT id, line_uid, is_active, active_overridden_at FROM coaches WHERE line_uid = $1`,
      [incomingLineUid]
    );
    existingCoachRow = byLine.rows[0] || null;
  }
  if (!existingCoachRow && ragicRecordId) {
    const byRid = await client.query(
      `SELECT id, line_uid, is_active, active_overridden_at FROM coaches WHERE ragic_record_id = $1`,
      [ragicRecordId]
    );
    existingCoachRow = byRid.rows[0] || null;
  }
  if (!existingCoachRow) {
    const byEmp = await client.query(
      `SELECT id, line_uid, is_active, active_overridden_at FROM coaches WHERE ragic_employee_id = $1`,
      [staffId]
    );
    existingCoachRow = byEmp.rows[0] || null;
  }
  // 第三層 fallback：用電話查（ragic_employee_id 不一致但同一真實人時）
  // 可避免「找不到 → INSERT → coaches_phone_key 衝突」的 staging approve 失敗迴圈。
  if (!existingCoachRow && (p.phone || '').trim()) {
    const byPhone = await client.query(
      `SELECT id, line_uid, is_active, active_overridden_at FROM coaches WHERE phone = $1`,
      [String(p.phone).trim()]
    );
    if (byPhone.rows[0]) {
      existingCoachRow = byPhone.rows[0];
      console.warn(
        `[ragicAdmin] coach found by phone=${p.phone} (ragic_employee_id mismatch: entity=${staffId}); will UPDATE instead of INSERT`
      );
    }
  }
  // Task #91 後續：Ragic 同步的 email 寫入 coaches.email（若 coach row 已存在）。
  // 保留後台手動編輯優先：只在現值為空時才覆寫，避免蓋掉 admin 在彈窗改過的私人信箱。
  if (p.email && existingCoachRow) {
    await client.query(
      `UPDATE coaches SET email = $2, updated_at = NOW()
        WHERE id = $1 AND (email IS NULL OR email = '')`,
      [existingCoachRow.id, String(p.email).trim()]
    );
  }
  const isCoachRole = String(p.role || '') === 'coach';
  const hasCoachProfile = !!existingCoachRow;
  // A0：疊加教練身份（role 仍是 'staff'/其他，但 Ragic 應徵職務同時命中「教練」關鍵字，
  // 即 payload.is_coach===true）且目前尚無 coaches 資料列 → 也要建立教練身份，
  // 不能只靠 isCoachRole（那只在 roleVal 剛好算成 'coach' 時才會是 true，雙重身份時
  // roleVal 早被 COUNTER 命中壓成 'staff'，isCoachRole 永遠不會是 true）。
  const isDualCoach = !!p.is_coach && !isCoachRole;

  // ── 教練 1:1 維護：staff↔coach invariant ──
  // 當這次 apply 後的 staff 是教練（role=coach 或 DB 已有 coach 兼任 row），
  // 必須確保 coaches 表存在對應 row，否則 LIFF /api/coaches/by-line-uid 找不到、
  // 教練永遠無法登入。
  //
  // line_uid 寫入規則：
  //   1) Ragic 有合法 UID → 以 H01 為權威寫入 / 校正
  //   2) Ragic 空值 → 不清掉本地已綁定值
  //   3) Ragic 與本地不同 → log 一筆，然後由下方 UPDATE 校正
  if (hasCoachProfile && incomingLineUid && existingCoachRow.line_uid
      && existingCoachRow.line_uid !== incomingLineUid) {
    console.warn(
      `[ragicAdmin] line_uid mismatch for coach=${staffId}: `
      + `local=${existingCoachRow.line_uid} ragic=${incomingLineUid} → 以 Ragic H01 校正`
    );
  }

  if (isCoachRole && (p.phone || '').trim()) {
    // 教練（單一角色或已有 profile）：就地更新既有列，或新建 + 同步 venues + 寫入 line_uid（若有）
    let coachId;
    if (existingCoachRow) {
      await client.query(
	        `UPDATE coaches SET
	           ragic_employee_id = $2,
	           ragic_record_id = COALESCE($3, ragic_record_id),
	           name = $4, phone = $5,
	           email = COALESCE(NULLIF($6, ''), email),
	           line_uid = CASE WHEN NULLIF($7, '') IS NOT NULL THEN NULLIF($7, '') ELSE line_uid END,
	           is_active = CASE WHEN active_overridden_at IS NULL THEN $8 ELSE is_active END,
	           updated_at = NOW()
	         WHERE id = $1`,
	        [existingCoachRow.id, staffId, ragicRecordId, p.name || '', String(p.phone || '').trim(),
	         String(p.email || '').trim(), incomingLineUid, !!p.is_active]
	      );
      coachId = existingCoachRow.id;
    } else {
      const inserted = await client.query(
	        `INSERT INTO coaches
	           (ragic_employee_id, ragic_record_id, name, phone, email, line_uid,
	            is_senior, pricing_multiplier, specialties, bio_rich_text,
	            is_active, intro_review_status, active_overridden_at)
	         VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''),
	                 FALSE, 1.00, ARRAY[]::text[], '',
	                 $7, 'draft', NOW())
	         RETURNING id`,
	        [staffId, ragicRecordId, p.name || '', String(p.phone || '').trim(),
	         String(p.email || '').trim(), incomingLineUid, !!p.is_active]
	      );
      coachId = inserted.rows[0]?.id || null;
    }
    await _syncCoachVenueIds(client, coachId, p.venue_ids);
  } else if (isDualCoach && !hasCoachProfile && (p.phone || '').trim()) {
    // A0（關鍵既有 bug 修復）：既有員工被 Ragic 標記為教練（疊加身份），但尚無
    // coaches 資料列 → 新建。新建立的教練身份預設 coach_active=FALSE，需要管理員手動開通，
    // 不會讓一批櫃檯人員
    // 一夕之間全部被動開放教練預約——這裡刻意不沿用 isCoachRole 分支的
    // is_active: !!p.is_active（那是給「單一教練角色」新人用的行為，語意不同）。
    const inserted = await client.query(
	      `INSERT INTO coaches
	         (ragic_employee_id, ragic_record_id, name, phone, email, line_uid,
	          is_senior, pricing_multiplier, specialties, bio_rich_text,
	          is_active, intro_review_status, active_overridden_at)
	       VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''),
	               FALSE, 1.00, ARRAY[]::text[], '',
	               FALSE, 'draft', NULL)
	       RETURNING id`,
	      [staffId, ragicRecordId, p.name || '', String(p.phone || '').trim(),
	       String(p.email || '').trim(), incomingLineUid]
	    );
    const coachId = inserted.rows[0]?.id;
    await _syncCoachVenueIds(client, coachId, p.venue_ids);
  } else if (hasCoachProfile && incomingLineUid) {
    // dual-role 兼任教練 或 既有 coach row：H01 有合法 UID 時校正，空值不覆蓋
    await client.query(
	      `UPDATE coaches
	          SET line_uid = CASE WHEN NULLIF($2, '') IS NOT NULL THEN NULLIF($2, '') ELSE line_uid END,
	              ragic_record_id = COALESCE($3, ragic_record_id),
	              updated_at = NOW()
	        WHERE id = $1`,
	      [existingCoachRow.id, incomingLineUid, ragicRecordId]
	    );
  }
  // Task #90：同步 admin_staff_venues（多場館），並把第一筆寫回 admin_staff.venue_id 作 fallback
  // staffId（非 row.entity_id）：上面 admin_staff.id 若因員工編號變更被 UPDATE，
  // admin_staff_venues.staff_id 已透過 ON UPDATE CASCADE 連動改成新值，這裡要用新值查/寫。
  // admin_staff.venue_id 保留第一筆作舊讀取路徑 fallback；完整權限以 admin_staff_venues 為準。
  await _syncStaffVenueIds(client, staffId, p.venue_ids);
}

async function _applyCoachChange(row, client) {
  const p = row.payload_json || {};
  if (row.change_type === 'deactivate') {
    await client.query(
      `UPDATE coaches SET is_active = FALSE, updated_at = NOW()
         WHERE ragic_employee_id = $1 AND active_overridden_at IS NULL
           AND COALESCE(is_placeholder, FALSE) = FALSE`,
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
       line_uid = CASE WHEN NULLIF($5, '') IS NOT NULL THEN NULLIF($5, '') ELSE coaches.line_uid END,
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

// P1.1「熊韋程 staff 事故」防線：待審核區出現 staff「新增」提案時，檢查是否跟既有
// 列撞號（phone / line_uid / 正規化姓名+場館 任一命中，且不是同一個 Ragic 記錄）。
// 命中代表很可能是「員工編號變更被誤判成新人」，而非真的新進員工——不可讓「通過
// 並套用」直接建出第二筆同人記錄，只能走合併路徑（見 mergeStagedStaffChange）。
async function _findStaffCollision(payload) {
  const ragicRecordId = payload.ragic_record_id || null;
  const phone = String(payload.phone || '').trim();
  if (phone) {
    const r = await pool.query(
      `SELECT id, name, ragic_record_id FROM admin_staff
        WHERE phone = $1 AND ($2::text IS NULL OR ragic_record_id IS DISTINCT FROM $2)
        LIMIT 1`,
      [phone, ragicRecordId]
    );
    if (r.rowCount) return { entity_id: r.rows[0].id, matched_name: r.rows[0].name, reason: 'phone_match' };
  }
  const lineUid = String(payload.line_uid || '').trim();
  if (lineUid) {
    const r = await pool.query(
      `SELECT id, name, ragic_record_id FROM coaches
        WHERE line_uid = $1 AND ($2::text IS NULL OR ragic_record_id IS DISTINCT FROM $2)
        LIMIT 1`,
      [lineUid, ragicRecordId]
    );
    if (r.rowCount) return { entity_id: r.rows[0].id, matched_name: r.rows[0].name, reason: 'line_uid_match' };
  }
  const name = String(payload.name || '').trim().normalize('NFKC');
  const venueIds = cleanVenueList(payload.venue_ids);
  if (name && venueIds.length) {
    const r = await pool.query(
      `SELECT s.id, s.name, s.ragic_record_id FROM admin_staff s
         JOIN admin_staff_venues v ON v.staff_id = s.id
        WHERE s.name = $1 AND v.venue_id = ANY($2::text[])
          AND ($3::text IS NULL OR s.ragic_record_id IS DISTINCT FROM $3)
        LIMIT 1`,
      [name, venueIds, ragicRecordId]
    );
    if (r.rowCount) return { entity_id: r.rows[0].id, matched_name: r.rows[0].name, reason: 'name_venue_match' };
  }
  return null;
}

async function applyStagedChange(stagingId, byUserId) {
  const client = await pool.connect();
  // A7（熊韋程卡 pending 調查）：hoist 到 try 外層，讓 catch block 在 apply 失敗時
  // 仍能取得 entity_type/entity_id，附掛在錯誤物件上供上層（ragicStaging.js 的
  // approve route）做結構化 log + 回傳具體失敗原因給前端，不必再多查一次 DB。
  let row = null;
  try {
    await client.query('BEGIN');
    // FOR UPDATE 防併發 approve 同一 row
    const r = await client.query(`SELECT * FROM ragic_staging_changes WHERE id = $1 FOR UPDATE`, [stagingId]);
    if (!r.rowCount) throw new Error('staging row not found');
    row = r.rows[0];
    if (row.status !== 'pending') throw new Error(`status=${row.status}, only pending can be approved`);
    if (row.entity_type === 'staff' && row.change_type === 'new') {
      const collision = await _findStaffCollision(row.payload_json || {});
      if (collision) {
        const err = new Error(
          `疑似同一人已存在（entity_id=${collision.entity_id}，${collision.matched_name}，命中：${collision.reason}），`
          + `不可直接核准新增，請改用合併`
        );
        err.code = 'STAFF_COLLISION_SUSPECTED';
        err.collisionEntityId = collision.entity_id;
        throw err;
      }
    }
    await _assertStagedRagicStillFresh(row);
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
    err.stagingId = stagingId;
    if (row) {
      err.stagingEntityType = row.entity_type;
      err.stagingEntityId = row.entity_id;
    }
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

// P1.1「熊韋程 staff 事故」合併動作：admin 人工確認一筆 staff「新增」提案其實是
// 既有 target_entity_id 這個人（員工編號變更被誤判成新人），把提案的身份/欄位
// 寫到既有列上，而不是另建一筆第二筆同人記錄。跟熊韋程事發當下的手動修復是
// 同一套邏輯，這裡把它一般化成可重複使用的動作。關聯資料（admin_staff_venues
// 等）刻意不在這裡處理——合併後 ragic_record_id 對得上了，下一輪一般同步會
// 把剩餘欄位差異（含場館）當成正常的 update 提案送審，不需要在合併當下全部
// 處理完。
async function mergeStagedStaffChange(stagingId, targetEntityId, byUserId) {
  const client = await pool.connect();
  let row = null;
  try {
    await client.query('BEGIN');
    const r = await client.query(`SELECT * FROM ragic_staging_changes WHERE id = $1 FOR UPDATE`, [stagingId]);
    if (!r.rowCount) throw new Error('staging row not found');
    row = r.rows[0];
    if (row.status !== 'pending') throw new Error(`status=${row.status}, only pending can be merged`);
    if (row.entity_type !== 'staff' || row.change_type !== 'new') {
      throw new Error('merge 僅支援 staff 的「新增」提案');
    }
    const p = row.payload_json || {};
    const targetCheck = await client.query(`SELECT id FROM admin_staff WHERE id = $1`, [targetEntityId]);
    if (!targetCheck.rowCount) throw new Error(`target_entity_id ${targetEntityId} 不存在`);
    await _assertStagedRagicStillFresh(row);

	    const newId = p.id || row.entity_id;
	    const ragicRecordId = p.ragic_record_id || null;
	    const incomingLineUid = p.line_uid ? String(p.line_uid).trim() : '';
	    await client.query(
	      `UPDATE admin_staff SET
	         id = $1, name = $2, phone = $3,
	         role = CASE WHEN $10::text = 'admin' THEN 'admin' ELSE role END,
	         active = CASE WHEN active_overridden_at IS NULL THEN $4 ELSE active END,
	         is_coach = $5, is_counter = $6, is_lifeguard = $7,
	         ragic_record_id = COALESCE($8, ragic_record_id),
	         line_uid = CASE WHEN NULLIF($9, '') IS NOT NULL THEN NULLIF($9, '') ELSE line_uid END,
	         last_synced_at = NOW()
	       WHERE id = $11`,
	      [newId, p.name || '', p.phone || '', !!p.is_active,
	       !!p.is_coach, !!p.is_counter, !!p.is_lifeguard, ragicRecordId, incomingLineUid, p.role || '', targetEntityId]
	    );
    if (p.role === 'admin') {
      await client.query(
        `UPDATE admin_users
            SET role = 'admin', updated_at = NOW()
          WHERE staff_id = $1 OR staff_id = $2`,
        [newId, targetEntityId]
      );
    }
    // admin_staff_venues.staff_id 已透過 ON UPDATE CASCADE 連動改成 newId，不需要另外處理。
    const coach = await client.query(`SELECT id FROM coaches WHERE ragic_employee_id = $1`, [targetEntityId]);
	    if (coach.rowCount) {
	      await client.query(
	        `UPDATE coaches SET ragic_employee_id = $1, ragic_record_id = COALESCE($2, ragic_record_id),
	           line_uid = COALESCE(line_uid, NULLIF($3, '')), updated_at = NOW()
	         WHERE id = $4`,
	        [newId, ragicRecordId, incomingLineUid, coach.rows[0].id]
	      );
	    }
    await client.query(
      `UPDATE ragic_staging_changes SET status = 'approved', reviewed_by = $2, reviewed_at = NOW() WHERE id = $1`,
      [stagingId, byUserId]
    );
    await client.query('COMMIT');
    return { merged_into: newId };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    err.stagingId = stagingId;
    if (row) {
      err.stagingEntityType = row.entity_type;
      err.stagingEntityId = row.entity_id;
    }
    throw err;
  } finally {
    client.release();
  }
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
  // P1.1「熊韋程 staff 事故」防線：pending 的 staff「新增」提案額外附上碰撞檢查結果，
  // 供待審核頁呈現「疑似同一人，建議合併」——只在 change_type==='new' 才需要檢查
  // （update/deactivate 一定是已知既有列，不會有「建出第二筆」的風險）。
  await Promise.all(r.rows.map(async (row) => {
    if (row.entity_type === 'staff' && row.change_type === 'new' && row.status === 'pending') {
      row.collision = await _findStaffCollision(row.payload_json || {});
    }
  }));
  return r.rows.map(_publicStagingRow);
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
      const msg = _syncErrorMessage(err, { localId: row.id });
      errors.push(msg);
      console.warn('[ragic-backup] parent sync failed (id=%s): %s', row.id, msg);
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
      const msg = _syncErrorMessage(err, { localId: row.id });
      errors.push(msg);
      console.warn('[ragic-backup] student sync failed (id=%s): %s', row.id, msg);
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

function _trueZ01LineUid(z01Row) {
  return getTrueRagicLineUid(z01Row);
}

function _sourceUpdatedTime(z01Row) {
  const raw = _pickZ01Raw(z01Row, ['109', '最後更新日期', '_update_date']);
  if (!raw) return { raw: '', iso: null };
  const m = raw.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (!m) return { raw, iso: null };
  const iso = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}` +
    `T${String(m[4] || 0).padStart(2, '0')}:${String(m[5] || 0).padStart(2, '0')}:${String(m[6] || 0).padStart(2, '0')}+08:00`;
  return Number.isNaN(new Date(iso).getTime()) ? { raw, iso: null } : { raw, iso };
}

function _safeDateForPreview(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
  if (!match) return null;
  const iso = `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
  return Number.isNaN(new Date(`${iso}T00:00:00+08:00`).getTime()) ? null : iso;
}

// 把一筆壞姓名（或已是真人但姓名仍壞）的 Z01 記錄，連同底下學員子表格，整份原始值
// upsert 進 Z03 人工整理表。刻意不經 mapZ01Parent/normalizeGender 之外的任何轉換
// （mapped.* 本身只有 trim + fallback key，沒有語意轉換，可以直接當「原始值」使用；
// 學員子表格改用 parseZ01StudentsRaw，避開 parseZ01Students 的 normalizeDate/toUpperCase）。
// status 只在非 'dismissed' 時重置為 'pending'：一旦人工判定誤判並忽略，往後排程刷新
// 不會又把它翻回待處理，除非真的重新指定。
async function _upsertZ03Record(client, ragicRecordId, mapped, z01Row, options = {}) {
  if (!ragicRecordId) {
    const err = new Error('Z01 source record 缺少 immutable record id');
    err.code = 'RAGIC_SOURCE_RECORD_ID_MISSING';
    throw err;
  }
  if (_trueZ01LineUid(z01Row)) {
    const err = new Error('真正 LINE UID 已存在的 Z01 record 不得進入 Z03');
    err.code = 'Z03_TRUE_LINE_UID_PRESENT';
    throw err;
  }

  // Historical tombstones previously made fetched source records disappear.
  // Keep the audit row, but surface it as manual_review instead of silently
  // skipping or deleting the source-derived Z03 record.
  const tomb = await client.query(
    `SELECT reason FROM ragic_z03_deleted_tombstones WHERE z01_ragic_record_id = $1 LIMIT 1`,
    [ragicRecordId]
  );
  const lineChatUrlRaw = _pickZ01Raw(z01Row, ['1002390', 'line對話網址']);
  const studentCountRaw = _pickZ01Raw(z01Row, ['1001138', '名下有幾位學生']);
  const phoneCanonical = normalizePhone(mapped.phone);
  const sourceUpdated = _sourceUpdatedTime(z01Row);
  const validMobile = isCanonicalMobilePhone(phoneCanonical);
  const initialStatus = tomb.rowCount || !validMobile ? 'manual_review' : 'pending';
  const reasonCode = options.reasonCode || (tomb.rowCount
    ? 'LEGACY_TOMBSTONE_RETAINED'
    : (!validMobile ? 'INVALID_CANONICAL_PHONE' : 'TRUE_LINE_UID_EMPTY'));
  const r = await client.query(
    `INSERT INTO ragic_z03_records
       (z01_ragic_record_id, raw_name, venue_raw, phone, identity_raw, gender_raw,
        email_raw, home_phone_raw, home_address_raw, line_id_raw, line_chat_url_raw,
        line_uid_raw, student_count_raw, status, fetched_at, phone_canonical,
        source_updated_at, source_updated_raw, classification, reason_code,
        claim_state, last_processed_at, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),$15,$16,$17,
             $18,$19,'UNRESOLVED',NOW(),COALESCE($20::uuid, gen_random_uuid()))
     ON CONFLICT (z01_ragic_record_id) DO UPDATE SET
       raw_name = EXCLUDED.raw_name, venue_raw = EXCLUDED.venue_raw, phone = EXCLUDED.phone,
       identity_raw = EXCLUDED.identity_raw, gender_raw = EXCLUDED.gender_raw,
       email_raw = EXCLUDED.email_raw, home_phone_raw = EXCLUDED.home_phone_raw,
       home_address_raw = EXCLUDED.home_address_raw, line_id_raw = EXCLUDED.line_id_raw,
       line_chat_url_raw = EXCLUDED.line_chat_url_raw, line_uid_raw = EXCLUDED.line_uid_raw,
       student_count_raw = EXCLUDED.student_count_raw,
       phone_canonical = EXCLUDED.phone_canonical,
       source_updated_at = EXCLUDED.source_updated_at,
       source_updated_raw = EXCLUDED.source_updated_raw,
       status = CASE
         WHEN ragic_z03_records.status = 'resolved' THEN 'resolved'
         WHEN ragic_z03_records.status IN ('manual_review', 'dismissed') THEN 'manual_review'
         ELSE EXCLUDED.status
       END,
       classification = CASE
         WHEN ragic_z03_records.status = 'resolved' THEN 'RESOLVED'
         WHEN ragic_z03_records.status IN ('manual_review', 'dismissed') THEN 'MANUAL_REVIEW'
         ELSE EXCLUDED.classification
       END,
       reason_code = CASE
         WHEN ragic_z03_records.status = 'resolved' THEN ragic_z03_records.reason_code
         WHEN ragic_z03_records.status IN ('manual_review', 'dismissed')
           THEN COALESCE(ragic_z03_records.reason_code, EXCLUDED.reason_code)
         ELSE EXCLUDED.reason_code
       END,
       fetched_at = NOW(), last_processed_at = NOW(),
       correlation_id = COALESCE(ragic_z03_records.correlation_id, EXCLUDED.correlation_id)
     RETURNING id,correlation_id`,
    [ragicRecordId, mapped.name || '', mapped.primary_venue_id || '', mapped.phone || '',
     mapped.identity || '', mapped.gender || '', mapped.email || '', mapped.home_phone || '',
     mapped.home_address || '', mapped.line_id || '', lineChatUrlRaw,
     '', studentCountRaw, initialStatus, phoneCanonical, sourceUpdated.iso,
     sourceUpdated.raw, initialStatus === 'manual_review' ? 'MANUAL_REVIEW' : 'PENDING_Z03',
     reasonCode, options.correlationId || null]
  );
  const z03Id = r.rows[0].id;
  const sourceStudents = ragic.parseZ01StudentsRaw(z01Row);
  await client.query(
    `UPDATE ragic_z03_students
        SET present_in_latest_payload = FALSE
      WHERE z03_record_id = $1`,
    [z03Id]
  );
  const normalizedCounts = new Map();
  for (const s of sourceStudents) {
    const key = normalizeStudentName(s.name_raw);
    if (key) normalizedCounts.set(key, (normalizedCounts.get(key) || 0) + 1);
  }
  for (let rowIndex = 0; rowIndex < sourceStudents.length; rowIndex++) {
    const s = sourceStudents[rowIndex];
    const normalizedName = normalizeStudentName(s.name_raw);
    const anyContent = [s.name_raw, s.birth_date_raw, s.gender_raw, s.id_number_raw,
      s.student_code_raw, s.registered_phone_raw].some((value) => String(value || '').trim());
    let classification = 'VALID';
    let studentReason = 'STUDENT_ROW_VALID';
    if (!anyContent) {
      classification = 'EMPTY_TEMPLATE_ROW';
      studentReason = 'EMPTY_TEMPLATE_ROW';
    } else if (!normalizedName) {
      classification = 'INVALID_ROW';
      studentReason = 'STUDENT_NAME_MISSING';
    } else if ((normalizedCounts.get(normalizedName) || 0) > 1) {
      classification = 'DUPLICATE_CANDIDATE';
      studentReason = 'DUPLICATE_STUDENT_NAME_IN_SOURCE';
    } else if (!String(s.birth_date_raw || '').trim()) {
      classification = 'INVALID_ROW';
      studentReason = 'STUDENT_BIRTH_DATE_MISSING';
    } else if (!_sourceUpdatedTime({ 109: s.birth_date_raw }).iso) {
      classification = 'INVALID_ROW';
      studentReason = 'STUDENT_BIRTH_DATE_INVALID';
    }
    const sourceRowKey = `${String(s.seq_raw || 'row').trim()}:${rowIndex}`;
    await client.query(
      `INSERT INTO ragic_z03_students
         (z03_record_id, seq_raw, student_status_raw, name_raw, birth_date_raw,
          gender_raw, id_number_raw, blood_type_raw, age_raw, student_code_raw,
          registered_phone_raw, source_row_key, name_normalized, classification,
          reason_code, present_in_latest_payload, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,TRUE,NOW())
       ON CONFLICT (z03_record_id, source_row_key) DO UPDATE SET
         seq_raw=EXCLUDED.seq_raw, student_status_raw=EXCLUDED.student_status_raw,
         name_raw=EXCLUDED.name_raw, birth_date_raw=EXCLUDED.birth_date_raw,
         gender_raw=EXCLUDED.gender_raw, id_number_raw=EXCLUDED.id_number_raw,
         blood_type_raw=EXCLUDED.blood_type_raw, age_raw=EXCLUDED.age_raw,
         student_code_raw=EXCLUDED.student_code_raw,
         registered_phone_raw=EXCLUDED.registered_phone_raw,
         name_normalized=EXCLUDED.name_normalized,
         classification=EXCLUDED.classification, reason_code=EXCLUDED.reason_code,
         present_in_latest_payload=TRUE, last_seen_at=NOW()`,
      [z03Id, s.seq_raw, s.student_status_raw, s.name_raw, s.birth_date_raw, s.gender_raw,
       s.id_number_raw, s.blood_type_raw, s.age_raw, s.student_code_raw, s.registered_phone_raw,
       sourceRowKey, normalizedName, classification, studentReason]
    );
  }
  if (!validMobile) {
    await createParentIdentityBackofficeTask({
      client,
      phone: mapped.phone || '',
      sourceRecordIds: [ragicRecordId],
      reasonCode: 'INVALID_CANONICAL_PHONE',
      suggestedAction: 'Correct the misplaced Ragic mobile field after source review; do not auto-link or create a duplicate family.',
      correlationId: r.rows[0].correlation_id,
    });
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

// P1.1 決策9：無腦 shadow 寫入——只呼叫 Ragic API + 完整性/schema-drift 把關，
// 不跑任何畢業判斷/quarantine/upsert 邏輯。這支是全系統「唯一」打 Z01 全量查詢的
// 地方，讓「打 Ragic」與「跑清洗邏輯」在程式碼上解耦：清洗邏輯之後再怎麼變慢/變複雜，
// 都不影響對 Ragic 的呼叫時程；也讓 ragic_z01_shadow 成為可獨立查驗的「Ragic 現況鏡像」。
// Phase 5：incremental=true 時走 ragic.getAllParentsChangedSinceWithFreshness（只抓
// watermark 之後有變更的列，見該函式與 _shadowPullH01Impl 頂部註解，理由相同）。
async function _fetchZ01ByFieldId({ incremental = false, watermark = null } = {}) {
  const pageSize = Number(process.env.RAGIC_PAGE_SIZE) || 200;
  const maxPages = Number(process.env.RAGIC_MAX_PAGES) || 50;
  const where = incremental && watermark
    ? `109,gte,${ragic.formatRagicDateTime(new Date(watermark))}`
    : undefined;
  const records = [];
  let naturalEnd = false;
  let firstPageIds = [];
  for (let page = 0; page < maxPages; page++) {
    const result = await ragic.fetchPage(FORMS.Z01, {
      limit: pageSize,
      offset: page * pageSize,
      where,
      order: '109,ASC',
      naming: 'EID',
    });
    if (page === 0) firstPageIds = result.rows.map((row) => String(row._ragicId || '')).filter(Boolean);
    records.push(...result.rows);
    if (result.count < pageSize) {
      naturalEnd = true;
      break;
    }
  }
  if (!naturalEnd) {
    const err = new Error('naming=EID fetch reached page limit');
    err.code = 'RAGIC_Z01_EID_TRUNCATED';
    throw err;
  }
  const boundary = await ragic.fetchPage(FORMS.Z01, {
    limit: pageSize,
    offset: 0,
    where,
    order: '109,ASC',
    naming: 'EID',
  });
  const allIds = new Set(records.map((row) => String(row._ragicId || '')).filter(Boolean));
  const boundaryMismatch = boundary.rows.some((row) => !allIds.has(String(row._ragicId || '')))
    || firstPageIds.some((id) => !allIds.has(id));
  if (boundaryMismatch) {
    const err = new Error('naming=EID boundary recheck mismatch');
    err.code = 'RAGIC_Z01_EID_BOUNDARY_MISMATCH';
    throw err;
  }
  return records;
}

async function _shadowPullZ01Impl({ incremental = false, watermark = null } = {}) {
  if (!ragicEnabled()) return { synced: 0, skipped: true };
  const useIncremental = !!(incremental && watermark);
  let integrity;
  let freshness = null;
  try {
    integrity = useIncremental
      ? await ragic.getAllParentsChangedSinceWithFreshness(watermark)
      : await ragic.getAllParentsWithIntegrityAndFreshness();
    freshness = integrity.freshness || null;
  } catch (err) {
    return { synced: 0, error: `Ragic Z01 ${useIncremental ? '增量' : '全量'}查詢失敗：${err.message}` };
  }
  if (integrity.stale_read) {
    await _alertFreshnessIfNeeded('Z01', freshness, integrity.error);
    return _withFreshness({ synced: 0, stale_read: true, error: integrity.error }, freshness);
  }
  await _alertFreshnessIfNeeded('Z01', freshness);
  if (!useIncremental) {
    const gateError = await _checkZ01IntegrityGate(integrity);
    if (gateError) return _withFreshness({ synced: 0, error: gateError }, freshness);
  }
  try {
    const eidRecords = await _fetchZ01ByFieldId({ incremental: useIncremental, watermark });
    const normalIds = new Set(integrity.records.map((row) => String(row?._ragicId || '')).filter(Boolean));
    const eidIds = new Set(eidRecords.map((row) => String(row?._ragicId || '')).filter(Boolean));
    const sameIds = normalIds.size === eidIds.size && [...normalIds].every((id) => eidIds.has(id));
    if (!sameIds) {
      return _withFreshness({
        synced: 0,
        error: `RAGIC_Z01_EID_SOURCE_SET_MISMATCH normal=${normalIds.size} eid=${eidIds.size}`,
      }, freshness);
    }
    integrity.records = eidRecords;
  } catch (err) {
    return _withFreshness({ synced: 0, error: `${err.code || 'RAGIC_Z01_EID_FETCH_FAILED'}: ${err.message}` }, freshness);
  }

  const client = await pool.connect();
  let synced = 0;
  try {
    await client.query('BEGIN');
    const presentIds = [];
    if (!useIncremental) {
      // Mark first, then mark fetched records present below. A partial/error run
      // rolls the whole transaction back, so an incomplete page set can never
      // make an old source look missing.
      await client.query(`UPDATE ragic_z01_shadow SET present_in_latest_pull = FALSE`);
    }
    for (const row of integrity.records) {
      if (ragic.isCanaryRecord(row, 'Z01')) continue;
      const ragicRecordId = row && row._ragicId != null ? String(row._ragicId) : null;
      if (!ragicRecordId) {
        const err = new Error('Ragic Z01 fetch 回傳一筆沒有 _ragicId 的 source record');
        err.code = 'RAGIC_SOURCE_RECORD_ID_MISSING';
        throw err;
      }
      presentIds.push(ragicRecordId);
      await client.query(
        `INSERT INTO ragic_z01_shadow
           (ragic_record_id, raw_data, fetched_at, last_seen_at, missing_since, present_in_latest_pull)
         VALUES ($1, $2::jsonb, NOW(), NOW(), NULL, TRUE)
         ON CONFLICT (ragic_record_id) DO UPDATE SET
           raw_data = EXCLUDED.raw_data,
           fetched_at = NOW(),
           last_seen_at = NOW(),
           missing_since = NULL,
           present_in_latest_pull = TRUE`,
        [ragicRecordId, JSON.stringify(row)]
      );
      synced++;
    }
    if (!useIncremental) {
      // Source history is never deleted. Missing is an observable state and is
      // only assigned after a complete, integrity-checked full pull.
      await client.query(
        `UPDATE ragic_z01_shadow
            SET missing_since = COALESCE(missing_since, NOW())
          WHERE NOT (ragic_record_id = ANY($1::text[]))
            AND present_in_latest_pull = FALSE`,
        [presentIds]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // ROLLBACK 已撤銷整個交易——回報實際持久化筆數 0，理由同 H01 shadow-pull 的同款修復。
    return _withFreshness({ synced: 0, error: `Shadow 寫入失敗：${err.message}` }, freshness);
  } finally {
    client.release();
  }
  return _withFreshness({ synced, incremental: useIncremental }, freshness);
}

async function _readShadowZ01(client) {
  const r = await client.query(
    `SELECT raw_data FROM ragic_z01_shadow WHERE present_in_latest_pull = TRUE`
  );
  return r.rows.map((row) => row.raw_data).filter((row) => !ragic.isCanaryRecord(row, 'Z01'));
}

function _z01SyncError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function _venueIdFromMap(venuesMap, value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (venuesMap.byId.has(raw)) return raw;
  return venuesMap.byName.get(raw) || null;
}

async function _recordZ01ImportReview({ ragicRecordId, mapped, code }) {
  const phoneCanonical = normalizePhone(mapped?.phone);
  await pool.query(
    `INSERT INTO identity_claims
       (purpose, state, phone_canonical, student_name_normalized,
        source_system, source_table, source_record_id, last_error_code)
     VALUES ('IMPORT_SOURCE', 'MANUAL_REVIEW', $1, '__import__', 'RAGIC', 'Z01', $2, $3)
     ON CONFLICT (purpose, source_system, source_table, source_record_id, student_name_normalized)
     DO UPDATE SET state = 'MANUAL_REVIEW', last_error_code = EXCLUDED.last_error_code,
                   version = identity_claims.version + 1, updated_at = NOW()`,
    [phoneCanonical, ragicRecordId, code]
  );
}

async function _syncCanonicalZ01Record(client, z01Row, mapped, venuesMap) {
  const ragicRecordId = String(mapped.ragic_record_id || z01Row?._ragicId || '').trim();
  const phoneCanonical = normalizePhone(mapped.phone);
  const lineUid = _trueZ01LineUid(z01Row);
  if (!ragicRecordId) throw _z01SyncError('RAGIC_SOURCE_RECORD_ID_MISSING', 'Z01 缺少 source record id');
  if (!lineUid) throw _z01SyncError('Z01_LINE_UID_MISSING', '正式 Z01 同步缺少真正 LINE UID');
  if (!phoneCanonical) throw _z01SyncError('INVALID_PHONE', '真正 LINE UID 已存在，但手機無法 canonicalize');

  // One lock order for every formal Z01 import: canonical phone first, source
  // record second. This serializes same-family records without relying on the
  // mutable Ragic record id as the parent identity key.
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [
    `canonical-parent:${phoneCanonical}`,
    `ragic-z01:${ragicRecordId}`,
  ]);

  const linked = (await client.query(
    `SELECT * FROM source_record_links
      WHERE source_system = 'RAGIC' AND source_table = 'Z01' AND source_record_id = $1
      FOR UPDATE`,
    [ragicRecordId]
  )).rows[0] || null;
  const phoneRows = (await client.query(
    `SELECT * FROM parents
      WHERE phone = $1 OR regexp_replace(COALESCE(phone,''), '\\D', '', 'g') = $1
      ORDER BY created_at, id
      FOR UPDATE`,
    [phoneCanonical]
  )).rows;
  if (phoneRows.length > 1) {
    throw _z01SyncError('DUPLICATE_PARENT_IDENTITY', 'canonical phone 命中多個 parent');
  }
  const uidParent = (await client.query(
    `SELECT * FROM parents WHERE line_uid = $1 FOR UPDATE`, [lineUid]
  )).rows[0] || null;

  const candidateIds = new Set([
    linked?.canonical_parent_id,
    phoneRows[0]?.id,
    uidParent?.id,
  ].filter(Boolean).map(String));
  if (candidateIds.size > 1) {
    throw _z01SyncError('MEMBER_MERGE_REQUIRED', 'source link、canonical phone 與 LINE UID 指向不同 parent');
  }
  let parent = linked
    ? (await client.query(`SELECT * FROM parents WHERE id = $1 FOR UPDATE`, [linked.canonical_parent_id])).rows[0]
    : (uidParent || phoneRows[0] || null);

  if (uidParent && parent && uidParent.id !== parent.id) {
    throw _z01SyncError('PHONE_BOUND_TO_OTHER_UID', 'LINE UID 已屬於另一個 canonical parent');
  }
  if (uidParent && !parent) {
    if (normalizePhone(uidParent.phone) !== phoneCanonical) {
      throw _z01SyncError('PHONE_BOUND_TO_OTHER_UID', 'LINE UID 與 incoming canonical phone 不一致');
    }
    parent = uidParent;
  }
  if (parent?.line_uid && parent.line_uid !== lineUid) {
    throw _z01SyncError('PHONE_BOUND_TO_OTHER_UID', 'canonical phone 已綁另一個 LINE UID');
  }

  const venueId = _venueIdFromMap(venuesMap, mapped.primary_venue_id);
  if (!parent) {
    parent = (await client.query(
      `INSERT INTO parents
         (phone, name, line_uid, primary_venue_id, gender, email, ragic_record_id,
          identity, home_phone, home_address, line_id, is_active, last_synced_at)
       VALUES ($1,$2,$3,$4,NULLIF($5,''),NULLIF($6,''),$7,NULLIF($8,''),
               NULLIF($9,''),NULLIF($10,''),NULLIF($11,''),TRUE,NOW())
       RETURNING *`,
      [phoneCanonical, mapped.name || '未命名家長', lineUid, venueId,
       ragic.normalizeGender(mapped.gender), mapped.email || '', ragicRecordId,
       mapped.identity || '', mapped.home_phone || '', mapped.home_address || '', mapped.line_id || '']
    )).rows[0];
  } else {
    parent = (await client.query(
      `UPDATE parents SET
         phone = $2,
         name = COALESCE(NULLIF($3,''), name),
         line_uid = COALESCE(line_uid, $4),
         primary_venue_id = COALESCE($5, primary_venue_id),
         gender = COALESCE(NULLIF($6,''), gender),
         email = COALESCE(NULLIF($7,''), email),
         ragic_record_id = COALESCE(ragic_record_id, NULLIF($8,'')),
         identity = COALESCE(NULLIF($9,''), identity),
         home_phone = COALESCE(NULLIF($10,''), home_phone),
         home_address = COALESCE(NULLIF($11,''), home_address),
         line_id = COALESCE(NULLIF($12,''), line_id),
         is_active = TRUE, last_synced_at = NOW(), updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [parent.id, phoneCanonical, mapped.name || '', lineUid, venueId,
       ragic.normalizeGender(mapped.gender), mapped.email || '', ragicRecordId,
       mapped.identity || '', mapped.home_phone || '', mapped.home_address || '', mapped.line_id || '']
    )).rows[0];
  }

  if (linked && linked.canonical_parent_id !== parent.id) {
    throw _z01SyncError('SOURCE_ALREADY_CLAIMED', 'source record 已連結另一個 parent');
  }
  await client.query(
    `INSERT INTO source_record_links
       (source_system, source_table, source_record_id, canonical_parent_id, link_method)
     VALUES ('RAGIC','Z01',$1,$2,'TRUE_LINE_UID_IMPORT')
     ON CONFLICT (source_system, source_table, source_record_id) DO UPDATE SET
       canonical_parent_id = EXCLUDED.canonical_parent_id,
       link_method = EXCLUDED.link_method,
       updated_at = NOW()`,
    [ragicRecordId, parent.id]
  );

  // Exact normalized name inside this canonical family only. National ID is
  // retained in the source mirror but never used as a match/merge key here.
  const rawStudentRows = ragic.parseZ01StudentsRaw(z01Row);
  const studentIssues = [];
  for (const raw of rawStudentRows) {
    const anyContent = [raw.name_raw, raw.birth_date_raw, raw.gender_raw, raw.id_number_raw,
      raw.student_code_raw].some((value) => String(value || '').trim());
    if (!anyContent) studentIssues.push({ code: 'EMPTY_TEMPLATE_ROW', source_row_id: raw.seq_raw || null });
    else if (!normalizeStudentName(raw.name_raw)) studentIssues.push({ code: 'STUDENT_NAME_MISSING', source_row_id: raw.seq_raw || null });
  }
  const sourceStudents = ragic.parseZ01Students(z01Row);
  const sourceNameCounts = new Map();
  for (const s of sourceStudents) {
    const key = normalizeStudentName(s.name);
    if (key) sourceNameCounts.set(key, (sourceNameCounts.get(key) || 0) + 1);
  }
  const existingStudents = (await client.query(
    `SELECT * FROM students WHERE parent_id = $1 ORDER BY created_at, id FOR UPDATE`, [parent.id]
  )).rows;
  const syncedStudentIds = [];
  for (const s of sourceStudents) {
    const normalizedName = normalizeStudentName(s.name);
    if (!normalizedName) {
      studentIssues.push({ code: 'STUDENT_NAME_MISSING', source_row_id: s.seq_raw || null });
      continue;
    }
    if (sourceNameCounts.get(normalizedName) > 1) {
      studentIssues.push({ code: 'AMBIGUOUS_STUDENT_MATCH', name: normalizedName });
      continue;
    }
    const matches = existingStudents.filter((row) => normalizeStudentName(row.name) === normalizedName);
    if (matches.length > 1) {
      studentIssues.push({ code: 'AMBIGUOUS_STUDENT_MATCH', name: normalizedName });
      continue;
    }
    let student = matches[0] || null;
    const birthDate = /^\d{4}-\d{2}-\d{2}$/.test(String(s.birth_date || '')) ? s.birth_date : null;
    if (student) {
      student = (await client.query(
        `UPDATE students SET
           name = $2,
           birth_date = COALESCE($3::date, birth_date),
           gender = COALESCE(NULLIF($4,''), gender),
           blood_type = COALESCE(NULLIF($5,''), blood_type),
           student_code = COALESCE(NULLIF($6,''), student_code),
           is_active = TRUE, last_synced_at = NOW(), updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [student.id, s.name, birthDate, ragic.normalizeGender(s.gender), s.blood_type || '', s.student_code || '']
      )).rows[0];
    } else {
      student = (await client.query(
        `INSERT INTO students
           (parent_id, name, birth_date, gender, blood_type, student_code, is_active, last_synced_at)
         VALUES ($1,$2,$3::date,NULLIF($4,''),NULLIF($5,''),NULLIF($6,''),TRUE,NOW())
         RETURNING *`,
        [parent.id, s.name, birthDate, ragic.normalizeGender(s.gender), s.blood_type || '', s.student_code || '']
      )).rows[0];
      existingStudents.push(student);
    }
    syncedStudentIds.push(student.id);
  }
  if (syncedStudentIds.length === 1) {
    await client.query(
      `UPDATE source_record_links SET canonical_student_id = $2, updated_at = NOW()
        WHERE source_system='RAGIC' AND source_table='Z01' AND source_record_id=$1`,
      [ragicRecordId, syncedStudentIds[0]]
    );
  }
  return { parent, syncedStudentIds, studentIssues };
}

async function reconcileZ01BlankUidCoverage(clientOrPool = pool) {
  const rows = (await clientOrPool.query(
    `SELECT s.ragic_record_id, s.raw_data, z.status
       FROM ragic_z01_shadow s
       LEFT JOIN ragic_z03_records z ON z.z01_ragic_record_id = s.ragic_record_id
      ORDER BY s.ragic_record_id`
  )).rows;
  const blankRows = rows.filter((row) => !_trueZ01LineUid(row.raw_data));
  const allowed = new Set(['pending', 'resolved', 'manual_review']);
  const missingSourceIds = blankRows.filter((row) => !row.status).map((row) => row.ragic_record_id);
  const invalidStatusSourceIds = blankRows
    .filter((row) => row.status && !allowed.has(row.status))
    .map((row) => row.ragic_record_id);
  return {
    blank_uid_source_count: blankRows.length,
    accounted_count: blankRows.length - missingSourceIds.length - invalidStatusSourceIds.length,
    missing_source_count: missingSourceIds.length,
    invalid_status_count: invalidStatusSourceIds.length,
    missing_source_ids: missingSourceIds,
    invalid_status_source_ids: invalidStatusSourceIds,
    pass: missingSourceIds.length === 0 && invalidStatusSourceIds.length === 0,
  };
}

async function reconcileZ01SourceCoverage(clientOrPool = pool) {
  const r = await clientOrPool.query(
    `WITH source AS (
       SELECT ragic_record_id
         FROM ragic_z01_shadow
        WHERE present_in_latest_pull = TRUE
     ), classified AS (
       SELECT s.ragic_record_id,
         CASE
           WHEN l.id IS NOT NULL THEN 'LINKED_LOCAL_Z01'
           WHEN z.id IS NOT NULL AND z.status IN ('pending','manual_review')
             THEN CASE WHEN z.status='manual_review' THEN 'MANUAL_REVIEW' ELSE 'PENDING_Z03' END
           WHEN z.id IS NOT NULL AND z.status='dismissed' THEN 'EXPLICIT_IGNORED'
           WHEN c.state = 'MANUAL_REVIEW' THEN 'MANUAL_REVIEW'
           WHEN c.state = 'SYNC_BLOCKED_SCHEMA' THEN 'ERROR_NON_RETRYABLE'
           WHEN c.state = 'SYNC_FAILED_RETRYABLE' THEN 'ERROR_RETRYABLE'
           WHEN c.id IS NOT NULL THEN 'PENDING_RECONCILIATION'
           WHEN z.id IS NOT NULL THEN 'PENDING_RECONCILIATION'
           WHEN t.z01_ragic_record_id IS NOT NULL THEN 'EXPLICIT_IGNORED'
           ELSE 'MISSING'
         END AS classification
       FROM source s
       LEFT JOIN source_record_links l
         ON l.source_system='RAGIC' AND l.source_table='Z01'
        AND l.source_record_id=s.ragic_record_id
       LEFT JOIN ragic_z03_records z ON z.z01_ragic_record_id=s.ragic_record_id
       LEFT JOIN LATERAL (
         SELECT id,state FROM identity_claims
          WHERE source_system='RAGIC' AND source_table='Z01'
            AND source_record_id=s.ragic_record_id
          ORDER BY updated_at DESC,id LIMIT 1
       ) c ON TRUE
       LEFT JOIN ragic_z03_deleted_tombstones t ON t.z01_ragic_record_id=s.ragic_record_id
     )
     SELECT classification, COUNT(*)::int AS count,
            ARRAY_AGG(ragic_record_id ORDER BY ragic_record_id)
              FILTER (WHERE classification='MISSING') AS missing_ids
       FROM classified GROUP BY classification`,
  );
  const counts = Object.fromEntries(r.rows.map((row) => [row.classification, row.count]));
  const fetched = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);
  const missingRow = r.rows.find((row) => row.classification === 'MISSING');
  return {
    fetched_count: fetched,
    linked_local_z01_count: counts.LINKED_LOCAL_Z01 || 0,
    pending_z03_count: counts.PENDING_Z03 || 0,
    pending_reconciliation_count: counts.PENDING_RECONCILIATION || 0,
    manual_review_count: counts.MANUAL_REVIEW || 0,
    ignored_count: counts.EXPLICIT_IGNORED || 0,
    retryable_error_count: counts.ERROR_RETRYABLE || 0,
    non_retryable_error_count: counts.ERROR_NON_RETRYABLE || 0,
    missing_source_count: counts.MISSING || 0,
    missing_source_ids: missingRow?.missing_ids || [],
    pass: !counts.MISSING,
  };
}

async function findZ01SourcesByTrueLineUid(lineUid, clientOrPool = pool) {
  const uid = String(lineUid || '').trim();
  if (!uid) return [];
  return (await clientOrPool.query(
    `SELECT raw_data FROM ragic_z01_shadow
      WHERE present_in_latest_pull=TRUE AND raw_data->>'1006846'=$1
      ORDER BY ragic_record_id`, [uid]
  )).rows.map((row) => row.raw_data);
}

async function findZ01SourcesByPhone(phone, clientOrPool = pool) {
  const phoneCanonical = normalizePhone(phone);
  if (!isCanonicalMobilePhone(phoneCanonical)) return [];
  return (await clientOrPool.query(
    `SELECT raw_data FROM ragic_z01_shadow
      WHERE present_in_latest_pull=TRUE
        AND regexp_replace(COALESCE(raw_data->>'1001100',''),'\\D','','g') IN ($1,$2)
      ORDER BY ragic_record_id`,
    [phoneCanonical, `886${phoneCanonical.slice(1)}`]
  )).rows.map((row) => row.raw_data);
}

async function findZ01SourcesByPhoneStudent(phone, studentName, clientOrPool = pool) {
  const phoneCanonical = normalizePhone(phone);
  const studentNameNormalized = normalizeStudentName(studentName);
  if (!phoneCanonical || !studentNameNormalized) return [];
  return (await findZ01SourcesByPhone(phoneCanonical, clientOrPool)).filter((raw) =>
    ragic.parseZ01StudentsRaw(raw).some((student) =>
      normalizeStudentName(student.name_raw) === studentNameNormalized
    )
  );
}

async function reingestZ01Record(z01Row, { dryRun = true } = {}) {
  const mapped = ragic.mapZ01Parent(z01Row);
  const ragicRecordId = String(mapped?.ragic_record_id || z01Row?._ragicId || '').trim();
  if (!ragicRecordId) throw _z01SyncError('RAGIC_SOURCE_RECORD_ID_MISSING', 'Z01 source record id 必填');
  const trueLineUid = _trueZ01LineUid(z01Row);
  const phoneCanonical = normalizePhone(mapped.phone);
  const validMobile = isCanonicalMobilePhone(phoneCanonical);
  const target = trueLineUid ? 'LINKED_LOCAL_Z01' : (validMobile ? 'PENDING_Z03' : 'MANUAL_REVIEW');
  const current = (await pool.query(
    `SELECT
       (SELECT status FROM ragic_z03_records WHERE z01_ragic_record_id=$1) AS z03_status,
       (SELECT canonical_parent_id FROM source_record_links
         WHERE source_system='RAGIC' AND source_table='Z01' AND source_record_id=$1) AS linked_parent_id,
       (SELECT COUNT(*)::int FROM parents
         WHERE phone=$2 OR regexp_replace(COALESCE(phone,''), '\\D', '', 'g')=$2) AS phone_parent_count,
       (SELECT COUNT(*)::int FROM parents WHERE ragic_record_id=$1) AS source_parent_count,
       (SELECT COUNT(*)::int FROM parents WHERE line_uid=$3) AS uid_parent_count`,
    [ragicRecordId, phoneCanonical, trueLineUid || `__blank__:${ragicRecordId}`]
  )).rows[0];
  const rawStudents = ragic.parseZ01StudentsRaw(z01Row);
  const normalizedCounts = new Map();
  rawStudents.forEach((row) => {
    const key = normalizeStudentName(row.name_raw);
    if (key) normalizedCounts.set(key, (normalizedCounts.get(key) || 0) + 1);
  });
  const studentRows = rawStudents.map((row, index) => {
    const nameNormalized = normalizeStudentName(row.name_raw);
    const anyContent = [row.name_raw, row.birth_date_raw, row.gender_raw, row.id_number_raw,
      row.student_code_raw].some((value) => String(value || '').trim());
    let validation = 'VALID';
    let reasonCode = 'STUDENT_ROW_VALID';
    if (!anyContent) { validation = 'EMPTY_TEMPLATE_ROW'; reasonCode = 'EMPTY_TEMPLATE_ROW'; }
    else if (!nameNormalized) { validation = 'INVALID_ROW'; reasonCode = 'STUDENT_NAME_MISSING'; }
    else if ((normalizedCounts.get(nameNormalized) || 0) > 1) {
      validation = 'DUPLICATE_CANDIDATE'; reasonCode = 'DUPLICATE_STUDENT_NAME_IN_SOURCE';
    } else if (!String(row.birth_date_raw || '').trim()) {
      validation = 'INVALID_ROW'; reasonCode = 'STUDENT_BIRTH_DATE_MISSING';
    }
    return {
      source_row_id: row.seq_raw || String(index),
      student_name_normalized: nameNormalized,
      birth_date_parse_state: String(row.birth_date_raw || '').trim() ? (_safeDateForPreview(row.birth_date_raw) ? 'PARSED' : 'INVALID') : 'MISSING',
      gender_mapping_state: String(row.gender_raw || '').trim() ? 'PRESENT' : 'MISSING',
      national_id_present: Boolean(String(row.id_number_raw || '').trim()),
      student_number_present: Boolean(String(row.student_code_raw || '').trim()),
      validation,
      reason_code: reasonCode,
    };
  });
  const preview = {
    dry_run: !!dryRun,
    source_record_id: ragicRecordId,
    true_line_uid_present: Boolean(trueLineUid),
    canonical_phone_present: Boolean(phoneCanonical),
    canonical_phone_masked: phoneCanonical ? maskPhone(phoneCanonical) : null,
    target,
    reason_code: trueLineUid ? 'TRUE_LINE_UID_PRESENT' : (validMobile ? 'TRUE_LINE_UID_EMPTY' : 'INVALID_CANONICAL_PHONE'),
    line_chat_url_present: Boolean(_pickZ01Raw(z01Row, ['1002390'])),
    current,
    student_source_row_count: rawStudents.length,
    student_rows: studentRows,
  };
  if (dryRun) return preview;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (!trueLineUid) {
      await _upsertZ03Record(client, ragicRecordId, mapped, z01Row);
    } else {
      const venuesMap = await parentSync.loadVenuesMap(client);
      const result = await _syncCanonicalZ01Record(client, z01Row, mapped, venuesMap);
      await client.query(
        `UPDATE ragic_z03_records SET
           status='resolved', classification='LINKED_LOCAL_Z01', reason_code='TRUE_LINE_UID_PRESENT',
           claim_state='SYNCED', canonical_parent_id=$2, last_error_code=NULL,
           resolved_at=COALESCE(resolved_at,NOW()), resolved_by=COALESCE(resolved_by,'z01-reingest'),
           last_processed_at=NOW()
         WHERE z01_ragic_record_id=$1`,
        [ragicRecordId, result.parent.id]
      );
      preview.canonical_parent_id = result.parent.id;
      preview.canonical_student_ids = result.syncedStudentIds;
      preview.student_issues = result.studentIssues;
    }
    await client.query('COMMIT');
    return { ...preview, dry_run: false, applied: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function _reconcileZ01FromShadowImpl() {
  const reader = await pool.connect();
  let records;
  try {
    records = await _readShadowZ01(reader);
  } catch (err) {
    return { synced: 0, staged_z03: 0, error: `讀取 ragic_z01_shadow 失敗：${err.message}` };
  } finally {
    reader.release();
  }

  const client = await pool.connect();
  let linkedLocalZ01 = 0;
  let stagedZ03 = 0;
  let manualReview = 0;
  const errors = [];
  try {
    const venuesMap = await parentSync.loadVenuesMap(client);
    for (const z01Row of records) {
      const mapped = ragic.mapZ01Parent(z01Row);
      const ragicRecordId = String(mapped?.ragic_record_id || z01Row?._ragicId || '').trim();
      if (!ragicRecordId) {
        errors.push('RAGIC_SOURCE_RECORD_ID_MISSING');
        continue;
      }

      // Sole split rule: only the exact frozen LINE UID field participates.
      // No phone/name completeness, chat URL, account text, or display status
      // can send a blank-UID source away from Z03.
      const trueLineUid = _trueZ01LineUid(z01Row);
      try {
        await client.query('BEGIN');
        if (!trueLineUid) {
          await _upsertZ03Record(client, ragicRecordId, mapped, z01Row);
          await client.query('COMMIT');
          stagedZ03++;
          continue;
        }

        const synced = await _syncCanonicalZ01Record(client, z01Row, mapped, venuesMap);
        await client.query(
          `UPDATE ragic_z03_records
              SET status = 'resolved', classification = 'LINKED_LOCAL_Z01',
                  reason_code = 'TRUE_LINE_UID_PRESENT', claim_state = 'SYNCED',
                  canonical_parent_id = $2, last_error_code = NULL,
                  resolved_at = COALESCE(resolved_at, NOW()),
                  resolved_by = COALESCE(resolved_by, 'z01-reconcile'),
                  last_processed_at = NOW()
            WHERE z01_ragic_record_id = $1 AND status <> 'resolved'`,
          [ragicRecordId, synced.parent.id]
        );
        await client.query('COMMIT');
        linkedLocalZ01++;

        if (synced.studentIssues.length) {
          manualReview++;
          await _recordZ01ImportReview({
            ragicRecordId,
            mapped,
            code: synced.studentIssues[0].code,
          });
        }
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        const code = err.code || 'LOCAL_TRANSACTION_FAILED';
        manualReview++;
        await _recordZ01ImportReview({ ragicRecordId, mapped, code }).catch((reviewErr) => {
          errors.push(`${ragicRecordId}:REVIEW_WRITE_FAILED:${reviewErr.code || 'ERROR'}`);
        });
        // A source that now has a true UID must not remain in the active Z03
        // pending queue. Preserve any historical row for audit and route the
        // conflict through identity_claims.MANUAL_REVIEW instead.
        if (trueLineUid) {
          try {
            await pool.query(
              `UPDATE ragic_z03_records
                  SET status = 'resolved', classification = 'MIGRATED_OUT_OF_Z03',
                      reason_code = 'TRUE_LINE_UID_PRESENT_WITH_CONFLICT',
                      claim_state = 'MANUAL_REVIEW', last_error_code = $2,
                      resolved_at = COALESCE(resolved_at, NOW()),
                      resolved_by = COALESCE(resolved_by, 'z01-reconcile'),
                      last_processed_at = NOW()
                WHERE z01_ragic_record_id = $1`,
              [ragicRecordId, code]
            );
          } catch (reviewUpdateErr) {
            errors.push(`${ragicRecordId}:Z03_REVIEW_WRITE_FAILED:${reviewUpdateErr.code || 'ERROR'}`);
          }
        }
      }
    }
  } finally {
    client.release();
  }

  const coverage = await reconcileZ01SourceCoverage().catch((err) => ({
    pass: false,
    missing_source_count: -1,
    error: err.message,
  }));
  if (!coverage.pass) {
    errors.push(`Z01_COVERAGE_INCOMPLETE:missing=${coverage.missing_source_count}`);
  }

  const result = {
    fetched_count: coverage.fetched_count ?? records.length,
    linked_local_z01_count: coverage.linked_local_z01_count ?? linkedLocalZ01,
    pending_z03_count: coverage.pending_z03_count ?? stagedZ03,
    pending_reconciliation_count: coverage.pending_reconciliation_count ?? 0,
    manual_review_count: coverage.manual_review_count ?? manualReview,
    ignored_count: coverage.ignored_count ?? 0,
    retryable_error_count: coverage.retryable_error_count ?? 0,
    non_retryable_error_count: coverage.non_retryable_error_count ?? 0,
    synced: coverage.linked_local_z01_count ?? linkedLocalZ01,
    staged_z03: coverage.pending_z03_count ?? stagedZ03,
    coverage,
  };
  return errors.length
    ? { ...result, partial: true, error: `${errors.length} 筆/項未完成：${errors[0]}` }
    : result;
}

// Retained temporarily for audit comparison only. It is deliberately not
// exported or called: it contains the superseded three-condition split and
// destructive sweep behavior that Z01 split v2 disables.
async function _reconcileZ01FromShadowLegacyDisabled() {
  throw _z01SyncError('DESTRUCTIVE_RECONCILE_DISABLED', 'legacy Z01 reconcile 已永久停用');
  const client0 = await pool.connect();
  let records;
  try {
    records = await _readShadowZ01(client0);
  } catch (err) {
    return { synced: 0, error: `讀取 ragic_z01_shadow 失敗：${err.message}` };
  } finally {
    client0.release();
  }

  let synced = 0;
  let quarantinedZ03 = 0;
  const errors = [];
  const client = await pool.connect();
  try {
    const venuesMap = await parentSync.loadVenuesMap(client);
    const studentsByPhone = await parentSync.loadStudentsByParentPhone(client);
    const boundPhones = await parentSync.loadBoundPhones(client);
    // 「電話對上」檢查用的反向表：UID → 本地已綁定的電話。
    const uidToPhone = new Map();
    for (const [phone, uid] of boundPhones) uidToPhone.set(uid, phone);
    // P1.1 決策5掃尾用：本次 Ragic 完整快照裡「所有」出現過的 ragic_record_id
    // （不限已畢業/已綁 UID 的列，只要 Ragic 端還有這筆記錄就算存在）。
    const presentRagicIds = [...new Set(
      records.map((r) => (r && r._ragicId != null ? String(r._ragicId) : null)).filter(Boolean)
    )];
    const ragicUidPhones = new Map();
    for (const z01Row of records) {
      const mapped = ragic.mapZ01Parent(z01Row);
      const uid = String(mapped.line_uid || '').trim();
      const phoneDigits = _digits(mapped.phone);
      if (!uid || uid.startsWith('demo:') || uid.startsWith('DEMOTEST_') || !phoneDigits) continue;
      const phones = ragicUidPhones.get(uid) || new Set();
      phones.add(phoneDigits);
      ragicUidPhones.set(uid, phones);
    }

    for (const z01Row of records) {
      const mapped = ragic.mapZ01Parent(z01Row);
      if (!mapped.phone) continue; // 沒電話無法比對，且 upsertLocalParent 本身也會拒絕
      const ragicRecordId = mapped.ragic_record_id ? String(mapped.ragic_record_id) : String(z01Row._ragicId || '');
      // ── 分流規則（Z01＝登入核心來源）──────────────────────────────────
      // 畢業（進本地 Z01/Z02 鏡像）採「三必備條件」（2026-07-03 資料流向定案）：
      //   1. UID 有回寫 —— Ragic「家教系統uid」已是真實 LINE UID（demo:/DEMOTEST_ 不算）；
      //   2. 電話對上 —— 記錄有電話，且該 UID 沒有被本地「另一支電話」綁走
      //      （同 UID 掛兩支電話＝資料衝突，寧可留在 Z03 由人工/登入流程收斂）；
      //   3. 家長姓名不等於電話 —— 姓名非空且不是電話佔位（isPlaceholderParentName）。
      // 三者滿足即自行畢業回寫本地 Z01 鏡像；其餘欄位（Email/性別/身分/館別）缺漏
      // 不再擋畢業，由家長端個資頁／夜間同步後續補齊。
      // 未達成者一律只進 Z03 整理佇列，不進 parents/students。
      // 本 pull job 只讀取 Ragic、比對分類、同步畢業者；不可在背景回寫 Ragic。
      const hasRealUid = Boolean(
        mapped.line_uid &&
        !mapped.line_uid.startsWith('demo:') &&
        !mapped.line_uid.startsWith('DEMOTEST_')
      );
      const phoneDigits = _digits(mapped.phone);
      const boundPhoneOfUid = hasRealUid ? uidToPhone.get(mapped.line_uid) : undefined;
      const boundPhoneDigits = _digits(boundPhoneOfUid);
      const uidPhonesInRagic = hasRealUid ? ragicUidPhones.get(mapped.line_uid) : null;
      const uidHasMultipleRagicPhones = Boolean(uidPhonesInRagic && uidPhonesInRagic.size > 1);
      const phoneMatches = Boolean(phoneDigits) &&
        !uidHasMultipleRagicPhones &&
        (!boundPhoneDigits || boundPhoneDigits === phoneDigits);
      const nameIsReal = Boolean(mapped.name) && !isPlaceholderParentName(mapped.name);
      const isIncomplete = !(hasRealUid && phoneMatches && nameIsReal);

      try {
        if (isIncomplete) {
          // 殘缺/未開通 → 只進 Z03，不建立/更新 parents/students。
          // _upsertZ03Record 會把歷史 tombstone 轉成 manual_review；不得讓
          // source 消失，也不得清除既有本地 UID 或破壞既有 session。
          await client.query('BEGIN');
          await _upsertZ03Record(client, ragicRecordId, mapped, z01Row);
          await client.query('COMMIT');
          quarantinedZ03++;
          continue;
        }

        // 完成記錄（必填齊全＋已綁 UID）→ 同步進本地 Z01/Z02 鏡像。
        await client.query('BEGIN');
        const local = await parentSync.upsertLocalParent(client, mapped, mapped.line_uid || null, {
          reactivate: false,
          venuesMap,
          // 夜間全量 pull：本地未回寫 Ragic 的編輯（last_synced_at IS NULL）保留，
          // 不被 Ragic 舊值覆蓋（P1.1 決策1/2、嫌疑6 lost-update）。
          preservePending: true,
        });
        if (hasRealUid && local.line_uid !== mapped.line_uid) {
          await _upsertZ03Record(client, ragicRecordId, mapped, z01Row);
          await client.query('COMMIT');
          quarantinedZ03++;
          continue;
        }
        const students = ragic.parseZ01Students(z01Row);
        await parentSync.upsertLocalStudents(client, local.id, students, {
          authoritative: true,
          existingStudents: studentsByPhone.get(mapped.phone) || [],
        });
        // 已完成 → 若先前卡在 Z03 待處理，這裡自動畢業（dismissed 忽略列不受影響）。
        await _resolveZ03IfPending(client, ragicRecordId, mapped.name);
        await client.query('COMMIT');
        uidToPhone.set(mapped.line_uid, mapped.phone);
        boundPhones.set(mapped.phone, mapped.line_uid);
        synced++;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        const msg = _syncErrorMessage(err, { ragicId: z01Row._ragicId });
        errors.push(msg);
        console.warn('[ragic-pull] parent sync failed (ragicId=%s): %s', z01Row._ragicId, msg);
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

    // ── P1.1 決策5掃尾：本地已綁定家長，若已不在本次 Ragic 完整快照裡 → 刪除 ──
    // 前提：本函式已通過 _checkZ01IntegrityGate（fetched 未截斷、無邊界位移、無
    // schema-drift）才會執行到這裡，「快照裡沒有」才具備刪除的正當性；只有 Ragic
    // 資料才是核心，本地可自由做任何應刪除（決策5）。preservePending 的列（本地尚
    // 有未回寫 Ragic 的編輯）跳過不刪——刪除不可逆，比一般 UPDATE 更需保守。
    // 有業務 FK 的記錄跳過不動，保留業務資料完整性；硬邊界：只動本地 DB。
    try {
      await client.query('BEGIN');
      const absent = await client.query(
        `SELECT id FROM parents
          WHERE ragic_record_id IS NOT NULL
            AND NOT (ragic_record_id = ANY($1::text[]))
            AND last_synced_at IS NOT NULL`,
        [presentRagicIds]
      );
      let deletedAbsent = 0;
      for (const row of absent.rows) {
        const deleted = await parentSync.hardDeleteParentIfSafe(client, row.id);
        if (deleted) deletedAbsent++;
      }
      if (deletedAbsent) {
        console.log('[ragic-pull] 決策5掃尾：Ragic 完整快照已無此記錄，硬刪除 %d 筆（有 FK 者保留）', deletedAbsent);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      errors.push(`Ragic 快照缺席掃尾失敗：${err.message}`);
      console.warn('[ragic-pull] Ragic 快照缺席掃尾失敗:', err.message);
    }
  } finally {
    client.release();
  }

  return errors.length
    ? { synced, quarantined: quarantinedZ03, error: `${errors.length} 筆同步失敗（詳見伺服器 log）：${errors[0]}` }
    : { synced, quarantined: quarantinedZ03 };
}

// 對外維持原函式名/簽名不變（FORM_META.pull、cron、admin 手動觸發皆呼叫這支，
// 完全不需要跟著改）：內部改為「先無腦寫 shadow，再從 shadow 清洗」兩步驟。
// shadow-pull 失敗（含完整性/schema-drift hard-fail）就不進 reconcile，
// 避免拿不完整/過期的 shadow 資料跑清洗邏輯。
// Phase 5：手動觸發且已有 watermark 時走增量（理由同 _syncStaffImpl 頂部註解）；
// watermark 只在整輪成功才推進。
async function _pullParentsStudentsImpl(triggeredBy = 'cron') {
  const watermark = await getSyncWatermark(FORM_META.pull.code);
  const useIncremental = triggeredBy === 'manual' && !!watermark;
  const runStartedAt = new Date();
  const shadowResult = await _shadowPullZ01Impl({ incremental: useIncremental, watermark });
  if (shadowResult.skipped) return shadowResult;
  if (shadowResult.error) {
    return _withFreshness(
      { synced: 0, stale_read: !!shadowResult.stale_read, error: `[shadow-pull] ${shadowResult.error}`, incremental: useIncremental },
      _freshnessFromResult(shadowResult)
    );
  }
  const reconciled = await _reconcileZ01FromShadowImpl();
  const combined = { ...reconciled, incremental: useIncremental };
  if (!combined.error && !combined.partial && !shadowResult.stale_read) {
    await setSyncWatermark(FORM_META.pull.code, runStartedAt).catch((err) => {
      console.warn('[Ragic sync] Z01 watermark 寫入失敗（不影響本輪同步結果）:', err.message);
    });
  }
  return _withFreshness(combined, _freshnessFromResult(shadowResult));
}

async function pullParentsStudentsFromRagic(triggeredBy = 'cron') { return _singleflight('pull', triggeredBy); }

// ─────────────────────────────────────────────────────────────
// Z03 人工整理表 — 後台 API 用（列表 / 本地修正草稿 / 寫回 Ragic / 忽略）
// 資料本身由 _pullParentsStudentsImpl 的 Z03 分流邏輯灌入，這裡只負責讀取與人工動作。
// ─────────────────────────────────────────────────────────────
const Z03_RECORD_UPDATE_FIELDS = [
  'raw_name',
  'venue_raw',
  'phone',
  'identity_raw',
  'gender_raw',
  'email_raw',
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
    // Staging display data is never an identity credential. Canonical UID is
    // read only from raw Ragic field 1006846 before a source enters Z03.
    line_uid: '',
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
    // 登記電話：綁定/註冊流程的「學員姓名＋登記手機」多方驗證用
    // （parentSync.classifyStudentPhoneClaim 讀 registered_phone，缺值退回比對家長電話）。
    registered_phone: _cleanText(row.registered_phone_raw, 30),
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
    ['gender', '性別'],
  ];
  for (const [key, label] of required) {
    if (!String(parent[key] || '').trim()) missing.push({ key, label });
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

async function _loadZ03RecordByRagicId(ragicRecordId) {
  if (!ragicRecordId) return null;
  const record = (await pool.query(
    `SELECT * FROM ragic_z03_records WHERE z01_ragic_record_id = $1 LIMIT 1`,
    [String(ragicRecordId)]
  )).rows[0];
  if (!record) return null;
  const students = (await pool.query(
    `SELECT * FROM ragic_z03_students WHERE z03_record_id = $1 ORDER BY seq_raw, id`,
    [record.id]
  )).rows;
  return {
    row: { ...record, students },
    parent: _z03ParentFromRow(record),
    students: students.map(_z03StudentFromRow).filter((s) => s.name),
  };
}

/**
 * 註冊/綁定流程用：以電話在本地 Z03 佇列（ragic_z03_records）尋找未開通記錄。
 * 資料流向定案（2026-07-03）：填完電話 → 比對本地 Z01 → 沒資料才來 Z03 核對，
 * 兩處都不在熱路徑打 Ragic。比對同時接受「原字串相等」與「去非數字後相等」
 * （Ragic 端電話可能帶 - / 空白等格式符號）。
 * 回傳 { row, parent, students }（parent/students 已轉成 mapZ01Parent/認領驗證可用的形狀），
 * 查無回 null。只取 pending；resolved 是歷史畢業列，不應再攔截綁定/註冊熱路徑。
 */
async function findZ03RecordByPhone(phone) {
  const phoneCanonical = normalizePhone(phone);
  if (!phoneCanonical) return null;
  const r = await pool.query(
    `SELECT * FROM ragic_z03_records
      WHERE status = 'pending'
        AND (phone_canonical = $1
          OR phone = $2
          OR regexp_replace(COALESCE(phone,''), '\\D', '', 'g') = $1)
      ORDER BY fetched_at DESC, id`,
    [phoneCanonical, String(phone || '').trim()]
  );
  if (r.rowCount > 1) {
    const err = new Error('同一 canonical phone 命中多筆 active Z03 family，禁止 LIMIT 1');
    err.code = 'MANUAL_REVIEW_REQUIRED';
    err.reason = 'AMBIGUOUS_Z03_FAMILY';
    err.z03Ids = r.rows.map((row) => row.id);
    throw err;
  }
  const row = r.rows[0];
  if (!row) return null;
  const students = (await pool.query(
    `SELECT * FROM ragic_z03_students WHERE z03_record_id = $1 ORDER BY seq_raw, id`,
    [row.id]
  )).rows;
  return {
    row: { ...row, students },
    parent: _z03ParentFromRow(row),
    students: students.map(_z03StudentFromRow).filter((s) => s.name),
  };
}

/**
 * 註冊熱路徑用：Ragic 仍查得到、但本地 Z03 尚未被排程拉入時，自動把該筆讀入 Z03。
 * 這是 read-only hydrate；真正回寫 Ragic 只發生在家長完成註冊驗證後。
 */
async function hydrateZ03RecordFromRagicRow(z01Row) {
  if (!z01Row) return null;
  const mapped = ragic.mapZ01Parent(z01Row);
  const ragicRecordId = mapped.ragic_record_id ? String(mapped.ragic_record_id) : String(z01Row._ragicId || '');
  if (!mapped.phone || !ragicRecordId) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await _upsertZ03Record(client, ragicRecordId, mapped, z01Row);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  try {
    const pending = await findZ03RecordByPhone(mapped.phone);
    return pending || _loadZ03RecordByRagicId(ragicRecordId);
  } catch (err) {
    if (err.code !== 'MANUAL_REVIEW_REQUIRED') throw err;
    return _loadZ03RecordByRagicId(ragicRecordId);
  }
}

function _studentMatchesRegistration(z03Student, formStudent) {
  const zId = String(z03Student?.id_number || '').trim().toUpperCase();
  const fId = String(formStudent?.id_number || '').trim().toUpperCase();
  if (zId && fId && zId === fId) return true;
  return String(z03Student?.name || '').trim() === String(formStudent?.name || '').trim();
}

function _newStudentsForZ03Registration(z03Students, formStudents) {
  return (formStudents || []).filter((s) =>
    !(z03Students || []).some((existing) => _studentMatchesRegistration(existing, s)));
}

async function _markZ03RegistrationResolved(z03Id, { parent, students, lineUid, actor }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = (await client.query(
      `SELECT * FROM ragic_z03_records WHERE id = $1 FOR UPDATE`,
      [z03Id]
    )).rows[0];
    if (!current) throw new Error('找不到這筆 Z03 記錄');

    await client.query(
      `UPDATE ragic_z03_records
          SET raw_name = $2,
              phone = $3,
              venue_raw = $4,
              identity_raw = $5,
              gender_raw = $6,
              email_raw = $7,
              line_uid_raw = $8,
              status = 'resolved',
              fixed_name = $2,
              resolved_at = NOW(),
              resolved_by = $9,
              fetched_at = NOW()
        WHERE id = $1`,
      [
        z03Id,
        _cleanText(parent?.name, 120),
        _cleanText(parent?.phone, 30),
        _cleanText(parent?.primary_venue_id, 120),
        _cleanText(parent?.identity || '一般身分', 80),
        _cleanText(parent?.gender, 30),
        _cleanText(parent?.email, 255),
        _cleanText(lineUid, 160),
        actor || 'parent-register-line',
      ]
    );

    const existingRows = (await client.query(
      `SELECT * FROM ragic_z03_students WHERE z03_record_id = $1 ORDER BY seq_raw, id`,
      [z03Id]
    )).rows;
    const usedRowIds = new Set();
    let nextSeq = existingRows.length + 1;

    for (const s of students || []) {
      const match = existingRows.find((row) => {
        if (usedRowIds.has(row.id)) return false;
        return _studentMatchesRegistration(_z03StudentFromRow(row), s);
      });
      if (match) {
        usedRowIds.add(match.id);
        await client.query(
          `UPDATE ragic_z03_students
              SET name_raw = $3,
                  birth_date_raw = $4,
                  gender_raw = $5,
                  id_number_raw = $6,
                  blood_type_raw = $7,
                  registered_phone_raw = COALESCE(NULLIF(registered_phone_raw, ''), $8)
            WHERE id = $1 AND z03_record_id = $2`,
          [
            match.id,
            z03Id,
            _cleanText(s.name, 100),
            _cleanText(s.birth_date, 30),
            _cleanText(s.gender, 30),
            _cleanText(s.id_number, 30).toUpperCase(),
            _cleanText(s.blood_type, 20),
            _cleanText(parent?.phone, 30),
          ]
        );
      } else {
        await client.query(
          `INSERT INTO ragic_z03_students
             (z03_record_id, seq_raw, student_status_raw, name_raw, birth_date_raw,
              gender_raw, id_number_raw, blood_type_raw, age_raw, student_code_raw, registered_phone_raw)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            z03Id,
            String(nextSeq++),
            '01.一般生',
            _cleanText(s.name, 100),
            _cleanText(s.birth_date, 30),
            _cleanText(s.gender, 30),
            _cleanText(s.id_number, 30).toUpperCase(),
            _cleanText(s.blood_type, 20),
            '',
            '',
            _cleanText(parent?.phone, 30),
          ]
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 家長註冊命中本地 Z03 後的「補資料 → 回寫 Ragic → Z03 畢業」。
 * 回寫 Ragic 使用既有 found→update helper，避免同電話重複建 Z01；本地 Z03 更新
 * 是 audit/狀態收斂，不阻擋已驗證使用者後續 refresh。
 */
async function completeZ03Registration({ z03, parent, students = [], lineUid, actor = 'parent-register-line' }) {
  const disabled = new Error('Z03 認領必須使用 local-first claim + transactional outbox');
  disabled.code = 'LOCAL_FIRST_CLAIM_REQUIRED';
  throw disabled;
  if (!z03?.row) throw new Error('Z03 註冊需要 z03.row');
  const existing = {
    ...(z03.parent || {}),
    ragic_record_id: String(z03.parent?.ragic_record_id || z03.row.z01_ragic_record_id || '').trim(),
  };
  if (!existing.ragic_record_id) {
    const err = new Error('Z03 記錄缺少 Ragic Z01 record id');
    err.code = 'PARENT_RAGIC_RECORD_REQUIRED';
    throw err;
  }

  const z03Students = z03.students || [];
  const newStudents = _newStudentsForZ03Registration(z03Students, students);
  const wantNameFix = !existing.name || isPlaceholderParentName(existing.name);
  const nameToWrite = (wantNameFix && !isPlaceholderParentName(parent?.name)) ? parent.name : '';
  const resolvedParent = {
    ...parent,
    name: nameToWrite || existing.name || parent.name,
    phone: parent.phone || existing.phone,
    gender: existing.gender || parent.gender || null,
    email: existing.email || parent.email || null,
    primary_venue_id: (existing.primary_venue_id && existing.primary_venue_id !== '待補登')
      ? existing.primary_venue_id
      : (parent.primary_venue_id || null),
    identity: existing.identity || parent.identity || '一般身分',
  };

  await ragic.completeParentOnRegisterInRagic({
    existing,
    parent: resolvedParent,
    students: newStudents,
    lineUid,
    nameToWrite,
  });

  try {
    await _markZ03RegistrationResolved(z03.row.id, { parent: resolvedParent, students, lineUid, actor });
  } catch (err) {
    console.warn('[ragic-z03] 註冊已回寫 Ragic，但本地 Z03 resolved 標記失敗:', err.message);
    return { linked_existing: true, z03_updated: false, new_students: newStudents.length, z03_update_error: err.message };
  }
  return { linked_existing: true, z03_updated: true, new_students: newStudents.length };
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
    const textPatternParam = vals.length;
    parts.push(`COALESCE(raw_name, '') ILIKE $${textPatternParam} ESCAPE '\\'`);
    parts.push(`COALESCE(fixed_name, '') ILIKE $${textPatternParam} ESCAPE '\\'`);
    parts.push(`COALESCE(z01_ragic_record_id, '') ILIKE $${textPatternParam} ESCAPE '\\'`);
    parts.push(`COALESCE(phone_canonical, '') ILIKE $${textPatternParam} ESCAPE '\\'`);
    parts.push(`COALESCE(canonical_parent_id::text, '') ILIKE $${textPatternParam} ESCAPE '\\'`);
    parts.push(`COALESCE(correlation_id::text, '') ILIKE $${textPatternParam} ESCAPE '\\'`);
    parts.push(`EXISTS (
      SELECT 1 FROM ragic_z03_students zs
       WHERE zs.z03_record_id = ragic_z03_records.id
         AND COALESCE(zs.name_raw, '') ILIKE $${textPatternParam} ESCAPE '\\'
    )`);
    parts.push(`EXISTS (
      SELECT 1 FROM identity_claims ic
       WHERE ic.source_system = 'RAGIC'
         AND ic.source_table = 'Z01'
         AND ic.source_record_id = ragic_z03_records.z01_ragic_record_id
         AND (ic.id::text ILIKE $${textPatternParam} ESCAPE '\\'
           OR COALESCE(ic.phone_canonical, '') ILIKE $${textPatternParam} ESCAPE '\\')
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
  };

  // 若本地 Z03 已有 LINE UID（家長登入後自動寫入），一併回寫 Ragic Z01。
  // 不寫則每日 01:00 pull 讀到 Ragic 仍無 UID → 再次被分流回 Z03 → 永遠卡住。
  // upsertParentStrict 的條件：`payloadLineUid || !ragicRecordId` → 需在 payload
  // 裡明確帶上 UID 它才會寫入（有 ragicRecordId 的更新不自動補 UID）。
  const realUid = parent.line_uid &&
    !parent.line_uid.startsWith('demo:') &&
    !parent.line_uid.startsWith('DEMOTEST_')
    ? parent.line_uid : '';
  if (realUid) payload[ragic.FIELD.Z01.LINE_UID] = realUid;

  await ragic.upsertParentStrict(payload, parent.ragic_record_id);

  for (const student of students) {
    await ragic.updateStudentFromZ03Strict({ parent, student });
  }

  let refreshed = null;
  let upgraded = false;
  if (parent.line_uid && !parent.line_uid.startsWith('demo:') && !parent.line_uid.startsWith('DEMOTEST_')) {
    const parentRefresh = require('./parentRefresh');
    refreshed = await parentRefresh.refreshParentMirrorFromRagic({
      lineUid: parent.line_uid,
      phone: parent.phone,
      minStudents: students.length,
      reason: 'admin-z03-upgrade',
    });
    upgraded = true;
  }

  await pool.query(
    `UPDATE ragic_z03_records
        SET status = 'resolved', fixed_name = $2, resolved_at = NOW(), resolved_by = $3
      WHERE id = $1`,
    [row.id, parent.name, adminUsername || null]
  );

  return { upgraded, synced_to_ragic: true, missing: [], refreshed };
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
        SET status = 'manual_review', classification = 'MANUAL_REVIEW',
            reason_code = 'ADMIN_DISMISSED', claim_state = 'MANUAL_REVIEW',
            resolved_at = NOW(), resolved_by = $2, last_processed_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [id, adminUsername || null]
  )).rows[0];
  if (!updated) throw new Error('找不到這筆 Z03 記錄');
  return updated;
}

/**
 * Z03 強制刪除（含 tombstone，防止下次 Ragic 同步復活）：
 *  - 交易內先讀出這筆的 z01_ragic_record_id，寫入 ragic_z03_deleted_tombstones，
 *    再刪掉 ragic_z03_records 本列；ragic_z03_students 由既有 FK
 *    （z03_record_id ... ON DELETE CASCADE）自動連帶刪除，不需額外語句。
 *  - 之後每次 _upsertZ03Record 都會先查 tombstone 表，命中即整筆跳過，
 *    來源 Ragic Z01 記錄本身完全不動。
 */
async function deleteZ03Record(id, { adminUsername = null, reason = null } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query(
      `SELECT * FROM ragic_z03_records WHERE id = $1 FOR UPDATE`, [id]
    )).rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      throw new Error('找不到這筆 Z03 記錄');
    }
    const updated = (await client.query(
      `UPDATE ragic_z03_records SET
         status='manual_review', classification='MANUAL_REVIEW',
         reason_code='ADMIN_ARCHIVE_REQUESTED', claim_state='MANUAL_REVIEW',
         last_error_code=NULL, resolved_at=COALESCE(resolved_at,NOW()),
         resolved_by=$2, last_processed_at=NOW()
       WHERE id=$1 RETURNING *`,
      [id, adminUsername || null]
    )).rows[0];
    await client.query('COMMIT');
    return {
      id,
      z01_ragic_record_id: row.z01_ragic_record_id,
      archived: true,
      status: updated.status,
      reason: reason || null,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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
  if (!(await hasRecentFreshPull())) {
    const msg = `Z01 quarantine/ghost 掃描缺少最近 ${FRESH_SHADOW_MAX_AGE_HOURS} 小時內的 freshness_verified pull，已中止，避免使用過期 shadow`;
    await _alertAdmins(`【Ragic stale_read】${msg}`);
    return { synced: 0, stale_read: true, error: msg, freshness_verified: false, stale_retries: 0 };
  }
  // P1.1 決策9：改讀 ragic_z01_shadow（由當晚 #2 pull 的 _shadowPullZ01Impl 維護），
  // 不再獨立重打一次 Ragic 全量查詢——同一份快照給多個消費者用，減少對 Ragic 的
  // 重複呼叫。完整性/schema-drift 把關已經在寫入 shadow 那一關做過。
  let records;
  try {
    const client0 = await pool.connect();
    try {
      records = await _readShadowZ01(client0);
    } finally {
      client0.release();
    }
  } catch (err) {
    return { synced: 0, error: `讀取 ragic_z01_shadow 失敗：${err.message}` };
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
      // 使用者回報修復：同 _reconcileZ01FromShadowImpl 的 tombstone 檢查——admin
      // 已主動決定永久排除這筆 Ragic record（例如 purge-ghosts），就不要因為姓名
      // 判斷又把他寫回 quarantine「黑名單」。
      const tomb = await pool.query(
        `SELECT 1 FROM ragic_z03_deleted_tombstones WHERE z01_ragic_record_id = $1 LIMIT 1`,
        [String(z01Row._ragicId)]
      );
      if (tomb.rowCount) continue;

      // 同 _upsertZ03Record 的理由：ON CONFLICT 鍵是 z01_ragic_record_id，Ragic 換發
      // 新 ID 時會留舊列變孤兒。先清掉同電話、不同 ID 的未解決列，已 resolved 的歷史不動。
      if (mapped.phone) {
        await pool.query(
          `DELETE FROM ragic_z01_quarantine
            WHERE phone = $1 AND z01_ragic_record_id <> $2 AND resolved_at IS NULL`,
          [mapped.phone, String(z01Row._ragicId)]
        );
      }
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
      const msg = _syncErrorMessage(err, { ragicId: z01Row._ragicId });
      errors.push(msg);
      console.warn('[ragic-quarantine] track failed (ragicId=%s): %s', z01Row._ragicId, msg);
    }
  }

  // 決策(P1.1 #10，2026-07-07 定案，won't-do)：Ragic 端 Z01→Z03 表單 push 不做。
  // 職責劃分：RAGIC PULL 只管無腦 pull，本地 REPLIT 做資料清洗——quarantine 維持
  // 本地 ragic_z01_quarantine/ragic_z03_records 追蹤，不反向寫回 Ragic 端 Z03 表單。
  const note = `偵測到 ${tier1Count} 筆姓名疑似為電話號碼（另有 ${tier2Count} 筆不含中文字，僅統計未觸發）；本地追蹤，不推送 Ragic Z03（決策 won't-do）`;
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

// 哪些 job 真的會打 Ragic HTTP（見上表 impl 實作）——quarantine 只讀本地
// ragic_z01_shadow，不打 Ragic，故不需要（也不應該）搶 'ragic_sync' 全域鎖，
// 否則會被無關的 Ragic 忙碌狀態無謂卡住。
const RAGIC_LOCKED_JOBS = new Set(['staff', 'venues', 'parents', 'students', 'backup', 'pull']);
const MANUAL_RAGIC_LOCK_WAIT_MS = Number(process.env.RAGIC_MANUAL_LOCK_WAIT_MS || 10 * 60 * 1000);
const MANUAL_RAGIC_LOCK_POLL_MS = Number(process.env.RAGIC_MANUAL_LOCK_POLL_MS || 1500);

const LIVE_PROBE_FORMS = {
  h01: { label: 'H01 員工 API', env: 'RAGIC_FORM_H01' },
  h23: { label: 'H23 新生/基本資料 API', env: 'RAGIC_FORM_H23' },
  h05: { label: 'H05 場館 API', env: 'RAGIC_FORM_H05' },
  z01: { label: 'Z01 家長 API', env: 'RAGIC_FORM_Z01' },
  z02: { label: 'Z02 學員 API', env: 'RAGIC_FORM_Z02' },
};
const LIVE_PROBE_TTL_MS = Number(process.env.RAGIC_STATUS_PROBE_TTL_MS) || 60000;
let _liveProbeCache = null;
let _liveProbeCacheAt = 0;

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

// ── Phase 5（docs/ragic_sync_audit.md）：增量同步 watermark ──
// 存 admin_settings（key=ragic_watermark_<formCode>，value = epoch 毫秒；同一張表
// NUMERIC 欄位存不了 ISO 字串，用毫秒數最單純）。watermark 只在整輪成功（無 error、
// 非 partial、非 stale_read）才推進，且推進到「這輪開始拉取的時間」而非「完成的
// 時間」——寧可下次增量多重覆蓋一點時間範圍，也不要因為拉取期間又有新變更、
// 而把 watermark 推到漏掉那筆變更的時間點之後。
function _watermarkKey(formCode) { return `ragic_watermark_${formCode}`; }

async function getSyncWatermark(formCode) {
  const r = await pool.query(`SELECT value FROM admin_settings WHERE key = $1`, [_watermarkKey(formCode)]);
  if (!r.rows.length) return null;
  const ms = Number(r.rows[0].value);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms);
}

async function setSyncWatermark(formCode, date) {
  await pool.query(
    `INSERT INTO admin_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [_watermarkKey(formCode), date.getTime()]
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
 * 相容既有 cron 呼叫名稱，但 backup 已降級為 observation，不再是 pull gate。
 * 入站 Z01 是獨立的 source-discovery plane；本地→Ragic 寫入失敗只能告警，
 * 不得讓下一輪唯讀 pull 跳過，否則來源會在本地持續不可見。
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
  if (r.rowCount === 0) {
    console.warn('[ragic-pull] Z01_Z02_BACKUP_MISSING: inbound pull remains enabled (windowHours=%s)', windowHours);
  }
  return true;
}

async function hasRecentFreshPull(windowHours = FRESH_SHADOW_MAX_AGE_HOURS) {
  const r = await pool.query(
    `SELECT 1 FROM ragic_sync_log
      WHERE form_code = 'Z01_Z02_PULL'
        AND status = 'ok'
        AND freshness_verified = TRUE
        AND created_at >= NOW() - ($1 || ' hours')::interval
      LIMIT 1`,
    [windowHours]
  );
  return r.rowCount > 0;
}

async function _logSyncResult(jobName, formCode, result, durationMs, triggeredBy) {
  // 嫌疑4 CONFIRMED 修復：staff/venues 迴圈改 per-record 隔離後，「部分成功」需要
  // 獨立於 ok/error 的狀態，不能把「已完成的進度」塌成單純 error（會誤導成整輪都沒做）。
  const status = result?.skipped
    ? 'skipped'
    : (result?.stale_read ? 'stale_read' : (result?.partial ? 'partial' : (result?.error ? 'error' : 'ok')));
  try {
    await pool.query(
      `INSERT INTO ragic_sync_log
         (form_code, job_name, status, synced_count, error_message, duration_ms,
          freshness_verified, freshness_latency_ms, stale_retries, freshness_nonce, triggered_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        formCode,
        jobName,
        status,
        result?.synced || 0,
        result?.error || null,
        durationMs,
        result?.freshness_verified ?? null,
        result?.freshness_latency_ms ?? null,
        result?.stale_retries || 0,
        result?.freshness_nonce || null,
        triggeredBy,
      ]
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
  if (RAGIC_LOCKED_JOBS.has(jobName)) {
    // 全域 Ragic 帳號租約：所有觸發路徑（cron、kickoffSync*Async、admin 手動
    // /sync）最終都走這裡，故單一把關點即可保證同一時間對 Ragic 帳號只有一個
    // in-flight 請求。搶不到鎖不是錯誤——只是另一個 Ragic job 正在跑，記一筆
    // skipped 讓下一輪 cron（10 分鐘後）或使用者重新手動觸發即可，不需要重試。
    const lockOptions = String(triggeredBy) === 'manual'
      ? { triggeredBy, waitMs: MANUAL_RAGIC_LOCK_WAIT_MS, pollMs: MANUAL_RAGIC_LOCK_POLL_MS }
      : { triggeredBy };
    const outcome = await cronLock.runWithLock('ragic_sync', () => meta.impl(triggeredBy), lockOptions);
    if (outcome.status === 'skipped_lock') {
      const waitedSeconds = Math.round((outcome.waitedMs || 0) / 1000);
      result = {
        synced: 0,
        skipped: true,
        locked_by_other_ragic_job: true,
        current_holder: outcome.currentHolder,
        error: String(triggeredBy) === 'manual'
          ? `等待 Ragic 同步鎖 ${waitedSeconds} 秒後仍未取得；目前由 ${outcome.currentHolder || 'unknown'} 執行中，請稍後再試。`
          : null,
      };
    } else if (outcome.status === 'success') {
      result = outcome.result;
    } else {
      result = { synced: 0, error: outcome.error };
    }
  } else {
    try {
      result = await meta.impl(triggeredBy);
    } catch (err) {
      result = { synced: 0, error: err.message };
    }
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
    RAGIC_FORM_H23: !!FORMS.H23,
    RAGIC_FORM_H05: !!process.env.RAGIC_FORM_H05,
    RAGIC_FORM_Z01: !!process.env.RAGIC_FORM_Z01,
    RAGIC_FORM_Z02: !!process.env.RAGIC_FORM_Z02,
  };
}

async function getLiveRagicProbeSnapshot() {
  if (_liveProbeCache && Date.now() - _liveProbeCacheAt < LIVE_PROBE_TTL_MS) {
    return { ..._liveProbeCache, cached: true };
  }
  const checkedAt = new Date();
  const env = getRagicEnvFlags();
  const canProbe = env.RAGIC_API_KEY && env.RAGIC_BASE_URL;
  const forms = {};
  await Promise.all(Object.entries(LIVE_PROBE_FORMS).map(async ([key, meta]) => {
    const formPath = process.env[meta.env] || (meta.env === 'RAGIC_FORM_H23' ? FORMS.H23 : '');
    const base = {
      label: meta.label,
      env: meta.env,
      configured: !!formPath,
      checked_at: checkedAt.toISOString(),
    };
    if (!canProbe) {
      forms[key] = { ...base, status: 'skipped', ok: false, error: 'RAGIC_API_KEY / RAGIC_BASE_URL 未完整設定' };
      return;
    }
    if (!formPath) {
      forms[key] = { ...base, status: 'missing_env', ok: false, error: `${meta.env} 未設定` };
      return;
    }
    try {
      const probe = await ragic.probeForm(formPath);
      forms[key] = {
        ...base,
        status: probe.ok ? 'ok' : 'empty',
        ok: probe.ok,
        empty: probe.empty,
        record_count: probe.count,
        duration_ms: probe.duration_ms,
      };
    } catch (err) {
      forms[key] = {
        ...base,
        status: 'error',
        ok: false,
        error: err.message || String(err),
      };
    }
  }));
  const snapshot = {
    checked_at: checkedAt.toISOString(),
    cached: false,
    ok: Object.values(forms).every((item) => item.ok),
    forms,
  };
  _liveProbeCache = snapshot;
  _liveProbeCacheAt = Date.now();
  return snapshot;
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
      `SELECT status, synced_count, error_message, duration_ms, created_at, triggered_by,
              freshness_verified, freshness_latency_ms, stale_retries
         FROM ragic_sync_log WHERE form_code = $1 ORDER BY created_at DESC LIMIT 1`,
      [meta.code]
    );
    const lastOk = await pool.query(
      `SELECT synced_count, duration_ms, created_at,
              freshness_verified, freshness_latency_ms, stale_retries
         FROM ragic_sync_log WHERE form_code = $1 AND status = 'ok'
         ORDER BY created_at DESC LIMIT 1`,
      [meta.code]
    );
    const freshnessTrend = await pool.query(
      `SELECT created_at, freshness_verified, freshness_latency_ms, stale_retries, status
         FROM ragic_sync_log
        WHERE form_code = $1
          AND created_at >= NOW() - INTERVAL '7 days'
          AND (freshness_verified IS NOT NULL OR status = 'stale_read')
        ORDER BY created_at ASC
        LIMIT 200`,
      [meta.code]
    );
    const stale7d = freshnessTrend.rows.filter((row) => row.status === 'stale_read' || row.freshness_verified === false).length;
    // Phase 5：有 watermark 代表下次「手動」觸發會走增量（cron 排程仍固定全量）。
    const watermark = await getSyncWatermark(meta.code).catch(() => null);
    out[job] = {
      form_code: meta.code,
      label: meta.label,
      kind: meta.kind || 'sync',
      admin_enabled:         toggles[job],
      in_progress:           isJobRunning(job),
      incremental_watermark_at: watermark ? watermark.toISOString() : null,
      next_manual_sync_mode: watermark ? 'incremental' : 'full',
      last_run_at:           latest.rows[0]?.created_at      || null,
      last_status:           latest.rows[0]?.status          || null,
      last_triggered_by:     latest.rows[0]?.triggered_by    || null,
      last_error:            latest.rows[0]?.error_message   || null,
      last_run_count:        latest.rows[0]?.synced_count ?? null,
      last_run_duration_ms:  latest.rows[0]?.duration_ms  ?? null,
      freshness_verified:    latest.rows[0]?.freshness_verified ?? null,
      freshness_latency_ms:  latest.rows[0]?.freshness_latency_ms ?? null,
      stale_retries:         latest.rows[0]?.stale_retries ?? 0,
      stale_read_7d_count:   stale7d,
      freshness_7d:          freshnessTrend.rows.map((row) => ({
        at: row.created_at,
        verified: row.freshness_verified,
        latency_ms: row.freshness_latency_ms,
        stale_retries: row.stale_retries || 0,
        status: row.status,
      })),
      last_success_at:       lastOk.rows[0]?.created_at      || null,
      last_success_count:    lastOk.rows[0]?.synced_count ?? null,
      last_success_duration_ms: lastOk.rows[0]?.duration_ms  ?? null,
      last_success_freshness_latency_ms: lastOk.rows[0]?.freshness_latency_ms ?? null,
      // 向後相容欄位（保留舊鍵；前端持續可用，含義仍以 success 為準）
      last_count:       lastOk.rows[0]?.synced_count ?? null,
      last_duration_ms: lastOk.rows[0]?.duration_ms  ?? null,
    };
  }
  return out;
}

function _extractWebhookRecordIds(body) {
  if (Array.isArray(body)) return body.map((v) => String(v || '').trim()).filter(Boolean);
  const out = [];
  const add = (v) => {
    const s = String(v || '').trim();
    if (s) out.push(s);
  };
  for (const item of (Array.isArray(body?.data) ? body.data : [])) {
    add(item?._ragicId || item?.ragicId || item?.id);
  }
  add(body?._ragicId || body?.ragicId || body?.id || body?.nodeId || body?.recordId);
  return [...new Set(out)];
}

function _webhookFormPath(sheetCode) {
  const code = String(sheetCode || '').trim().toUpperCase();
  if (code === 'H01') return process.env.RAGIC_FORM_H01;
  if (code === 'H05') return process.env.RAGIC_FORM_H05;
  if (code === 'Z01') return process.env.RAGIC_FORM_Z01;
  if (code === 'Z02') return process.env.RAGIC_FORM_Z02;
  return null;
}

async function _deleteWebhookShadow(client, sheetCode, ragicRecordId) {
  if (sheetCode === 'H01') {
    await client.query(
      `DELETE FROM ragic_h01_shadow
        WHERE ragic_record_id = $1 OR raw_data->>'_ragicId' = $1 OR raw_data->>'ragicId' = $1`,
      [ragicRecordId]
    );
  } else if (sheetCode === 'Z01') {
    await client.query(
      `UPDATE ragic_z01_shadow
          SET present_in_latest_pull=FALSE,
              missing_since=COALESCE(missing_since,NOW())
        WHERE ragic_record_id=$1`,
      [ragicRecordId]
    );
  } else if (sheetCode === 'H05') {
    await client.query(
      `DELETE FROM ragic_h05_shadow
        WHERE raw_data->>'_ragicId' = $1 OR raw_data->>'ragicId' = $1`,
      [ragicRecordId]
    );
  }
}

async function _upsertWebhookShadow(client, sheetCode, row) {
  if (!row || ragic.isCanaryRecord(row, sheetCode)) return false;
  const rid = row._ragicId != null ? String(row._ragicId) : String(row.ragicId || '');
  if (sheetCode === 'H01') {
    const shadowKey = _h01ShadowKey(row, 0, new Set());
    const ragicDataNo = _h01DataNo(row) || null;
    await client.query(
      `INSERT INTO ragic_h01_shadow (ragic_record_id, ragic_data_no, raw_data, fetched_at)
       VALUES ($1, $2, $3::jsonb, NOW())
       ON CONFLICT (ragic_record_id) DO UPDATE SET
         ragic_data_no = EXCLUDED.ragic_data_no,
         raw_data = EXCLUDED.raw_data,
         fetched_at = NOW()`,
      [shadowKey, ragicDataNo, JSON.stringify(row)]
    );
    return true;
  }
  if (sheetCode === 'Z01') {
    if (!rid) return false;
    await client.query(
      `INSERT INTO ragic_z01_shadow (ragic_record_id, raw_data, fetched_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (ragic_record_id) DO UPDATE SET raw_data = EXCLUDED.raw_data, fetched_at = NOW()`,
      [rid, JSON.stringify(row)]
    );
    return true;
  }
  if (sheetCode === 'H05') {
    const v = _mapRagicVenue(row);
    if (!v?.code) return false;
    await client.query(
      `INSERT INTO ragic_h05_shadow (venue_code, raw_data, fetched_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (venue_code) DO UPDATE SET raw_data = EXCLUDED.raw_data, fetched_at = NOW()`,
      [v.code, JSON.stringify(row)]
    );
    return true;
  }
  return false;
}

async function handleRagicWebhook(sheetCode, body = {}) {
  const code = String(sheetCode || '').trim().toUpperCase();
  const formPath = _webhookFormPath(code);
  if (!formPath) throw new Error(`unsupported Ragic webhook sheet: ${sheetCode}`);
  const ids = _extractWebhookRecordIds(body);
  if (!ids.length) throw new Error('webhook payload 未包含 record id');
  const eventType = String(body?.eventType || body?.event_type || '').trim();
  const items = [];
  for (const id of ids) {
    const t0 = Date.now();
    let refetched = false;
    let shadowUpdated = false;
    let error = null;
    const client = await pool.connect();
    try {
      const record = await ragic.getRecordByRagicId(
        formPath,
        id,
        { ignoreFixedFilter: process.env.RAGIC_IGNORE_FIXED_FILTER === 'false' ? undefined : 'true' },
        { noCache: true }
      );
      await client.query('BEGIN');
      if (record) {
        refetched = true;
        shadowUpdated = await _upsertWebhookShadow(client, code, record);
      } else {
        await _deleteWebhookShadow(client, code, id);
      }
      await client.query(
        `INSERT INTO ragic_webhook_log
           (sheet_code, ragic_record_id, event_type, refetched, latency_ms, error_message)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [code, id, eventType || null, refetched, Date.now() - t0, null]
      );
      await client.query('COMMIT');
      items.push({ id, refetched, shadow_updated: shadowUpdated, latency_ms: Date.now() - t0 });
    } catch (err) {
      error = err.message || String(err);
      await client.query('ROLLBACK').catch(() => {});
      await pool.query(
        `INSERT INTO ragic_webhook_log
           (sheet_code, ragic_record_id, event_type, refetched, latency_ms, error_message)
         VALUES ($1,$2,$3,FALSE,$4,$5)`,
        [code, id, eventType || null, Date.now() - t0, error]
      ).catch(() => {});
      items.push({ id, refetched: false, shadow_updated: false, latency_ms: Date.now() - t0, error });
    } finally {
      client.release();
    }
  }
  return {
    sheet_code: code,
    event_type: eventType || null,
    count: items.length,
    refetched: items.filter((i) => i.refetched).length,
    items,
  };
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
    ragic_record_id: r._ragicId != null ? String(r._ragicId) : null,
    ragic_last_update_at: _ragicLastUpdateValue(r),
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
  const pull = await ragic.getActiveVenuesWithFreshness();
  if (pull.stale_read) throw new Error(pull.error || 'Ragic H05 stale_read');
  await _alertFreshnessIfNeeded('H05', pull.freshness);
  const records = pull.records || [];
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
  const pull = await ragic.getActiveVenuesWithFreshness();
  if (pull.stale_read) throw new Error(pull.error || 'Ragic H05 stale_read');
  await _alertFreshnessIfNeeded('H05', pull.freshness);
  const records = pull.records || [];
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
  getLiveRagicProbeSnapshot,
  getSyncStatusSnapshot,
  pingParentsFromRagic,
  pingStudentsFromRagic,
  backupParentsStudentsToRagic,
  pullParentsStudentsFromRagic,
  reconcileZ01BlankUidCoverage,
  reconcileZ01SourceCoverage,
  findZ01SourcesByTrueLineUid,
  findZ01SourcesByPhone,
  findZ01SourcesByPhoneStudent,
  reingestZ01Record,
  quarantineBadZ01Names,
  hasRecentBackupSuccess,
  hasRecentFreshPull,
  isPlaceholderParentName,
  hasNoCjkCharacters,
  getRagicJobNames,
  // Task #83 single-flight helpers
  isJobRunning,
  getRunningJobs,
  // admin 手動開關（Ragic 連線狀態頁）
  setJobEnabled,
  getJobToggles,
  // Phase 5：增量同步 watermark
  getSyncWatermark,
  setSyncWatermark,
  handleRagicWebhook,
  // Z03 人工整理表
  listZ03Records,
  findZ03RecordByPhone,
  hydrateZ03RecordFromRagicRow,
  completeZ03Registration,
  getZ03UpgradeMissingFields,
  saveZ03RecordDraft,
  resolveZ03Record,
  dismissZ03Record,
  deleteZ03Record,
  markPlaceholderNameResolved,
  // Task #66 staging
  applyStagedChange,
  rejectStagedChange,
  mergeStagedStaffChange,
  listStagingChanges,
  countStagingPending,
  __test__: {
    extractLineUid,
    normalizeLineUserId,
    trueZ01LineUid: _trueZ01LineUid,
    sourceUpdatedTime: _sourceUpdatedTime,
    upsertZ03Record: _upsertZ03Record,
    syncCanonicalZ01Record: _syncCanonicalZ01Record,
    reconcileZ01BlankUidCoverage,
    reconcileZ01SourceCoverage,
    shadowPullZ01Impl: _shadowPullZ01Impl,
    h23CourseCoefficient: _h23CourseCoefficient,
	    staffPayloadFromRagicRow: _staffPayloadFromRagicRow,
	    h01ShadowKey: _h01ShadowKey,
	    publicStagingRow: _publicStagingRow,
    sanitizeH01RawRow: _sanitizeH01RawRow,
    reconcileH23FromShadowImpl: _reconcileH23FromShadowImpl,
  },
};
