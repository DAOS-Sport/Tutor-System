# 時區稽核報告（2026-10，Issue #11）

目標（Owner 定義）：程式碼全面統一台灣時間（Asia/Taipei，固定 UTC+8、無日光節約）；
任何日期／時間邏輯都不得因為「伺服器或瀏覽器的時區不同」而算錯日期。

稽核基準：`main` @ d7fc0a4（2026-10-19）。行號為本次修正後的行號。

## 一、結論摘要

| 層 | 現況 | 本次處理 |
|---|---|---|
| 執行環境 | 正式機 container／Node／DB 皆 `Asia/Taipei`；`server/index.js:4` 強制 `process.env.TZ`；`models/db.js` 每條連線 `-c timezone=Asia/Taipei`；`coreSchema.js:31-39` `ALTER DATABASE ... SET timezone` | 保留（作為保險），但**程式語意不再依賴它們** |
| Node 端共用 helper | `server/utils/dateTime.js`（Intl + `Asia/Taipei`）、`server/utils/sessionDateSql.js`（SQL 片段）| 新增 `taipeiMonthKey`、`parsePgDateAsTaipei`、`parsePgTimestampAsTaipei`、`taipeiDayStart` |
| pg 回傳值解析 | pg 預設把 `DATE`／`TIMESTAMP`（無時區）用「Node 行程本地時區」解讀 → 正確性全靠 `process.env.TZ` | **已修**：`models/db.js` 改以台北牆鐘解讀（TZ=Taipei 下輸出逐位元不變）|
| SQL 業務日期 | 大部分已寫 `AT TIME ZONE 'Asia/Taipei'`；報表／MGM／評鑑／課程需求仍用 `::date`、`CURRENT_DATE`、`DATE_TRUNC` 吃連線 TimeZone | **已修** 4 檔；凍結檔 2 處、未授權檔 1 處列於「三、未修」 |
| JS 業務日期 | 多數已用 `formatPlainDate`／`taipeiToday`／`+08:00`／固定 +8h 位移 | **已修** 2 處（評鑑月份、學員稽核生日） |
| 前端顯示 | `client/admin/src/utils/format.js`、`client/liff/src/utils/format.js` 皆固定台北；共用元件 `DateRangeSheet`／`DateTimePicker` 用 UTC getter + 8h | **已修** 2 處 `slice(0,10)` 取到 UTC 日期 |
| 匯出（CSV/XLSX）| 檔名 `todayISO()`、內容 `formatTWDateTime`／`Intl ... timeZone:'Asia/Taipei'` | 無須修 |
| 通知文字（LINE／Email）| `line.js twTime()`（+8h）、`emailTemplates.js formatTaipeiDateTime`、cron 到期提醒 `formatPlainDate` | 無須修 |
| Cron 排程 | `cron/index.js:13` `timezone:'Asia/Taipei'`；`cron/slots.js` 固定 +8h | 排程正確；查詢內 `CURRENT_DATE` 屬凍結檔，列入未修 |

迴歸鎖：
- `tests/timezone_independence_test.js`（unit）：同一組台北跨日邊界案例在 `TZ=Asia/Taipei／UTC／America/Los_Angeles／Asia/Tokyo／Pacific/Kiritimati` 五個子行程各跑一次，結果必須相同且等於預期；並靜態守衛本次修過的 4 支檔案不得退回 `CURRENT_DATE`、`timestamptz::date`、`toISOString().slice`。
- `tests/timezone_sql_db_test.js`（db）：對真 Postgres 以 `SET LOCAL TimeZone = 'UTC'／'America/Los_Angeles'／'Asia/Taipei'` 求值修正後的 SQL 片段，並同時證明舊寫法在 UTC 下確實會錯（避免案例沒踩到邊界卻綠燈）。

## 二、本次修正清單

