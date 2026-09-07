# Ragic API 打法稽核 + 2026-09-06/07 log 全清單處置報告

日期：2026-09-07　範圍：`server/services/ragic.js`、`ragicWriter.js`、`ragicAdmin.js`、`ragicSyncOutbox.js`、`ragicFreshness.js`、`cron/index.js`；正式庫 `neondb`（唯讀查證）

## 0. 一句話結論

Ragic client 本身的打法**基本正確**（讀取有指數退避、寫入不重試、錯誤有分類、欄位用 ID 釘死且有漂移檢查），真正的問題在**三個系統性缺口**：
(1) outbox 一筆壞資料能拖垮整晚排空（已修）；(2) 本地資料不符 Ragic 必填規則、卻每晚原封不動重送（資料＋產品決策）；(3) freshness canary 從未設定（設定項，非 bug）。
log 裡 9 類訊息，**2 類是程式 bug（已修）、4 類是資料問題、2 類是設定/設計提醒、1 類良性**。

---

## 1. Ragic API 呼叫方式（client 層）稽核

| 面向 | 現況 | 評價 | 風險／建議 |
|---|---|---|---|
| 認證 | `Authorization: Basic <API key>`，key 由 env 注入 | ✅ | — |
| URL 組合 | `_withApi()` 先剝掉既有 query 再接 `?api`；註解明講「env 已帶 `?PAGEID=ruv` 要用 `&`」 | ✅ 已踩過坑並防住 | 保留 `_stripQuery` 測試 |
| 讀取重試 | `query()` 只對逾時/連線層/429/408/5xx 重試，指數退避 `base×2^(n-1)`＋30% jitter，用盡標 `RAGIC_RETRY_EXHAUSTED` | ✅ 正確的可重試集合 | — |
| 寫入重試 | `postFormPath` **不重試**（`grep retry/attempt` 為空） | ✅ 對：POST 逾時後重送會在 Ragic 建重複列 | 逾時後的「不確定寫入」靠 `_assertWriteOk` + 事後 readback 補救 |
| 200+`status:ERROR` | 顯式拋 `RAGIC_APPLICATION_ERROR`，不進重試 | ✅ | — |
| 分頁 | `queryAllPaged`：`limit/offset`、可並發、短頁即停、`RAGIC_MAX_PAGES` 上限 | ⚠️ 撞上限**靜默截斷**、offset 分頁在資料被增刪時會位移 | 已有 `queryAllPagedWithIntegrity`（回 `truncated/boundaryMismatch`），**建議所有全量抓取都改走它** |
| 欄位對應 | 全部用 Field ID，中文名只作 fallback；`checkZ01SchemaDrift()` 打 `?api&def=1` 比對 | ✅ 09-05 實測 0 漂移 | — |
| 鮮度保護 | `ragicFreshness`：canary write-read proof；**H01/H05 canary 從未設定**，退化成直接 fetch 並每小時提醒一次 | ⚠️ 設定未完成，不是 bug | 見 §3-1 |
| 寫後讀回 | 註冊/綁定寫入後立刻 `_lookupZ01`（先 UID 後電話） | ⚠️ Ragic 索引有延遲 → `RAGIC_REFRESH_NOT_FOUND` | 背景刷新已放寬（`strictUidMatch=false`）；剩下的是 outbox 沒排掉的人（§3-2） |
| 節流 | **沒有全域限流器**；各呼叫端自己 sleep（如 backfill 250ms 起、撞 429 加倍） | ⚠️ 多個 cron 同時打會疊加 | 三個夜間排程已錯開（00:10 outbox → 00:30 backup → 01:30 pull）並共用 `ragic_sync` 鎖；備份「常拿不到鎖」的抱怨在 08-30 改夜間批次後應緩解，建議觀察 `job_runs` |
| 錯誤正規化 | `_normalizeRagicError` 統一 code（`RAGIC_RATE_LIMITED`…） | ✅ | — |

**整體**：client 層沒有需要立刻改的打法。要改的是上層「怎麼用」：全量抓取走 integrity 版、canary 設起來、失敗的列不要盲目重送。

---

## 2. 這次 log 的 9 類訊息逐一處置

