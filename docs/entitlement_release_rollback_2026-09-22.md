# 課程權益守門 —— 發布與回滾（2026-09-22）

搭配 `docs/entitlement_repair_2026-09-22.md` 一起看。**歷史資料先處理，程式才發布。**

分支 `fix/tutor-audit-20260918`，基底 Draft PR #8 `bfacacd4`。
正式環境目前跑 `76a5d51`，**PR #8 與本輪修補都還沒上線**。

---

## 1. 這次會上什麼

### 程式

| 檔案 | 性質 |
|---|---|
| `server/services/courseEntitlements.js` | 三處守門修補（T1／T2／T4） |
| `server/routes/checkins.js` | **凍結檔，已取得 Owner 同意**。兩處：T5 預約制簽到加 `requireActiveStudent`；自助簽到改成「濾掉不合格的學員」而不是整批拒絕 |
| `server/cron/index.js` | **凍結檔，已取得 Owner 同意**。到期提醒只發給「還有堂數沒上完」的課期；觸發條件由等號改為區間 |
| `server/services/line.js` | 教練簽到通知改版：標題固定為「🔔學員簽到通知🔔」，學員改列進內文第一欄 |
| `client/liff/src/pages/CoachTodayPage.jsx` | 教練端首頁版面改版（到期卡標題／組數徽章／紅色提醒藥丸／剩餘天數配色／頁首） |

### 測試

| 檔案 | 性質 |
|---|---|
| `tests/course_entitlement_is_active_db_test.js` | 新增，17 案例（含並行／重送／故障／兄弟姊妹） |
| `tests/counter_entitlement_routes_db_test.js` | 新增，7 案例（櫃檯與家長端入口的真實路由行為） |
| `tests/expiry_reminder_scope_db_test.js` | 新增，8 案例（直接抽 cron 的 SQL 來跑） |
| `tests/coach_home_layout_test.js` | 新增，9 案例（真元件渲染，鎖版面契約） |
| `tests/coach_push_scope_test.js` | 改：原本鎖「標題不用 emoji」「主標＝學員名單」的兩條已被 Owner 推翻，改成正面斷言新規格 |
| `tests/sessions_venue_options_test.js` | 改：去除對資料長相的依賴 |
| `tests/weekly_filters_2026_09_test.js` | 改：到期卡標題改名，跟著改點擊目標 |
| `scripts/run-tests.js` | 把四支新測試登記進對應層級 |

### 文件

`docs/entitlement_repair_2026-09-22.md`（歷史修復計畫）、本文、
`docs/parent_account_business_logic_2026-09-22.md`（家長帳號業務邏輯盤點）。

**沒有 schema 變更、沒有 migration、沒有 feature flag 變更。**
純程式邏輯 + 測試 + 文件，所以回滾非常乾淨（見 §4）。

---

## 2. 發布前的門檻（每一項都要有人簽名）

1. **修復計畫 §2 的 4 個課期已逐筆處理**。
   沒處理就發布 → 那 3 個 active 課期的家長當天簽不進去（409）。
2. **修復計畫 §1 的 2 名學員已判定復學或退出**。
3. 在隔離環境重跑 db 層，確認兩支新測試是綠的：
   ```bash
   node scripts/run-tests.js db
   ```
4. 擁有者對修復計畫 §5 的行為變更表（含凍結令第 3 條相鄰的部分）確認無誤。
   **2026-09-22 已口頭同意，發布前請再對一次那張表。**

---

## 3. 發布步驟

Replit 的部署行為要記住兩件事：

- **Replit 部署的是工作目錄，不是 git commit。** 發布前先確認工作目錄沒有
  別人未提交的改動，否則會一起上線。
- **Replit 先發布、後提交**，所以 `/health` 的 build stamp 會慢一版，
  不能拿它當「上線版本」的憑據。

步驟：

1. 確認工作目錄乾淨（`git status`），沒有其他人未提交的檔案。
2. 重建後台前端（`client/admin`）—— 本次雖然沒改前端，但 PR #8 有，
   一起上線時仍需重建。
3. Publish。
4. 發布後立刻驗：
   - `GET /api/health` 回 200。
   - 拿修復計畫 §2 處理過的課期，實際走一次自助簽到 → 應該**成功**（不是 409）。
   - 拿一個正常的跨家庭共享課期走一次自助簽到 → 應該成功，且
     `attendance_count` 等於名單上**未停用**的人數。
   - 找一個櫃檯同事實際做一次「單人課期的手動扣課」→ 應該照舊成功。
   - 查 log 有沒有出現 `ENROLLMENT_SOURCE_UNRESOLVED`。
     **出現就代表還有沒清到的課期**，立刻列出來人工處理。

---

## 4. 回滾

因為沒有 schema 變更，回滾就是把程式退回去，**不需要動資料庫**。

**回滾條件（任一成立就退）**：

- 24 小時內出現 3 次以上 `ENROLLMENT_SOURCE_UNRESOLVED`，且無法立即補正課期。
- 出現 `REFUND_IDENTITY_REVIEW_REQUIRED` 擋到已付費家庭（目前預期 0 筆，
  一出現就代表對 `enrollment_batch_id` 的理解有誤）。
