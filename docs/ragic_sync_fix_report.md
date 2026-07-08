# Ragic 同步修復報告（2026-07-08）

本報告記錄本次修復工作的全過程：診斷 → 決策 → 實作 → 測試。診斷細節見
`docs/ragic_sync_audit.md`；本報告聚焦「修了什麼、為什麼、怎麼驗證、還剩什麼風險」。

## 1. 官方規則對照

| Ragic 官方規則 | 本系統現況 | 本次處理 |
|---|---|---|
| API Key 驗證方式 | 本帳號用 `APIKey=` URL query 參數，程式碼註解記載 Basic/Bearer header 曾實測被拒（guest code 106） | **維持不動**（決策，見 §6）——切換前需先用 smoke script 對非正式帳號驗證，不可盲改 |
| GET 預設 1000 筆，需 `limit`/`offset` 分頁 | 已用（`RAGIC_PAGE_SIZE`/`RAGIC_MAX_PAGES`） | 無需更動 |
| 大量資料會顯著拖慢 API | 已知 | 見 §3 根因分析 |
| GET 隊列上限 50，建議序列送出，>5次/秒可能觸發審核 | 部分違反（見 §3/§4） | 已修：cron 併發改循序、接上全域鎖 |
| `where=<fieldId>,<op>,<value>` | 讀取路徑已用（單筆查詢) | 新增：增量同步用 `where=109,gte,<watermark>` |
| 日期格式 `yyyy/MM/dd HH:mm:ss` | 新增 `_formatRagicDateTime`，對應台灣時區（UTC+8，無 DST) | 已實作並測試 |
| `listing=true` / `subtables=0` / `naming=EID` | 全數未使用 | **暫緩**（決策，見 §6）——已提供 `fetchPage()` 供未來驗證用 |
| 400/401/402/404 與 500/502/503/504 需分開分類 | 舊版只有 `RAGIC_TIMEOUT`/`RAGIC_HTTP_ERROR` 兩種 | 已擴充完整分類（見 §4） |

## 2. 舊問題列表（診斷發現，詳見 docs/ragic_sync_audit.md）

1. **Freshness-canary 重試迴圈每次重試都重新拉整份分頁快照**（而非只重查 canary 單筆）——最可能是回報 224,509ms 單次同步 + stale_read 的根因。
2. `cron/index.js` 的 `*/10` 排程用 `Promise.allSettled` **同時**跑 H01+H05 全量同步，違反「同一時間對 Ragic 只應有一個 in-flight 請求」。
3. 專案已建好的 DB 租約模組 `cron/lock.js`（`job_locks`/`job_runs`）**完全沒被接上**，形同虛設。
4. `POST /api/admin/staff/sync`、`POST /api/admin/venues/sync` 仍同步阻塞 HTTP 回應，雖然 `ragicStatus.js` 早就示範了正確的 fire-and-forget 寫法。
5. `_reconcileH23FromShadowImpl`、`_shadowPullZ01Impl`（以及同款的 H01/H05/H23 shadow-pull）在 ROLLBACK 之後仍回報 rollback 前的計數，造成「回報已同步 N 筆，實際上一筆都沒進去」的假象。
6. 多處 `console.warn`/`console.log` 明文記錄手機號碼、姓名，以及未經處理的 Postgres `err.detail`（可能內嵌違反 constraint 的原始值）。
7. H23（薪資倍率）unmatched 警告只有單一方向（H23 有列但 admin_staff 找不到），沒有反向警告（H01 教練存在但從未被任何 H23 列配對到）。
8. Z01/Z02 全量拉取沒有任何 watermark，每次都拉全表（~1500 筆）。

## 3. 根因分析（224,509ms + stale_read）

排序由高到低：

