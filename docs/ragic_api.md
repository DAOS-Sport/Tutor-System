# Ragic API 整合說明

> 本文件為 DAOS 家教系統與 Ragic 之間的整合手冊，涵蓋認證、表單路徑、欄位對照表（含 Ragic Field ID）。
> 程式實作位於 `server/services/ragic.js`。

---

## Ragic API Key 與環境變數

API Key、帳號、表單路徑都透過環境變數注入，**請勿** 將明文 Key 直接寫入任何 repo 檔案。

| 環境變數 | 範例值 | 說明 |
|---|---|---|
| `RAGIC_API_KEY` | `（敏感資料，存 Replit Secrets，切勿寫入 repo）` | Ragic API Key。**必須**透過 `?APIKey=<key>` query 參數傳遞（Ragic 不接受 `Authorization: Basic` / `Bearer` header，會被當 guest 拒絕，回 `code:106`）|
| `RAGIC_BASE_URL` | `https://ap7.ragic.com` | 依實際 Ragic Server 位置調整（本系統使用 `ap7`）|
| `RAGIC_ACCOUNT` | `xinsheng` | Ragic 帳號（URL 第一段都是這個，與「AP_Name」不同）|
| `RAGIC_FORM_H01` | `/xinsheng/ragicforms4/20004` | H01 教練在職狀態（AP_Name `standardzhtw`）|
| `RAGIC_FORM_H05` | `/xinsheng/ragicforms4/7` | H05 場館清單與銀行（AP_Name `xinsheng`）|
| `RAGIC_FORM_Z01` | `/xinsheng/general-information/6` | Z01 家長帳號（AP_Name `xinsheng`）|
| `RAGIC_FORM_Z02` | `/xinsheng/general-information/11` | Z02 學員資料（AP_Name `xinsheng`）|

> **`RAGIC_ACCOUNT` 與 `AP_Name` 的差別**：
> - URL 第一段（如 `/xinsheng/...`）是 Ragic **帳號名稱**，所有表單都一樣（本系統一律是 `xinsheng`）。
> - `AP_Name`（H01 為 `standardzhtw`、其餘為 `xinsheng`）是 Ragic 內部「表單群組（tab）」的 metadata，呼叫 API 時通常**不需要替換** URL 路徑，照表單顯示 URL 直接打即可（程式中的 `RAGIC_FORM_*` 也是用顯示 URL）。AP_Name 僅作為對應 Ragic 後台設定時的查詢依據。

設定方式：
1. 在 Replit Secrets（環境變數面板）建立上述 key。
2. 開發環境也可複製 `.env.example` → `.env` 後填入。
3. **不要把實際 Key 提交到 git**。
4. ⚠️ `RAGIC_BASE_URL` 與 `RAGIC_API_KEY` **必須同時存在**，否則 `ragicEnabled()` 回 false → `syncCoachesFromRagic` / `syncVenuesFromRagic` 整段被 noop（dev 環境用，但 prod 缺一個就靜默不同步）。Server 啟動時會印 `[Ragic] sync enabled=true (base=...)` 或 `[Ragic] sync DISABLED — missing <var>`，缺哪個一秒看出。
5. ⚠️ `RAGIC_FORM_*` 路徑若已含 `?PAGEID=ruv` 等 query string，程式會自動用 `&api` append（不是第二個 `?`），且 `APIKey` 會以 axios `params` 傳入，無需手動拼接。

### H01 / H05 實際欄位對映（Task #37）

實際打 Ragic API 取出的 record，欄位鍵名以 **中文欄位名** 為主（不是 Field ID 數字）。經 Plan mode 探查實機回應，本系統使用以下欄位：

