# Ragic 全量對帳調查報告（P1.4 §2 證據 + P1.1 權威矩陣草案）

日期：2026-07-07
性質：**唯讀調查**，動工前依 P1.4 §9 規定先產出證據。實作前需 Chumg 確認權威矩陣與 §末決策清單。
方法：8 個唯讀調查員（6 嫌疑 + cron chain 盤點 + 權威矩陣草案）→ 對抗式 verify → 綜整。所有引用皆 file:line。

---

## §2 六個「漏/跑掉」嫌疑 — 證據與判定

### 嫌疑 1：modified-since watermark / 時區 → ❌ NOT_A_BUG
系統**沒有任何增量 cursor**：`getAllParents` 傳 `{}` 給 `queryAllPaged`（ragic.js:251-254），只用 limit/offset（ragic.js:168-189）；grep `modifiedsince|watermark|last_pull` 全 server 0 命中。`last_synced_at` 只是 write-back 髒旗標（ragicWriteback.js:68,121），從不拿來過濾 Ragic READ。pull cron 綁 Asia/Taipei（cron/index.js:389）。**夜間 pull 本身就已經是每日全量對帳**，視窗內被改的記錄隔晚會被重讀，不會永久漏。
- 但要帶進設計的 3 個相鄰問題：(A) 10k 分頁上限，Z01>10000 會靜默截斷（ragic.js:165-166）；(B) write-back `last_synced_at=NOW()` 的 clobber 視窗（ragicAdmin.js:908-911）；(C) pull#2 若 push#1 三小時內無成功就整段跳過（cron/index.js:380-383）——入站對帳不該綁出站 push 健康，或至少跳過要告警。

### 嫌疑 2：offset/limit 分頁 race → 🟡 PARTIAL（verify 降為 PLAUSIBLE）
真實但未證觸發：`queryAllPaged` 無穩定排序（ragic.js:175）、以 `_ragicId` keyed `Object.assign` 合併（:182，**輸出不會重複**）、以短頁啟發式結束、無總數校驗（:183,179-181）、50 頁×200=10000 靜默上限（:165-166）。
- 校準：現況 Z01 約 1300-1500，離 10k 尚有 ~7x；「無排序鍵→掉單」須靠 Ragic 排序不穩 + 抓取中並發 DELETE（罕見）；消費端非破壞、會自癒（**刻意不自動停用缺席家長**，ragicAdmin.js:1037-1038）。
- 引擎要做的硬化：(1) 以不可變鍵分頁（`_ragicId` 升冪 cursor）取代 raw offset；(2) 先取 Ragic 回報總數，`fetched==expected` 才算完整，否則硬失敗。**未過完整性 gate 前，不得把「快照裡沒有」當成刪除/quarantine。**

### 嫌疑 3：欄位以「顯示名稱」對映而非 Field ID → 🔴 CONFIRMED（可觸發，最高危）
入站 GET **完全靠中文顯示名稱取值**，無 field-id naming 參數（`_withApi` 只加 `?api`，ragic.js:56-58；`query()` 只加 APIKey+params，:130-144；grep `naming/def=1` 0 命中）。mapper 雖列 Field ID 優先但那是**死碼**（回應是中文名 keyed；證明：H01 用 `r['應徵職務']` 中文名過濾，若回應是 ID keyed 則沒有教練會同步，ragic.js:222-234）。**非工程人員在 Ragic 改欄位名 → 入站靜默壞掉。**
- verify 修正歸屬：**每日 pull 走 `_pullParentsStudentsImpl`（非 parentSync）**。家長姓名欄改名 → 每筆 `mapped.name=''` → 全部進 Z03 quarantine、剝除 line_uid、呼叫 `hardDeleteParentIfSafe`（ragicAdmin.js:1207-1215）＝**大規模解綁 + 硬刪**，比預想更嚴重。行動電話改名 → 每筆 continue 跳過（:1159）。**這條最可能是你回報「值會跑掉」的元兇。**
- 修法：GET 改用 Field ID naming，或每 run 用 `?api&def=1` 抓 schema 建 {顯示名→FieldID} 映射；加 schema-drift 偵測（def=1 IDs vs ragicSchema.js）改名即告警；硬化 upsert 使映射失誤不致大規模 quarantine。

