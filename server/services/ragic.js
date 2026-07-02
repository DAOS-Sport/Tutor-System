/**
 * Ragic API 封裝服務
 * H01 教練 / H05 場館 → 每次即時查詢
 * Z01 家長 / Z02 學員 → 雙向同步
 *
 * 寫回（upsertParent / upsertStudent）一律改用 Ragic Field ID 當 JSON key，
 * 避免後台中文欄位名被改名後寫回失效。caller 可傳「Field ID」或「中文欄位名」，
 * 服務層會統一翻譯成 Field ID 後再送出。
 *
 * 中文 → Field ID 對照來源：docs/ragic_api.md
 */
const axios = require('axios');
const { pool } = require('../models/db');

// ── 館別代碼 → 名稱（寫回 Ragic 用）────────────────────────────────────────
// Ragic 的「館別」欄位（Z01 1002174 / Z02 1002175）存的是場館「名稱」（如「新北高中」），
// 但本地 venues.id 是「代碼」（如「B」）。若把代碼原樣寫進 Ragic，Ragic 不認得 → 視為空值
// → 整筆 status:INVALID「欄位 館別 為必填」（家長/學員編輯同步失敗的真因）。
// 故寫回前一律把代碼換成名稱；名稱清單小且少變動 → 記憶體快取 60s，避免每次寫入都打 DB。
let _venueLabelCache = null;
let _venueLabelAt = 0;
async function venueLabel(venueId) {
  const id = String(venueId || '').trim();
  if (!id) return '';
  if (!_venueLabelCache || Date.now() - _venueLabelAt > 60000) {
    try {
      const r = await pool.query('SELECT id, name FROM venues');
      _venueLabelCache = new Map(r.rows.map((row) => [String(row.id), row.name]));
      _venueLabelAt = Date.now();
    } catch (err) {
      console.warn('[Ragic] venueLabel 載入 venues 失敗，暫用原代碼:', err.message);
      return id;
    }
  }
  return _venueLabelCache.get(id) || id;
}

// Ragic 認證：必須用 `APIKey=` query 參數（Basic / Bearer header 都會被當 guest 拒絕，回 code:106）
// URL append：很多 RAGIC_FORM_* env 已帶 ?PAGEID=ruv，要用 & 而非第二個 ?，否則 ?api 會被吃進前一個 value
// Task #83：timeout 改成可由 env 覆蓋（H01 教練含子表 / H05 場館 expand 較慢）。
// 預設 60s：實測 H01_STAFF 同步偶發 ~35s 尖峰會超過舊預設 30s 而逾時失敗（約 25% 失敗率），
// 提高至 60s 給足餘裕；仍可由 RAGIC_TIMEOUT_MS 覆寫。
const RAGIC_TIMEOUT_MS = Number(process.env.RAGIC_TIMEOUT_MS) || 60000;
const client = axios.create({
  baseURL: process.env.RAGIC_BASE_URL,
  timeout: RAGIC_TIMEOUT_MS,
});

// Ragic 表單 env 可能被貼成「瀏覽器網址」而帶 ?PAGEID=… 之類 UI 參數：
// 對讀取(GET)無害(Ragic 忽略未知 param)，但寫入(POST)會被 Ragic 當成欄位 →
// 報「Field id PAGEID not found」整筆寫入靜默失敗。組 API URL 時一律先去掉 query string。
function _stripQuery(formPath) {
  return String(formPath || '').split('?')[0];
}

function _withApi(formPath) {
  return `${_stripQuery(formPath)}?api`;
}

function _recordPath(formPath, ragicRecordId) {
  return `${_stripQuery(formPath)}/${ragicRecordId}`;
}

// 補償用：盡力刪除指定表單的多筆 record（失敗只記 log、不拋）。
// 用於「Z01 家長已建、Z02 學員寫一半失敗」時回滾，讓使用者可乾淨重試。
async function _bestEffortDelete(formPath, ragicRecordIds = []) {
  for (const rid of ragicRecordIds) {
    if (rid == null) continue;
    try {
      await client.delete(_withApi(_recordPath(formPath, rid)), {
        params: { APIKey: process.env.RAGIC_API_KEY },
      });
    } catch (err) {
      console.error('[Ragic] 補償刪除失敗:', _stripQuery(formPath), rid, err.message);
    }
  }
}

// Ragic 寫入成功為 status:'SUCCESS'；'ERROR'(系統錯) / 'INVALID'(欄位驗證失敗，如必填缺漏)
// 等都代表沒寫進去。先前多處只擋 'ERROR' → 'INVALID' 被當成功靜默吞掉、整筆沒落地。
function _assertWriteOk(data) {
  const d = data || {};
  if (d.status && d.status !== 'SUCCESS') {
    throw new Error(`Ragic ${d.status} ${d.code || ''}: ${d.msg || ''}`.trim());
  }
  // 防「軟失敗靜默吞掉」：Ragic 寫入成功一定回 status:'SUCCESS' 且帶 record id。
  // 若回 200 卻既無 SUCCESS 狀態也無 record id（例如打到錯表單 / 回了非預期 JSON / 空 body），
  // 視為寫入失敗並拋錯，避免「看起來成功、實際沒落地」。
  const hasRecordId =
    d.ragicId != null ||
    d._ragicId != null ||
    (d.data && typeof d.data === 'object' && (d.data._ragicId != null || d.data.ragicId != null));
  if (d.status !== 'SUCCESS' && !hasRecordId) {
    throw new Error('Ragic 寫入未確認成功（回應無 SUCCESS 狀態且無 record id），疑似打到錯誤表單或回應異常');
  }
}

// Task #83：把 axios timeout / 超時類錯誤正規化成中文友善文案，
// 讓 admin UI 直顯「Ragic 慢回應，請稍後再試」而非 raw `timeout of 10000ms exceeded`。
function _normalizeRagicError(err) {
  const isTimeout =
    err?.code === 'ECONNABORTED' ||
    err?.code === 'ETIMEDOUT' ||
    /timeout/i.test(err?.message || '');
  if (isTimeout) {
    const e = new Error('Ragic 慢回應，請稍後再試');
    e.code = 'RAGIC_TIMEOUT';
    e.cause = err;
    return e;
  }
  // Ragic / 上游回 HTTP 4xx/5xx 時，axios 的 err.message 只是無資訊量的
  // 「Request failed with status code 400」——存進 ragic_sync_log.error_message 後，
  // 後台「Ragic 連線狀態」卡片就只顯示這串神祕代碼，admin 無從判斷原因。
  // 這裡把真正的 HTTP 狀態 + Ragic 回應內容（msg/code 或前 200 字）萃取成可讀訊息。
  const status = err?.response?.status;
  if (status) {
    const body = err.response.data;
    let detail = '';
    if (typeof body === 'string') detail = body.replace(/<[^>]*>/g, ' ').trim().slice(0, 200);
    else if (body && typeof body === 'object') detail = (body.msg || body.message || JSON.stringify(body)).slice(0, 200);
    const e = new Error(`Ragic 回應 HTTP ${status}${detail ? `：${detail}` : ''}`);
    e.code = 'RAGIC_HTTP_ERROR';
    e.status = status;
    e.cause = err;
    return e;
  }
  return err;
}

async function query(formPath, params = {}) {
  let res;
  try {
    res = await client.get(_withApi(formPath), {
      params: { ...params, APIKey: process.env.RAGIC_API_KEY },
    });
  } catch (err) {
    throw _normalizeRagicError(err);
  }
  // Ragic 錯誤回應仍是 200 + JSON：{ status:'ERROR', msg, code }；要顯式拋出，避免被當成資料 swallow
  if (res.data && typeof res.data === 'object' && res.data.status === 'ERROR') {
    throw new Error(`Ragic ${res.data.code}: ${res.data.msg}`);
  }
  return res.data;
}

