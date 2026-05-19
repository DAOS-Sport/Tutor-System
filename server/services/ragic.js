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

// Ragic 認證：必須用 `APIKey=` query 參數（Basic / Bearer header 都會被當 guest 拒絕，回 code:106）
// URL append：很多 RAGIC_FORM_* env 已帶 ?PAGEID=ruv，要用 & 而非第二個 ?，否則 ?api 會被吃進前一個 value
// Task #83：timeout 改成可由 env 覆蓋，預設 30s（H01 教練含子表 / H05 場館 expand 較慢）
const RAGIC_TIMEOUT_MS = Number(process.env.RAGIC_TIMEOUT_MS) || 30000;
const client = axios.create({
  baseURL: process.env.RAGIC_BASE_URL,
  timeout: RAGIC_TIMEOUT_MS,
});

function _withApi(formPath) {
  const sep = formPath.includes('?') ? '&' : '?';
  return `${formPath}${sep}api`;
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

// H05：場館清單（履約中，非內勤；5 分鐘快取，分頁拉取）
async function getActiveVenues() {
  return cached('h05:venues', async () => {
    const data = await queryAllPaged(process.env.RAGIC_FORM_H05, { '履約狀態': '履約中' });
    return Object.values(data).filter(r => r['營運性質'] !== '內勤單位');
  });
}

// =====================================================================
// Ragic 欄位 ID 表（中文欄位 → Field ID）
// 完整欄位定義詳見 docs/ragic_api.md。本表為 services 層唯一真實來源，
// 新增 / 異動欄位時，請同步本表 + docs/ragic_api.md。
// =====================================================================

// Z01 家長主檔
const Z01_FIELDS = {
  '家長姓名':       '1001101',
  '館別':           '1002174',
  '系統登入密碼':   '1003715',
  '(報)行動電話':   '1001100',
  '(報)身分':       '1002177',
  '(報)性別':       '1001121',
  '服務單位':       '1002179',
  '(報)Email':      '1002820',
  '(服)員工編號':   '1002180',
  '住家電話':       '1001122',
  'LINE ID':        '1001123',
  '住家地址':       '1001124',
};

// Z02 學員主檔（含家長關聯欄位）
const Z02_FIELDS = {
  '學員編號':       '1001132',
  '學員身分':       '1002178',
  '學員姓名':       '1001115',
  '學(性別)':       '1001117',
  '出生年月日':     '1001116',
  '身分證字號':     '1001118',
  '血型':           '1001880',
  '館別':           '1002175',
  '(報)行動電話':   '1001113',
  '家長帳號':       '1002830',
  '家長姓名':       '1001272',
  '(報)性別':       '1001273',
  '(報)身分':       '1002181',
  '服務單位':       '1002182',
  '(服)員工編號':   '1002183',
  '(報)Email':      '1002831',
};

// 程式碼可讀別名（避免散落字串），對應上述 Field ID
const FIELD = {
  Z01: {
    PARENT_NAME:    Z01_FIELDS['家長姓名'],
    VENUE:          Z01_FIELDS['館別'],
    PHONE:          Z01_FIELDS['(報)行動電話'],
    IDENTITY:       Z01_FIELDS['(報)身分'],
    GENDER:         Z01_FIELDS['(報)性別'],
    EMAIL:          Z01_FIELDS['(報)Email'],
    HOME_PHONE:     Z01_FIELDS['住家電話'],
    HOME_ADDRESS:   Z01_FIELDS['住家地址'],
    LINE_ID:        Z01_FIELDS['LINE ID'],
  },
  Z02: {
    STUDENT_CODE:   Z02_FIELDS['學員編號'],
    NAME:           Z02_FIELDS['學員姓名'],
    GENDER:         Z02_FIELDS['學(性別)'],
    BIRTH_DATE:     Z02_FIELDS['出生年月日'],
    ID_NUMBER:      Z02_FIELDS['身分證字號'],
    BLOOD_TYPE:     Z02_FIELDS['血型'],
    VENUE:          Z02_FIELDS['館別'],
    PARENT_PHONE:   Z02_FIELDS['(報)行動電話'],
    PARENT_NAME:    Z02_FIELDS['家長姓名'],
    PARENT_EMAIL:   Z02_FIELDS['(報)Email'],
  },
};

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

// Z01：依手機查詢家長（用 Ragic 的 where 語法做精確過濾）
async function getParentByPhone(phone) {
  const data = await query(process.env.RAGIC_FORM_Z01, { where: `${FIELD.Z01.PHONE},eq,${phone}` });
  const records = Object.values(data);
  return records[0] || null;
}

// Z01：回寫家長資料（key 可用中文欄位名或 Field ID，內部統一翻譯成 Field ID）
async function upsertParent(parentData, ragicRecordId = null) {
  try {
    const payload = toFieldIdPayload(parentData, Z01_FIELDS, 'Z01');
    const base = ragicRecordId
      ? `${process.env.RAGIC_FORM_Z01}/${ragicRecordId}`
      : process.env.RAGIC_FORM_Z01;
    await client.post(_withApi(base), payload, { params: { APIKey: process.env.RAGIC_API_KEY } });
    _cacheInvalidate('z01:');
  } catch (err) {
    console.error('[Ragic] upsertParent failed:', err.message);
  }
}

// Z02：依身分證字號查詢學員（必須用 where=<fid>,eq,... 才能精確過濾）
async function getStudentByIdNumber(idNumber) {
  const data = await query(process.env.RAGIC_FORM_Z02, { where: `${FIELD.Z02.ID_NUMBER},eq,${idNumber}` });
  const records = Object.values(data);
  return records[0] || null;
}

// Z02：回寫學員資料（key 可用中文欄位名或 Field ID，內部統一翻譯成 Field ID）
async function upsertStudent(studentData, ragicRecordId = null) {
  try {
    const payload = toFieldIdPayload(studentData, Z02_FIELDS, 'Z02');
    const base = ragicRecordId
      ? `${process.env.RAGIC_FORM_Z02}/${ragicRecordId}`
      : process.env.RAGIC_FORM_Z02;
    await client.post(_withApi(base), payload, { params: { APIKey: process.env.RAGIC_API_KEY } });
    _cacheInvalidate('z02:');
  } catch (err) {
    console.error('[Ragic] upsertStudent failed:', err.message);
  }
}

module.exports = {
  FIELD,
  Z01_FIELDS,
  Z02_FIELDS,
  toFieldIdPayload,
  getActiveCoaches,
  getCounterStaff,
  getAllStaff,
  getActiveVenues,
  getParentByPhone,
  upsertParent,
  getStudentByIdNumber,
  upsertStudent,
};
