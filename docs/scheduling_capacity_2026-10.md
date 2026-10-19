# 排程／容量／尖峰負載檢查（2026-10，GitHub #10）

> 範圍：autoscale 部署下排程「漏跑／重複跑」、附件與驗證紀錄的容量、開放報名尖峰負載。
> 本文件的壓測數字一律是**本機沙箱**（單一 Node 行程＋本機 PostgreSQL 16、4 vCPU），**不是正式環境數字**。

## 0. 一頁結論

| 項目 | 狀態 |
|---|---|
| 8 支每日排程：多台只跑一次、縮到 0 台會補跑、寫 `job_runs` | ✅ 已在 main（`server/cron/slots.js`，2026-10-14），本次再加「多行程」測試證明 |
| 每分鐘／5 分鐘／每小時排程重複跑是否安全 | ✅ 6 支安全；❌ 1 支不安全（期末評鑑 7 天提醒會重複推播）→ **本次已修**（非凍結的 `services/evaluations.js`） |
| `ragic_z01_uid_schema_verifications` 無限成長 | ✅ 本次加保留期（預設 30 天、可設 7–365 天），永遠保留新鮮度判斷要用的那一列 |
| 附件（`uploaded_files` 349 MB／DB 456 MB） | 📄 現況與建議政策見 §3；搬遷需 Owner 在正式環境執行 |
| 開放報名尖峰 | ⚠️ **壓測抓到嚴重問題：並發報名 ≥ 10 時整台伺服器永久卡死**（連線池互等）→ 家長報名、團購路由**本次已修**；凍結區還有同型問題 3 處，需 Owner 同意（§4.4） |
| 正式環境壓測 | ⏳ 需 Owner 在預備環境執行（§5） |

---

## 1. 排程逐支判定

正式站是 Replit Autoscale：排程寫在網站程式內，0 台時不跑、多台時每台都跑。
`server/cron/index.js` 屬簽到／扣課凍結檔，本次**未修改**。

### 1.1 每日排程（走 `slots.daily` 時段認領＋補跑）

時段認領：每個「排程＋時段」對應確定性的 `job_runs.id`，`INSERT … ON CONFLICT` 搶到的那台才執行；
`*/5` 與啟動後 1 分鐘的補跑檢查會補「最近一個沒人認領的時段」。推播類只補當天、最晚 20:00。

| 排程 | 時間 | 多台不重複 | 漏跑補跑 | 業務層第二道保險 |
|---|---|---|---|---|
| `ragic_outbox_nightly` | 00:10 | ✅ 時段認領 | ✅ any | outbox 列 `FOR UPDATE SKIP LOCKED` |
| `ragic_backup` | 00:30 | ✅ | ✅ any | ragic_sync 鎖；鎖被占記 retry 重排 |
| `ragic_pull` | 02:30 | ✅ | ✅ any（需 3 小時內有備份成功） | 同上 |
| `ragic_quarantine` | 02:45 | ✅ | ✅ any | 同上 |
| `ragic_staff_venues` | 03:30 | ✅ | ✅ any | 同上 |
| `expiry_reminder` | 09:00 | ✅ | ✅ same_day ≤20:00 | `notification_log` UNIQUE 先 claim 再推 |
| `mgm_trial_today` | 09:30 | ✅ | ✅ same_day ≤20:00 | 同上 |
| `eval_threshold_alert` | 10:30 | ✅ | ✅ same_day ≤20:00 | `eval_threshold_alerts` UNIQUE(coach,metric,月) |

`tests/cron_slots_db_test.js` 另有一條斷言，保證 `cron/index.js` 裡**剛好 8 支**每日排程、cron 運算式與登記時段一致。

### 1.2 非每日排程（不走時段認領，靠業務層去重）