### 嫌疑 4：單筆錯誤中斷整批 / 靜默 OK → 🟡 PARTIAL
- 子項(1)「run 標 ok 但只 console.warn」：**不存在**。每個 job 都以 `status='error'` 呈現失敗（_logSyncResult ragicAdmin.js:2072；_runWithLog catch :2085-2105）。
- 子項(2)「整批中止」：**視 job 而定**。PULL/BACKUP 是 per-record 隔離（inner try/BEGIN…COMMIT/continue）→ 非 bug。**STAFF `_syncStaffImpl` 與 VENUES `_syncVenuesImpl` 確有此病**：整個 record loop 在單一 function-level try（staff 215/catch 380；venues 424/catch 469），一筆毒資料就中止其餘並回 `{synced:0}` 掩蓋部分進度 → CONFIRMED。潛在邊界：pull/quarantine 的 `mapZ01Parent` + 前置 guard 在 per-record try **之外**（:1147-1185），null/髒 row 會 TypeError 逃逸中止整批。
- 修法：staff/venues 迴圈加 per-record try/catch；把 mapZ01Parent + guard 移進 per-record try；停止把部分進度塌成 `synced:0`；引入獨立 `partial` 狀態。

### 嫌疑 5：upsert 鍵不是 Ragic record id → 🟡 PARTIAL
無任何表以 `_ragicId` upsert。**parents = 真缺陷**：`ON CONFLICT (phone)`（可變業務欄，parentSync.js:200-228），`ragic_record_id` 反被當可變跟隨欄（真 _ragicId 其實可得，ragic.js:436）；全量 pull 以 phone 解析家長（ragicAdmin.js:1197-1202）→ **改電話會孤立舊列 + 新增一列；兩筆共用電話會塌成一筆（last-writer-wins）**。students = 三階比對（(parent_id,id_number)→(parent_id,ragic_record_id)→(parent_id,name+birth)）相對穩，殘留風險在第三階。staff/coaches/venues 用穩定外部 id → 低風險（但 admin_staff.ragic_record_id 命名誤植，實存員工編號，:499）。**schema：coreSchema.js:910 只建非唯一索引；`uq_parents/students_ragic_record_id` 只在未被 bootstrap 執行的 migration 010，且遇重複會降級成普通索引 → 唯一性可能不成立。**
- 修法：parents 升 `ragic_record_id` 為主要比對/ON CONFLICT 鍵、phone 為 fallback（+ dedup/merge pass），前提是先修好 uq；students 確認 uq 真的唯一或改用 (parent_id, ragic_record_id)。

### 嫌疑 6：夜間 chain 順序 / pull 蓋掉未回寫的本地改動 → 🟡 PARTIAL
**chain 順序正確**、無 pull-before-push 粗 bug：#1 00:30 push、#2 01:30 pull（gated `hasRecentBackupSuccess(3)`）、#3 01:45 quarantine，皆 Asia/Taipei（cron/index.js:362-408）。
- **殘留 parent lost-update**：push `SELECT 髒列 ORDER BY updated_at ASC LIMIT 200`（ragicAdmin.js:967-968）；待推 >200 時只 flush **最舊 200**、回 `{synced:200}` 無錯 → status ok → gate 打開，但**最新的編輯根本沒被嘗試**；接著 pull 以 `name=EXCLUDED.name` 無條件覆蓋（parentSync.js:206）+ `last_synced_at=NOW()`（:225）→ **未 flush 的編輯被永久靜默覆蓋**。students 有 `preservePending` guard（:372-380）保護，**parents 沒有**。同理也影響 00:30–01:30 視窗內 best-effort writeback 暫時失敗的 admin 編輯。
- 修法：保留順序 + gate；給 `upsertLocalParent` 與 students 同款 preservePending guard、pull 傳 `preservePending=true`；backup 偵測 LIMIT-200 後仍有髒 backlog 就回 incomplete，讓 gate 保持關閉直到清空。

---