| # | 檔案:行 | 問題 | 修法 |
|---|---|---|---|
| 1 | `server/models/db.js:1-14` | pg 預設以 Node 本地時區解析 `DATE`(1082)／`TIMESTAMP`(1114)。TZ≠台北時（測試、腳本、未載入 `index.js` 的行程），DATE 變成別的時刻；TZ 在台北以東（如 Tokyo）時經台北投影會**退回前一天** | 註冊型別解析器，固定以台北牆鐘解讀；infinity／BC 交回 pg 原解析器。正式機（TZ=Taipei）輸出逐位元相同 |
| 2 | `server/utils/dateTime.js` | — | 新增 `taipeiMonthKey()`、`parsePgDateAsTaipei()`、`parsePgTimestampAsTaipei()` |
| 3 | `server/utils/sessionDateSql.js` | — | 新增 `taipeiDayStart(dateExpr)`：台北某日 00:00 的 timestamptz（保留欄位索引） |
| 4 | `server/services/studentAudit.js:15` | 生日用 `getFullYear()/getMonth()/getDate()` 本地 getter，依賴 Node TZ | 改 `formatPlainDate()` |
| 5 | `server/routes/admin/reports.js:68,93,101,102,117,159-163,188` | 營收／堂數／折扣／MGM 轉換／學習完成率報表以 `created_at::date`、`CURRENT_DATE` 切日，吃連線 TimeZone | 改 `taipeiDate(col) BETWEEN $1::date AND $2::date`、`expires_at < 台北今天` |
| 6 | `server/routes/admin/mgmStats.js:25-26` | `rr.created_at >= $n::date`：date 轉 timestamptz 用連線 TimeZone | 改 `>= taipeiDayStart($n)`、`< taipeiDayStart($n::date + 1)` |
| 7 | `server/routes/admin/courseTypes.js:139,189,326` | `CURRENT_DATE`（課程需求生效日、畫面上的「今天」）| 改 `(NOW() AT TIME ZONE 'Asia/Taipei')::date` |
| 8 | `server/services/evaluations.js:146` | 評鑑月趨勢 `DATE_TRUNC('month', submitted_at)` 吃連線 TimeZone | 改 `DATE_TRUNC('month', submitted_at AT TIME ZONE 'Asia/Taipei')` |
| 9 | `server/services/evaluations.js:261` | 不達標偵測月份 `new Date().toISOString().slice(0, 7)` 為 UTC 月份，每月 1 日台北 00:00–08:00 會寫成上個月（UNIQUE 防重也跟著錯月）| 改 `taipeiMonthKey()` |
| 10 | `client/admin/src/pages/CourseTypesPage.jsx:18,140` | `fmtDate` 一律 `slice(0,10)`：對 `created_at`／`updated_at`（ISO 時刻）取到 UTC 日期；後備「今天」用 `new Date().toISOString()` | `fmtDate` 改 `formatPlainDate()`（純日期原樣、時刻投影台北）；後備改 `todayISO()` |
| 11 | `client/liff/src/components/CoachDetailModal.jsx:136` | 優惠迄日 `String(end_date).slice(0,10)`：`end_date` 為 timestamptz，JSON 是 UTC ISO | 改 `formatPlainDate()` |

> 前端原始碼已修，但 `server/public/{admin,liff}` 的 build 產物未在本次重建，需於整合時重新 build。

## 三、未修項目

### 3-1 凍結區（需 Owner 同意，本次未動）

| 檔案:行 | 現況 | 建議改法與理由 |
|---|---|---|
| `server/cron/index.js:221-222`（簽到／扣課凍結令涵蓋的檔案）| 到期提醒 `cp.expires_at >= CURRENT_DATE AND <= CURRENT_DATE + N` | 改 `(NOW() AT TIME ZONE 'Asia/Taipei')::date`。現在正確是因為連線釘了台北；換環境會在台北 00:00–08:00 用前一天當「今天」 |
| `server/cron/index.js:277` | MGM「今天上課」提醒 `cs2.scheduled_at::date = CURRENT_DATE` | 改 `(cs2.scheduled_at AT TIME ZONE 'Asia/Taipei')::date = (NOW() AT TIME ZONE 'Asia/Taipei')::date`（同上） |
| `server/routes/sessions.js:317` | 教練端優惠卡 `p.end_date::text`（timestamptz 轉字串用連線 TimeZone），前端 `CoachTodayPage.jsx:105` 再 `slice(0,10)` | 改 `((p.end_date AT TIME ZONE 'Asia/Taipei')::date)::text`。目前 end_date 存 23:59:59 台北，UTC 下日期仍相同，風險低 |
| `server/bootstrap/coreSchema.js:207`（遷移區塊）| 一次性回填 `COALESCE(effective_date, created_at::date, CURRENT_DATE)` | 已執行過的歷史回填，影響僅限舊資料；不建議再動 |
| `server/bootstrap/coreSchema.js:2342`（示範種子）| 示範課期 `(NOW() + INTERVAL '6 months')::date` | 只影響 demo 資料，不改 |
| `server/routes/admin/enrollments.js` 凍結區（611–1004）| 經檢查無時區問題 | — |

### 3-2 非凍結但本次未改（需確認）

