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
// Task #83：timeout 改成可由 env 覆蓋（H01 教練含子表 / H05 場館 expand 較慢）。
// 預設 60s：實測 H01_STAFF 同步偶發 ~35s 尖峰會超過舊預設 30s 而逾時失敗（約 25% 失敗率），
// 提高至 60s 給足餘裕；仍可由 RAGIC_TIMEOUT_MS 覆寫。
const RAGIC_TIMEOUT_MS = Number(process.env.RAGIC_TIMEOUT_MS) || 60000;
const client = axios.create({
  baseURL: process.env.RAGIC_BASE_URL,
  timeout: RAGIC_TIMEOUT_MS,
});

function _withApi(formPath) {
  const sep = formPath.includes('?') ? '&' : '?';
  return `${formPath}${sep}api`;
}

function _recordPath(formPath, ragicRecordId) {
  const [pathOnly, qs] = String(formPath || '').split('?');
  return `${pathOnly}/${ragicRecordId}${qs ? `?${qs}` : ''}`;
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
  await client.post(url, payload, { params: { APIKey: process.env.RAGIC_API_KEY } });
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
  if (data.status === 'ERROR') {
    throw new Error(`Ragic ${data.code}: ${data.msg}`);
  }
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
  const base = ragicRecordId
    ? _recordPath(process.env.RAGIC_FORM_Z01, ragicRecordId)
    : process.env.RAGIC_FORM_Z01;
  const raw = await postRagicStrict(base, payload);
  _cacheInvalidate('z01:');
  return raw;
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
      ragic_record_id: pick(row, ['_ragicId', 'ragicId']),
    };
  }).filter((s) => s.name);
}

async function createParentWithStudentsInRagic({ parent, students = [], lineUid }) {
  if (!parent || !parent.phone) throw new Error('parent.phone 必填');
  if (!lineUid) throw new Error('lineUid 必填');

  const payload = {
    [FIELD.Z01.PARENT_NAME]: parent.name || '',
    [FIELD.Z01.PHONE]:       parent.phone,
    [FIELD.Z01.LINE_UID]:    lineUid,
  };
  if (parent.gender)           payload[FIELD.Z01.GENDER] = parent.gender;
  if (parent.email)            payload[FIELD.Z01.EMAIL]  = parent.email;
  if (parent.primary_venue_id) payload[FIELD.Z01.VENUE]  = parent.primary_venue_id;

  students.forEach((s, idx) => {
    if (!s || !s.name) return;
    const prefix = `${Z01_STUDENTS_SUBTABLE_ID}_${idx}_`;
    payload[`${prefix}${FIELD.Z01_STUDENT.NAME}`] = s.name;
    if (s.birth_date) payload[`${prefix}${FIELD.Z01_STUDENT.BIRTH_DATE}`] = s.birth_date;
    if (s.gender)     payload[`${prefix}${FIELD.Z01_STUDENT.GENDER}`]     = s.gender;
    if (s.id_number)  payload[`${prefix}${FIELD.Z01_STUDENT.ID_NUMBER}`]  = String(s.id_number).toUpperCase();
    if (s.blood_type) payload[`${prefix}${FIELD.Z01_STUDENT.BLOOD_TYPE}`] = s.blood_type;
  });

  const res = await client.post(_withApi(process.env.RAGIC_FORM_Z01), payload, {
    params: { APIKey: process.env.RAGIC_API_KEY },
  });
  _cacheInvalidate('z01:');

  const data = res.data || {};
  if (data.status === 'ERROR') {
    throw new Error(`Ragic ${data.code}: ${data.msg}`);
  }

  // 嘗試從常見三種位置抽 record id
  let ragicRecordId = data.ragicId || data._ragicId || null;
  if (!ragicRecordId && data.data && typeof data.data === 'object') {
    const firstKey = Object.keys(data.data)[0];
    ragicRecordId = firstKey || null;
  }
  return { ragicRecordId, raw: data };
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
    if (s.gender)     payload[`${prefix}${FIELD.Z01_STUDENT.GENDER}`]     = s.gender;
    if (s.id_number)  payload[`${prefix}${FIELD.Z01_STUDENT.ID_NUMBER}`]  = String(s.id_number).toUpperCase();
    if (s.blood_type) payload[`${prefix}${FIELD.Z01_STUDENT.BLOOD_TYPE}`] = s.blood_type;
  });

  const res = await client.post(_withApi(_recordPath(process.env.RAGIC_FORM_Z01, ragicRecordId)), payload, {
    params: { APIKey: process.env.RAGIC_API_KEY },
  });
  _cacheInvalidate('z01:');
  const data = res.data || {};
  if (data.status === 'ERROR') throw new Error(`Ragic ${data.code}: ${data.msg}`);
  return { added: list.length, raw: data };
}