## Cron / 同步鏈地圖 + 可重用 vs 需新建

**現行鏈（node-cron, server/cron/index.js）**
- H01/H05 STAFF+VENUE PULL：cron */10（L321），走 **staging 模型**（diff→`ragic_staging_changes` 待人工核准）；例外：staff 場館變更 auto-apply 繞過 staging（`_applyStaffVenuesDirect` :168-203）。H01 Ragic 權威、系統從不回寫。
- 夜間 Z01/Z02 鏈（Asia/Taipei，順序 load-bearing，#1 gate #2/#3）：#1 00:30 backup push（batch 200）；#2 01:30 pull（除非 `hasRecentBackupSuccess(3h)` 否則跳過；**全量 ~1500 無 watermark**；逐列 graduation → upsert 或 Z03 quarantine；尾端硬刪未綁家長）；#3 01:45 name-quality 掃描 → `ragic_z01_quarantine`（Z01→Z03 的 Ragic push 仍 TODO，卡 Z03 field IDs，:1983）。
- WRITEBACK：best-effort fire-and-forget（groupOrders/customerParents/customerStudents/transfers/enrollments）；caller 交易內標 `last_synced_at=NULL`，成功→NOW()，失敗→留給夜間 #1 retry。

**可重用（收編，勿重造）**
1. 全量抓取已存在（getAllParents/Staff/Venues over queryAllPaged）——已是快照形狀，只需視需要提高 `RAGIC_MAX_PAGES`。
2. `ragic_staging_changes`（coreSchema.js:776）：H01/H05 diff 審核，含 diff_json、per-entity dedupe、`*_overridden_at` 保護、auto_resolved 清理。
3. `ragic_z03_records`/`_students`/`_deleted_tombstones`（:741/754/768）：quarantine/ghost 鏡射 + tombstone 跨 re-pull。
4. `ragic_sync_log`（:704）via `_runWithLog`/`_logSyncResult`/`hasRecentBackupSuccess`：run 帳本 + 排序 gate。
5. id-stable upsert + FK-guarded 權威刪除：`upsertLocalParent`/`upsertLocalStudents` + `hardDeleteParentIfSafe`（含 REFERENCE_SPECS）——**對帳不得重寫刪除邏輯**。
6. 並發防護：`_singleflight` in-proc mutex、`_kickoff` 10 分節流、`pg_advisory_xact_lock`、per-row SAVEPOINT。
7. push-before-pull 順序 + gate（嫌疑 6 已證正確）。

**需新建/必修**
- (a) **先修 ragic.js:488 正則**：`parseZ01Students` 內 `normalizeDate` 用雙反斜線 literal `/^(\\d{4})[\\/-].../` 永不匹配（回原字串）；相鄰 `_normalizeRagicDate`(:512) 才正確。目前被 Postgres DATE 容錯掩蓋，但對 **content-hash 快照比對是 false-diff 風險**。
- (b) 不可依賴 `students.ragic_record_id` DB 唯一（:910 非唯一；uq 只在未執行的 migration 010）——dedupe 後加 uq，或以 (parent_id, ragic_record_id) 比對。
- (c) 無跨實體「一次 run」分組——`ragic_sync_log` 只 per-job；若引擎需跨 staff+venue+parents+students 的單一 reconciliation run-id（+ `partial` 狀態 + failed/skipped 計數）是新建。
- (d) Ragic 端 Z03 form write 未實作——quarantine 只本地追蹤，引擎不能依賴伺服器端 quarantine push。
- (e) staff/venues 迴圈 per-record 隔離 + 「absent 才刪」的完整性 gate + parents preservePending guard = 疊在既有機制上的新建項。
- 註：`server/services/learning.js` 與 Ragic 無關，不在此鏈。

---

## P1.1 資料權威矩陣（草案，待 Chumg 確認）