**H01 員工**（`syncCoachesFromRagic` / `syncStaffFromRagic` 用）：
- `員工編號`（fallback `工號` / `3000935`）→ `coaches.ragic_employee_id`
- `姓名`（fallback `3000933`）→ `coaches.name`
- `手機`（fallback `手機（公司）` / `手機（個人）` / `3001424` / `3000941`）→ `coaches.phone`
- `E-mail`（fallback `Email` / `3000940`）→ `coaches.email`
- `應徵職務`（**陣列** `["教練"]`，可能多值如 `"體育署救生員,教練"`）→ filter 是否含「教練」
- `在職狀態`（`"在職"` / `"離職"` / `"合約到期"` …，僅 `"在職"` 入 `coaches`）

**H05 場館**（`syncVenuesFromRagic` 用）：
- `部門編號`（fallback `場館代號` / `1000253`）→ `venues.id` / `admin_venues.id`
- `部門名稱`（fallback `場館名稱` / `1000254`）→ `venues.name`
- `完整地址`（fallback `場館地址` / `1000271`）→ `venues.full_address`
- `總機構名稱`（`1001013`）→ `admin_venues.bank_institution_name`
- `分支機構名稱`（`1001015`）→ `admin_venues.bank_branch_name`
- `戶名`（`1001016`）→ `admin_venues.account_holder`
- `帳號`（`1001017`）→ `admin_venues.account_number`
- `履約狀態`（僅 `"履約中"`）+ `營運性質`（排除 `"內勤單位"`）

---

## 整合原則（資料分工）

| 資料 | 方向 | 說明 |
|---|---|---|
| H01 教練在職狀態 | Ragic → 系統（唯讀）| 每次進入系統即時 API 查詢 |
| H05 場館清單 | Ragic → 系統（唯讀）| 每次進入系統即時 API 查詢 |
| Z01 家長資料 | Ragic ↔ 系統（雙向）| 即時雙向同步 |
| Z02 學員資料 | Ragic ↔ 系統（雙向）| 即時雙向同步 |

---

## API 呼叫範例

> 註：以下範例已更新為與目前 `server/services/ragic.js` 一致的 URL 與查詢 key（與舊版本相比，URL 從占位符改為實際表單路徑、寫回範例改用 Field ID）。

> ⚠️ **認證**：所有範例都需在 URL 加上 `&APIKey=<RAGIC_API_KEY>`（為了可讀性下方範例省略）。
> Ragic **不接受** `Authorization: Basic` / `Bearer` header — 用 header 會被當 guest，回 `code:106`。
> 程式中由 `server/services/ragic.js` 統一以 axios `params` 注入 `APIKey`，呼叫端不需手動拼。

### 查詢在職教練
```
GET https://ap7.ragic.com/xinsheng/ragicforms4/20004?api&在職狀態=在職&APIKey=<RAGIC_API_KEY>
```

### 查詢場館清單
```
GET https://ap7.ragic.com/xinsheng/ragicforms4/7?api&履約狀態=履約中&APIKey=<RAGIC_API_KEY>
```

### 依手機查詢家長
```
GET https://ap7.ragic.com/xinsheng/general-information/6?api&where=1001100,eq,09xxxxxxxx
```
> ⚠️ Ragic 的「直接用欄位中文名當 query string」（如 `?api&行動電話=...`）並不會做精確過濾，實測會回傳整批 1000 筆資料。**精確查詢必須使用 `where=<FieldID>,<op>,<value>` 語法**（op 常用 `eq` / `like` / `gt` / `lt`）。本文件中的查詢範例與 `server/services/ragic.js` 內的查詢都應遵循此規則。

### 依身分證字號查詢學員
```
GET https://ap7.ragic.com/xinsheng/general-information/11?api&where=1001118,eq,A123456789
```

### 新建家長記錄（回寫）
```
POST https://ap7.ragic.com/xinsheng/general-information/6?api
Content-Type: application/json
Body: {"1001101": "王小明", "1001100": "0912345678", ...}
```
> 寫回時建議直接用「Field ID」當 key（如上例），可避免中文鍵名因為網頁版重命名而失效。