| 排程 | 頻率 | 兩台同時跑 | 判定依據 | 漏跑一輪 |
|---|---|---|---|---|
| Ragic Z01 UID schema 驗證 | `*/5`＋啟動 | ✅ 無害：多一次 Ragic GET、多寫一列證據 | 新鮮度只讀「最新一列」（`getLatestRagicZ01UidSchemaEvidence`） | 15 分鐘 TTL 內下一輪補上；超過則 UID 回寫暫停（fail-closed，設計如此） |
| Ragic webhook 重試 | 每分鐘 | ✅ 安全 | `ragicWebhookInbox.processInbox`：逐列 `FOR UPDATE SKIP LOCKED`，鎖到投影完成 | 下一分鐘補 |
| 聊天室補建 | `*/5` | ✅ 安全 | `INSERT … ON CONFLICT (course_period_id) DO NOTHING` | 下一輪補 |
| 課程需求排程套用 | `*/5` | ✅ 安全 | `UPDATE … WHERE pending_changes = 讀到的值 AND scheduled_* = 讀到的值`：後到的那台 rowCount=0 直接跳過，稽核紀錄只在成功時寫 | 下一輪補；GET 讀取時也會補套用 |
| 上課前 1 小時提醒 | 每小時 :00 | ✅ 安全 | `notification_log` 先 claim（UNIQUE(kind,ref_id,recipient_uid)）才推；推失敗刪 claim | ⚠️ **會漏**：查詢窗是「現在＋60～120 分鐘」，整點那台不在線，那 1 小時內開課的提醒就永遠不會發（見 §1.3） |
| 期末評鑑邀請 (a) | 每小時 :05 | ✅ 安全 | `ensureInvitation`：`INSERT … ON CONFLICT DO NOTHING RETURNING`，只有真的插入的那台會推 | ✅ 回看 25 小時，漏幾輪沒關係 |
| 期末評鑑 7 天提醒 (b) | 每小時 :05 | ❌→✅ **原本會重複推播；本次已修** | 見下 | ✅ 條件是「邀請 > 7 天且未提醒」，漏幾輪沒關係 |
| 每日補跑檢查 | `*/5`＋啟動 | ✅ 安全 | 每支都經 `claimSlot` | — |

**期末評鑑 7 天提醒的修法**（`server/services/evaluations.js` `listInvitesForReminder`）：
原本是單純 `SELECT`，推播成功後才寫 `reminder_sent_at`；兩台在同一個 :05 會拿到同一批、各推一次。
現在取清單時同一條 SQL 在 `notification_log` 插一筆 `kind='evaluation_reminder_claim'` 認領列，
搶到的那台才回傳。認領列的 `sent_at` 當租約起點，**30 分鐘後可再認領** —— 推播失敗（`reminder_sent_at`
沒寫上）時下一小時照樣重試，行為與改版前相同；與上課提醒／到期提醒「先 claim 再推」同一套機制，不新增資料表。
`cron/index.js` 呼叫端不需要改。

### 1.3 凍結區內的發現（未改，需 Owner 同意）

| 位置 | 問題 | 建議改法 |
|---|---|---|
| `server/cron/index.js:144-145`（上課前 1 小時提醒） | 查詢窗固定「現在＋60～120 分鐘」。整點時沒有任何 instance 在線（縮到 0 台、部署中），那個小時開課的家長**不會收到提醒、也不會補**。不是重複問題，是漏發。 | 把窗改成「現在 ～ 現在＋120 分鐘」並排除已開課的，靠既有 `notification_log` 去重；或改走每 5 分鐘、窗 0～120 分鐘。 |
| `server/cron/index.js:338-348`（期末評鑑邀請 (a)） | 邀請列先建立、推播失敗只記 log；之後 `ensureInvitation` 因 ON CONFLICT 不再回傳這列 → 那位家長**永遠收不到邀請推播**（7 天後的提醒 (b) 會補一次）。 | 推播失敗時記錄並於下一輪重推（例：比照 (b) 用 notification_log claim）。 |

---

## 2. 測試證明

