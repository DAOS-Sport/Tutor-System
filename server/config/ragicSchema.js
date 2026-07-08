/**
 * ════════════════════════════════════════════════════════════════════════
 * Ragic 資料表 / 欄位 對應 — 全系統「唯一真實來源」（凍結點）
 * ════════════════════════════════════════════════════════════════════════
 *
 * 為什麼有這個檔：
 *   先前 Ragic 的「表單路徑」「欄位 Field ID」「LINE UID 綁定欄位」散落在
 *   services/ragic.js、services/ragicAdmin.js、scripts/ragic-auth-smoke.js、
 *   routes/auth.js 等多個檔案，且 H01/Z01 的 LINE UID 預設值（1003633 / 1006846）
 *   被「複製貼上」重複定義 3 次。任一處改了、其它沒跟著改，就會出現
 *   「角色抓不到 / 綁定寫錯欄位」這種難查的漂移 bug。
 *
 * 凍結規則（請務必遵守）：
 *   - 任何 Ragic 表單 / 欄位 ID 的「定義」只能寫在這個檔，其餘檔案一律 import。
 *   - Ragic 端若異動欄位 ID：① 改這裡 ② 同步 docs/ragic_api.md ③ 不需動其它程式。
 *   - 需要臨時覆寫（例如 Ragic 換欄位但還沒重 deploy）：用對應的 env 覆寫，
 *     程式不改、不重 build（見下方各欄位的 env fallback）。
 *
 * 對應的角色抓取（roles）：
 *   - 行政端 管理員(admin)/櫃台(staff)/主管(manager)：來源 H01（在職員工，應徵職務含
 *     「管理員」→ admin；含「行政櫃台/櫃檯」→ staff；主管 manager 由後台手動指派，不從 Ragic 同步）。
 *   - 教練(coach)：來源 H01（應徵職務含「教練」）+ 個人 LINE ID 欄位綁定。
 *   - 客人/家長(parent)：來源 Z01（家教系統 uid 綁定 LINE userId）。
 */

// ─────────────────────────────────────────────────────────────
// 表單路徑（form path / ?api endpoint）
//   用 getter 在「存取當下」讀 env，避免 require 時序早於 dotenv 載入。
//   注意 H01 與 H05/Z01/Z02 的 Ragic AP_Name 不同（見 replit.md / docs/ragic_api.md），
//   各表單路徑前綴各自獨立，皆放在對應 env。
// ─────────────────────────────────────────────────────────────
const FORMS = {
  get H01() { return process.env.RAGIC_FORM_H01; }, // 人事（員工 / 教練）
  get H23() { return process.env.RAGIC_FORM_H23 || 'https://ap7.ragic.com/xinsheng/general-information/23'; }, // 新生/基本資料（薪資倍率）
  get H05() { return process.env.RAGIC_FORM_H05; }, // 場館
  get Z01() { return process.env.RAGIC_FORM_Z01; }, // 家長主檔（+ 學員子表格）
  get Z02() { return process.env.RAGIC_FORM_Z02; }, // 學員主檔
};

// ─────────────────────────────────────────────────────────────
// LINE UID 綁定欄位 Field ID（角色抓取核心 — 全系統唯一定義處）
//   Z01 家教系統uid  → 預設 1006846，env RAGIC_FIELD_Z01_LINE_UID 可覆寫
//   H01 個人LINE ID  → 固定 1003633。這是教練 LINE userId 唯一入口，不吃 env。
//                     實機 API 有時只回中文 key「個人LINE ID」，故只允許精準欄名 fallback，
//                     不做 LINE/uid 模糊搜尋，避免誤抓「400Line訊息」等訊息/狀態欄位。
//   Z01 仍保留 env 覆寫；H01 若 Ragic 真正換欄位，必須改 code + 文件一起審核。
// ─────────────────────────────────────────────────────────────
const LINE_UID_FIELD = {
  Z01: process.env.RAGIC_FIELD_Z01_LINE_UID || '1006846',
  H01: '1003633',
};