| # | 訊息 | 判定 | 根因 | 處置 |
|---|---|---|---|---|
| 1 | `[Cron/RagicOutbox] failed: 22P02` | **程式 bug（已修）** | 2 筆 `CREATE_Z01_PARENT`（07-25/07-31）卡 `processing`、attempts 56/45、錯誤碼全空。`_claimNextJob` 每晚回收 15 分鐘前的 processing 列 → `_markFailure` 在交易內拋 22P02 → rollback（錯誤碼永遠空）→ 從 catch 再炸出 → cron `break` → **當晚其他 18 筆 pending 一筆都沒處理**。dev 用同型假資料重現不出，判定為正式站特有資料形狀 | `_markFailureOrQuarantine`：`_markFailure` 自己炸時印出 pg 的 where/table/column/detail，並用**不做任何轉型**的最小 UPDATE 把該列隔離成 `blocked_data_conflict`／`DB_22P02`，其餘筆繼續。cron 批次層也改印 where/table。**明晚 log 會直接寫出是哪一句。** 測試 6 條、mutation 5/5 紅 |
| 2 | `[client-diag] picker_closed_without_pick path=/liff/coach/schedule` | **程式 bug（已修，待發布）** | 同一支共用 `DateTimePicker`（教練排程頁也用）—— iOS 內建瀏覽器選完月後補送的模擬點擊落在觸發鈕 | 500ms 守門已上（前一輪），這筆是發布前的舊 bundle。發布後看 `client_diagnostics` 歸零 |
| 3 | `[ragic-backup] parent sync failed … (報)Email 為必填` | **資料** | 正式庫 **56 位**啟用中、有 LINE 的家長 email 空白；Ragic Z01 Email 必填 | 需補資料。SQL 已備（前幾輪）。程式面：這些會被 `stuckExclusionSql` 排除，除非家長列 `updated_at` 又被推進（見 #5） |
| 4 | `[ragic-backup] student sync failed … 學員編號/出生年月日/身分證字號 為必填` | **資料＋產品決策** | 125 個待備份學員：**114 缺學員編號**、21 缺生日、25 缺身分證。`_backupStudentToRagic` 原樣送 `student_code: null` → Ragic 必退 | 學員編號誰產生？若應由本系統配號，現在沒配 → 114 人永遠進不去；若應由 Ragic 自動編號，則不該送空值而該**省略該欄**。這是規格問題，**不盲修**，請決定 |
| 5 | 同一批學員每晚重複失敗 | **設計** | 失敗已記 `permanent`，但 `stuckExclusionSql` 用 `occurred_at >= GREATEST(s.updated_at, p.updated_at)`；11 筆因**家長列 updated_at 被其他路徑推進**而重回佇列。註：是**每晚 00:30 一趟**噴一次，不是每小時 | 行為上算合理（資料變了就重試）。若嫌吵：對 permanent 失敗改用「資料指紋（生日/身分證/編號）沒變就不重送」 |
| 6 | `STUDENT_ID_NUMBER_EXISTS: 身分證字號 X 已被其他學員使用` | **資料** | 正式庫 **23 組重複身分證、48 名學員**，其中 **2 組是測試碼**（A123456789 / F123456789 / F123456888 這類） | 清資料：測試碼直接清；其餘 21 組要人工判斷是重複建檔還是輸入錯 |
| 7 | `[ragicFreshness] H01/H05 canary 未設定` | **設定提醒（非 bug）** | 程式已刻意做成每小時一次的提醒（`_warnOncePerHour`） | 要消音就把 canary 設起來：在 Ragic H01/H05 各建一筆永久測試列，填 `RAGIC_CANARY_H01_RECORD_ID`、`_H01_NONCE_FIELD_ID`（H05 同）；要硬擋再加 `RAGIC_FRESHNESS_REQUIRE_CANARY=1` |
| 8 | `[ragic-pull] Z01_Z02_BACKUP_MISSING` | **設計提醒** | pull 前檢查 3 小時內有無 `ok/skipped` 的備份紀錄；備份只要有任何一筆失敗就記 `error` → 觸發此警告 | 語意上「部分成功」該不該算 ok 是設計選擇。建議備份紀錄改成 `partial`，pull 把 `partial` 也視為近期有備份 |
| 9 | `[auth] verifyLineIdToken failed: LINE_TOKEN_EXPIRED` | **良性** | 家長用過期的 LINE id_token 開舊分頁；client 端 `LoginPage`/`RegisterPage` 已有對應訊息並重走 `liff.login` | 不處理 |

另：`[parents/me/sync] refresh 失敗：Ragic Z01 查無剛寫入的會員資料`（08:36–08:41 六次）＝ #1 的下游症狀：那些人的 outbox 從沒排掉。#1 修好後，18 筆 pending 會在下一晚排掉；55 筆 `blocked_schema` 是 #3 的 Email 缺，補了資料才會過。

---

## 3. 本次改動與驗證

| 改動 | 檔案 | 驗證 |
|---|---|---|
| 試上價 × 教練係數（規格改變，使用者決定） | `trialEnrollment.js`、`routes/enrollments.js`、`useEnrollmentPricing.js`、`CoachCard.jsx`、`PriceBreakdown.jsx`（係數≠100% 時標出）、`tests/e2e/trial_full_chain.js`（期望值改 `trial_price × 係數`） | 新測試 `trial_price_multiplier_test` 7/7；mutation 2/2 紅；LIFF bundle 已重建含新標籤 |
| outbox 毒資料守門 | `ragicSyncOutbox.js`（`_markFailureOrQuarantine`，每筆 catch 改走它）、`cron/index.js`（批次層印 where/table） | 新測試 `outbox_poison_guard_test` 6/6；mutation 3/3 紅 |
| 全套 | — | unit 92/95；紅的 3 支（`rate_limit_policy` / `coach_unbind_line` / `sessions_venue_options`）需要 `:3001` 測試伺服器，改前就紅，已搬到需外部依賴層 |

**沒有動的、且刻意不動的**：canary（設定項）、學員編號產生（規格）、重複身分證（資料）、BACKUP_MISSING 語意（設計選擇）—— 都列在 §4 等決定。

---

## 4. 建議後續（依風險排序）

1. **發布**（帶上：試上係數、outbox 守門、上一輪的日期選擇器守門與員工徽章修正）。
2. **明晚看 log**：`[ragic-outbox] _markFailure 本身失敗` 那行會寫出 where/table/column —— 拿到後可以精準修根因（預期一次就定案）。
3. **決定學員編號規則**（§2-4）：本系統配號 or Ragic 自動編號並省略空欄。決定後 114 人才有機會進 Ragic。
4. **補 56 位家長 Email**、**清 23 組重複身分證**（先清 2 組測試碼）。
5. **設定 H01/H05 canary**（§2-7），順便消掉每小時的提醒。
6. 全量抓取一律改走 `queryAllPagedWithIntegrity`；備份紀錄增加 `partial` 狀態。
