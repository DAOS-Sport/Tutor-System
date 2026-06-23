# Ragic（舊系統）→ 新系統 歷史資料完整匯入計畫

> 目標：把 Ragic 的歷史資料**完整 LOAD** 進新系統（Replit Express + PostgreSQL），讓正式切換上線時「新舊系統的縫隙最小化」——舊客戶一進來就看到自己既有的學員、課程與**剩餘堂數**，且第一次 LINE 登入會「接上」預先匯入的資料，而不是建出重複帳號。
>
> 本文件由程式碼實證整理（已對照 `server/services/ragic.js`、`server/bootstrap/coreSchema.js`、`server/routes/auth.js`、`server/routes/admin/enrollments.js` 等）。欄位 ID 來源 `docs/ragic_api.md`，唯一凍結點 `server/config/ragicSchema.js`。

---

## 一、縫隙在哪（現況實證）

新系統**目前不是 Ragic 的完整鏡像**，只有「參考資料」被批次帶入：

| 資料 | 現況 | 證據 |
|---|---|---|
| H01 員工/教練、H05 場館 | ✅ 已批次同步（cron 每 10 分鐘 `queryAllPaged` → staging 審核）| `ragic.js:204/219/233` |
| **Z01 家長** | ❌ 無批次匯入，**只有單筆查詢**（依手機 `getParentByPhone`、依 uid）| `ragic.js`：只有 `getAllStaff/getActiveVenues`，**無** `getAllParents` |
| **Z02 學員** | ❌ 無批次匯入，只在登入時從 Z01 子表懶解析 | 同上，無 `getAllStudents` |
| **購買紀錄/堂數**（常態團體班 `1001458`、課後班 `1004109`）| ❌ **完全沒被讀過** | `1001458/1004109/報名單號` 在 server 程式碼 **0 處**出現，只在 docs |
| 緊急聯絡人（`1001170`）| ❌ 無 parser、**新系統根本沒有這張表** | grep 全無 |
| 退費紀錄 | ❌ 無 `refund_records` 表（只在未套用的 `db/migrations/001`）| 現以 `admin_enrollments.status='refunded'` 表示 |

**核心問題**：家長/學員是「**懶載入**」——只有當某位客戶**親自 LINE 登入並綁定手機命中 Ragic 時**，才會建立一筆本地資料（`auth.js` `syncFromRagicRecord`）。因此：

1. **沒登入過的舊客戶 → 新系統沒有任何資料列**（推播也推不到）。
2. **即使登入了，也看不到任何既有課程與剩餘堂數**——因為沒有任何程式讀 Z02 的購買子表，新系統的堂數帳本（`admin_enrollments`/`course_periods`）完全是 app 自己長出來的，與 Ragic 無連結。

---

## 二、最大未知數（必須先確認，否則無法「完整」）

> ⚠️ **這是整個計畫的成敗關鍵，請先回答。**

Ragic Z02 的兩張購買子表（`1001458`/`1004109`）**只有** `報名單號 / 報名表狀態(正常|已退費) / 報名日期 / 退費單號`，**沒有「總堂數 / 已用堂數 / 剩餘堂數 / 有效期限」欄位**。

而 `報名單號` 是**連結欄位**，指向另外兩張表單：
- 常態團體班 → `/group-class-regular/24`
- 課後班 → `/after-school-class/5`

➡️ **真正的堂數與到期日，極可能存在這兩張「連結報名表單」裡（目前尚未文件化、尚未對應）。**

若無法取得每筆訂單的「已用堂數」與「原始到期日」，匯入時 `剩餘 = 總堂數`、`到期 = NOW()+365`，會**讓每位舊客戶被多送堂數、已過期的方案又復活**。

**需要你提供：**
1. `group-class-regular/24` 與 `after-school-class/5` 的欄位定義（可用 `?api&def=1` 抓 schema），找出：**總堂數 / 已用(已上)堂數 / 有效期限 / 金額**。
2. 子表 `1001458`（團體）/`1004109`（課後）各自對應新系統哪個 `course_type`（1=1對1、2、3…）。

---

## 三、要完整匯入的實體（含冪等鍵）

依 **FK 依賴順序**，每個實體都有「可重跑不重複」的自然鍵：