1. **Freshness-canary 重試代價**（見上）：`RAGIC_FRESHNESS_RETRIES` 預設 5、`RAGIC_FRESHNESS_BACKOFF_MS` 預設 1000ms（指數退避 1/2/4/8/16 秒 ≈ 31 秒退避），且**每次重試都重跑整份分頁快照**。最壞情況 1 初次 + 5 重試 = 最多 6 次全量分頁拉取，疊加退避時間，很容易堆到 224 秒。
2. **不是 Ragic 分頁本身的問題**：H01_STAFF 只有約 262-400 筆（遠低於 1000 筆/請求上限），smoke script 實測單頁 100 筆耗時 1-2.2 秒，4 頁（400 筆）總耗時約 5.7 秒（見 §5 smoke 結果）。
3. **naming=EID / listing=true 未使用**：增加單次請求 payload 重量，但非本次異常耗時的主因（次要貢獻因子）。
4. **Ragic 帳號併發沒有真正保持 1**：`cron/index.js` 的 `Promise.allSettled` 併發、加上不同 job（staff/venues/backup/pull）之間完全沒有互斥保護，在真實負載下會疊加拖慢。

## 4. 新架構

### 4.1 統一錯誤分類與重試（`server/services/ragic.js`）

`query()` 現在會對可重試錯誤做指數退避＋jitter 重試：

- 可重試：`RAGIC_TIMEOUT`、`RAGIC_NETWORK_ERROR`（連線層失敗）、`RAGIC_RATE_LIMITED`(429)、`RAGIC_HTTP_SERVER_ERROR`(408/5xx)
- 不重試：`RAGIC_AUTH_FAILED`(401/403)、`RAGIC_ENDPOINT_NOT_FOUND`(404)、`RAGIC_HTTP_ERROR`（其餘 4xx）、`RAGIC_APPLICATION_ERROR`（Ragic 200+status:ERROR 的欄位/語法錯誤）
- 重試用盡：`RAGIC_RETRY_EXHAUSTED`，附 `retryCount` 與 `cause`（最後一次的真正錯誤）
- 環境變數：`RAGIC_QUERY_MAX_RETRIES`（預設 3）、`RAGIC_QUERY_RETRY_BASE_MS`（預設 500ms）
- **刻意不對寫入（POST/PATCH/DELETE）加重試**：寫入非冪等，逾時後盲目重試可能在 Ragic 端造成重複記錄；`ragicWriter.js` 只更新了錯誤分類，沒有加重試迴圈。

### 4.2 Freshness-canary 重試重新設計（`server/services/ragicFreshness.js`）

`runCanaryWriteReadProof` 的重試迴圈：每次重試先做**便宜的單筆 canary 查詢**；只有在 canary 確認新鮮之後，才值得再付一次完整分頁快照的代價。不再是「每次重試都重拉全表」。

### 4.3 全域 Ragic 帳號併發鎖（`server/services/ragicAdmin.js` + 既有 `server/cron/lock.js`）

所有真的會打 Ragic 的 job（staff/venues/backup/pull/parents/students）現在共用同一把 DB 租約 `'ragic_sync'`（透過既有但先前完全沒被使用的 `cron/lock.js`）。同一時間只有一個 job 能持有這把鎖；搶不到鎖的 job 記一筆 `skipped`，不會排隊等待或報錯。`quarantine` job 因為完全不打 Ragic（只讀本地 shadow 表），刻意排除在鎖之外。

`cron/index.js` 的 `*/10` 排程也從 `Promise.allSettled` 改為循序執行 staff → venues。

### 4.4 Fire-and-forget 管理端點

`POST /api/admin/staff/sync`、`POST /api/admin/venues/sync` 改為立即回 202（背景執行），比照 `ragicStatus.js` 既有慣例。回應多了 `already_running` 欄位。`StaffPage.jsx` 的「立即同步」按鈕改為輪詢 `GET /api/admin/ragic-status` 直到完成再顯示結果。

### 4.5 增量同步（`server/services/ragic.js` + `server/services/ragicAdmin.js`）