- 櫃檯回報手動扣課或補簽到被擋，而學員其實該正常上課
  （先確認是不是該學員的 `is_active` 被誤設成停用 —— 那要修資料不是退程式）。

**回滾方式（三選一，由輕到重）**：

**四塊是獨立的，可以分開退**（到期提醒、通知文案、首頁版面、權益守門互不相依）：

| 想退什麼 | 指令（基準 `bfacacd4`） |
|---|---|
| 到期提醒 | `git checkout bfacacd4 -- server/cron/index.js` |
| 簽到通知文案 | `git checkout bfacacd4 -- server/services/line.js` |
| 教練首頁版面 | `git checkout bfacacd4 -- client/liff/src/pages/CoachTodayPage.jsx`（要重建前端） |
| 權益守門 | 見下方第 1 點 |

1. **只退權益守門這兩個檔案**（最小、最快）：
   ```bash
   git checkout bfacacd48e097c91bb7bfb03b2f4ceee346b9a22 -- server/services/courseEntitlements.js server/routes/checkins.js
   ```
   ⚠️ 退 `checkins.js` 會一併退掉「自助簽到濾掉不合格學員」那一段 —— 退回去之後，
   **一個孩子停學就會讓整家簽不進去**（正式庫有 321 個課期／198 位家長是這種形狀）。
   只有在權益守門本身出事時才退這個檔，不要為了別的原因順手退。
   守門行為立即回到 PR #8 的狀態，測試與文件留著。
   **只退 `checkins.js`（保留 T1/T2/T4）也是安全的組合** —— 那只會讓
   「預約制簽到對單人課期停用學員」回到會扣堂卻報 500 的舊行為，
   其餘守門仍在。反之**不要只退 `courseEntitlements.js`**：
   `requireActiveStudent` 這個參數會變成沒人認得的第四參數（舊版直接忽略，
   不會報錯，但 T5 也就跟著失效），等於默默退回舊行為。
2. **退回 PR #8 整包**：切回 `bfacacd4`。
3. **退回正式現行版**：切回 `76a5d51`。注意這會同時退掉 PR #8 對
   Issue #1／#2／#3／#5／#6／#7 的修補，範圍大得多。

**回滾後要補做的事**：退回去就等於那 3 個「查不到來源報名」的課期
重新變成可簽到的缺口。回滾不是結案，要另外排人工處理。

---

## 5. 發布後要持續盯的訊號

| 訊號 | 意義 | 該做什麼 |
|---|---|---|
| `ENROLLMENT_SOURCE_UNRESOLVED` | 還有課期對不回來源報名 | 逐筆補 `admin_enrollment_id` |
| `STUDENT_ENTITLEMENT_INACTIVE` | 有人拿停學學員簽到／扣課 | 確認該學員是否應復學 |
| `REFUND_IDENTITY_REVIEW_REQUIRED` | 團報／共班的退款識別有歧義 | 人工核對，**不要批次放行** |
| 課堂 `session_deducted=TRUE` 但無出席紀錄 | T5 想擋的情境又出現了 | 這代表還有別的入口沒收；立刻回報 |

最後一項可以用這個查（唯讀）。**2026-09-22 在正式庫跑過，結果是 0 筆**：

```sql
SELECT cs.id, cs.course_period_id, cs.completed_at
  FROM course_sessions cs
 WHERE cs.session_deducted = TRUE
   AND cs.status::text NOT LIKE 'cancelled%'
   AND NOT EXISTS (SELECT 1 FROM checkin_records cr
                    WHERE cr.course_session_id = cs.id AND cr.attendance_status = 'ATTENDED')
 ORDER BY cs.completed_at DESC;
```

---

## 6. 本輪測試環境（要重現請照這個湊）

本機 Windows，隔離環境不是 Replit：

- WSL2 PostgreSQL **16.15**，庫名必須是 `daos_test`（多支測試硬性斷言
  `/^\/daos_(audit|test)/` 且主機必須是 loopback）。
- WSL2 自己的 localhost 轉發會間歇掉線 → 另架一條 Windows 端 TCP relay
  聽 `127.0.0.1:15432` 轉到 WSL 的 5432，並用一個不會退出的 WSL 進程
  把 distro 釘住。
- schema 用 `server/bootstrap/admin` + `server/bootstrap/coreSchema` 建
  （不是 `db/migrate.js`）。建完 104 表 / 961 約束。
- `NODE_PATH` 要指到 `server/node_modules`（root `node_modules` 是空的，
  而 `tests/release/*` 的 `require('express')` 從檔案所在目錄往上找）。
- 伺服器起在 3001，測試進程的 `JWT_SECRET` 必須與伺服器一致，否則測試
  自己 `signToken` 會全部被判 401。
- e2e 需要 `BASE_URL=http://127.0.0.1:3001`，且測試庫要有 `manager` 帳號
  （bootstrap 只種 `admin` / `staff`）並給它場館範圍，否則 B/E/F/G/H 會紅。