// Z01 家長主檔（中文欄位 → Field ID）
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
  'line對話網址':   '1002390',
  '住家地址':       '1001124',
  // 家長 LINE 登入綁定：LIFF 取得的 LINE userId (sub)
  '家教系統uid':    LINE_UID_FIELD.Z01,
};

// ─────────────────────────────────────────────────────────────
// Z01 子表格「學員」（stid 1001119）
//   Ragic 同份家長 (Z01) 可掛多位學員，subtable parent field id = 1001119
//   寫入子表格時 Ragic 接受兩種 key 形式：
//     1) 巢狀 object：{ "1001119": { "0": {1001115:"張小明", ...}, "1": {...} } }
//     2) 扁平 dotted：{ "1001119_0_1001115":"張小明", ... }
//   本服務一律走「扁平 dotted」(較不易踩到 JSON shape 差異)。
// ─────────────────────────────────────────────────────────────
const Z01_STUDENTS_SUBTABLE_ID = '1001119';
const Z01_STUDENT_FIELDS = {
  '學員姓名':       '1001115',
  '出生年月日':     '1001116',
  // Ragic 後台顯示名稱已改為「(學)性別」（原「學(性別)」），2026-07-07 由
  // checkZ01SchemaDrift() 的 ?api&def=1 即時比對發現並校正；parseZ01Students 的
  // pick() 早已把兩種寫法都列為 fallback，故此前未造成實際讀取失效，僅本檔定義過期。
  '(學)性別':       '1001117',
  '身分證字號':     '1001118',
  '血型':           '1001880',
  '學員編號':       '1001132',
};