- 新函式：`getAllStaffChangedSinceWithFreshness(watermark)`、`getAllParentsChangedSinceWithFreshness(watermark)`，用 `where=109,gte,<watermark>&order=109,ASC`。
- Watermark 存在 `admin_settings`（key=`ragic_watermark_<form_code>`，值為 epoch 毫秒；沿用既有 job-toggle 的儲存慣例）。
- **手動觸發**（`triggeredBy==='manual'`）且已有前一輪成功的 watermark → 走增量。
- **cron 排程觸發**（`triggeredBy==='cron'`，含現有 `*/10` H01/H05 排程與夜間 Z01 pull）→ 一律全量，滿足「每天仍跑一次全量」。
- Watermark 只在整輪「無 error、非 partial、非 stale_read」才推進，且推進到「這輪開始拉取的時間點」而非完成時間，避免拉取期間的新變更被漏掉。
- Shadow-pull 函式在增量模式下：只 upsert 變更子集，**不**執行「快照裡沒有 = 已刪除」的清理（那項判斷需要全集才安全，留給每日仍會跑的全量 cron 負責）。

目前只對 **H01（員工）與 Z01（家長）** 實作了增量；H05（場館）與 H23（薪資倍率）維持全量（場館異動極少、H23 量體不大，優先序較低，架構已可直接沿用）。

### 4.6 H23/H01 unmatched 警告完善

`unmatched_staff_warning_samples` 現在包含 `employee_no`、`name`、`normalized_name`（去除全形/半形空白後的比對用姓名）、`phone`（遮罩過，best-effort 查詢）、`source_form`、`reason`。新增反向警告 `h01_missing_h23_warning`：H01 教練確實存在、但沒有任何 H23 列精確配對到過，同樣是警告不阻斷。

### 4.7 假成功計數修正

`_shadowPullH01Impl`、`_shadowPullH05Impl`、`_shadowPullZ01Impl`、`_shadowPullH23Impl` 的 shadow 寫入失敗（ROLLBACK）後，一律回報 `synced: 0`，不再沿用 rollback 前迴圈累加的計數。`_reconcileH23FromShadowImpl` 改成逐筆獨立 BEGIN/COMMIT（比照既有 H01/H05/Z01 reconcile 的「嫌疑4 修復」寫法），單筆失敗不影響其餘已提交的筆數。

### 4.8 PII 遮罩

`server/utils/piiMask.js` 新增 `maskPhone`（頭 4 碼 + 尾 2 碼，中段遮罩；≤6 碼全遮）。套用到 `ragic.js`、`parentSync.js`、`parentRefresh.js` 裡先前明文記錄手機/姓名的 log。`ragicAdmin.js` 裡記錄 Postgres `err.detail`（可能內嵌違規值）的 4 處全部移除，改用既有 `_syncErrorMessage` 產生的已分類訊息。

## 5. 變更檔案清單

**核心服務**
- `server/services/ragic.js` — 重試/退避、擴充錯誤分類、`fetchPage()`、增量查詢函式、`_formatRagicDateTime`、PII 遮罩
- `server/services/ragicFreshness.js` — 重試迴圈重新設計
- `server/services/ragicWriter.js` — 錯誤分類擴充（無重試）
- `server/services/ragicAdmin.js` — 全域鎖、fire-and-forget 相容、假成功計數修正、H23/H01 警告完善、watermark 管理、增量/全量分派
- `server/services/parentSync.js`、`server/services/parentRefresh.js` — PII 遮罩
- `server/utils/piiMask.js` — 新增 `maskPhone`
- `server/cron/index.js` — H01+H05 排程改循序

**路由 / 前端**
- `server/routes/admin/staff.js`、`server/routes/admin/venues.js` — 改 fire-and-forget
- `server/routes/admin/ragicStatus.js` — 回應加上 `already_running_jobs`
- `client/admin/src/pages/StaffPage.jsx`、`client/admin/src/api/staff.js` — 配合新的非同步同步流程