### 取得表單欄位定義（Schema 探索用）
```
GET https://ap7.ragic.com/xinsheng/general-information/11?api&def=1
```
> 回傳 JSON 中 `fields.fid<XXXX>` 為主檔欄位、`fields.stid<YYYY>` 為子表（Subtable），各自再含 `fid<ZZZZ>`。本文件 Z02 欄位對照即由此 endpoint 直接抓出。當 Ragic 後台新增/重命名欄位後，重跑此查詢即可同步本表。

---

## H01 教練在職狀態

### 表單資訊
| 項目 | 值 |
|---|---|
| 表單網址 | <https://ap7.ragic.com/xinsheng/ragicforms4/20004> |
| AP_Name | `standardzhtw` |
| Key Field | `3000942`（到職日期）|
| 緊急聯絡人 subtable key（姓名）| `3001028` |
| 工作經歷 subtable key（公司名稱）| `3000985` |
| 學歷 subtable key（學校名稱）| `3000989` |

### 完整欄位對照
**基本資料**

| 中文欄位 | Field ID | 系統 DB 欄位 | 備註 |
|---|---|---|---|
| 資料編號 | `3000934` |  |  |
| 姓名 | `3000933` | `coaches.name` |  |
| 英文名稱 | `3000947` |  |  |
| 照片 | `3000953` |  |  |
| 身分證字號 | `3001021` |  |  |
| 出生日期 | `3000954` |  |  |
| 年齡 | `3000958` |  |  |
| 性別 | `3000956` |  |  |
| 婚姻狀態 | `3001020` |  |  |
| 最高教育程度 | `3001022` |  |  |

**任職資料**

| 中文欄位 | Field ID | 系統 DB 欄位 | 備註 |
|---|---|---|---|
| 在職狀態 | `3000945` | `coaches.is_active` | 過濾「在職」用 |
| 工號 | `3000935` | `coaches.ragic_employee_id` |  |
| 員工帳號 | `3001018` |  |  |
| 部門 | `3000937` |  |  |
| 職稱 | `3000939` |  | 用來區分「教練／行政櫃檯」|
| 直屬主管 | `3000948` |  |  |
| 職等 | `3000949` |  |  |
| 聘雇類別 | `3000955` |  |  |
| 招聘來源 | `3000959` |  |  |
| 公司電話 | `3000936` |  |  |
| 分機 | `3000938` |  |  |
| 手機（公司）| `3001424` | `coaches.phone` |  |
| E-mail（公司）| `3000940` | `coaches.email` |  |
| LINE userid | （由 user 維護，欄位 ID 自定）| `coaches.line_uid` | Task #34 — 教練端 LIFF 自動登入用；`server/services/ragicAdmin.js` 用多重鍵名 fallback + `RAGIC_FIELD_H01_LINE_UID` env 覆寫；空白值不會洗掉系統內已綁定值 |

**到離職與年資**

| 中文欄位 | Field ID | 系統 DB 欄位 | 備註 |
|---|---|---|---|
| 到職滿半年日 | `3005784` |  |  |
| 到職 1 週年日 | `3005785` |  |  |
| 到職多週年日 | `3005848` |  |  |
| 到職日期 | `3000943` |  |  |
| 離職日期 | `3000944` |  |  |
| 到期日期 | `3001091` |  |  |
| 工作年資計算 | `3003650` |  |  |
| 工作年資 | `3003651` |  |  |
| 享有特休(日) | `3003652` |  |  |
| 享有特休(時數) | `3003653` |  |  |
| 工作年資(月) | `3003654` |  |  |
| 備註 | `3000957` |  |  |

**個人聯絡**

| 中文欄位 | Field ID | 系統 DB 欄位 | 備註 |
|---|---|---|---|
| 聯絡電話 | `3000975` |  |  |
| 手機（個人）| `3000941` |  | 與 `3001424` 公司手機區分 |
| Email（個人）| `3000976` |  |  |
| 通訊地址 | `3000977` |  |  |
| 戶籍地址 | `3001019` |  |  |