// Task #83：H01 教練 / H05 場館分頁拉取（Ragic 支援 ?limit=N&offset=N）
// 避免單次回應 payload 過大導致 timeout。回傳合併後的 records map（同 query() 形狀）。
const RAGIC_PAGE_SIZE = Number(process.env.RAGIC_PAGE_SIZE) || 200;
const RAGIC_MAX_PAGES = Number(process.env.RAGIC_MAX_PAGES) || 50; // 上限 10000 筆，足夠 H01/H05
async function queryAllPaged(formPath, params = {}) {
  const merged = {};
  for (let page = 0; page < RAGIC_MAX_PAGES; page++) {
    const offset = page * RAGIC_PAGE_SIZE;
    const pageData = await query(formPath, { ...params, limit: RAGIC_PAGE_SIZE, offset });
    if (!pageData || typeof pageData !== 'object') break;
    const keys = Object.keys(pageData);
    if (keys.length === 0) break;
    Object.assign(merged, pageData);
    if (keys.length < RAGIC_PAGE_SIZE) break; // 最後一頁
  }
  return merged;
}

// ─────────────────────────────────────────────────────────────
// 簡易 in-process TTL 快取，避免高併發打爆 Ragic（不引入 Redis）
// ─────────────────────────────────────────────────────────────
const CACHE_TTL_MS = Number(process.env.RAGIC_CACHE_TTL_MS ?? 5 * 60 * 1000);
const CACHE_DISABLED = CACHE_TTL_MS <= 0;
const CACHE_MAX = 64;
const _cache = new Map(); // key -> { v, exp }
function _cacheGet(key) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (hit.exp < Date.now()) { _cache.delete(key); return null; }
  return hit.v;
}
function _cacheSet(key, v) {
  if (_cache.size >= CACHE_MAX) _cache.delete(_cache.keys().next().value);
  _cache.set(key, { v, exp: Date.now() + CACHE_TTL_MS });
}
function _cacheInvalidate(prefix) {
  for (const k of _cache.keys()) if (k.startsWith(prefix)) _cache.delete(k);
}
async function cached(key, fn) {
  if (CACHE_DISABLED) return fn();
  const hit = _cacheGet(key);
  if (hit !== null) return hit;
  const v = await fn();
  _cacheSet(key, v);
  return v;
}

// 把 應徵職務 統一成可 substring-search 的字串（H01 該欄可能是 string 或 array，
// array 元素也可能是 "體育署救生員,教練" 這種複合字串）
function _roleStr(r) {
  const v = r['應徵職務'];
  if (Array.isArray(v)) return v.join(',');
  return v || '';
}

// H01：在職教練（5 分鐘快取，分頁拉取）
async function getActiveCoaches() {
  return cached('h01:coaches', async () => {
    const data = await queryAllPaged(process.env.RAGIC_FORM_H01, { '在職狀態': '在職' });
    return Object.values(data).filter(r => _roleStr(r).includes('教練'));
  });
}

// H01：行政櫃檯（5 分鐘快取，分頁拉取）
async function getCounterStaff() {
  return cached('h01:counter', async () => {
    const data = await queryAllPaged(process.env.RAGIC_FORM_H01, { '在職狀態': '在職' });
    return Object.values(data).filter(r => _roleStr(r).includes('行政櫃台') || _roleStr(r).includes('行政櫃檯'));
  });
}

// H01：全員工（角色指派用，5 分鐘快取，分頁拉取）
async function getAllStaff() {
  return cached('h01:all', async () => Object.values(await queryAllPaged(process.env.RAGIC_FORM_H01)));
}

// Z01：全量家長清單（Ragic → 本地每日全量拉取用；刻意不套 cached()，
// 排程每次都要拿當下最新資料，語意同 getAllStaff 但不走 5 分鐘快取）
async function getAllParents() {
  return Object.values(await queryAllPaged(process.env.RAGIC_FORM_Z01));
}

// 註（Task #95 政策定案）：H01 員工資料一律「Ragic → 系統」單向，本系統**不寫** H01。
// 曾實作 admin 編輯寫回（syncStaffToRagicStrict），後依政策移除：
//   1. Ragic 為人事權威資料庫，異動一律請 HR 在 Ragic 操作，系統同步帶回即可。
//   2. 技術面也不可行性高：實測 H01 新建必填欄位 14 個全為 HR 專屬資料（國籍/直屬主管/
//      HR專員/系統群組…）；更新時整筆重驗，紀錄缺任一必填（教學項目/400Line訊息…）即 INVALID。
// 實機驗證過的欄位對應（留供查考）：3000933=姓名、3001424=手機（顯示名「手機」）、
// 3000940=電子郵件信箱、3000937=部門（**多選**，值為場館名稱陣列）、3000935=員工編號。

// H05：場館清單（履約中，非內勤；5 分鐘快取，分頁拉取）
async function getActiveVenues() {
  return cached('h05:venues', async () => {
    const data = await queryAllPaged(process.env.RAGIC_FORM_H05, { '履約狀態': '履約中' });
    return Object.values(data).filter(r => r['營運性質'] !== '內勤單位');
  });
}

// =====================================================================
// Ragic 欄位 ID 表（中文欄位 → Field ID）
// 唯一真實來源已搬到 server/config/ragicSchema.js（凍結點）。
// 這裡只 require 回來、保留原本的 local const 名稱，讓本檔其餘程式不動。
// 新增 / 異動欄位 → 改 ragicSchema.js + docs/ragic_api.md，不要在這裡重複定義。
// =====================================================================
const {
  LINE_UID_FIELD,
  Z01_FIELDS,
  Z01_STUDENT_FIELDS,
  Z01_STUDENTS_SUBTABLE_ID,
  Z02_FIELDS,
  FIELD,
} = require('../config/ragicSchema');

// 向後相容別名（本檔多處仍以這兩個名稱引用）
const Z01_LINE_UID_FIELD = LINE_UID_FIELD.Z01;
const H01_LINE_UID_FIELD = LINE_UID_FIELD.H01;

/**
 * 把 caller 給的 payload（key 可能是中文欄位名或 Field ID）統一翻譯成 Field ID 為 key。
 * - 純數字字串視為 Field ID，原樣保留。
 * - 中文欄位名查 nameToFid 表後改用 Field ID。
 * - 未知 key 會 warn 並丟棄（避免 Ragic 因不識別欄位整筆寫入失敗）。
 */
function toFieldIdPayload(data, nameToFid, formLabel) {
  const out = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (/^\d+$/.test(key)) {
      out[key] = value;
      continue;
    }
    const fid = nameToFid[key];
    if (fid) {
      out[fid] = value;
    } else {
      console.warn(`[Ragic] ${formLabel} 未知欄位 "${key}"，已忽略（請對照 docs/ragic_api.md）`);
    }
  }
  return out;
}

// Z01：依手機查詢家長（用 Ragic 的 where 語法做精確過濾，Field ID 1001100）
async function getParentByPhone(phone) {
  const data = await query(process.env.RAGIC_FORM_Z01, { where: `${FIELD.Z01.PHONE},eq,${phone}` });
  const records = Object.values(data);
  return records[0] || null;
}

/**
 * Z01：依家教系統uid（LINE 登入綁定 UID）查詢家長
 * - LIFF 端拿到 id_token → verify 後得到 lineUid (sub) → 用此查 Z01
 * - 找不到回 null，由 caller 決定接下來走「手機綁定」或「需註冊」流程
 */
async function getParentByLineUid(lineUid) {
  if (!lineUid) return null;
  const data = await query(process.env.RAGIC_FORM_Z01, {
    where: `${Z01_LINE_UID_FIELD},eq,${lineUid}`,
  });
  const records = Object.values(data);
  return records[0] || null;
}