async function resolveParentRagicRecord(parent) {
  if (parent?.ragic_record_id) return parent.ragic_record_id;
  const phone = String(parent?.phone || '').trim();
  if (!phone) {
    const err = new Error('缺少家長手機，無法定位 Ragic Z01');
    err.code = 'PARENT_PHONE_REQUIRED';
    throw err;
  }
  const record = await getParentByPhone(phone);
  if (!record?._ragicId) {
    const err = new Error('找不到家長 Ragic Z01 記錄，無法同步');
    err.code = 'PARENT_RAGIC_NOT_FOUND';
    throw err;
  }
  return record._ragicId;
}

function buildZ01StudentPayload(student, rowIndex) {
  const prefix = `${Z01_STUDENTS_SUBTABLE_ID}_${rowIndex}_`;
  const payload = {};
  payload[`${prefix}${FIELD.Z01_STUDENT.NAME}`] = student.name || '';
  if (student.birth_date) payload[`${prefix}${FIELD.Z01_STUDENT.BIRTH_DATE}`] = student.birth_date;
  if (student.gender) payload[`${prefix}${FIELD.Z01_STUDENT.GENDER}`] = student.gender;
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
  const rowIndex = findZ01StudentRowIndex(z01Record, student);
  if (rowIndex == null) {
    const err = new Error('找不到 Z01 學員子表格列，無法更新');
    err.code = 'Z01_STUDENT_ROW_NOT_FOUND';
    throw err;
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

function buildZ02StudentPayload({ parent, student, status = '啟用' }) {
  return {
    [FIELD.Z02.NAME]: student.name || '',
    [FIELD.Z02.STUDENT_STATUS]: status,
    [FIELD.Z02.GENDER]: student.gender || '',
    [FIELD.Z02.BIRTH_DATE]: student.birth_date || '',
    [FIELD.Z02.ID_NUMBER]: student.id_number ? String(student.id_number).toUpperCase() : '',
    [FIELD.Z02.BLOOD_TYPE]: student.blood_type || '',
    [FIELD.Z02.VENUE]: parent.primary_venue_id || '',
    [FIELD.Z02.PARENT_PHONE]: parent.phone || '',
    [FIELD.Z02.PARENT_ACCOUNT]: parent.phone || '',
    [FIELD.Z02.PARENT_NAME]: parent.name || '',
    [FIELD.Z02.PARENT_GENDER]: parent.gender || '',
    [FIELD.Z02.PARENT_IDENTITY]: parent.identity || '',
    [FIELD.Z02.PARENT_EMAIL]: parent.email || '',
  };
}

async function upsertZ02ForParentStudent({ parent, student, status = '啟用' }) {
  let z02Record = null;
  if (student.ragic_record_id) {
    z02Record = { _ragicId: student.ragic_record_id };
  } else if (student.student_code) {
    z02Record = await getStudentByCode(student.student_code);
  } else if (student.id_number) {
    z02Record = await getStudentByIdNumber(String(student.id_number).toUpperCase());
  }
  const payload = buildZ02StudentPayload({ parent, student, status });
  if (student.student_code) payload[FIELD.Z02.STUDENT_CODE] = student.student_code;
  const raw = await upsertStudentStrict(payload, z02Record?._ragicId || null);
  return { ragicRecordId: z02Record?._ragicId || raw.ragicId || raw._ragicId || null, raw };
}

async function createStudentZ01Z02Strict({ parent, student, startIndex = 0 }) {
  const ragicRecordId = await resolveParentRagicRecord(parent);
  const z01Raw = await postRagicStrict(
    _recordPath(process.env.RAGIC_FORM_Z01, ragicRecordId),
    buildZ01StudentPayload(student, startIndex)
  );
  _cacheInvalidate('z01:');
  const z02 = await upsertZ02ForParentStudent({ parent, student, status: '啟用' });
  return { z01: z01Raw, z02, parentRagicRecordId: ragicRecordId };
}

async function updateStudentZ01Z02Strict({ parent, student, status = '啟用' }) {
  const ragicRecordId = await resolveParentRagicRecord(parent);
  const z01 = await updateStudentInParentSubtable({ ragicRecordId, student });
  const z02 = await upsertZ02ForParentStudent({ parent, student, status });
  return { z01, z02, parentRagicRecordId: ragicRecordId };
}

async function deactivateStudentZ02Strict({ parent, student }) {
  const ragicRecordId = await resolveParentRagicRecord(parent);
  const z02 = await upsertZ02ForParentStudent({ parent, student, status: '停用' });
  return { z02, parentRagicRecordId: ragicRecordId };
}

module.exports = {
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
  getParentByPhone,
  getParentByLineUid,
  bindParentLineUidToRagic,
  upsertParent,
  upsertParentStrict,
  mapZ01Parent,
  parseZ01Students,
  createParentWithStudentsInRagic,
  addStudentsToParentInRagic,
  resolveParentRagicRecord,
  updateStudentInParentSubtable,
  getStudentByIdNumber,
  getStudentByCode,
  upsertStudent,
  upsertStudentStrict,
  createStudentZ01Z02Strict,
  updateStudentZ01Z02Strict,
  deactivateStudentZ02Strict,
};