| 順序 | 實體 | Ragic 來源 | 目標表 | 冪等鍵（upsert key）|
|---|---|---|---|---|
| 0 | 員工/教練、場館 | H01 / H05 | `coaches`/`admin_staff`、`venues`/`admin_venues` | 已由 cron 同步，匯入前先跑一次即可 |
| 1 | **家長** | Z01（新增 `getAllParents`）| `parents` | `phone`（正規化成 `09xxxxxxxx`）|
| 2 | **學員** | Z02（新增 `getAllStudents`）| `students` | `(parent_id, id_number大寫)` → 退而求其次 `(parent_id, name, birth_date)` |
| 3 | 緊急聯絡人 | Z02 子表 `1001170` | **新建 `emergency_contacts`** | 合成鍵 `(owner_id, 電話, 姓名)` |
| 4 | **常態團體班報名/堂數** | Z02 子表 `1001458` (+連結表單) | `admin_enrollments` + `course_periods` + `course_period_enrollments` | `admin_enrollments.ragic_record_id = 報名單號(1001451)` |
| 5 | **課後班報名/堂數** | Z02 子表 `1004109` (+連結表單) | 同上 | `ragic_record_id = 報名單號(1004095)` |
| 6 | 退費 | 子表 `報名表狀態=已退費` | `admin_enrollments.status='refunded'` | 併入 4/5（退費是訂單屬性，非獨立列）|

**必做的 schema 補強（idempotent DDL，加進 `coreSchema.js`）：**
- `ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS ragic_record_id VARCHAR(50);` + 部分唯一索引（仿 `coreSchema.js:749/759`，包在 `RAISE WARNING` 防爆 boot）。**沒有這個外鍵，重跑匯入會重複建訂單。**
- 新建 `emergency_contacts` 表。

---

## 四、為什麼這樣做「縫隙最小化」（接縫消失原理）

匯入時**完全複用登入流程會用到的同一組 upsert 語意**（`auth.js:199` `upsertLocalParent`、`auth.js:240` `upsertLocalStudents`），讓「批次匯入寫出的列」與「日後客戶登入會產生的列」**逐欄一致**：

- 家長以 `phone` upsert、`line_uid` 留 **NULL**（**不要偽造**）。
- 學員以 `(parent_id, id_number)` SELECT-then-insert。

於是切換上線後，真人第一次 LINE 登入：
`parent-line-login`（uid 查無）→ `parent-bind-phone`（用**同一支正規化手機**命中預匯入那筆）→ 把 uid 寫回 Ragic `1006846` → `upsertLocalParent` 走 `ON CONFLICT(phone)` **更新既有列**（`line_uid` 用 `COALESCE` 補上），**而不是新增重複**。學員也以 `(parent_id, id_number)` 接上。

➡️ **真人「接上」預匯入的資料；堂數/歷史/聯絡人早就在 → 接縫對使用者隱形。**

---

## 五、分階段執行（單一腳本 `scripts/import-ragic-history.js`，預設 dry-run、`--apply` 才寫）

腳本骨架沿用 `scripts/heal-coach-staff-orphans.js`（dry-run 預設 + `--apply`，無 dotenv，`NODE_PATH=server/node_modules`）+ `scripts/seed_group_test_sessions.js`（每階段 `BEGIN/COMMIT` 交易）。

- **Stage 0｜前置**：補 `admin_enrollments.ragic_record_id`、建 `emergency_contacts`、重啟套 DDL、強制跑一次 H01/H05 同步；**調高分頁上限**（預設 `RAGIC_MAX_PAGES*RAGIC_PAGE_SIZE = 50*200 = 10000` 會**靜默截斷**大量 Z01/Z02，務必先確認總筆數並調大 env）。
- **Stage 1｜家長**：新增 `ragic.getAllParents()`（仿 `getAllStaff` 用 `queryAllPaged(RAGIC_FORM_Z01)`）；手機正規化（去空白/連字號、全形→半形、+886→0），不符 `/^09\d{8}$/` 的**跳過並記錄**；同手機多筆 Z01 先**標記人工清理**（`getParentByPhone` 只取 `records[0]`）；`ON CONFLICT(phone)` upsert、`line_uid` 留 NULL、`is_active=TRUE`。
- **Stage 2｜學員**：新增 `getAllStudents()`；先建 `phone→parent_id` 記憶體表；以 `(parent_id, id_number大寫)` → `(parent_id,name,birth_date)` SELECT-then-insert（**不可** `ON CONFLICT(id_number)`，現行 schema 非唯一）；查無家長的孤兒學員→記錄跳過。
- **Stage 3｜緊急聯絡人**：複用 Stage 2 已抓的 Z02 payload 解析子表 `1001170`（parser 仿 `parseZ01Students` 容錯三種子表形狀）；以 `(owner, 電話, 姓名)` SELECT-then-insert。
- **Stage 4｜常態團體班**：解析子表 `1001458`；`admin_enrollments` 以 `ragic_record_id=報名單號` upsert；**同時**建對應 `course_period`（堂數/到期取自 Ragic，**不可**用 NOW()+365）並讓兩邊 `total/used_sessions` **相等**（`/api/courses/mine` 讀 `admin_enrollments`、`/api/courses/lessons` 與選課容量讀 `course_periods`，不一致會打架）；coach_id 以教練名+場館反解（`enrollments.js:155`），解不到→只建 `admin_enrollments`、記 `period-skipped`（客戶看得到剩餘堂數但暫無法選課）。
- **Stage 5｜課後班**：同 Stage 4，解析子表 `1004109`、對應各自 `course_type`（注意報名日含 `HH:mm`）。
- **Stage 6｜退費**：併入 4/5——`報名表狀態=已退費` → `status='refunded'`、連動 `course_periods.status='refunded'`、`退費單號` 存 notes/audit；**不動堂數**（與現行退費行為一致）。