| # | 資料域 | 觀察到的權威 | 方向 | 失敗語意 | 引用 |
|---|---|---|---|---|---|
| A1 | 家長/學員 LINE 綁定 (line_uid)+is_active | **本地 DB**（Ragic 只鏡射） | local→Ragic（綁定時） | 強同步 + advisory lock + 409 | parentSync.js:207-210；:485-497 |
| A2 | 家長姓名 | **Ragic**（pull 無條件覆蓋） | Ragic→local | 電話當名的佔位進 Z03 | parentSync.js:206；ragicAdmin.js:1184 |
| A3 | 家長電話 | 值屬 Ragic、綁定屬本地；且為 Z01↔Z02 連結鍵 | Ragic→local | — | customerParents.js:14；ragic.js:626 |
| A4 | 學員 身分證/姓名/生日/性別/血型/編號 | **Ragic**（Z02） | Ragic→local | id-stable upsert + 權威硬刪 | parentSync.js:290-440 |
| B1 | 家長/學員 營運欄位（後台編輯） | **宣稱 Ragic、實作 local-first + best-effort 回寫** ⚠️ | local→Ragic（回寫） | 只 warn；留 NULL 待夜間 retry | customerParents.js:189-266；ragicWriteback.js:141-166 |
| C1 | enrollment/session/checkin/group-order/promotion | **本地 DB**（無 Ragic） | — | 純本地交易；是擋權威硬刪的業務 FK | parentSync.js:132-159,455-467 |
| D1 | 員工/場館（H01/H05） | **Ragic**（唯讀，系統不回寫） | Ragic→local via 人工審核 staging | best-effort swallow + warn | ragicAdmin.js:748-784,380-383 |

**4 個矛盾（需人工裁決）**
1. **B1 宣稱 vs 實作不符**：碼說「Ragic 權威」卻 local-first + best-effort 回寫。
2. **A2 vs B1**：家長姓名 Ragic 無條件覆蓋且**無 preservePending**，營運欄卻 local-first ＝ 嫌疑 6 lost-update；students 有 guard、parents 沒有。
3. **D1 內部分裂**：staff 場館變更 auto-apply 繞過審核 staging，其餘 H01 要人工核准。
4. **D1 H05 三套並存**：`_syncVenuesImpl`→staging、`applyVenueSync` 兩階段、`_applyStaffVenuesDirect` auto-apply，需收斂為一條。

---

## 待 Chumg 決策（實作前，缺一不可）

1. **B1 權威**：後台家長/學員營運欄，Ragic 權威（後台編輯改為 staged 提案、絕不就地寫）還是本地權威（夜間 pull 不得覆蓋 dirty 列）？（解 矛盾#1、#2）
2. **家長姓名覆蓋政策**：維持 Ragic 無條件覆蓋，還是加 students 那款 preservePending，讓未推的本地姓名編輯存活？（連動 嫌疑6）
3. **staff-venue + H05 機制收斂**（矛盾#3、#4）：統一走審核 staging，還是統一 auto-apply？選一條。
4. **drift/完整性告警閾值**：fetched-vs-total 差多少硬失敗 vs 告警續跑？schema-drift（def=1 vs ragicSchema.js）改名硬失敗 vs 告警？告警走哪個管道、誰負責？
5. **「快照裡沒有」語意**：是否才觸發刪除/quarantine，且僅在總數完整性 gate 通過後？現在提高 10k 上限還是等接近再提？
6. **家長 upsert 身分鍵**：核准把 `parents.ragic_record_id` 升為主鍵、phone 為 fallback？需先修 uq_parents_ragic_record_id + dedup/merge——重複電話與改電話時哪列勝出？
7. **學員 rid 唯一性**：dedupe 後加 uq，還是改 (parent_id, ragic_record_id)？第三階 name+birth fallback 要不要改為進 quarantine 待審而非靜默 upsert？
8. **pull-gate 耦合**：入站對帳是否繼續綁 `hasRecentBackupSuccess`？admin 停用 backup 的 'skipped' 是否仍開 gate？跳過是否告警？
9. **run 狀態模型**：引入獨立 `partial` + failed/skipped 計數 + 跨實體 run-id，還是維持現有 per-job ok/error/skipped？
10. **Ragic 端 Z03 write 範圍**：伺服器端 Z01→Z03 quarantine push（現 TODO，卡 Z03 field IDs）是否納入本引擎，還是 quarantine 維持本地追蹤？