| 檔案:行 | 現況 | 說明 |
|---|---|---|
| `server/routes/admin/enrollments.js:215,409,445` | 課期效期 `(NOW() + (n \|\| ' days')::interval)::date`：以連線 TimeZone 決定「哪一天」 | 這三行在凍結區**之外**，但檔案含凍結區且效期屬 2026-07-16 政策，本次修改被權限分類器擋下，未動。建議改 `((NOW() AT TIME ZONE 'Asia/Taipei') + (n \|\| ' days')::interval)::date`；寫法已在 `tests/timezone_sql_db_test.js` 第 6 組驗證。正式機連線已釘台北，現況結果正確 |
| `server/models/db.js` | `DATE[]`(1182)／`TIMESTAMP[]`(1115) 陣列型別仍用 pg 預設解析器 | 全專案查無回傳這兩種陣列的查詢；有需要再補 |
| `client/liff/src/pages/{ProfilePage,RegisterPage,CoachHistoryPage}.jsx:5/15`、`components/group/GroupMemberFields.jsx:5`、`utils/coachGuideDemo.js:14` | 各自重複定義 `todayTaipeiYMD = Date.now()+8h → toISOString().slice(0,10)` | 結果正確（台北固定 +8、無 DST），只是重複；可日後統一改用 `utils/format.js` 的 `todayTaipeiYMD` |

## 四、完整盤點（伺服器）

標記：✅ 明確以台北計算／顯示；⚠️ 依賴連線或行程 TZ（本次已修者另註）；— 與日曆日無關（絕對時刻、相對區間）。

### 4-1 共用基礎
| 位置 | 內容 | 標記 |
|---|---|---|
| `server/index.js:4` | `process.env.TZ = 'Asia/Taipei'`（保險，不再是正確性的前提） | ✅ |
| `server/index.js:120,177-187` | `/health` 回報 app／DB 時區與台北時間 | ✅ |
| `server/models/db.js:1-14` | DATE／TIMESTAMP 以台北解析（本次新增） | ✅ |
| `server/models/db.js:30` | 每條連線 `-c timezone=Asia/Taipei` | ✅ |
| `server/bootstrap/coreSchema.js:31-39` | `ALTER DATABASE ... SET timezone 'Asia/Taipei'` | ✅ |
| `server/utils/dateTime.js` 全檔 | `formatPlainDate`、`taipeiToday`、`addCalendarDays`、`taipeiWeekStart`、`formatTaipeiDateTime`、`formatTaipeiTime`、`taipeiMonthKey`、pg 解析器 | ✅ |
| `server/utils/sessionDateSql.js` 全檔 | `taipeiDate`、`taipeiDayStart`、`taipeiToday`、`todayWhere`、`historyRangeWhere`、`weekRangeWhere` | ✅ |
| `server/utils/sessionDateRange.js:3-15` | 純日期字串驗證與加月（UTC 容器，不涉及時刻） | ✅ |