每階段寫 `ragic_sync_log(job_name='backfill')`；**錯誤訊息嚴禁帶身分證/手機（PII）**。

---

## 六、切換上線（cutover）順序

1. **乾跑（dry-run）**：完整爬 Ragic、逐階段算「預計 old==new 筆數」+ 重複手機報告 + 孤兒學員報告 + 教練解不到/period-skipped 報告 + 「堂數未知」訂單報告。**先 `pg_dump` 快照**。
2. **正式匯入（`--apply`）**：Stage 0→6 各自交易；cron H01/H05 同步全程無害（不碰 Z01/Z02）。
3. **抓增量**：本系統**沒有也不新增 Z01/Z02 增量 cron**——「登入懶載入」本身就是增量；上線前再跑一次匯入（冪等，安全）補齊匯入期間 Ragic 的異動。
4. **上線**：開放客戶端。靠第四節的「綁定即接上」讓接縫隱形。
- **回滾**：所有寫入都是非破壞性 upsert 且帶 Ragic 來源標記 → 依反向 FK 順序 scoped delete（`ragic_record_id IS NOT NULL`）；parents/students 不硬刪（登入流程可能已合法綁定），改 `is_active=FALSE` 或還原快照。

---

## 七、驗收（證明 old == new）

- **筆數對齊**：`len(queryAllPaged(form))` == `COUNT(*) WHERE ragic_record_id IS NOT NULL`（parents/students/各類訂單）。
- **零重複**：`parents` 同 phone、`students` 同 `(parent_id,id_number)`、`admin_enrollments` 同 `ragic_record_id` group by having count>1 == 0。
- **雙帳本一致**：`admin_enrollments` 與 `course_periods` 的 `total/used_sessions` 必須相等（否則 `/mine` 與 `/lessons` 不同調）。
- **不超發堂數**：每筆 confirmed 訂單都有 used 值；抽 10 筆 `剩餘=總-已用` 對得上 Ragic。
- **到期非預設**：無 `course_periods.expires_at = CURRENT_DATE+365` 的匯入列。
- **接縫煙霧測試**：staging 拿一位「沒登入過」的真客戶跑登入+綁定，斷言**沒新增重複列**（只補 line_uid）、`/api/courses/mine` 出現其匯入課程與正確剩餘。

---

## 八、需要你拍板的決策

1. **【最重要】堂數/到期來源**：`group-class-regular/24`、`after-school-class/5` 的欄位定義？哪欄是總堂數/已用/有效期限？（見第二節）
2. **course_type 對應**：`1001458`/`1004109` 各對應哪個 `course_type` 整數？
3. **退費訂單要不要匯**：建議以 `status='refunded'` 匯入（保留歷史、不顯示為進行中）。
4. **緊急聯絡人掛誰**：掛 `student_id`（子表在 Z02，自然）或 `parent_id`？
5. **同手機多筆 Z01**：只匯第一筆+標記人工清理，或先請 HR 在 Ragic 去重再匯？
6. **分頁上限**：Z01+Z02 實際總筆數多少？以便調大 `RAGIC_MAX_PAGES`（避免 10000 靜默截斷）。
7. **soft-delete race（建議修）**：`auth.js` 在 Ragic 查詢「暫時失敗」時會把家長 `is_active=FALSE`，而 `requireParent` 以 `is_active=TRUE` 為門檻——建議改成「暫時性失敗不 soft-delete」，否則匯入的客戶可能因一次抖動的登入而失去存取。

---

## 九、可直接複用的程式（不要重寫）

- `ragic.js:150 queryAllPaged`（表單無關分頁爬蟲）、`:218 getAllStaff` 為樣板新增 `getAllParents/getAllStudents`
- `ragic.js:361 mapZ01Parent`、`:392 parseZ01Students`（子表三形狀容錯）→ 家長直接用、購買/緊急子表 parser 照抄改 stid
- `auth.js:199 upsertLocalParent`、`:240 upsertLocalStudents`（**接縫隱形的關鍵**：匯入列＝登入會產生的列）
- `enrollments.js:150 ensureSoloCoursePeriod`（教練反解 + course_period SELECT-then-insert + 名冊 ON CONFLICT）→ 改成注入 Ragic 堂數/到期
- `coreSchema.js:749/759`（ragic_record_id + 部分索引樣式）、`:401`（RAISE-WARNING 包唯一索引）、`:612 ragic_sync_log`
- 腳本骨架：`scripts/heal-coach-staff-orphans.js`（dry-run/--apply）+ `scripts/seed_group_test_sessions.js`（交易）