**腳本 / 設定**
- `server/scripts/ragic-sync-smoke.js`（新增）— 分頁 smoke script
- `server/package.json` — 新增 `ragic:smoke` script

**測試（新增）**
- `tests/piiMask_test.js`
- `tests/ragic_query_retry_test.js`
- `tests/ragic_incremental_sync_test.js`

**文件**
- `docs/ragic_sync_audit.md`（新增，Phase 1 診斷）
- `docs/ragic_sync_fix_report.md`（本文件）

## 6. 待決策事項的最終處理

依 `docs/ragic_sync_audit.md` §6 提出的 4 項待決策，經確認後的處理方式：

1. **Auth 機制**：維持 `APIKey=` query 參數，不動。
2. **Freshness 重試重新設計**：已實作（§4.2）。
3. **naming=EID**：暫緩，維持現行 `checkZ01SchemaDrift`（`def=1`）schema-drift 偵測 stopgap。新增的 `fetchPage()` 支援手動傳入 `naming`/`listing`/`subtables` 參數，未來若要驗證 naming=EID 在這個帳號上的實際行為，可直接用 smoke script 測試，不需要另外開發工具。
4. **背景任務架構**：確認沿用既有 `ragic_sync_log` + shadow 表 + `ragic_staging_changes` + `cron/lock.js`（本次接上），沒有新建 `ragic_sync_runs`/`ragic_sync_pages` 之類的平行 schema。

## 7. 測試結果

所有測試皆為純函式或輕量 DB round-trip（key-value 讀寫，跟既有 `isJobEnabled`/`setJobEnabled` 同等級），**不會**對 Ragic 或大量業務資料做寫入；`node tests/xxx_test.js` 逐一執行（本專案無 jest/mocha，沿用既有慣例）：

```
tests/piiMask_test.js                    PASS  （maskPhone 邊界案例）
tests/ragic_query_retry_test.js          PASS  （重試/退避/錯誤分類，5 個情境）
tests/ragic_incremental_sync_test.js     PASS  （日期格式化、where/order 參數、watermark round-trip）
tests/ragic_freshness_test.js            PASS  （含新增：驗證重試不再每次重拉整份快照）
tests/ragic_data_no_visibility_test.js   PASS  （既有，未變動邏輯）
tests/ragic_h01_line_uid_test.js         PASS  （既有，未變動邏輯）
tests/ragic_h23_coefficient_test.js      PASS  （既有，未變動邏輯）
tests/ragic_writer_test.js               PASS  （既有，未變動邏輯）
tests/perf/ragic_concurrency.js          PASS  （既有，未變動邏輯）
```

`npm run lint`：本專案（`server/`、`client/admin`、`client/liff`）**沒有設定 lint 腳本或 ESLint 設定檔**，無法執行；如實記錄，不假裝跑過。

`client/admin` 已用 `vite build` 驗證可正常編譯（無語法錯誤）。

### Smoke script 實測結果（對真實 Ragic 帳號，唯讀）

```
$ npm run ragic:smoke -- --form H01_STAFF --limit 100 --max-pages 10
page=0 offset=0   count=100 duration_ms=2199
page=1 offset=100 count=100 duration_ms=1020
page=2 offset=200 count=100 duration_ms=1079
page=3 offset=300 count=100 duration_ms=981
page=4 offset=400 count=0   duration_ms=482
pages_run: 5 (natural_end)
total_rows: 400
first_record_id: 1390
last_record_id: 1033
schema_missing_fields: 3000934, 1003633, 3000933, 3000945   ← 預期中（未用 naming=EID，回應為中文欄名 keyed）
```

驗證了：H01_STAFF 穩定拉到 400 筆（與使用者原始截圖一致），總耗時約 5.8 秒（遠低於原本回報的 224,509ms）。

錯誤分類實測（刻意把 `RAGIC_TIMEOUT_MS` 調到 1ms 逼出逾時）：