/**
 * Z01：把 LINE UID 回填到既有家長記錄（用 Field ID 1006846 寫入）
 * - ragicRecordId：Z01 該筆 record 的 _ragicId（必填，沒有就無法 PATCH 既有列）
 * - lineUid：LIFF 驗證後得到的 sub
 * - 不會建立新筆；找不到 ragicRecordId 時 caller 應改用 upsertParent
 */
async function bindParentLineUidToRagic({ ragicRecordId, lineUid }) {
  if (!ragicRecordId) throw new Error('ragicRecordId 必填');
  if (!lineUid) throw new Error('lineUid 必填');
  const payload = { [Z01_LINE_UID_FIELD]: lineUid };
  const url = _withApi(_recordPath(process.env.RAGIC_FORM_Z01, ragicRecordId));
  const res = await client.post(url, payload, { params: { APIKey: process.env.RAGIC_API_KEY } });
  _assertWriteOk(res.data);
  _cacheInvalidate('z01:');
  return { ok: true };
}

async function postRagicStrict(formPath, payload) {
  let res;
  try {
    res = await client.post(_withApi(formPath), payload, {
      params: { APIKey: process.env.RAGIC_API_KEY },
    });
  } catch (err) {
    throw _normalizeRagicError(err);
  }
  const data = res.data || {};
  _assertWriteOk(data);
  return data;
}

// Z01：回寫家長資料（key 可用中文欄位名或 Field ID，內部統一翻譯成 Field ID）
async function upsertParent(parentData, ragicRecordId = null) {
  try {
    const payload = toFieldIdPayload(parentData, Z01_FIELDS, 'Z01');
    const base = ragicRecordId
      ? _recordPath(process.env.RAGIC_FORM_Z01, ragicRecordId)
      : process.env.RAGIC_FORM_Z01;
    await client.post(_withApi(base), payload, { params: { APIKey: process.env.RAGIC_API_KEY } });
    _cacheInvalidate('z01:');
  } catch (err) {
    console.error('[Ragic] upsertParent failed:', err.message);
  }
}

async function upsertParentStrict(parentData, ragicRecordId = null) {
  const payload = toFieldIdPayload(parentData, Z01_FIELDS, 'Z01');
  const payloadLineUid = _extractLineUidFromPayload(payload);
  if (payloadLineUid || !ragicRecordId) {
    payload[FIELD.Z01.LINE_UID] = _assertRealLineUidForZ01(payloadLineUid, 'upsertParentStrict');
  }
  const base = ragicRecordId
    ? _recordPath(process.env.RAGIC_FORM_Z01, ragicRecordId)
    : process.env.RAGIC_FORM_Z01;
  const raw = await postRagicStrict(base, payload);
  _cacheInvalidate('z01:');
  return raw;
}

function _realLineUidForZ01(lineUid) {
  const uid = String(lineUid || '').trim();
  if (!uid) return '';
  if (uid.startsWith('demo:') || uid.startsWith('DEMOTEST_')) return '';
  return uid;
}

function _assertRealLineUidForZ01(lineUid, context = 'Z01 write') {
  const uid = _realLineUidForZ01(lineUid);
  if (uid) return uid;
  const err = new Error(`${context}: 缺少有效 LINE UID，已拒絕寫入 Ragic Z01`);
  err.code = 'PARENT_LINE_UID_REQUIRED';
  throw err;
}

function _extractLineUidFromPayload(payloadByFieldId = {}) {
  return payloadByFieldId[FIELD.Z01.LINE_UID] || payloadByFieldId[Z01_LINE_UID_FIELD] || '';
}

function _assertNoZ01LineUidConflict(record, lineUid, context = 'Z01 write') {
  const mapped = mapZ01Parent(record);
  if (mapped?.line_uid && mapped.line_uid !== lineUid) {
    const err = new Error(`${context}: Ragic Z01 已綁定其他 LINE UID，拒絕覆蓋`);
    err.code = 'PARENT_LINE_UID_MISMATCH';
    throw err;
  }
}

/**
 * 將 Z01 record 主表轉成本地 parent 欄位形狀。
 * Ragic 回傳 key 同時包含中文欄位名（如「家長姓名」）與 Field ID 字串（"1001101"），
 * 兩者都當 fallback 嘗試一次。
 */
function mapZ01Parent(record) {
  if (!record) return null;
  const get = (...keys) => {
    for (const k of keys) {
      if (record[k] != null && String(record[k]).trim() !== '') return String(record[k]).trim();
    }
    return '';
  };
  return {
    ragic_record_id: record._ragicId || record['_ragicId'] || null,
    name:             get(FIELD.Z01.PARENT_NAME, '家長姓名'),
    phone:            get(FIELD.Z01.PHONE, '(報)行動電話'),
    gender:           get(FIELD.Z01.GENDER, '(報)性別'),
    email:            get(FIELD.Z01.EMAIL, '(報)Email'),
    primary_venue_id: get(FIELD.Z01.VENUE, '館別'),
    identity:         get(FIELD.Z01.IDENTITY, '(報)身分'),
    home_phone:       get(FIELD.Z01.HOME_PHONE, '住家電話'),
    home_address:     get(FIELD.Z01.HOME_ADDRESS, '住家地址'),
    line_id:          get(FIELD.Z01.LINE_ID, 'LINE ID'),
    line_uid:         get(FIELD.Z01.LINE_UID, '家教系統uid'),
  };
}

/**
 * 解析 Z01 record 中的子表格學員清單。
 * Ragic 對子表格的回傳形狀並非穩定一致，至少觀察到三種：
 *   (a) record[<subtable_id>] 是 object：{ "<rowKey>": { fid: value, ... } }
 *   (b) record[<subtable_id>] 是 array：[ { fid: value }, ... ]
 *   (c) 直接把子表格欄位放到第一層 record 上（單列子表格時）
 * 任一狀況都要能解出來；解不出來時回 []，由 caller 決定容錯。
 */
function parseZ01Students(record) {
  if (!record || typeof record !== 'object') return [];

  const subtable =
    record._subtable_1001119 ||
    record['1001119'] ||
    record['學員資料'] ||
    record['項次'] ||
    null;

  const rows = Array.isArray(subtable)
    ? subtable.map((row, index) => ({ row, rowKey: String(index) }))
    : (subtable && typeof subtable === 'object'
        ? Object.entries(subtable).map(([rowKey, row]) => ({ row, rowKey }))
        : []);

  const pick = (row, keys) => {
    for (const key of keys) {
      const value = row?.[key];
      if (value !== undefined && value !== null && String(value).trim() !== '') {
        return String(value).trim();
      }
    }
    return '';
  };

  const normalizeDate = (value) => {
    const s = String(value || '').trim();
    if (!s) return '';
    // Ragic 實際回傳常見 yyyy/MM/dd；DB date 可吃 yyyy-MM-dd。
    const m = s.match(/^(\\d{4})[\\/-](\\d{1,2})[\\/-](\\d{1,2})/);
    if (!m) return s;
    return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  };

  return rows.map(({ row, rowKey }) => {
    const name = pick(row, ['1001115', '學員姓名']);
    return {
      row_key: rowKey,
      name,
      birth_date: normalizeDate(pick(row, ['1001116', '出生年月日'])),
      gender: pick(row, ['1001117', '(學)性別', '學(性別)']),
      id_number: pick(row, ['1001118', '身分證字號']).toUpperCase(),
      blood_type: pick(row, ['1001880', '血型']),
      student_code: pick(row, ['1001132', '學員編號']),
      registered_phone: pick(row, ['1004090', '登記電話']),
      ragic_record_id: pick(row, ['_ragicId', 'ragicId']),
    };
  }).filter((s) => s.name);
}