**緊急聯絡人 Subtable（key `3001028`）**

| 中文欄位 | Field ID | 備註 |
|---|---|---|
| 姓名 | `3000979` | subtable key |
| 關係 | `3001027` |  |
| 住家電話 | `3001029` |  |
| 公司電話 | `3001030` |  |
| 手機 | `3001031` |  |

**工作經歷 Subtable（key `3000985`）**

| 中文欄位 | Field ID | 備註 |
|---|---|---|
| 公司名稱 | `3000982` | subtable key（注意 `3000985` 為 subtable id，而 `3000982` 為「公司名稱」欄位本體）|
| 職稱 | `3000983` |  |
| 開始日期 | `3000984` |  |
| 結束日期 | `3000986` |  |
| 工作描述 | `3000987` |  |
| 年資 | `3001032` |  |

**學歷 Subtable（key `3000989`）**

| 中文欄位 | Field ID | 備註 |
|---|---|---|
| 學校名稱 | `3000965` | subtable key（`3000989` 為 subtable id）|
| 學歷 | `3000988` |  |
| 畢/肄業 | `3001092` |  |
| 主修 | `3000990` |  |
| 入學日期 | `3000991` |  |
| 結業日期 | `3000992` |  |

---

## H05 場館清單與銀行

### 表單資訊
| 項目 | 值 |
|---|---|
| 表單網址 | <https://ap7.ragic.com/xinsheng/ragicforms4/7> |
| AP_Name | `xinsheng` |
| Key Field | `1000256`（英文縮寫）|
| 合約狀態 subtable key | `1005366` |

### 完整欄位對照
**部門／場館主檔**

| 中文欄位 | Field ID | 系統 DB 欄位 | 備註 |
|---|---|---|---|
| 部門編號 | `1000253` | `venues.id` |  |
| 部門名稱 | `1000254` | `venues.name` |  |
| 總機構代號 | `1001012` |  |  |
| 總機構名稱 | `1001013` | `venues.bank_institution_name` | 銀行欄位之一 |
| 英文縮寫 | `1000257` |  | Key Field |
| 分支機構代號 | `1001014` |  |  |
| 分支機構名稱 | `1001015` | `venues.bank_branch_name` | 銀行欄位之一 |
| 營運性質 | `1002826` |  | 過濾「內勤單位」用 |
| 戶名 | `1001016` | `venues.account_holder` |  |
| 部門縣市 | `1000255` |  |  |
| 帳號 | `1001017` | `venues.account_number` |  |
| 部門區域 | `1000269` |  |  |
| 其他地址 | `1000270` |  |  |
| 完整地址 | `1000271` | `venues.full_address` |  |
| 發文字號 | `1003917` |  |  |
| 完整部門名稱 | `1000275` |  |  |
| 發文地址 | `1003918` |  |  |
| 履約狀態 | `1002871` |  | 過濾「履約中」用 |
| 統一編號 | `1000352` |  |  |
| google map | `1006594` |  |  |
| 稅籍編號 | `1004537` |  |  |
| 建立日期 | `105` |  | Ragic 系統欄位 |
| HN | `1006062` |  |  |
| 最後更新日期 | `109` |  | Ragic 系統欄位 |
| 今天日期 | `1006144` |  |  |
| 官方Line | `1005352` |  |  |
| Line 官方帳號名稱 | `1005353` |  |  |

**合約狀態 Subtable（key `1005366`）**

| 中文欄位 | Field ID | 備註 |
|---|---|---|
| 合約狀態 | `1006145` |  |
| 標案名稱 | `1005361` |  |
| 性質 | `1005360` |  |
| 標案編號 | `1005995` |  |
| 合約起始日 | `1005362` |  |
| 合約結束日 | `1005363` |  |
| 主約+續約年限 | `1005365` |  |
| 標案網址 | `1005999` |  |
| 備註 | `1005364` |  |
| 驗證合約結束是否正確 | `1006000` |  |
| 標案唯一值 | `1006064` |  |