// Z02 學員主檔（含家長關聯欄位）
const Z02_FIELDS = {
  '學員編號':       '1001132',
  // 「學員身分」= 身分「類別」欄（01.一般生…）。⚠️ 勿重用為啟用/停用狀態欄：
  //   本系統只在首次建立 Z02 時寫一次「01.一般生」，之後一律不碰此欄，
  //   停用/移除由櫃台在 Ragic 端處理（見 services/ragic.js buildZ02StudentPayload）。
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

// ─────────────────────────────────────────────────────────────
// H01 員工 / 教練（角色抓取：行政櫃台/主管、教練）
//   H01 在程式中多以「中文欄位名」直接讀取（在職狀態 / 應徵職務 / 館別…），
//   並輔以 Field ID fallback。這裡集中定義：
//     - NAME：H01「姓名」欄位（Field ID 3000933），staff sync 的主自然鍵
//     - NODE_ID：Ragic record/node id（Field ID 3000942；目前 API 仍常只回 _ragicId）
//     - DATA_NO：H01「資料編號」欄位（Field ID 3000934），僅保留為歷史/除錯資訊
//     - LINE_UID：員工 / 教練的個人 LINE ID 欄位（= LINE_UID_FIELD.H01）
//     - LINE_UID_CANDIDATES：凍結 Field ID + 精準中文欄名；不得用模糊搜尋猜 uid。
//     - VENUE_FIELD_ENV：多場館欄位的 env key（可逗號分隔多 Field ID）
//     - ROLE_MATCH：角色判斷用的關鍵字
// ─────────────────────────────────────────────────────────────
const H01 = {
  NAME: '3000933',
  NAME_DISPLAY_KEYS: ['姓名'],
  NODE_ID: '3000942',
  DATA_NO: '3000934',
  LINE_UID: LINE_UID_FIELD.H01,
  LINE_UID_CANDIDATES: [LINE_UID_FIELD.H01],
  LINE_UID_DISPLAY_KEYS: ['個人LINE ID', '*個人LINE ID'],
  // 多場館欄位（主場館 / 支援場館）：env 可指定 Field ID（逗號分隔），否則用中文欄名
  VENUE_FIELD_ENV: [
    process.env.RAGIC_FIELD_H01_VENUE_PRIMARY,
    process.env.RAGIC_FIELD_H01_VENUE_SUPPORT,
  ].filter(Boolean),
  VENUE_NAME_KEYS: ['主場館', '主要場館', '支援場館', '服務場館', '場館', '館別', '部門'],
  // 角色關鍵字（roleText = 應徵職務 + 職稱 的字串化）
  ROLE_MATCH: {
    ADMIN: /系統管理員|管理員|admin/i,
    COACH: '教練',
    COUNTER: /櫃檯|櫃台|行政|counter|front\s*desk/i,
    // 救生員（Workstream A）：與 COACH/COUNTER 同層獨立比對，非互斥判斷——
    // 一位員工可同時命中 COUNTER + LIFEGUARD（甚至三者皆命中），各自獨立的
    // is_counter / is_coach / is_lifeguard 旗標必須各自保留，不互相覆蓋。
    LIFEGUARD: /體育署救生員|守望員|救生員/,
  },
  // 註（Task #95 政策定案）：H01 為 Ragic 權威、本系統不寫，故無寫回欄位定義。
  // 實機驗證過的 Field ID 對應（讀取/除錯查考用）：3000933=姓名、3001424=手機、
  // 3000940=電子郵件信箱、3000937=部門（多選，場館名稱陣列）、3000935=員工編號、
  // 3000942=Ragic Node ID（若 listing 未回數字鍵則 fallback _ragicId）。
};

const H23 = {
  AP_NAME: 'standardzhtw',
  KEY_FIELD: '3000942',
  STAFF_EMP_ID: '3000935',
  STAFF_NAME: '3000933',
  COURSE_COEFFICIENT: '1006300',
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
    LINE_CHAT_URL:  Z01_FIELDS['line對話網址'],
    LINE_UID:       LINE_UID_FIELD.Z01,
    STUDENTS_SUBTABLE: Z01_STUDENTS_SUBTABLE_ID,
  },
  Z01_STUDENT: {
    NAME:         Z01_STUDENT_FIELDS['學員姓名'],
    BIRTH_DATE:   Z01_STUDENT_FIELDS['出生年月日'],
    GENDER:       Z01_STUDENT_FIELDS['(學)性別'],
    ID_NUMBER:    Z01_STUDENT_FIELDS['身分證字號'],
    BLOOD_TYPE:   Z01_STUDENT_FIELDS['血型'],
    STUDENT_CODE: Z01_STUDENT_FIELDS['學員編號'],
  },
  Z02: {
    STUDENT_CODE:   Z02_FIELDS['學員編號'],
    STUDENT_STATUS: Z02_FIELDS['學員身分'],
    NAME:           Z02_FIELDS['學員姓名'],
    GENDER:         Z02_FIELDS['學(性別)'],
    BIRTH_DATE:     Z02_FIELDS['出生年月日'],
    ID_NUMBER:      Z02_FIELDS['身分證字號'],
    BLOOD_TYPE:     Z02_FIELDS['血型'],
    VENUE:          Z02_FIELDS['館別'],
    PARENT_PHONE:   Z02_FIELDS['(報)行動電話'],
    PARENT_ACCOUNT: Z02_FIELDS['家長帳號'],
    PARENT_NAME:    Z02_FIELDS['家長姓名'],
    PARENT_GENDER:  Z02_FIELDS['(報)性別'],
    PARENT_IDENTITY: Z02_FIELDS['(報)身分'],
    PARENT_EMAIL:   Z02_FIELDS['(報)Email'],
  },
  H01,
  H23,
};

module.exports = {
  FORMS,
  LINE_UID_FIELD,
  Z01_FIELDS,
  Z01_STUDENT_FIELDS,
  Z01_STUDENTS_SUBTABLE_ID,
  Z02_FIELDS,
  H01,
  H23,
  FIELD,
};
