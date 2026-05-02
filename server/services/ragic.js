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

const client = axios.create({
  baseURL: process.env.RAGIC_BASE_URL,
  headers: { Authorization: `Basic ${Buffer.from(process.env.RAGIC_API_KEY).toString('base64')}` },
  timeout: 10000,
});

async function query(formPath, params = {}) {
  const res = await client.get(`${formPath}?api`, { params });
  return res.data;
}

// H01：在職教練
async function getActiveCoaches() {
  const data = await query(process.env.RAGIC_FORM_H01, { '在職狀態': '在職' });
  return Object.values(data).filter(r => r['應徵職務']?.includes('教練'));
}

// H01：行政櫃檯
async function getCounterStaff() {
  const data = await query(process.env.RAGIC_FORM_H01, { '在職狀態': '在職' });
  return Object.values(data).filter(r => r['應徵職務']?.includes('行政櫃檯'));
}

// H01：全員工（角色指派用）
async function getAllStaff() {
  return Object.values(await query(process.env.RAGIC_FORM_H01));
}

// H05：場館清單（履約中，非內勤）
async function getActiveVenues() {
  const data = await query(process.env.RAGIC_FORM_H05, { '履約狀態': '履約中' });
  return Object.values(data).filter(r => r['營運性質'] !== '內勤單位');
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
    const path = ragicRecordId
      ? `${process.env.RAGIC_FORM_Z01}/${ragicRecordId}?api`
      : `${process.env.RAGIC_FORM_Z01}?api`;
    await client.post(path, payload);
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
    const path = ragicRecordId
      ? `${process.env.RAGIC_FORM_Z02}/${ragicRecordId}?api`
      : `${process.env.RAGIC_FORM_Z02}?api`;
    await client.post(path, payload);
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