---

## Z01 家長帳號

### 表單資訊
| 項目 | 值 |
|---|---|
| 表單網址 | <https://ap7.ragic.com/xinsheng/general-information/6> |
| AP_Name | `xinsheng` |
| Key Field | `1001113` |
| 項次 subtable key（學員清單）| `1001119` |

### 完整欄位對照
**家長主檔**

| 中文欄位 | Field ID | 系統 DB 欄位 | 備註 |
|---|---|---|---|
| 家長姓名 | `1001101` | `parents.name` |  |
| 館別 | `1002174` | `parents.primary_venue_id` |  |
| 系統登入密碼 | `1003715` |  | 對應舊系統，新系統採 LINE Login |
| (報)行動電話 | `1001100` | `parents.phone` | 主要查詢欄位 |
| (報)身分 | `1002177` |  |  |
| 家長帳號(引) | `1003718` |  | Ragic 內部引用欄位 |
| (報)性別 | `1001121` | `parents.gender` |  |
| 服務單位 | `1002179` |  |  |
| (報)Email | `1002820` | `parents.email` |  |
| (服)員工編號 | `1002180` |  |  |
| 家長帳號 | `1002817` |  |  |
| line對話網址 | `1002390` |  |  |
| line網址狀態 | `1002827` |  |  |
| 住家電話 | `1001122` |  |  |
| 泳隊Line識別碼 | `1004429` |  |  |
| LINE ID | `1001123` |  |  |
| 住家地址 | `1001124` |  |  |
| 資料建立人 | `1001111` |  |  |
| 建立日期 | `105` |  | Ragic 系統欄位 |
| 建立年月 | `1002829` |  |  |
| 最後更新日期 | `109` |  | Ragic 系統欄位 |
| 最後編輯人 | `1002184` |  |  |
| 名下有幾位學生 | `1001138` |  |  |

**項次 Subtable（key `1001119`，每一筆代表家長名下的一位學員）**

| 中文欄位 | Field ID | 備註 |
|---|---|---|
| 項次 | `1001120` |  |
| 學員身分 | `1002178` |  |
| 學員姓名 | `1001115` |  |
| 出生年月日 | `1001116` |  |
| (學)性別 | `1001117` |  |
| 身分證字號 | `1001118` |  |
| 血型 | `1001880` |  |
| 歲數 | `1001330` |  |
| 學員編號 | `1001132` |  |
| 登記電話 | `1004090` |  |
| (引)學員ID | `1004091` |  |
| 統計 | `1004093` |  |
| 唯一值(身分英文) | `1001136` |  |
| 唯一值(身分後2) | `1001133` |  |
| 唯一值(手機末2) | `1001137` |  |
| 唯一值(手機3-4碼) | `1001135` |  |

---

## Z02 學員資料

> 本節欄位 ID 來源：直接呼叫 `GET https://ap7.ragic.com/xinsheng/general-information/11?api&def=1` 抓回的 schema（表單名稱「Z02-學員資料管理(含購買紀錄查詢)」）。
> 使用者最初提供的 Markdown 附件中 Z02 欄位與 Z01 完全相同，已確認為附件複製貼上錯誤；本表已用線上實際 schema 覆蓋。

### 表單資訊
| 項目 | 值 |
|---|---|
| 表單網址 | <https://ap7.ragic.com/xinsheng/general-information/11> |
| AP_Name | `xinsheng` |
| Title Field（標題欄位）| `1001115`（學員姓名）|
| 唯一鍵欄位（去重用）| `1001132`（學員編號）、`1001118`（身分證字號）兩者皆設 `attr_noDup` |
| 緊急聯絡人 Subtable ID | `1001170` |
| 購買紀錄(常態團體班) Subtable ID | `1001458` |
| 購買紀錄(課後班) Subtable ID | `1004109` |

> 一筆 Z02 紀錄＝一位學員（與 Z01「家長帳號」是父子關係，Z01 的項次子表記學員清單，Z02 才是真正的學員主檔）。