function _normalizeRagicDate(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
  if (!m) return s;
  return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
}

/**
 * 將 Z02 學員主檔 record 轉成本地 students 欄位形狀。
 * 用於註冊/綁定後的嚴格刷新：Z01 的 linked 子表可能短暫延遲，
 * 因此直接以 Z02「(報)行動電話」重拉學員鏡射。
 */
function mapZ02Student(record) {
  if (!record) return null;
  const get = (...keys) => {
    for (const k of keys) {
      if (record[k] != null && String(record[k]).trim() !== '') return String(record[k]).trim();
    }
    return '';
  };
  const name = get(FIELD.Z02.NAME, '學員姓名');
  if (!name) return null;
  return {
    name,
    birth_date: _normalizeRagicDate(get(FIELD.Z02.BIRTH_DATE, '出生年月日')),
    gender: get(FIELD.Z02.GENDER, '學(性別)'),
    id_number: get(FIELD.Z02.ID_NUMBER, '身分證字號').toUpperCase(),
    blood_type: get(FIELD.Z02.BLOOD_TYPE, '血型'),
    student_code: get(FIELD.Z02.STUDENT_CODE, '學員編號'),
    ragic_record_id: record._ragicId || record.ragicId || null,
  };
}

/**
 * parseZ01Students 的「原始值」版本——供 Z03 人工整理表使用，刻意不做
 * normalizeDate（不轉 yyyy-MM-dd）、不做 toUpperCase（身分證字號原樣），
 * 讓人工看到 Ragic 裡實際存的字串去判斷要怎麼修正。子表格三種形狀的解析邏輯
 * 與 parseZ01Students 相同（無法共用 helper，因為 pick/normalizeDate 是該函式的區域變數）。
 */
function parseZ01StudentsRaw(record) {
  if (!record || typeof record !== 'object') return [];

  const subtable =
    record._subtable_1001119 ||
    record['1001119'] ||
    record['學員資料'] ||
    record['項次'] ||
    null;

  const rows = Array.isArray(subtable)
    ? subtable.map((row, index) => ({ row, rowKey: String(index) }))
    : (subtable && typeof subtable === 'object'
        ? Object.entries(subtable).map(([rowKey, row]) => ({ row, rowKey }))
        : []);

  const pickRaw = (row, keys) => {
    for (const key of keys) {
      const value = row?.[key];
      if (value !== undefined && value !== null && String(value).trim() !== '') {
        return String(value).trim();
      }
    }
    return '';
  };

  return rows.map(({ row, rowKey }) => ({
    seq_raw:              pickRaw(row, ['1001120', '項次']) || rowKey,
    student_status_raw:   pickRaw(row, ['1002178', '學員身分']),
    name_raw:             pickRaw(row, ['1001115', '學員姓名']),
    birth_date_raw:       pickRaw(row, ['1001116', '出生年月日']),
    gender_raw:           pickRaw(row, ['1001117', '(學)性別', '學(性別)']),
    id_number_raw:        pickRaw(row, ['1001118', '身分證字號']),
    blood_type_raw:       pickRaw(row, ['1001880', '血型']),
    age_raw:              pickRaw(row, ['1001330', '歲數']),
    student_code_raw:     pickRaw(row, ['1001132', '學員編號']),
    registered_phone_raw: pickRaw(row, ['1004090', '登記電話']),
  })).filter((s) => s.name_raw);
}

// 男/女 → 生理男/生理女。Ragic Z02「學(性別)」「(報)性別」與 Z01 子表性別均為「選項欄位」，
// 只接受「生理男/生理女」，送「男/女」會被當無效值而落空。
function _toPhysGender(g) {
  const v = String(g || '').trim();
  if (!v) return '';
  if (v.startsWith('生理')) return v;
  if (['男', 'M', 'Male', 'male'].includes(v)) return '生理男';
  if (['女', 'F', 'Female', 'female'].includes(v)) return '生理女';
  // 不願透露：統一為 Ragic 選項值「不方便透漏」（注意是「漏」非「露」）。
  if (v.includes('不方便') || v.includes('不便') || v.includes('不願') || v.includes('不透')) return '不方便透漏';
  return v;
}

// 組 Z02 學員主檔 payload。
//
// 為什麼學員要寫 Z02 而非 Z01 子表：
//   Z01 的「項次/學員」子表（stid 1001119）是「依家長手機(報行動電話)自動連動帶出的 Z02 清單」，
//   屬 Ragic linked-records，**無法**用 dotted key 直接 POST 寫入（POST 會回 SUCCESS 但靜默丟棄，
//   兩步法 record-path POST 則回「館別為必填」INVALID）。真正的學員主檔是 Z02，
//   只要在 Z02 建一筆「(報)行動電話 = 家長手機」的紀錄，Z01 項次子表就會自動帶出該學員。
//
// Z02 必填欄位（缺一會 INVALID 202、整筆寫不進去）：學員編號 / (報)身分 / 血型。
//   - 學員編號：新生無編號 → 以身分證字號頂替（與既有真實紀錄一致）。
//   - (報)身分：家長身分，預設「一般身分」。
//   - 血型：未填以「不清楚」placeholder（Ragic 接受的選項值）。
async function _buildZ02RegistrationPayload({ parent, student }) {
  const idnum = student.id_number ? String(student.id_number).toUpperCase() : '';
  const birth = student.birth_date ? String(student.birth_date).replace(/-/g, '/') : '';
  return {
    [FIELD.Z02.NAME]:            student.name || '',
    [FIELD.Z02.STUDENT_STATUS]:  '01.一般生',                    // 學員身分（學生類別）
    [FIELD.Z02.GENDER]:          _toPhysGender(student.gender),  // 學(性別)
    [FIELD.Z02.BIRTH_DATE]:      birth,
    [FIELD.Z02.ID_NUMBER]:       idnum,
    [FIELD.Z02.STUDENT_CODE]:    student.student_code || idnum,  // 學員編號（缺則用身分證）
    [FIELD.Z02.BLOOD_TYPE]:      student.blood_type || '不清楚', // Z02 必填，缺則「不清楚」
    [FIELD.Z02.VENUE]:           await venueLabel(parent.primary_venue_id),
    [FIELD.Z02.PARENT_PHONE]:    parent.phone || '',             // ★ Z01↔Z02 連結鍵
    [FIELD.Z02.PARENT_NAME]:     parent.name || '',
    [FIELD.Z02.PARENT_GENDER]:   _toPhysGender(parent.gender),
    [FIELD.Z02.PARENT_IDENTITY]: parent.identity || '一般身分',  // (報)身分 必填
    [FIELD.Z02.PARENT_EMAIL]:    parent.email || '',
  };
}