### 4-2 SQL
| 位置 | 內容 | 標記 |
|---|---|---|
| `routes/admin/reports.js:68-188` | 報表區間 | ✅（本次修） |
| `routes/admin/mgmStats.js:25-26` | MGM 起訖 | ✅（本次修） |
| `routes/admin/courseTypes.js:139,189,326` | 課程需求今天／生效日 | ✅（本次修） |
| `services/evaluations.js:146` | 評鑑月趨勢 | ✅（本次修） |
| `services/evaluations.js:117,196` | `NOW() - INTERVAL` 相對區間 | — |
| `services/courseTypeSchedule.js:23,43-44` | 排程生效 `AT TIME ZONE 'Asia/Taipei'` | ✅ |
| `services/parentPurchaseCheckin.js:23-24` | 今日課程 `date_trunc('day', NOW() AT TIME ZONE ...)` | ✅ |
| `services/transfers.js:65` | 效期 `>= (NOW() AT TIME ZONE 'Asia/Taipei')::date` | ✅ |
| `services/promotions.js:143,256-257`、`routes/admin/promotions.js:123`、`routes/sessions.js:320` | 優惠起訖為 timestamptz，與 `NOW()` 比絕對時刻 | — |
| `routes/admin/periods.js:76` | `self_checkin_date = 台北今天` | ✅ |
| `routes/admin/checkins.js:26,72,97` | 營運日以台北（凍結檔） | ✅ |
| `routes/admin/sessions.js:36-38,248,351,366,448,477-478,511-512,859` | 課表日期／時間（凍結檔） | ✅ |
| `routes/admin/sessions.js:263` | `admin_today_sessions.date`（DATE 欄位直接比） | ✅ |
| `routes/admin/checkouts.js:208-209` | 送出日篩選 | ✅ |
| `routes/integrations.js:45-47,74-87,149-161` | 救生台查詢 | ✅ |
| `routes/slots.js:34-46,136,292`（凍結檔） | 時段產生、效期 | ✅ |
| `routes/checkins.js:68,185,222,366`（凍結檔） | 自助簽到「今天」 | ✅ |
| `routes/courses.js:40,44,206-210,602-606`（凍結檔） | 課表範圍、今日簽到 | ✅ |
| `cron/index.js:221-222,277`（凍結檔） | `CURRENT_DATE` | ⚠️ 見 3-1 |
| `routes/sessions.js:317`（凍結檔） | `p.end_date::text` | ⚠️ 見 3-1 |
| `routes/admin/enrollments.js:215,409,445` | 效期 `(NOW()+n days)::date` | ⚠️ 見 3-2 |
| `bootstrap/coreSchema.js:190` | 排程欄位遷移 `::timestamp AT TIME ZONE 'Asia/Taipei'` | ✅ |
| `bootstrap/coreSchema.js:207,2342` | 遷移回填／示範種子 | ⚠️ 見 3-1（不改） |
| `bootstrap/familySchema.js:133,149`、`services/familyAdmin.js:446`、`services/coachPortalSession.js:21`、`services/referrals.js:179`、`services/ragicWebhookAttempts.js:49`、`services/ragicAdmin.js:4679`、`routes/admin/ragicStatus.js:166` | `NOW() ± INTERVAL` 的到期／保留期限 | — |
| `routes/admin/families.js:381-447` | `to_char(birth_date, ...)`（DATE 欄位，無時區） | ✅ |

### 4-3 Node 端日期運算與文字
| 位置 | 內容 | 標記 |
|---|---|---|
| `cron/index.js:13` | `cron.schedule(..., { timezone: 'Asia/Taipei' })` | ✅ |
| `cron/index.js:244` | 到期提醒文字 `formatPlainDate(cp.expires_at)` | ✅ |
| `cron/slots.js:29,40-58` | 每日時段 key、補跑判斷固定 +8h | ✅ |
| `services/line.js:710-717` | 通知時間 `twTime()` 固定 +8h | ✅ |
| `services/emailTemplates.js:134,231,254` | `formatTaipeiDateTime` | ✅ |
| `services/slots.js:55`（凍結檔） | 衝突訊息 `formatTaipeiDateTime` | ✅ |
| `services/evaluations.js:261` | 不達標月份 | ✅（本次修） |
| `services/studentAudit.js:15` | 生日比對 | ✅（本次修） |
| `services/sessionRecordMerge.js:13,29`、`services/lessonSequence.js:68-69` | 固定 +8h 取台北日期 | ✅ |
| `services/ragic.js:108-113` | Ragic 查詢時間 +8h | ✅ |
| `services/ragicAdmin.js:2417,2426`、`services/z03IdentityClaim.js:38`、`routes/auth.js:1110,1116` | 日期字串以 `+08:00` 解讀 | ✅ |
| `services/ragicWriteback.js:28`、`services/objectStorage.js:87,135,175`、`routes/parents.js:72,126`、`routes/learn.js:219`、`routes/auth.js:205`、`routes/admin/customerParents.js:83`、`routes/admin/customerStudents.js:44,157-158`、`services/familyProfile.js:102` | `formatPlainDate` | ✅ |
| `routes/admin/reports.js:21-28` | 預設區間 `taipeiToday` + `+08:00` | ✅ |
| `routes/admin/courseTypes.js:24-37` | datetime-local 以 `+08:00` 解讀、+8h 顯示 | ✅ |
| `routes/admin/checkouts.js:25-40`、`routes/admin/_customerShared.js:21` | 純日期驗證（UTC 容器） | ✅ |
| `routes/sessions.js:93-118,393-394`（凍結檔） | +8h 計算台北日期與期限 | ✅ |
| `bootstrap/admin.js:13-19,252`、`bootstrap/coreSchema.js:2205-2206` | 種子資料 `taipeiToday` + `+08:00` | ✅ |
| `services/familyProfile.js:124`、`services/familyAdmin.js:602`、`services/parentAccountRecovery.js:206`、`routes/integrations.js:153` | 毫秒相對區間 | — |
| `scripts/birthday-date-diff-report.js:7`、`mcp/index.js:133` | 維運腳本（自設 TZ／檔案 mtime） | —（非業務日期） |