| 契約 | 測試 | 本次結果（`daos_test_i10`） |
|---|---|---|
| 多台同一時段只跑一次（同行程 5 個並發） | `tests/cron_slots_db_test.js` §2 | PASS |
| 錯過 00:30 → 補跑一次、不重複；推播類只補當天；寬限 3 分鐘不搶 | `tests/cron_slots_db_test.js` §5 | PASS |
| 夜間 Ragic 鏈跨台順序；retry／error／當機接手 | `tests/cron_slots_db_test.js` §3,4,6 | PASS（7/7） |
| **3 個獨立 node 行程**同時補跑錯過的 00:30 → 只執行 1 次、`job_runs` 記 `catchup`，之後再檢查不重跑 | `tests/cron_dedupe_retention_db_test.js`（新增） | PASS |
| 期末評鑑 7 天提醒：3 台並發取清單每筆只交一次；失敗的租約過期後重試 | 同上（新增） | PASS |
| 驗證紀錄保留期（見 §3.2） | 同上（新增） | PASS（6/6） |

---

## 3. 容量

### 3.1 附件（`uploaded_files`：349 MB／整顆 DB 456 MB）

**現行策略**（`server/services/objectStorage.js`）：

- production 預設 driver＝Replit App Storage（bucket），啟動前 `assertProductionStorageReady()` 實際探測；
- 探測失敗 → **降級**到 PostgreSQL `uploaded_files`（`bytea` 整檔存放），絕不退回本機磁碟（Autoscale 會遺失）；
- 讀取是 read-through：bucket → `uploaded_files` →（開發機）磁碟，同一個 `/uploads/<YYYY-MM>/<id>.<ext>` URL；
- 單檔上限：聊天／學習歷程 25 MB（`CHAT_UPLOAD_MAX_BYTES`）、匯款證明 5 MB、教練媒體 5 MB、發票 5 MB。

**349 MB 在 DB 裡＝正式站大部分時間跑在降級模式**（或曾長期降級）。後果：

1. DB 77% 是圖片／影片；備份、還原、分支（Neon branch）、`pg_dump` 時間與費用都跟著漲；
2. 讀取時 `readFile` 把整個 `bytea` 載進記憶體再回應（25 MB 影片＝25 MB 堆積 × 並發數）；
3. 每次讀圖都占一條 DB 連線（連線池預設 10，見 §4），尖峰時與報名搶連線。

**成長估算方法**（不讀正式資料，請 Owner 在正式 DB 執行）：key 前綴就是上傳月份。

```sql
SELECT substr(key, 1, 7) AS month, COUNT(*) AS files,
       pg_size_pretty(SUM(byte_size)::bigint) AS size
  FROM uploaded_files GROUP BY 1 ORDER BY 1;
SELECT pg_size_pretty(pg_total_relation_size('uploaded_files')) AS table_total;
```

本次沒有正式資料可查，月增量請用上面的 SQL 實測。粗估公式：月增量 ≈ 349 MB ÷ 已累積月數；
例如若是 4～5 個月累積，約 70～90 MB／月，開學季（匯款證明＋聊天照片集中）應以最高月 ×1.5 估，
維持降級模式一年後 `uploaded_files` 約 1.2～1.5 GB —— DB 方案的儲存上限與備份時間要先確認。

**建議政策**（需 Owner 決定，本次未動正式資料）：

1. **先讓 bucket 恢復成主要儲存**：查啟動 log 的 `[objectStorage] bucket preflight failed` 原因並修好。之後新檔不再進 DB。
2. **把 DB 內的舊檔搬到 bucket**：寫一支一次性腳本（逐筆讀 `uploaded_files` → 上傳 bucket 同 key → 驗證 `exists` → 刪 DB 列），
   因為讀取是 read-through，URL 不變、家長端與後台都不用改。搬完 `VACUUM FULL uploaded_files`（需停機窗或 `pg_repack`）才會真的還空間。
3. **保留期依用途分**：匯款證明／發票屬會計憑證，商業會計法要求保存至少 5 年 → **不刪，只搬家**；
   聊天室媒體建議由 Owner 訂保留期（例如課期結束後 1 年），之後才考慮清理。
4. 監控：在後台或 `/health` 加 `uploaded_files` 大小，超過門檻（例 600 MB）告警。