async function createParentWithStudentsInRagic({ parent, students = [], lineUid }) {
  if (!parent || !parent.phone) throw new Error('parent.phone 必填');
  lineUid = _assertRealLineUidForZ01(lineUid, 'createParentWithStudentsInRagic');

  const payload = {
    [FIELD.Z01.PARENT_NAME]:   parent.name || '',
    [FIELD.Z01.PHONE]:         parent.phone,
    [FIELD.Z01.LINE_UID]:      lineUid,
    // Ragic Z01 必填欄位（不送會被擋 status:INVALID）：身分 / 館別 / line對話網址。
    // 場館在報名時才選定，註冊階段先放「待補登」placeholder（Ragic 接受自由文字）。
    // 館別需送「名稱」而非代碼（venueLabel 轉換），否則 Ragic 不認得 → 為必填 INVALID。
    [FIELD.Z01.IDENTITY]:      parent.identity || '一般身分',
    [FIELD.Z01.VENUE]:         (await venueLabel(parent.primary_venue_id)) || '待補登',
    [FIELD.Z01.LINE_CHAT_URL]: '待補登',
  };
  if (parent.gender) payload[FIELD.Z01.GENDER] = _toPhysGender(parent.gender);
  if (parent.email)  payload[FIELD.Z01.EMAIL]  = parent.email;

  // 1) 建 Z01 家長主檔（不再帶 dotted 子表，子表寫不進去，見 _buildZ02RegistrationPayload 註解）
  const res = await client.post(_withApi(process.env.RAGIC_FORM_Z01), payload, {
    params: { APIKey: process.env.RAGIC_API_KEY },
  });
  _cacheInvalidate('z01:');

  const data = res.data || {};
  _assertWriteOk(data);

  // 嘗試從常見三種位置抽 record id
  let ragicRecordId = data.ragicId || data._ragicId || null;
  if (!ragicRecordId && data.data && typeof data.data === 'object') {
    const firstKey = Object.keys(data.data)[0];
    ragicRecordId = firstKey || null;
  }

  // 2) 學員逐筆寫 Z02（見 _writeStudentsToZ02）。某筆失敗 → helper 已回滾「本次新建」的
  //    Z02 學員，這裡再補刪剛建的 Z01 家長，讓使用者可乾淨重試。
  let studentRecordIds = [];
  try {
    ({ studentRecordIds } = await _writeStudentsToZ02({ parent, students }));
  } catch (err) {
    if (ragicRecordId) await _bestEffortDelete(process.env.RAGIC_FORM_Z01, [ragicRecordId]);
    _cacheInvalidate('z01:');
    throw err;
  }

  return { ragicRecordId, studentRecordIds, raw: data };
}

// 學員逐筆寫 Z02 學員主檔（依家長手機自動連動回 Z01 項次子表）。
// 身分證字號是 Z02 唯一鍵。若該號已存在：
//   · 同一位學員的孤兒紀錄（姓名相符、未綁定別的家長手機）→ 重新連結（更新而非新建）。
//   · 被「別的學員」占用 → 丟 STUDENT_ID_NUMBER_EXISTS，caller 回 409 明確訊息。
// 補償：中途失敗 → 回滾刪除「本次新建」的 Z02 學員後 rethrow。
// （只刪本次新建，避免誤刪我們只是「更新」的既有他人/孤兒紀錄；
//   caller 若同時新建了 Z01 家長，需在自己的 catch 補刪該筆 Z01。）
async function _writeStudentsToZ02({ parent, students = [] }) {
  const studentRecordIds = [];
  const createdStudentIds = [];
  try {
    for (const s of students) {
      if (!s || !s.name) continue;
      const idnum = s.id_number ? String(s.id_number).toUpperCase() : '';
      let targetRecordId = null;
      if (idnum) {
        const existing = await getStudentByIdNumber(idnum).catch(() => null);
        if (existing) {
          const exName  = String(existing[FIELD.Z02.NAME] || '').trim();
          const exPhone = String(existing[FIELD.Z02.PARENT_PHONE] || '').trim();
          const sameStudent = !!exName && exName === String(s.name || '').trim();
          const unboundOrSameParent = !exPhone || exPhone === parent.phone;
          if (sameStudent && unboundOrSameParent) {
            targetRecordId = existing._ragicId || existing.ragicId || null;  // 重新連結孤兒
          } else {
            const e = new Error(`身分證字號 ${idnum} 已被其他學員使用`);
            e.code = 'STUDENT_ID_NUMBER_EXISTS';
            e.idNumber = idnum;
            throw e;
          }
        }
      }
      const z02raw = await upsertStudentStrict(await _buildZ02RegistrationPayload({ parent, student: s }), targetRecordId);
      const newId = z02raw?.ragicId || z02raw?._ragicId || null;
      studentRecordIds.push(newId);
      if (!targetRecordId) createdStudentIds.push(newId);
    }
  } catch (err) {
    await _bestEffortDelete(process.env.RAGIC_FORM_Z02, createdStudentIds);
    _cacheInvalidate('z02:');
    throw err;
  }
  return { studentRecordIds, createdStudentIds };
}

/**
 * 註冊路徑的「找到就更新」（found→update）：電話已存在 Z01、且該筆尚未綁任何 LINE UID
 * （= 未開通，Z03 清洗池）時，在既有 record 上完成開通，永不新建第二筆同號記錄。
 *   1) 先把「全新」學員寫入 Z02（caller 已把既有家庭學員濾掉——既有學員一律不動，
 *      避免表單註冊預設值覆蓋 Ragic 真實資料）。
 *   2) 再對既有 Z01 一次 partial PATCH：
 *      · LINE UID 一律回寫 —— 這是「開通」的提交點，刻意放最後一步：若前面學員寫入失敗，
 *        不會留下「已綁 UID 但註冊其實沒完成」的半套狀態。
 *      · 家長姓名僅在 caller 判定既有值為電話佔位時覆蓋（nameToWrite 非空才寫）。
 *      · Email／性別／館別只補 Ragic 空缺（含「待補登」placeholder），不清掉既有非空值。
 *   補償：PATCH 失敗 → 回滾「本次新建」的 Z02 學員後 rethrow（既有列本函式不曾動過），
 *   讓重試乾淨——含無身分證字號、無法靠冪等鍵去重的學員。
 * caller（auth.js 註冊路由）負責：認領驗證、佔位姓名判斷、本地同步與 Z03 畢業標記。
 */
async function completeParentOnRegisterInRagic({ existing, parent, students = [], lineUid, nameToWrite = '' }) {
  const ragicRecordId = existing?.ragic_record_id;
  if (!ragicRecordId) throw new Error('existing.ragic_record_id 必填');
  lineUid = _assertRealLineUidForZ01(lineUid, 'completeParentOnRegisterInRagic');

  const { studentRecordIds, createdStudentIds } = await _writeStudentsToZ02({ parent, students });

  const payload = { [FIELD.Z01.LINE_UID]: lineUid };
  if (nameToWrite) payload[FIELD.Z01.PARENT_NAME] = nameToWrite;
  if (parent.phone && !existing.phone) payload[FIELD.Z01.PHONE] = parent.phone;
  if (parent.email  && !existing.email)  payload[FIELD.Z01.EMAIL]  = parent.email;
  if (parent.gender && !existing.gender) payload[FIELD.Z01.GENDER] = _toPhysGender(parent.gender);
  if (parent.identity && !existing.identity) payload[FIELD.Z01.IDENTITY] = parent.identity;
  if (parent.primary_venue_id && (!existing.primary_venue_id || existing.primary_venue_id === '待補登')) {
    const label = await venueLabel(parent.primary_venue_id);
    if (label) payload[FIELD.Z01.VENUE] = label;
  }
  let raw;
  try {
    raw = await upsertParentStrict(payload, ragicRecordId);
  } catch (err) {
    await _bestEffortDelete(process.env.RAGIC_FORM_Z02, createdStudentIds);
    _cacheInvalidate('z02:');
    throw err;
  }
  return { ragicRecordId, studentRecordIds, raw };
}

/**
 * 在「既有家長」的 Z01 record 上補掛新學員到學員子表格（團購加入流程用）。
 * createParentWithStudentsInRagic 是「建新家長」；本函式則是 POST 到既有 record，
 * 以扁平 dotted key 從 startIndex 起追加子表格列（startIndex 應為目前子表格列數，
 * 由 caller 先 query 既有列數算出，避免覆蓋既有列）。
 * 失敗時拋錯，由 caller 決定容錯（團購加入採 best-effort，不阻擋本地加入）。
 */
