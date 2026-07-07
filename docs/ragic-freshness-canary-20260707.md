# P1.5 Ragic Freshness Canary

日期：2026-07-07

## 結論

本系統的 Ragic 全量同步路徑已改成 Canary Write-Read Proof：

- H01/H05/Z01 shadow-pull 開始時會先寫 canary nonce。
- 同一輪全量 snapshot 內的 canary nonce 必須等於剛寫入的值，才會寫入 shadow 並進入 reconcile/apply。
- 不一致會以 no-cache single GET、cache-buster query、指數退避重試；仍不一致時記為 `stale_read`，本輪中止並發 LINE 告警。
- `ragic_sync_log` 會記錄 `freshness_verified`、`freshness_latency_ms`、`stale_retries`、`freshness_nonce`。
- 待審核 approve/merge 前會對 Ragic 目標 record 做 no-cache 單筆二次讀；若與 staging snapshot 不一致，該筆中止。
- Ragic webhook 入口只信 record id；payload 內容不落地，必 single re-fetch 後才寫 shadow / log。

## 必填環境變數

每張要跑 freshness gate 的 sheet 必須有 canary record 與 nonce 欄位：

```text
RAGIC_CANARY_H01_RECORD_ID=<H01 canary _ragicId>
RAGIC_CANARY_H01_NONCE_FIELD_ID=<H01 nonce Field ID>
RAGIC_CANARY_H05_RECORD_ID=<H05 canary _ragicId>
RAGIC_CANARY_H05_NONCE_FIELD_ID=<H05 nonce Field ID>
RAGIC_CANARY_Z01_RECORD_ID=<Z01 canary _ragicId>
RAGIC_CANARY_Z01_NONCE_FIELD_ID=<Z01 nonce Field ID>
RAGIC_WEBHOOK_SECRET=<shared secret for /api/ragic-webhook/:sheetCode>
```

選填：

```text
RAGIC_CANARY_<SHEET>_IDENTIFIER_FIELD_ID=<放 ZZ-CANARY 的欄位>
RAGIC_CANARY_<SHEET>_IDENTIFIER_VALUE=ZZ-CANARY
RAGIC_FRESHNESS_RETRIES=5
RAGIC_FRESHNESS_BACKOFF_MS=1000
RAGIC_FRESHNESS_ALERT_THRESHOLD_MS=120000
RAGIC_IGNORE_FIXED_FILTER=true
RAGIC_API_VERSION=2025-01-01
```

## Ragic Webhook URL

在 Ragic sheet webhook 設定：

```text
POST https://<server>/api/ragic-webhook/H01?secret=<RAGIC_WEBHOOK_SECRET>
POST https://<server>/api/ragic-webhook/H05?secret=<RAGIC_WEBHOOK_SECRET>
POST https://<server>/api/ragic-webhook/Z01?secret=<RAGIC_WEBHOOK_SECRET>
POST https://<server>/api/ragic-webhook/Z02?secret=<RAGIC_WEBHOOK_SECRET>
```

Webhook handler 會接受 Ragic 的 node id array 或 full-content payload，但只抽 `_ragicId` / `ragicId` / `id`，再用 no-cache single GET 取回最新 record。

## 官方 API 查證

查證來源：Ragic 官方 API Developer Guide（2026-07-07 查）。

- API version：官方建議 `version=YYYY-MM-DD`，`version=2025-01-01` 等價 v=3 且為 latest；程式預設帶 `version=2025-01-01`。
- `where`：官方格式為 `where=<field id>,<operand>,<value>`；本系統原本使用 Field ID `where` 的方向正確。
- paging：官方支援 `limit`/`offset`，預設 1000 筆；本系統維持分頁。
- ordering：官方支援 `order=<field id>,ASC|DESC`；官方列出系統欄位 `109` 是 Last Update Date，可作版本訊號與診斷。
- `listing=true`：官方語意是只回 Listing Page 欄位；本系統 freshness 全量讀取不使用 listing mode。
- `ignoreFixedFilter=true`：官方支援，但要求 API key user 具 SYSAdmin；本系統 freshness 讀取預設帶此參數，可用 `RAGIC_IGNORE_FIXED_FILTER=false` 關閉。
- `doFormula=true`：官方支援 create/update 時重算公式；canary write 帶 `doFormula=true`，但未把全系統寫入一律強制開啟，以免改變 workflow script 行為。
- webhook：官方說 webhook 可能有些微延遲，並可選 full content；本系統仍不信任 payload 內容，僅用 record id re-fetch。

## 快取盤點

- `server/services/ragic.js` 仍保留 in-process TTL cache 給一般 H01/H05 讀取（`getActiveCoaches`、`getCounterStaff`、`getAllStaff`、`getActiveVenues`）。
- 同步用路徑已改走 `getAllStaffWithFreshness`、`getActiveVenuesWithFreshness`、`getAllParentsWithIntegrityAndFreshness`，不走 TTL cache。
- Z01 全量 pull 原本已刻意不套 cache；現在再加 canary proof。
- axios client 沒有 ETag / If-Modified-Since / conditional request 設定。

## 兩表拓撲結論

目前 repo 設定的來源仍以 `RAGIC_FORM_H01` / `RAGIC_FORM_H05` / `RAGIC_FORM_Z01` 為 API 讀取表單；未在程式內硬編「人事資料表」與「H01-人事資料表」哪張是源表。

實際定案必須由 Ragic 後台把 canary 建在「人類實際編輯的源表」，並把該源表的 `_ragicId` 寫進 `RAGIC_CANARY_H01_RECORD_ID`。若 API 讀的是衍生/多版本表，canary write-read latency 會變成端到端傳播延遲，應用連續實測校正 `RAGIC_FRESHNESS_RETRIES` 與 `RAGIC_FRESHNESS_ALERT_THRESHOLD_MS`。

## 尚未標 PASS 的項目

以下需要真實 Ragic canary row 與 credentials 才能驗證，不能在本地純碼變更中冒稱 PASS：

- 連續 3 次真實 run `freshness_verified=true`。
- Ragic 端人工改值後立即手動 run，確認本地反映新值。
- webhook 真實觸發延遲與 re-fetch 來源證明。
- H01 源表 / 衍生表實測傳播延遲。