### 3.2 驗證紀錄保留期（`ragic_z01_uid_schema_verifications`）— 本次已實作

- 現況：`*/5` 寫一列、從不清理（約 2.5 萬列，一年約 10.5 萬列；多台時加倍）。
- 讀取端：新鮮度判斷（`assertRagicZ01UidSchemaFresh`）與兩支營運腳本只讀**最新一列**（`ORDER BY fetched_at DESC LIMIT 1`），舊列只剩稽核用途。
- 實作（`server/services/ragicSchemaFreshness.js`）：
  - 每次驗證**寫入成功之後**呼叫 `pruneRagicZ01UidSchemaVerifications()`，刪掉 `fetched_at` 早於 N 天的列；
  - **永遠保留**「最新一列」與「最新一列 `verified=true`」—— 即使 Ragic 連續壞超過 N 天，新鮮度判斷讀到的那列不變，也還查得到「最後一次通過是何時」；
  - 一次最多刪 5000 列（上線第一次要清掉累積的數萬列，分批避免長交易，約 25 分鐘清完）；
  - 清理失敗只記 log，**不讓驗證失敗、不暫停 UID 回寫**。
- 設定：`RAGIC_Z01_UID_SCHEMA_RETENTION_DAYS`，預設 **30**，夾在 **7～365**（空值、非數字→30；設 0 或負數→7，不會一次清光）。
- 穩定後列數約 30×288＝8,640 列／台。

---

## 4. 尖峰（開放報名）

### 4.1 方法

腳本：`tests/perf/open_enrollment_peak.js`（可重現、只允許 localhost＋庫名含 test/audit、任何非預期狀態碼／5xx／逾時／超賣都 exit 1）。

1. **種資料**：N 位家長＋各 1 位學員；一張「限量 K 名」的折價券（`FIXED_AMOUNT` 500、限 1 對 1、限該場館）。
2. **階段 1 瀏覽**：`BROWSE_CONN` 條連線輪流打報名頁的唯讀端點（`/api/venues`、`/api/courses/types`、`/api/courses/base-price`、`/api/promotions`、`/api/coaches`），持續 `BROWSE_SECONDS` 秒。
3. **階段 2 搶名額**：瀏覽持續，同時 N 位家長以 `ENROLL_CONC` 並發送 `POST /api/enrollments`（帶同一張限量券）；其中 `REPLAYS` 位用同一個 `request_id` 再送一次（打散順序，可能同時在飛）。
4. **判定**：成立訂單剛好 K 筆且都拿到折扣；搶輸的只能是 `400 COUPON_*`；重送兩個回應一致；
   `promotions.current_uses ≤ max_uses` 且 `= promotion_usages 列數 = checkout_sessions = admin_enrollments`。
5. 結束清掉自己種的資料（`KEEP=1` 保留）。

伺服器：`PREVIEW_SAFE_MODE=1`（關排程、LINE、寄信）、`NODE_ENV=development`、拋棄式測試庫、本機產生的測試 JWT_SECRET、沒有任何 Ragic／LINE 金鑰。

```bash
# 伺服器
cd server && PORT=3910 PREVIEW_SAFE_MODE=1 DATABASE_URL=postgresql://postgres@localhost:5433/daos_test_x \
  JWT_SECRET=<本機測試值> node index.js
# 壓測
DATABASE_URL=postgresql://postgres@localhost:5433/daos_test_x JWT_SECRET=<同上> BASE_URL=http://127.0.0.1:3910 \
  PARENTS=300 QUOTA=30 REPLAYS=30 ENROLL_CONC=50 BROWSE_CONN=20 BROWSE_SECONDS=20 node tests/perf/open_enrollment_peak.js
```

### 4.2 第一次跑：伺服器整台卡死（修正前）

`PARENTS=300 ENROLL_CONC=50`：送出約 10 筆報名後**所有請求停住，`/health` 也不回**（curl 5 秒逾時），必須重啟。
`pg_stat_activity` 顯示連線池 10 條連線全部 `idle in transaction`，停在報名交易中段：