async function addStudentsToParentInRagic({ ragicRecordId, startIndex = 0, students = [] }) {
  if (!ragicRecordId) throw new Error('ragicRecordId 必填');
  const list = (students || []).filter((s) => s && s.name);
  if (!list.length) return { added: 0 };

  const payload = {};
  list.forEach((s, i) => {
    const prefix = `${Z01_STUDENTS_SUBTABLE_ID}_${startIndex + i}_`;
    payload[`${prefix}${FIELD.Z01_STUDENT.NAME}`] = s.name;
    if (s.birth_date) payload[`${prefix}${FIELD.Z01_STUDENT.BIRTH_DATE}`] = s.birth_date;
    if (s.gender)     payload[`${prefix}${FIELD.Z01_STUDENT.GENDER}`]     = _toPhysGender(s.gender);
    if (s.id_number)  payload[`${prefix}${FIELD.Z01_STUDENT.ID_NUMBER}`]  = String(s.id_number).toUpperCase();
    if (s.blood_type) payload[`${prefix}${FIELD.Z01_STUDENT.BLOOD_TYPE}`] = s.blood_type;
  });

  const res = await client.post(_withApi(_recordPath(process.env.RAGIC_FORM_Z01, ragicRecordId)), payload, {
    params: { APIKey: process.env.RAGIC_API_KEY },
  });
  _cacheInvalidate('z01:');
  const data = res.data || {};
  _assertWriteOk(data);
  return { added: list.length, raw: data };
}

async function resolveParentRagicRecord(parent) {
  if (parent?.ragic_record_id) {
    console.log('[student-sync] resolveParent: DB 已存 ragic_record_id', { ragicId: parent.ragic_record_id });
    return parent.ragic_record_id;
  }
  const phone = String(parent?.phone || '').trim();
  if (!phone) {
    const err = new Error('缺少家長手機，無法定位 Ragic Z01');
    err.code = 'PARENT_PHONE_REQUIRED';
    throw err;
  }
  // 先用手機查既有家長（“先去打表單的值”）；查不到才在 Ragic 建立 Z01 家長主檔，
  // 讓「每次編輯都能同步回 Ragic」不因家長尚未入 Ragic（例如後台直建 / demo 帳號）而中斷。
  const record = await getParentByPhone(phone);
  if (record?._ragicId) {
    console.log('[student-sync] resolveParent: 以手機查到既有 Z01', { phone, ragicId: record._ragicId });
    return record._ragicId;
  }
  console.log('[student-sync] resolveParent: Ragic 查無此家長，將新建 Z01', { phone, name: parent?.name });
  return await createParentRagicRecord(parent);
}

// 在 Ragic 建立家長 Z01 主檔（補齊 INVALID 必填欄位 placeholder），回傳新 record id。
async function createParentRagicRecord(parent) {
  const lineUid = _assertRealLineUidForZ01(parent?.line_uid, 'createParentRagicRecord');
  const payload = {
    [FIELD.Z01.PARENT_NAME]:   parent?.name || '',
    [FIELD.Z01.PHONE]:         String(parent?.phone || '').trim(),
    [FIELD.Z01.IDENTITY]:      parent?.identity || '一般身分',
    // 館別送「名稱」而非代碼（venueLabel 轉換），否則 Ragic「館別 為必填」INVALID。
    [FIELD.Z01.VENUE]:         (await venueLabel(parent?.primary_venue_id)) || '待補登',
    [FIELD.Z01.LINE_CHAT_URL]: '待補登',
    [FIELD.Z01.LINE_UID]:      lineUid,
  };
  if (parent?.gender) payload[FIELD.Z01.GENDER] = _toPhysGender(parent.gender);
  if (parent?.email)  payload[FIELD.Z01.EMAIL]  = parent.email;
  const data = await postRagicStrict(process.env.RAGIC_FORM_Z01, payload);
  _cacheInvalidate('z01:');
  const id = data?.ragicId || data?._ragicId
    || (data?.data && typeof data.data === 'object' && (data.data._ragicId || data.data.ragicId)) || null;
  if (!id) {
    const err = new Error('建立家長 Ragic Z01 未取得 record id');
    err.code = 'PARENT_RAGIC_CREATE_FAILED';
    throw err;
  }
  console.log('[student-sync] 已在 Ragic 新建家長 Z01', { id: String(id), name: parent?.name });
  return String(id);
}

/**
 * 編輯家長後把完整 Z01 主檔寫回 Ragic，並自我修復「本地 ragic_record_id 已失效」的情況：
 *  1. 本地存了 record id → 先驗證該筆在 Ragic 仍存在（被後台刪除時會查無）；失效就丟棄。
 *  2. 沒有有效 id → 用手機查既有 Z01，查不到才新建（resolveParentRagicRecord 內含此邏輯）。
 *  3. 寫回完整欄位，回傳實際使用的 ragicRecordId（可能與傳入不同 → caller 應回存校正）。
 * payloadByFieldId：以 Field ID 為 key 的 Z01 欄位（caller 用 ragicParentPayload 組好）。
 */
async function syncParentProfileStrict(parent, payloadByFieldId) {
  const lineUid = _assertRealLineUidForZ01(
    parent?.line_uid || _extractLineUidFromPayload(payloadByFieldId),
    'syncParentProfileStrict'
  );
  payloadByFieldId = {
    ...payloadByFieldId,
    [FIELD.Z01.LINE_UID]: lineUid,
  };
  let ragicRecordId = parent?.ragic_record_id || null;
  if (ragicRecordId) {
    const existing = await getParentRecordByRagicId(ragicRecordId).catch(() => null);
    if (!existing) {
      console.warn('[parent-sync] 本地 ragic_record_id 在 Ragic 查無，改以手機重新定位', {
        staleId: String(ragicRecordId), phone: parent?.phone,
      });
      ragicRecordId = null;
    } else {
      _assertNoZ01LineUidConflict(existing, lineUid, 'syncParentProfileStrict');
    }
  }
  if (!ragicRecordId) {
    ragicRecordId = await resolveParentRagicRecord({ ...parent, ragic_record_id: null });
    const existing = await getParentRecordByRagicId(ragicRecordId).catch(() => null);
    if (existing) _assertNoZ01LineUidConflict(existing, lineUid, 'syncParentProfileStrict');
  }
  await upsertParentStrict(payloadByFieldId, ragicRecordId);
  return String(ragicRecordId);
}

function buildZ01StudentPayload(student, rowIndex) {
  const prefix = `${Z01_STUDENTS_SUBTABLE_ID}_${rowIndex}_`;
  const payload = {};
  payload[`${prefix}${FIELD.Z01_STUDENT.NAME}`] = student.name || '';
  if (student.birth_date) payload[`${prefix}${FIELD.Z01_STUDENT.BIRTH_DATE}`] = student.birth_date;
  if (student.gender) payload[`${prefix}${FIELD.Z01_STUDENT.GENDER}`] = _toPhysGender(student.gender);
  if (student.id_number) payload[`${prefix}${FIELD.Z01_STUDENT.ID_NUMBER}`] = String(student.id_number).toUpperCase();
  if (student.blood_type) payload[`${prefix}${FIELD.Z01_STUDENT.BLOOD_TYPE}`] = student.blood_type;
  if (student.student_code) payload[`${prefix}${FIELD.Z01_STUDENT.STUDENT_CODE}`] = student.student_code;
  return payload;
}

async function getParentRecordByRagicId(ragicRecordId) {
  if (!ragicRecordId) return null;
  const data = await query(_recordPath(process.env.RAGIC_FORM_Z01, ragicRecordId));
  if (!data || typeof data !== 'object') return null;
  if (data._ragicId || data[FIELD.Z01.PHONE] || data['家長姓名']) return data;
  return Object.values(data)[0] || null;
}