### 完整欄位對照

**主檔（基本資料）**

| 中文欄位 | Field ID | 型別 | 系統 DB 欄位 | 備註 |
|---|---|---|---|---|
| 學員編號 | `1001132` | D | `students.student_code` | `noDup` 自動編號（如 `A231842157`）|
| 學員身分 | `1002178` | L |  | 選項：`01.一般生` / `02. 免費生` / `03. 教職員` / `04. 特約` |
| 學員姓名 | `1001115` | D | `students.name` | Title field |
| 學(性別) | `1001117` | L | `students.gender` | 選項：`生理男` / `生理女` / `不方便透漏` |
| 出生年月日 | `1001116` | D | `students.birth_date` | 格式 `Ry/MM/dd` |
| 身分證字號 | `1001118` | D | `students.id_number` | `noDup`，正規 `^[A-Z][0-9]{9}$`（**查詢學員的主鍵**）|
| 血型 | `1001880` | L | `students.blood_type` | 選項：`A` / `B` / `AB` / `O` / `不清楚` 等 |
| 歲數 | `1001330` | D |  | 由出生日期計算 |

**主檔（家長／報名人關聯欄位）**

| 中文欄位 | Field ID | 型別 | 系統 DB 欄位 | 備註 |
|---|---|---|---|---|
| 館別 | `1002175` | L | `students.primary_venue_id` | 與 Z01 的「館別」`1002174` 不同，這是 Z02 專用欄位 |
| (報)行動電話 | `1001113` | L |  | 報名人手機（連動 Z01 家長）|
| 家長帳號 | `1002830` | L |  | 連動 Z01 家長帳號 |
| 家長姓名 | `1001272` | D |  |  |
| 家長帳號(引) | `1003709` | D |  | Ragic 內部引用 |
| (報)性別 | `1001273` | L |  |  |
| 電話後3碼 | `1003716` | D |  | 用於辨識 |
| (報)身分 | `1002181` | L |  |  |
| 服務單位 | `1002182` | D |  |  |
| (服)員工編號 | `1002183` | D |  |  |
| (報)Email | `1002831` | D |  |  |
| line對話網址 | `1002832` | D |  |  |

**主檔（購買摘要 / 系統欄位）**

| 中文欄位 | Field ID | 型別 | 備註 |
|---|---|---|---|
| 常態團體班 | `1003134` | D | 摘要文字（金額或方案）|
| 課後班 | `1004350` | D | 摘要文字 |
| 資料建立人 | `1001165` | L |  |
| 建立日期 | `105` | D | Ragic 系統欄位 |
| 建立年月 | `1002828` | D |  |
| 最後更新日期 | `109` | D | Ragic 系統欄位 |
| 最後編輯人 | `1001274` | L |  |

**緊急聯絡人 Subtable（stid `1001170`）**

| 中文欄位 | Field ID | 型別 | 備註 |
|---|---|---|---|
| 聯絡順序 | `1001166` | D | 自動 `$SEQ` |
| 緊聯人姓名 | `1001167` | D |  |
| 緊聯人電話 | `1001168` | D |  |
| 關係 | `1001169` | L | 選項：`父母` / `祖父母` / `親戚` / `兄弟姊妹` / `其他` |

**購買紀錄(常態團體班) Subtable（stid `1001458`）**

| 中文欄位 | Field ID | 型別 | 備註 |
|---|---|---|---|
| 報名表狀態 | `1002382` | L | 選項：`正常` / `已退費`，預設 `正常` |
| 報名日期 | `1001466` | D | `yyyy/MM/dd`，預設 `$DATETIME` |
| 報名單號 | `1001451` | D | 自動編號，連結 `/group-class-regular/24` |
| 退費單號 | `1002625` | D |  |

**購買紀錄(課後班) Subtable（stid `1004109`）**