```
15302 | idle in transaction | ClientRead | 00:06:34 | SELECT c.name, COALESCE(s.multiplier, c.pricing_multiplier) ...
...（共 10 條，同一句）
```

**根因**：`POST /api/enrollments` 先 `pool.connect()` 開交易，交易中途呼叫
`familyScope.actingParentIds(req)` 與 `promotions.previewBestDiscount()`，這兩個 helper 預設用全域 `pool.query`
→ 再借**第二條**連線。pg 連線池預設上限 10、而且沒設取得連線逾時：並發 ≥ 10 時 10 條連線全被交易占住，
每個交易都在等第 11 條，永遠等不到。這不需要很大的流量 —— **同一台同時 10 位家長按下送出就會發生**，
autoscale 多台只是把門檻乘上台數。開放報名、限量優惠正是這種情境。

**修正（非凍結檔）**：
- `server/routes/enrollments.js`：交易內 `actingParentIds(req, client)`、`previewBestDiscount({ …, db: client })`；
- `server/services/promotions.js`：`previewBestDiscount` 新增 `db` 參數（預設 pool，舊呼叫端不受影響），內部的券查詢、`listActivePromotions(db)`、`getParentPeriodUses(db, …)` 全走它；
- `server/routes/groupOrders.js`：團購發起／加入／上傳付款資料三個交易內的同型呼叫一併帶 `client`；
- 迴歸鎖 `tests/tx_single_connection_test.js`：掃描這兩支路由 BEGIN～release 之間的呼叫一定帶 client，並驗證帶 `db` 時一條查詢都不碰全域 pool。

### 4.3 修正後結果（本機沙箱，非正式環境）

環境：4 vCPU／15 GB、Node 22、PostgreSQL 16（同機）、單一 Node 行程、連線池 10。延遲單位 ms。

| 情境 | 參數 | 指標 | n | p50 | p95 | p99 | max | 錯誤 |
|---|---|---|---|---|---|---|---|---|
| A | 300 家長、限量 30、報名並發 50、重送 30、瀏覽 20 連線 | 純瀏覽（20 s，≈989 rps） | 19,770 | 17.8 | 39.7 | 56.6 | 189 | 0 |
| | | 報名期間的瀏覽 | 290 | 94.9 | 266.9 | 514.6 | 519 | 0 |
| | | 報名（全部 330 筆，牆鐘 1.7 s） | 330 | 211 | 495.5 | 544.8 | 564 | 0 |
| | | 其中成立（201） | 30 | 331.9 | 471.6 | 479.2 | 479 | — |
| B | 500 家長、限量 50、報名並發 100、重送 50、瀏覽 40 連線 | 純瀏覽（≈914 rps） | 18,276 | 40.7 | 76.8 | 91.9 | 143 | 0 |
| | | 報名期間的瀏覽 | 432 | 266.6 | 550.5 | 700.7 | 712 | 0 |
| | | 報名（550 筆，牆鐘 2.7 s） | 550 | 433.4 | 650.3 | 732.5 | 799 | 0 |
| C | 300 家長、限量 250（大多數成立＝寫入最重）、並發 50 | 純瀏覽（≈803 rps） | 8,034 | 23.3 | 43.0 | 60.4 | 123 | 0 |
| | | 報名期間的瀏覽 | 277 | 159 | 441 | 463 | 467 | 0 |
| | | 報名（330 筆，牆鐘 3.0 s） | 330 | 453.1 | 657.6 | 750.6 | 790 | 0 |
| | | 其中成立（201） | 250 | 474.3 | 670.3 | 756.3 | 790 | — |

**不超賣檢查**（三個情境全部 PASS）：

| 情境 | max_uses | current_uses | promotion_usages | checkout_sessions | admin_enrollments | 回應分布 |
|---|---|---|---|---|---|---|
| A | 30 | 30 | 30 | 30 | 30 | 201×30、200(冪等重送)×6、400 COUPON×294 |
| B | 50 | 50 | 50 | 50 | 50 | 201×50、200×9、400 COUPON×491 |
| C | 250 | 250 | 250 | 250 | 250 | 201×250、200×29、400 COUPON×51 |