function findZ01StudentRowIndex(z01Record, student) {
  const rows = parseZ01Students(z01Record);
  const code = String(student?.student_code || '').trim();
  const idNumber = String(student?._match_id_number || student?.id_number || '').trim().toUpperCase();
  const ragicId = String(student?.ragic_record_id || '').trim();
  const matched = rows.find((row) => (
    (ragicId && String(row.ragic_record_id || '') === ragicId) ||
    (code && String(row.student_code || '') === code) ||
    (idNumber && String(row.id_number || '').toUpperCase() === idNumber)
  ));
  if (!matched) return null;
  return matched.row_key;
}

async function updateStudentInParentSubtable({ ragicRecordId, student }) {
  if (!ragicRecordId) throw new Error('ragicRecordId 必填');
  if (!student?.name) throw new Error('student.name 必填');
  const z01Record = await getParentRecordByRagicId(ragicRecordId);
  let rowIndex = findZ01StudentRowIndex(z01Record, student);
  if (rowIndex == null) {
    // 子表格找不到對應列（學員尚未寫進 Z01、或無 id_number/編號 可比對）→ 視為新列附加，
    // 索引取目前列數（與新增流程 buildZ01StudentPayload(startIndex) 一致），避免整筆編輯被擋掉。
    rowIndex = (parseZ01Students(z01Record) || []).length;
    console.log('[student-sync] Z01 子表格：無對應列 → 附加新列', { ragicRecordId, rowIndex, student: student?.name });
  } else {
    console.log('[student-sync] Z01 子表格：比對到既有列 → 更新', { ragicRecordId, rowIndex, student: student?.name });
  }
  const raw = await postRagicStrict(
    _recordPath(process.env.RAGIC_FORM_Z01, ragicRecordId),
    buildZ01StudentPayload(student, rowIndex)
  );
  _cacheInvalidate('z01:');
  return { rowIndex, raw };
}

// Z02：依身分證字號查詢學員（必須用 where=<fid>,eq,... 才能精確過濾）
async function getStudentByIdNumber(idNumber) {
  const data = await query(process.env.RAGIC_FORM_Z02, { where: `${FIELD.Z02.ID_NUMBER},eq,${idNumber}` });
  const records = Object.values(data);
  return records[0] || null;
}

async function getStudentRecordByRagicId(ragicRecordId) {
  if (!ragicRecordId) return null;
  const data = await query(_recordPath(process.env.RAGIC_FORM_Z02, ragicRecordId));
  if (!data || typeof data !== 'object') return null;
  if (data._ragicId || data[FIELD.Z02.NAME] || data['學員姓名']) return data;
  return Object.values(data)[0] || null;
}

// Z02：依家長手機重拉該家庭學員主檔。註冊/綁定後的嚴格刷新使用，
// 避免 Z01 linked 子表尚未即時展開時，本地 students 被誤刷成空。
async function getStudentsByParentPhone(phone) {
  if (!phone) return [];
  const data = await query(process.env.RAGIC_FORM_Z02, {
    where: `${FIELD.Z02.PARENT_PHONE},eq,${phone}`,
  });
  return Object.values(data).map(mapZ02Student).filter(Boolean);
}

async function getStudentByCode(studentCode) {
  if (!studentCode) return null;
  const data = await query(process.env.RAGIC_FORM_Z02, { where: `${FIELD.Z02.STUDENT_CODE},eq,${studentCode}` });
  return Object.values(data)[0] || null;
}

// Z02：回寫學員資料（key 可用中文欄位名或 Field ID，內部統一翻譯成 Field ID）
async function upsertStudent(studentData, ragicRecordId = null) {
  try {
    const payload = toFieldIdPayload(studentData, Z02_FIELDS, 'Z02');
    const base = ragicRecordId
      ? _recordPath(process.env.RAGIC_FORM_Z02, ragicRecordId)
      : process.env.RAGIC_FORM_Z02;
    await client.post(_withApi(base), payload, { params: { APIKey: process.env.RAGIC_API_KEY } });
    _cacheInvalidate('z02:');
  } catch (err) {
    console.error('[Ragic] upsertStudent failed:', err.message);
  }
}

async function upsertStudentStrict(studentData, ragicRecordId = null) {
  const payload = toFieldIdPayload(studentData, Z02_FIELDS, 'Z02');
  const base = ragicRecordId
    ? _recordPath(process.env.RAGIC_FORM_Z02, ragicRecordId)
    : process.env.RAGIC_FORM_Z02;
  const raw = await postRagicStrict(base, payload);
  _cacheInvalidate('z02:');
  return raw;
}

async function buildZ02StudentPayload({ parent, student, setIdentity = false }) {
  // Z02 必填欄位（缺一會 INVALID 202、整筆寫不進去），與 _buildZ02RegistrationPayload 對齊：
  //   - 學員編號：新生無編號 → 以身分證字號頂替（與既有真實紀錄一致）
  //   - 血型：未填以「不清楚」placeholder（Ragic 接受的選項值）
  //   - (報)身分：家長身分，預設「一般身分」
  const idnum = student.id_number ? String(student.id_number).toUpperCase() : '';
  const payload = {
    [FIELD.Z02.NAME]: student.name || '',
    // 「學員身分」(1002178) 是身分「類別」欄（01.一般生…），不是啟用/停用狀態欄。
    //   只在「首次建立 Z02」時設一次（setIdentity=true）；既有紀錄一律不寫此欄，
    //   避免家長端編輯/同步把 Ragic 端的身分類別覆蓋掉（過去 bug：寫入「啟用/停用」）。
    [FIELD.Z02.GENDER]: _toPhysGender(student.gender),
    [FIELD.Z02.BIRTH_DATE]: student.birth_date || '',
    [FIELD.Z02.ID_NUMBER]: idnum,
    [FIELD.Z02.STUDENT_CODE]: student.student_code || idnum, // 學員編號 必填，缺則用身分證
    [FIELD.Z02.BLOOD_TYPE]: student.blood_type || '不清楚',  // Z02 必填
    [FIELD.Z02.VENUE]: await venueLabel(parent.primary_venue_id),  // 送名稱而非代碼
    [FIELD.Z02.PARENT_PHONE]: parent.phone || '',
    [FIELD.Z02.PARENT_ACCOUNT]: parent.phone || '',
    [FIELD.Z02.PARENT_NAME]: parent.name || '',
    [FIELD.Z02.PARENT_GENDER]: _toPhysGender(parent.gender),
    [FIELD.Z02.PARENT_IDENTITY]: parent.identity || '一般身分', // (報)身分 必填
    [FIELD.Z02.PARENT_EMAIL]: parent.email || '',
  };
  if (setIdentity) payload[FIELD.Z02.STUDENT_STATUS] = '01.一般生';
  return payload;
}