| 中文欄位 | Field ID | 型別 | 備註 |
|---|---|---|---|
| 報名表狀態 | `1004094` | L | 選項：`正常` / `已退費` |
| 報名日 | `1004219` | D | `yyyy/MM/dd HH:mm`，預設 `$DATETIME` |
| 報名單號 | `1004095` | D | 自動編號 `AFS-...`，連結 `/after-school-class/5` |
| 退費單號 | `1004177` | D |  |

---

## Z01 / H01 LINE 登入 / 註冊 對應（DAOS 後端使用）

| 用途 | Ragic 欄位 | Field ID | 本地對應 | 寫入時機 |
|---|---|---|---|---|
| 家教系統 LINE UID（家長登入綁定） | Z01.家教系統uid | `1006846` | `parents.line_uid` | parent-bind-phone（命中時 PATCH）/ parent-register-line（POST） |
| 教練 LINE UID（教練 LINE-only 登入） | H01.個人LINE ID | `1003633` | `coaches.line_uid` | 由管理員預先在 Ragic 填入（**本系統不寫**） |

兩個 Field ID 都可由 env `RAGIC_FIELD_Z01_LINE_UID` / `RAGIC_FIELD_H01_LINE_UID` 覆寫。

### Ragic 子表格 dotted-key payload 寫法
Ragic 主表 + 子表格在一次 POST 內建立時，子表格欄位 key 使用 `{subtableStid}_{rowIndex}_{fieldId}` dotted 寫法。

範例：Z01 註冊一位家長帶 2 位學員（學員子表格 stid = `1001119`，學員姓名 fieldId = `1001115`）：
```json
{
  "1006846": "U_xxxxx",              // 家教系統uid (Z01 主表)
  "1001012": "王小明",                // 家長姓名 (Z01 主表)
  "1001119_0_1001115": "王大寶",      // 子表格第 0 列 學員姓名
  "1001119_0_1001116": "2015/03/01",
  "1001119_1_1001115": "王二寶",      // 子表格第 1 列 學員姓名
  "1001119_1_1001116": "2017/08/12"
}
```

註冊流程：本系統 `POST` 寫入 **Z01 主表 + Z01 子表格**；Ragic 收到後會自動把子表格每一列**複製到 Z02（學員資料管理）** 並產生 Z02 record（透過 Ragic 內建的「子表格產生新表」流程），本系統無需直接 POST Z02。

### Z01 子表格「學員」（stid `1001119`）—— 本系統寫入欄位

| 中文欄位 | Field ID | 本地對應 |
|---|---|---|
| 學員姓名 | `1001115` | `students.name` |
| 出生年月日 | `1001116` | `students.birth_date` |
| 學(性別) | `1001117` | `students.gender` |
| 身分證字號 | `1001118` | `students.id_number` |
| 血型 | `1001880` | `students.blood_type` |
| 學員編號 | `1001132` | `students.student_code`（Ragic 自動編號回拋） |

### 註冊寫入 payload 範例（POST `RAGIC_FORM_Z01`）

採「扁平 dotted key」格式 `<subtable_id>_<rowIndex>_<field_id>`：

```json
{
  "1001101": "張媽媽",
  "1001100": "0912345678",
  "1006846": "Uxxxxxxxxxxxxxxx",
  "1001119_0_1001115": "張小明",
  "1001119_0_1001116": "2015/03/12",
  "1001119_0_1001117": "男",
  "1001119_1_1001115": "張小美",
  "1001119_1_1001116": "2017/08/05"
}
```

> 子表格也接受巢狀 object 形式 `{ "1001119": { "0": {...}, "1": {...} } }`，本服務統一使用扁平 dotted key 避免不同 Ragic Form 設定下 JSON shape 差異。

> Ragic 回傳的 record id 鍵名因帳號 / Form 不同會落在 `data.ragicId`、`data._ragicId` 或 `data.data[<rowKey>]`；服務層三種都試一輪，仍取不到時回 `null` 並把 raw 回傳給 caller。