各頁端點 p95（情境 A 純瀏覽）：venues 33.4、courses/types 44.8、base-price 33.3、promotions 33.0、coaches 46.4。

**解讀**：
- 限量券在 `recordUsage` 的 `FOR UPDATE` 下正確序列化：0 超賣、重送不重複建單。
- 瓶頸是單一行程的 10 條連線：報名期間瀏覽 p95 從 40 ms 拉到 270～550 ms，所有請求排隊等連線。
- 小問題（未改，屬 UX）：搶輸的家長拿到的是 `400 COUPON_INVALID`「折價券無法使用，請確認代碼或重新試算」，
  不是「名額已滿」—— `COUPON_EXHAUSTED` 沒有帶 `publicMessage`，被路由改寫成通用訊息。開放報名當下家長會以為自己打錯券號。
  建議在 `services/promotions.js` 的 `COUPON_EXHAUSTED`（preview 與 `recordUsage` 兩處）帶 `publicMessage`。

### 4.4 凍結區內同型問題（未改，需 Owner 同意）

下列家長端路由也在交易中呼叫 `familyScope.actingParentIds(req)`（未帶 client），並發 ≥ 連線池上限時一樣會整台卡死：

| 位置 | 路由 | 建議改法 |
|---|---|---|
| `server/routes/slots.js:307` | `POST /api/slots/:id/book`（家長預約） | 改 `actingParentIds(req, client)`；只改連線來源，不改預約語意 |
| `server/routes/checkins.js:120` | `POST /api/checkins/self`（家長自助簽到） | 同上 |
| `server/routes/checkins.js:317` | `POST /api/checkins`（家長簽到） | 同上 |

上課前集中簽到也是尖峰情境（同一時段整館家長一起簽），風險不低於開放報名。

另有兩項非凍結、但本次未改的防線建議：
- `server/models/db.js` 的 Pool 沒設 `connectionTimeoutMillis`、`max` 用預設 10：建議設取得連線逾時（例 10 秒，逾時回 503 而不是永遠掛著）並依 DB 方案的連線上限調整 `max`（autoscale 台數 × max 不可超過 DB 上限）。改動影響全站，宜單獨評估。
- `POST /api/enrollments` 帶匯款證明網址時，`parseProofInput` 在交易中做 `objectExists`，若走 DB driver 會再借一條連線（前端目前是建單後才補上傳，所以實務上很少觸發）。

### 4.5 限制

- 單機、單一行程、DB 同機無網路延遲；正式站是 autoscale 多台＋遠端 Neon（每次查詢多 1～5 ms RTT、連線上限依方案）。
- 沒有 LINE／Ragic／bucket 實際呼叫；沒有 TLS 與反向代理。
- 種子資料量小（場館、教練、課別只有測試庫那幾筆）；正式庫的 `coaches`／`promotions` 列表查詢成本會較高。
- 只測了一般報名（含限量券、冪等重送）；團購加入、預約、簽到的並發本次未壓。
- 數字只能用來比較「改前／改後」與找瓶頸，**不能當正式容量**。

---

## 5. 待 Owner／正式環境處理

1. **凍結區 3 處同型連線互等**（§4.4）＋**上課提醒漏發**、**評鑑邀請推播失敗不重推**（§1.3）：需 Owner 同意後修改。
2. 在預備環境（正式同規格、拋棄式 DB 分支）跑 `tests/perf/open_enrollment_peak.js` 情境 A／B，記錄正式數字；同時觀察 Neon 連線數上限。
3. 決定 DB Pool `max`／`connectionTimeoutMillis`（§4.4）。
4. 附件：查 bucket preflight 失敗原因、決定搬遷時程與聊天媒體保留期（§3.1），並執行成長估算 SQL。
5. 上線後確認 log 出現 `[RagicSchema] pruned …` 且 `ragic_z01_uid_schema_verifications` 列數收斂到約 8,640×台數。