async function upsertZ02ForParentStudent({ parent, student }) {
  let z02Record = null;
  let matchedBy = null;
  if (student.ragic_record_id) {
    z02Record = await getStudentRecordByRagicId(student.ragic_record_id).catch(() => null);
    if (!z02Record) z02Record = { _ragicId: student.ragic_record_id };
    matchedBy = 'ragic_record_id';
  } else if (student.student_code) {
    z02Record = await getStudentByCode(student.student_code);
    if (z02Record) matchedBy = 'student_code';
  } else {
    const matchIdNumber = student._match_id_number || student.id_number;
    if (matchIdNumber) {
      z02Record = await getStudentByIdNumber(String(matchIdNumber).toUpperCase());
      if (z02Record) matchedBy = 'id_number';
    }
  }

  const parentPhone = String(parent?.phone || '').trim();
  const targetIdNumber = student.id_number ? String(student.id_number).toUpperCase() : '';
  const recordId = z02Record?._ragicId || z02Record?.ragicId || null;
  if (targetIdNumber) {
    const existingByTargetId = await getStudentByIdNumber(targetIdNumber).catch(() => null);
    const existingTargetRecordId = existingByTargetId?._ragicId || existingByTargetId?.ragicId || null;
    if (existingByTargetId && (!recordId || String(existingTargetRecordId || '') !== String(recordId))) {
      const e = new Error(`身分證字號 ${targetIdNumber} 已被其他學員使用`);
      e.code = 'STUDENT_ID_NUMBER_EXISTS';
      e.idNumber = targetIdNumber;
      throw e;
    }
  }

  if (z02Record) {
    const exName = String(z02Record[FIELD.Z02.NAME] || z02Record['學員姓名'] || '').trim();
    const exPhone = String(z02Record[FIELD.Z02.PARENT_PHONE] || z02Record['(報)行動電話'] || '').trim();
    if (matchedBy === 'ragic_record_id' && exPhone && exPhone !== parentPhone) {
      const e = new Error(`學員資料已連結其他家庭，無法由目前帳號修改`);
      e.code = 'STUDENT_ID_NUMBER_EXISTS';
      e.idNumber = targetIdNumber || '';
      throw e;
    }
    if (matchedBy === 'ragic_record_id') {
      // 本地已保存的 Ragic record id 視為同一位學員；姓名可由本次編輯更新。
    } else {
    const sameStudent = !exName || exName === String(student.name || '').trim();
    const unboundOrSameParent = !exPhone || exPhone === parentPhone;
    if (!sameStudent || !unboundOrSameParent) {
      const e = new Error(`身分證字號 ${targetIdNumber || student.student_code || ''} 已被其他學員使用`);
      e.code = 'STUDENT_ID_NUMBER_EXISTS';
      e.idNumber = targetIdNumber || '';
      throw e;
    }
    }
  }
  // 只有 Ragic 端尚無此學員時才算「首次建立」→ 設一次身分類別「01.一般生」；
  //   既有紀錄一律不碰「學員身分」欄（避免覆蓋身分類別）。
  const setIdentity = !z02Record;
  const payload = await buildZ02StudentPayload({ parent, student, setIdentity });
  if (student.student_code) payload[FIELD.Z02.STUDENT_CODE] = student.student_code;
  const raw = await upsertStudentStrict(payload, z02Record?._ragicId || null);
  return { ragicRecordId: z02Record?._ragicId || raw.ragicId || raw._ragicId || null, raw };
}

// 註：Z01 的「項次/學員」子表是「依家長手機由 Z02 自動連動帶出」的 linked-records，
// dotted-key 直寫常被 Ragic 靜默丟棄、或回 INVALID（子表必填欄如 學員編號/學性別/身分證字號）。
// 真正落地靠 Z02（upsertZ02ForParentStudent）；故子表寫入一律 best-effort（失敗只記 log 不擋），
// 與註冊流程 createParentWithStudentsInRagic「不再帶 dotted 子表」一致。
async function createStudentZ01Z02Strict({ parent, student, startIndex = 0 }) {
  const lineUid = _assertRealLineUidForZ01(parent?.line_uid, 'createStudentZ01Z02Strict');
  const ragicRecordId = await resolveParentRagicRecord(parent);
  const existing = await getParentRecordByRagicId(ragicRecordId).catch(() => null);
  if (existing) _assertNoZ01LineUidConflict(existing, lineUid, 'createStudentZ01Z02Strict');
  await upsertParentStrict({ [FIELD.Z01.LINE_UID]: lineUid }, ragicRecordId);
  try {
    await postRagicStrict(
      _recordPath(process.env.RAGIC_FORM_Z01, ragicRecordId),
      buildZ01StudentPayload(student, startIndex)
    );
    _cacheInvalidate('z01:');
  } catch (err) {
    console.warn('[student-sync] Z01 子表寫入略過（非致命，靠 Z02 連動帶出）:', err.message);
  }
  const z02 = await upsertZ02ForParentStudent({ parent, student });
  return { z01: null, z02, parentRagicRecordId: ragicRecordId };
}

async function updateStudentZ01Z02Strict({ parent, student }) {
  const lineUid = _assertRealLineUidForZ01(parent?.line_uid, 'updateStudentZ01Z02Strict');
  const ragicRecordId = await resolveParentRagicRecord(parent);
  const existing = await getParentRecordByRagicId(ragicRecordId).catch(() => null);
  if (existing) _assertNoZ01LineUidConflict(existing, lineUid, 'updateStudentZ01Z02Strict');
  await upsertParentStrict({ [FIELD.Z01.LINE_UID]: lineUid }, ragicRecordId);
  try {
    await updateStudentInParentSubtable({ ragicRecordId, student });
  } catch (err) {
    console.warn('[student-sync] Z01 子表更新略過（非致命，靠 Z02 連動帶出）:', err.message);
  }
  const z02 = await upsertZ02ForParentStudent({ parent, student });
  return { z01: null, z02, parentRagicRecordId: ragicRecordId };
}

async function updateStudentFromZ03Strict({ parent, student }) {
  if (!parent?.ragic_record_id) {
    const err = new Error('Z03 寫回學員資料需要既有 Z01 Ragic record id');
    err.code = 'PARENT_RAGIC_RECORD_REQUIRED';
    throw err;
  }
  const ragicRecordId = String(parent.ragic_record_id);
  try {
    await updateStudentInParentSubtable({ ragicRecordId, student });
  } catch (err) {
    console.warn('[student-sync] Z03 Z01 子表更新略過（非致命，靠 Z02 連動帶出）:', err.message);
  }
  const z02 = await upsertZ02ForParentStudent({ parent, student });
  return { z01: null, z02, parentRagicRecordId: ragicRecordId };
}

// DEPRECATED：家長端已不再提供「停用」；移除/轉出一律由櫃台在 Ragic 端處理。
// 保留簽名以防舊呼叫端；現已不再寫入「學員身分」狀態欄（upsertZ02ForParentStudent
// 對既有紀錄不碰該欄），故即使被呼叫也不會再覆蓋身分類別。
async function deactivateStudentZ02Strict({ parent, student }) {
  const lineUid = _assertRealLineUidForZ01(parent?.line_uid, 'deactivateStudentZ02Strict');
  const ragicRecordId = await resolveParentRagicRecord(parent);
  const existing = await getParentRecordByRagicId(ragicRecordId).catch(() => null);
  if (existing) _assertNoZ01LineUidConflict(existing, lineUid, 'deactivateStudentZ02Strict');
  await upsertParentStrict({ [FIELD.Z01.LINE_UID]: lineUid }, ragicRecordId);
  const z02 = await upsertZ02ForParentStudent({ parent, student });
  return { z02, parentRagicRecordId: ragicRecordId };
}

module.exports = {
  normalizeGender: _toPhysGender,
  FIELD,
  Z01_FIELDS,
  Z01_STUDENT_FIELDS,
  Z01_STUDENTS_SUBTABLE_ID,
  Z02_FIELDS,
  Z01_LINE_UID_FIELD,
  H01_LINE_UID_FIELD,
  toFieldIdPayload,
  getActiveCoaches,
  getCounterStaff,
  getAllStaff,
  getActiveVenues,
  getAllParents,
  getParentByPhone,
  getParentByLineUid,
  bindParentLineUidToRagic,
  upsertParent,
  upsertParentStrict,
  getParentRecordByRagicId,
  syncParentProfileStrict,
  venueLabel,
  mapZ01Parent,
  parseZ01Students,
  parseZ01StudentsRaw,
  mapZ02Student,
  createParentWithStudentsInRagic,
  completeParentOnRegisterInRagic,
  addStudentsToParentInRagic,
  resolveParentRagicRecord,
  updateStudentInParentSubtable,
  getStudentByIdNumber,
  getStudentsByParentPhone,
  getStudentByCode,
  upsertStudent,
  upsertStudentStrict,
  createStudentZ01Z02Strict,
  updateStudentZ01Z02Strict,
  updateStudentFromZ03Strict,
  deactivateStudentZ02Strict,
};