```
$ RAGIC_TIMEOUT_MS=1 npm run ragic:smoke -- --form H01_STAFF --limit 10 --pages 1
[FAIL] form=H01_STAFF offset=0 limit=10 duration_ms=4170: RAGIC_RETRY_EXHAUSTED — Ragic 重試 3 次後仍失敗：Ragic 慢回應，請稍後再試
  retry_count=3
```

## 8. 剩餘風險 / 未完成項目

1. **H05（場館）、H23（薪資倍率）尚未支援增量同步**——維持全量（風險低：場館異動極少、H23 量體不大）。若未來要補上，直接沿用 §4.5 的既有模式即可。
2. **`_reconcileH23FromShadowImpl`、`_shadowPullZ01Impl` 等的自動測試覆蓋仍是空白**——本次僅手動對真實資料庫驗證過（見對話紀錄），未寫成自動化測試，因為這些函式會真的處理整張 `ragic_h23_shadow`／`ragic_z01_shadow`（數百筆真實資料），不適合每次跑測試就觸發一次真實全表 reconcile。若要補測試覆蓋，建議先把這兩支函式重構成可注入 DB client（比照 `ragicWriter.js` 的 `createWriter({http,audit,alert})` 依賴注入寫法），才能用 mock 資料安全測試。
3. **naming=EID / listing=true 尚未在真實帳號上驗證**——`fetchPage()` 已可支援手動測試，但需要先確認 Ragic 後台「Listing Page」欄位設定是否涵蓋所有需要的欄位，這需要人工檢查 Ragic 後台設定，非程式碼層面能自行判斷。
4. **`err.response.data` 內容截斷後仍可能包含少量使用者輸入回顯**（`_normalizeRagicError` 的 `detail` 欄位，取前 200 字）——這是既有行為，未在本次範圍內修改；若該訊息會被寫進 `ragic_sync_log.error_message` 或顯示在 admin UI，未來若要更嚴格可再加一層過濾。
5. **增量同步的 watermark 目前是 per-form 單一值**，若同一表單有多個並行的 cron/manual 觸發互相競爭（理論上已被 §4.3 的全域鎖擋掉，但若鎖被繞過），watermark 有被錯誤推進的風險——目前的全域鎖設計下這個風險應已消除，但未特別寫測試驗證這個交互情境。

## 9. 如何在 Replit 手動觸發與觀察同步

**手動觸發 H01 員工同步：**
1. 用 admin 帳號登入後台，進入「員工管理」頁，點擊「立即同步」按鈕——現在會立刻顯示「已排入背景同步」，並在背景完成後自動更新結果（不再卡住等待）。
2. 或直接呼叫 API：`POST /api/admin/staff/sync`（需 admin 權限），會立即回 202。

**觀察同步狀態：**
- 後台「Ragic 連線狀態」頁（對應 `GET /api/admin/ragic-status`）：每 5 秒自動輪詢，可看到 `in_progress`、`last_status`、`last_run_count`、`freshness_verified`、`stale_retries`，以及本次新增的 `incremental_watermark_at`（下次手動同步是否會走增量）。
- 直接查 DB：`SELECT * FROM ragic_sync_log WHERE form_code='H01_STAFF' ORDER BY created_at DESC LIMIT 5;`
- 全域鎖狀態：`SELECT * FROM job_locks WHERE job_name='ragic_sync';`（有列代表目前有 job 持有鎖）、`SELECT * FROM job_runs WHERE job_name='ragic_sync' ORDER BY started_at DESC LIMIT 10;`（執行歷史）。

**在 Replit shell 執行 smoke script（唯讀，安全重複執行）：**
```bash
cd server
npm run ragic:smoke -- --form H01_STAFF --limit 100 --max-pages 10
```

**手動重置某表單的增量 watermark（強制下次手動同步改走全量）：**
```sql
DELETE FROM admin_settings WHERE key = 'ragic_watermark_H01_STAFF';
```