## 五、完整盤點（前端）

| 位置 | 內容 | 標記 |
|---|---|---|
| `client/admin/src/utils/format.js` 全檔 | `formatTWDate`、`formatTWDateTime(Seconds)`、`formatHM`、`todayISO`、`formatPlainDate`、`taipeiInputToDate`、`toTaipeiDateTimeInput`（固定 +8h、UTC getter） | ✅ |
| `client/liff/src/utils/format.js` 全檔 | `formatTWYMD`、`todayTaipeiYMD`、`formatPlainDate`、`taipeiCalendarDate`、`addDaysToTaipeiYMD`、`formatTWDate/Time/DateTime`、`formatTWMonthKey`（Intl `timeZone:'Asia/Taipei'`） | ✅ |
| `client/shared/DateRangeSheet.jsx:18-22`、`client/shared/DateTimePicker.jsx:106-112` | 日曆格與「今天」（UTC 容器 + 8h） | ✅ |
| `client/shared/ErrorBoundary.jsx` | 錯誤時間台北 | ✅ |
| `client/admin/src/utils/csvExport.js:76,88,96,101` | 匯出時間 `formatTWDateTime`、檔名 `todayISO()` | ✅ |
| `client/admin/src/utils/sessionReportRows.mjs:5-12,66` | 課表匯出 Intl `timeZone:'Asia/Taipei'`；日期驗證 | ✅ |
| `client/admin/src/utils/sessionDateRange.mjs:13`、`reconcileDateRange.mjs:7-18`、`pages/SessionsPage.jsx:25`、`components/DateRangeSelect.jsx:47` | 純日期天數差（UTC 容器） | ✅ |
| `client/admin/src/pages/ReportsPage.jsx:10,21`、`MgmStatsPage.jsx:16`、`CoachEvalPage.jsx:23` | `todayISO()` | ✅ |
| `client/admin/src/pages/promotions/PromotionFormModal.jsx:25` | 台北日期 | ✅ |
| `client/admin/src/components/RagicTimelinePanel.jsx:28` | Intl `timeZone:'Asia/Taipei'` | ✅ |
| `client/admin/src/pages/ReconcilePage.jsx:693` | `toTaipeiDateTimeInput(...).slice(0,10)` | ✅ |
| `client/admin/src/pages/CourseTypesPage.jsx:18,140,469` | 日期顯示、今天、迄日判斷 | ✅（18、140 本次修） |
| `client/admin/src/pages/ManualDeductionPage.jsx:181-436`（凍結頁） | datetime-local 以台北 | ✅ |
| `client/admin/src/pages/ManualEnrollPage.jsx`（手動建檔凍結）| 僅金額 `toLocaleString`，無日期邏輯 | — |
| `client/liff/src/components/CoachDetailModal.jsx:136` | 優惠迄日 | ✅（本次修） |
| `client/liff/src/pages/CoachTodayPage.jsx:105` | 優惠迄日 `slice(0,10)`，來源為凍結檔 `sessions.js:317` 的 `::text` | ⚠️ 見 3-1 |
| `client/liff/src/pages/CoachScheduleWeekPage.jsx:19-29`、`components/coach/MonthGrid.jsx:6-33` | 週／月格以 `taipeiCalendarDate` + UTC getter | ✅ |
| `client/liff/src/components/coach/AddSlotModal.jsx:10` | 時段 `+08:00` | ✅ |
| `client/liff/src/components/coach/EnrollmentRow.jsx:126` | `formatTWYMD` | ✅ |
| `client/liff/src/pages/{ProfilePage,RegisterPage,CoachHistoryPage}.jsx`、`components/group/GroupMemberFields.jsx:5`、`utils/coachGuideDemo.js:14`、`utils/guideDemo.js:96-98` | `Date.now()+8h → toISOString().slice(0,10)` | ✅（重複實作，見 3-2） |
| `client/*/src/api/mock.js`、`familyMock.js` | 示範資料 | —（不影響正式資料） |

## 六、`toISOString().slice(0,10)` 五處複核

`server/cron/slots.js:42,46`、`server/utils/sessionDateRange.js:6,14`、`server/services/sessionRecordMerge.js:13,29`、`server/services/lessonSequence.js:68`、`server/mcp/index.js:133`：
前四者皆先 +8h 或作用在 UTC 容器的純日期上，結果正確；`mcp/index.js` 是檔案修改日，與業務日期無關。
唯一真正有問題的是 `services/evaluations.js` 的 `.slice(0, 7)`（UTC 月份），已修。
