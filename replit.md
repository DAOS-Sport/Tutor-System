# DAOS 家教課程系統 — Replit 開發筆記

## 專案概要
- 公司：駿斯運動事業股份有限公司 — 夢想體育學院
- 系統：個家教課程系統（DAOS Tutoring System）
- 主要使用者：教練、家長／學員（透過 LINE LIFF）、行政後台
- 主要外部系統：Ragic（人事／場館／家長學員資料來源）、LINE（Login + Messaging）

## 架構與目錄
- `server/` — Node.js + Express API
  - `routes/`、`services/`（含 `ragic.js`、`line.js`、`promotions.js`、`slots.js`、`websocket.js`）、`models/`、`middlewares/`（含 `adminAuth.js`、`coachAuth.js`、`auth.js`）、`cron/`、`bootstrap/`（`adminBootstrap.js` + `coreSchema.js` 啟動時自動建表 + 種子）
- `client/`
  - `liff/` — 學員／教練 LIFF Web App（React）
  - `admin/` — 後台 Web App（React）
- `db/migrations`、`db/seeds`
- `docs/` — 完整需求／規格文件（見 README 文件索引）

## 環境變數
- 主要 Key 都在 `.env.example`，正式部署時請放 Replit Secrets。
- Ragic 相關：`RAGIC_API_KEY`、`RAGIC_BASE_URL`、`RAGIC_FORM_H01/H05/Z01/Z02`。
- 注意 H01 與 H05/Z01/Z02 的 Ragic AP_Name 不同（H01 用 `standardzhtw`，其餘用 `xinsheng`），表單路徑前綴各自獨立。

## 教練端 LIFF (Task #14 已完成)
- 登入：手機 + LIFF id_token 雙因素 → `GET /api/coaches/by-phone?phone=…&id_token=…` 回傳 coach + JWT (12 小時)
  - 生產環境 (`NODE_ENV=production` 或 `REQUIRE_LINE_ID_TOKEN=1`)：必填 id_token，後端呼叫 LINE Verify API → 比對/綁定 `coaches.line_uid`
  - 開發環境若未提供 id_token：phone-only fallback（console.warn）
- token 存 `localStorage.daos.user.token`，axios interceptor 自動附 `Authorization: Bearer …`；payload 含 `lineUid`（若已驗證）
- 登入端點安全緩解：per-IP 速率限制（5 attempts / 5min → 429）+ 失敗紀錄 console.warn + 12h 短 TTL
- AuthContext storage shape: `{ role: 'parent'|'coach', data: {...}, token: string|null }`（後向相容：仍曝露 `parent` / `coach` getter）
- 路由保護：`<RequireParent>` / `<RequireCoach>` 互斥導頁；BottomNav 視 role 顯示 4 / 3 個 tab
- 教練分頁：`/coach`(今日)、`/coach/schedule`(週/月排課總表)、`/coach/profile`(bio + 介紹圖排序)
- 後端授權：`server/middlewares/coachAuth.js` 提供 `requireCoach` + `requireCoachOwner(paramName)`；slots / sessions / coaches 寫入端點皆需 token 且 IDOR-blocked (本人 only)
- 並發保護：`server/services/slots.js#createSlot` 用 `pg_advisory_xact_lock(hashtext(coach_id))` 包住「衝突檢查 + INSERT」，5 個並發同 start_at 請求測試 → 1 success + 4 conflict（已驗證）
- Multiplier 相容：`coaches.js` 將 DB 的 `pricing_multiplier (NUMERIC)` 同時對外曝露為 `multiplier (Number)`，避免家長端 CoachCard / useEnrollmentPricing 在切換 mock=false 時計算錯誤

## 簽到／扣課政策（2026-07 改版）
- **團報預約免同組確認**：`pending_group_confirm` 流程整組移除（`bookSlot1vN`、每分鐘自動確認 cron、SlotPicker/SlotActionSheet 等待文案）；所有預約一律 `bookSlot1v1` 即時 confirmed。舊 pending 資料由 `bootstrap/coreSchema.js` 冪等遷移轉正（enum 值保留）。`multi_confirm_minutes` 設定與 `groupConfirmInvite` Flex 模板成為死碼（未刪，勿再接線）。
- **一方簽到＝整組生效＋揭露簽到方全名**：團報期（`group_order_id` 非空）其他成員在上課記錄按鈕看到「已簽 · 簽到方家長姓名」（`/courses/lessons` 回 `checked_in_by_name`、`/mine` 與 `/:id` 回 `partner_checkin_name`，僅姓名不含電話/parent id；稱謂版 `partner_checkin_label` 保留相容）。後台簽到驗證列表回 `checked_in_by`（家長全名/教練/櫃檯）。
- **櫃台手動扣課解除共享課期限制**：`SHARED_PERIOD_REQUIRES_CHECKIN` 409 移除，改為「整班簽到語意」——一筆 completed session＋整班 active roster（過濾 `students.is_active`，anchor 例外保留）各一筆 staff checkin＝整期共扣 1 堂；ledger 加 `roster_snapshot` JSONB；前端共享期只render一顆「扣除 1 堂（整班 N 位簽到）」按鈕。
- **used_sessions 鏡射統一**：`services/usageSync.js`（自 checkins/sessions 抽取）為唯一同步入口，含 `listLinkedEnrollmentIds` 供扣課/衝正稽核對同團全部訂單各寫一筆；家長/教練逐堂簽到的計數改在 `FOR UPDATE OF cp` 之下，修並發舊值覆寫。WS `checkin:created` 事件一律帶 `checkin_id`（缺了會被 CheckinPage 去重誤吞）。

## 文件
- 文件索引以 `README.md` 為主。
- `docs/ragic_api.md`：Ragic 整合手冊（含完整欄位對照表 + Field ID）。
- 其他規格：`architecture_v7.md`、`schema_v2.sql`、`dev_schedule.md`、`brand_colors.md`、`replit_notes.md`、`line_setup.md`、`flex_messages.md`。

## 部署設定
- 正式網址：`https://daos-tutoring-courses.replit.app`
- LIFF：LINE Console 建 **2 個** LIFF App（家長端 + 教練端，掛同一個 LINE Login Channel 下），兩個 Endpoint URL 都設 `https://daos-tutoring-courses.replit.app/liff/`（無 `#`，前端為 BrowserRouter）。家長分享 `https://liff.line.me/<LIFF_ID_PARENT>`、教練分享 `https://liff.line.me/<LIFF_ID_COACH>/coach`。前端 `main.jsx` 會偵測 path 自動挑要 init 哪個 LIFF。
- `LIFF_URL_PARENT` 環境變數設 `https://liff.line.me/<LIFF_ID_PARENT>`（無結尾斜線，無 `#`）；cron / learn / MGM 推播會自動接 `/my-courses`、`/evaluation/:id`、`/history/:periodId`、`/referral` 等路徑。`LIFF_URL_COACH` 保留供未來教練 push 用。舊的 `LIFF_URL` / `LIFF_ID` 仍是 fallback，建議切換完成後刪掉。
- Target：`autoscale`（單一服務）
- Build：依序 `npm install` server、admin、liff，並把兩個前端 build 到 `server/public/{admin,liff}`。前端 LIFF ID 用 Replit secret 直接命名為 `VITE_LIFF_ID_PARENT` / `VITE_LIFF_ID_COACH`（Vite 會自動撿 `VITE_*` 寫進 bundle，不用改 `.replit`）；舊的 `LIFF_ID` 仍透過 `.replit` 的 `VITE_LIFF_ID="$LIFF_ID"` 當 fallback。前端 `main.jsx` 用 `import.meta.env.VITE_LIFF_ID_*` 依路徑初始化對應的 LIFF SDK。
- Run：`cd server && npm start`（`node index.js`）
- **後台初始登入密碼**：production 必須在 Replit Secrets 設 `ADMIN_BOOTSTRAP_PASSWORD`（≥ 8 chars），bootstrap 會把它套用到 `admin / manager / staff` 三個 seed 帳號。若未設，admin_users seed 整段跳過 → 沒有任何帳號可登入（請手動建第一個）。**production 下不會 seed `admin/admin` 弱密碼**。dev 環境永遠用「帳號 = 密碼」。
- Task #68 修正：admin 前端 axios 401 攔截器加上 `skipAuthRedirect` opt-out，Sidebar 的 ragic-staging badge 輪詢（每 60 秒 + onFocus）改用此 flag，且失敗 3 次後自動停止；Dashboard 的多支 API 改 `Promise.allSettled`，單支失敗只顯示 `—` 不再讓整頁白屏。避免「使用者操作中被靜默踢回登入」。
- Task #70 修正：`RagicStatusPage`（GET/POST ragic-status）與 `RagicStagingPage`（GET/POST ragic-staging 全 5 支）的 API 呼叫全面加上 `skipAuthRedirect: true`。遇到 401/500/timeout 只顯示 toast + 頁面級「重新載入」按鈕，不清除 session 也不跳轉登入。client.js 補判斷準則註解：互動寫入動作不加 flag；背景輪詢與 Ragic 狀態頁 API 全加。
- Task #91 後續修正（#92 / #93 / #94，員工 ↔ 教練合併三個 Ragic 同步 follow-up）：
  - **#92**：`_syncStaffImpl` 加入 `_normalizeStaffId`（trim + toUpperCase），`dbMap` / `seenKeys` 改用 normalized key 比對；matched row 用 DB PK `cur.id` 當 entity_id，新增則用 normalized id 落地。修正「admin 手建 c001、Ragic 回 C001 → 被誤判為新人重新進待審核」的 bug。
  - **#93**：`RagicStagingPage` 批次通過時若 `okN===0` 改丟 `toast.error`（先前用 warning 易被忽略），同時把 `failed[].error` 列表存到 state，render 紅色 banner 顯示前 20 筆 ID + 失敗原因，使用者可一眼看到「哪些通過失敗、為什麼」。
  - **#94**：`ragicAdmin.js` 的 `FORM_META` 每筆加 `kind: 'sync'|'healthcheck'`，`getSyncStatusSnapshot` 帶出 `kind`；前端 `RagicStatusPage` 依此顯示「全表同步 / 健康檢查」徽章，按鈕文案改為「單獨同步此表 / 發送連線 Ping」，「最後成功筆數」對 ping job 改為「上次回應筆數 (ping 通常 0)」。同步移除 Task #91 後遺留的死碼：`_syncCoachesImpl` / `syncCoachesFromRagic` / `kickoffSyncCoachesAsync` 三個入口與 exports 全部刪除（避免外部誤呼叫落到 `_runWithLog('coaches')` 拋 "unknown ragic sync job"）。
- Task #95：H01 員工資料改採「**Ragic 唯讀權威**」政策（修「ADMIN 端調整後被同步打回、待審核清不完」）：
  - 根因 1：admin 改員工 H01 欄位只寫本地 DB → 下一輪同步把 Ragic 舊值 stage 回待審核（rejected 不抑制 → 每輪重現），調整永遠被打回。**政策定案：任何端都不寫 H01、後台也不可改 H01 欄位** — 來自 Ragic 的員工（`admin_staff.ragic_record_id` 非空 → API 回 `ragic_locked:true`）其 姓名/手機/所屬場館 在 StaffEditModal 鎖定唯讀＋顯示「請洽 HR 至 Ragic 修改」提示；後端 PATCH 同步忽略這些欄位（defense-in-depth）。內部欄位（角色/係數/資深/簡介/Email/啟用/介紹圖）照常可編；手建員工（ragic_record_id 空，如 C001/S001/M001 demo）不鎖。教練 LIFF 本來就零 Ragic 寫入（稽核確認：寫入函式只被家長流程 auth/parents/groupOrders 呼叫），只能改自介（本地）。
  - 根因 2：`_syncStaffImpl` 拿 H01 部門「名稱」直接比 DB venue「代碼」→ 全員每輪 stage venue_ids 假差異、核准後（apply 才轉代碼）下一輪又重生 — 實測 373 筆 pending 中 357 筆為此類，怎麼審都審不完。**修法：場館自動套用** — 部門欄位（多選、含逗號/頓號複合值與「 (後綴)」）經 `_extractStaffVenueIds` 拆分 + `_buildVenueResolver` 清洗成代碼後，與 DB 不同即由 `_applyStaffVenuesDirect` 直接寫入 `admin_staff_venues`/`coach_venues`/`venue_id` fallback（**不經待審核**，教練端授權館別即時生效）；解析為空（公司名/內勤處室）不動 DB。venue_ids 不再進 staging；舊的場館 pending 下一輪自動 auto_resolved。
  - email 一致性修正：diff 改為只在「DB 空 + Ragic 有值」才 stage（與 apply 的 fill-empty-only 一致），admin 自填信箱不再被每輪 nag。
  - 曾實作 admin→H01 寫回後依政策移除；技術限制實測紀錄（H01 新建必填 14 欄全 HR 專屬、更新整筆重驗必填、3000937 部門為多選陣列、3001424=顯示名「手機」、3000940=電子郵件信箱）留存於 docs/ragic_api.md「H01 唯讀權威政策」節。
- 由 Express 同時提供：
  - `/api/*` → 後端 API
  - `/admin/*` → 後台 SPA（含 React Router fallback）
  - `/liff/*` → LIFF SPA（含 React Router fallback）
  - `/` → 預設 302 轉到 `/admin/`；若 query 帶有 `liff.*` 參數（LINE 開啟 LIFF 時會附），則改導到 `/liff/` 並保留 query
  - `/health` → 健康檢查
- WebSocket 透過同一個 HTTP server 啟動（`initWebSocket(server)`）。

## Demo 帳密登入（手機功能測試用，繞過 LINE）
- 目的：讓使用者在手機上用帳密直接測試家長／教練端功能，不需走 LINE Login。
- 開關：env flag `ALLOW_DEMO_LOGIN=1` 才啟用 `POST /api/auth/demo-login`；未設則回 404。**Demo 結束務必刪除此 flag**（含 production），避免變成後門。
- 帳密（硬寫在 `server/routes/auth.js` 的 `DEMO_ACCOUNTS`）：
  - 教練端 `coach` / `coach` → 簽 coach token，登入 Ragic「(測試帳號)教練」。**fail-closed**：DB 無「測試帳號」教練則回 404，不退回任一真實教練（避免冒用）。
  - 家長端 `custom` / `custom` → 簽 parent token，登入 phone `0912345678`（Ragic「(測試帳號)家長」+ 測試學員）。
- 入口：以一般瀏覽器開 `https://daos-tutoring-courses.replit.app/liff/demo`。`client/liff/src/main.jsx#isDemoPath` 會在 `/liff/demo` 略過 `liff.init`/`liff.login`，否則 production 未登入 LINE 會被導去 OAuth。
- 登入成功依 `role` 導頁（coach→`/coach`、parent→`/`）；token 走既有 AuthContext，line_uid 一律去敏不落地。

## Codebase Memory MCP（Agent 上手工具）

**codebase-memory-mcp v0.8.1** 已安裝。每個 Agent 啟動後，可用圖查詢取代逐檔 grep/read，速度快 10×、token 少 120×。

### 索引狀態
- Binary：`.local/bin/codebase-memory-mcp`（Linux amd64 portable，已 commit 進 repo）
- 索引約 **~3,800 nodes、~8,500 edges**（只含 server/ + client/ 程式碼，排除 node_modules/build 產物）
- **手動重新索引**（auto hook 已停用，會 OOM）：需要時手動跑下方指令

### Container 重建後重新安裝（`~/.cache/` 不進 git，重建後消失）
```bash
.local/bin/codebase-memory-mcp install -y
.local/bin/codebase-memory-mcp cli index_repository '{"repo_path":"/home/runner/workspace"}'
```

### Agent 常用工具
```
search_graph(project="home-runner-workspace", name_pattern="函式名或路由名")
trace_path(...)        # 追呼叫鏈
get_code_snippet(...)  # 取函式原始碼
get_architecture(...)  # 整體架構摘要
```
優先用 MCP 工具；搜尋字串字面值、非程式碼設定檔時才用 grep。

---

## 自訂 Secondary Skills
以下 7 個 skill 安裝在 `.local/secondary_skills/`，需要時用 `skillSearch` 找出來再讀。

| 名稱 | 來源 | 用途 |
|------|------|------|
| `code-review-excellence` | [awesome-skills/code-review-skill](https://github.com/awesome-skills/code-review-skill) | 多語言（React 19、Vue 3、Rust、TS、Java、Python、C/C++）PR review 知識庫；含 16 份語言別 reference、PR 模板、`pr-analyzer.py` |
| `ui-ux-pro-max` | [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | 67 種 UI 風格 / 161 色票 / 57 字體配對 / 99 條 UX 指引 / 25 種圖表類型 + 15+ 技術棧 CSV 資料庫；**精簡安裝**（未裝 npm CLI、未裝 Python deps） |
| `frontend-design` | [anthropics/skills · frontend-design](https://github.com/anthropics/skills/tree/main/skills/frontend-design) | 避免「AI slop」、追求大膽設計美學的指引 |
| `brand-guidelines` | [anthropics/skills · brand-guidelines](https://github.com/anthropics/skills/tree/main/skills/brand-guidelines) | **Anthropic 官方**品牌規範（橘 #d97757 + Poppins/Lora）。⚠️ 僅作為「品牌指引模板」概念參考；DAOS 實際品牌色以 `docs/brand_colors.md`（深海藍 #15316a 系）為準，不要套用 Anthropic 色票到本專案 UI |
| `mcp-builder` | [anthropics/skills · mcp-builder](https://github.com/anthropics/skills/tree/main/skills/mcp-builder) | 建立 MCP（Model Context Protocol）server 的指引；目前本專案沒用到，留作將來工具開發參考 |
| `webapp-testing` | [anthropics/skills · webapp-testing](https://github.com/anthropics/skills/tree/main/skills/webapp-testing) | Playwright 自動化測試 web app 的工具組（含 `with_server.py`）。⚠️ 沒有預先安裝 Playwright runtime（瀏覽器與 Python 套件），實際要跑測試前需用 package-management skill 補裝 |
| `web-artifacts-builder` | [anthropics/skills · web-artifacts-builder](https://github.com/anthropics/skills/tree/main/skills/web-artifacts-builder) | claude.ai 用的 React+TS+Vite+Tailwind+shadcn 單檔 HTML artifact 建置工具；本專案是部署型 web app 不直接用到，僅作為 shadcn 整合範例參考 |

注意：
- 以上全部放在 secondary 目錄，不會自動載入到主 prompt；用到時 agent 會主動讀
- 內建 `code_review`（呼叫 architect 子代理人）與新裝的 `code-review-excellence`（多語言知識庫）並存，互補使用
- 內建 `design`（design 子代理人委派）與新裝的 `frontend-design`、`ui-ux-pro-max` 並存
- ui-ux-pro-max 的 `scripts/search.py` 真要跑時需先 `pip install rank-bm25 pandas numpy`


## 階段性開發紀錄索引

完整 Phase 1–8 + Task #32 / #34 / #37 + Phase 5 補強紀錄已搬到 [`docs/phase_history.md`](docs/phase_history.md)，本檔僅保留目前進行中與還在演進的章節。

## LINE 登入改造 Phase 1-5 完成摘要

家長 **LINE-first**（自動 id_token → Ragic Z01 查詢 → 缺手機就綁手機 → 缺資料就註冊）：
- `POST /api/auth/parent-line-login` → `logged_in` / `need_phone_binding`
- `POST /api/auth/parent-bind-phone` → `bound_and_logged_in` / `need_registration`
- `POST /api/auth/parent-register-line` → `registered_and_logged_in`（寫 Z01 主表 + 子表格學生；子表格 dotted key `1001119_0_1001115`；Z02 由 Ragic 自動產生）
  - 同 endpoint 接 `ref_token` → 註冊成功後 `referrals.bindReferee` best-effort，失敗回 `ref_error`、不 rollback；前端依 `ref_bound` 才寫 `PENDING_COUPON_KEY/TRIAL50`
- AuthContext `setParent/setCoach` 中央去敏 `line_uid` / `lineUid`，不落地 localStorage
- production 必須設 `REQUIRE_LINE_ID_TOKEN=1`、`RAGIC_FIELD_Z01_LINE_UID=1006846`

教練 **LINE-only**（不接受手動輸入手機首次綁定）：
- `GET /api/coaches/by-line-uid?id_token=…` → 用 Ragic H01「個人LINE ID」(`1003633`) 查 coach
- 404 `LINE_UID_NOT_BOUND` → 前端顯示「尚未完成綁定，請截圖傳送結果至 400 官方帳號」
- `by-phone` production 已禁止首次綁定（dev fallback 保留）

受控驗證腳本：`cd server && npm run smoke:ragic-auth`（read-only by default；寫入須 `ENABLE_RAGIC_WRITE_SMOKE=1` + `TEST_PHONE` / `TEST_PARENT_NAME` / `TEST_LINE_UID`）。

## 變更紀錄
- 2026-07-14：上架後修正——「上課記錄查詢」(F-R01) 查不到真實上課資料：
  - **根因（既有缺口，非本日部署引入）**：`/api/admin/sessions`（range/today）、補簽到、verify-checkin 的「下一堂」全部只讀舊示範表 `admin_today_sessions`——沒有任何真實流程（預約排課、自助簽到、教練簽到）回寫該表，真實課堂永遠查不到。上架首日營運端第一次真用此頁即暴露（實測正式環境新購買＋自助簽到後此頁空白）。
  - **修正**：主資料源改讀真實 `course_sessions`（統一 `REAL_SESSIONS_SELECT`，台灣時區、簽到狀態以 checkin_records 為真相），UNION 舊表列向後相容（既有補登/示範資料不消失），場館範圍過濾兩邊一體適用，回傳 shape 不變（前端零改動）。補簽到改寫真實簽到紀錄（該堂全期 active 學員、來源 'staff'、找不到真實課堂時退回舊表路徑）；verify-checkin「下一堂」改解析報名對應課程期（團報→家庭共班→anchor 三層）取今日真實課堂。
  - **手動扣課頁查無資料**：後端實測正常（完整重現正式流程：購買→對帳→自助簽到→搜尋命中），需輸入 ≥2 字的家長姓名/電話/學員姓名/報名編號後搜尋，頁面不自動列出全部。
  - **驗證**：admin_sessions_regression（F-R01/F-R03/F-M05 場館防護＋補簽到＋復活）、U13 全項、家庭共班、拆單聚合、smoke 全過。UNION 修過 uuid/text 型別衝突（id::text）。
  - **需重新部署**（Publish）後正式環境生效。
  - **（同輪追加）「扣課復活」(F-M05) 同款修正**：清單只讀舊示範表 `admin_cancelled_sessions` → 主資料源改讀真實「已扣堂取消」課堂（`course_sessions.status='cancelled_penalty'`）＋UNION 舊表相容；revive 對真實課堂＝轉 `cancelled_normal`（歸還、退出清單）＋anchor 報名 audit＋used_sessions 相容遞減，舊表 id 走原路徑（F-M05 回歸全過）。
  - **（同輪追加）正式環境「測試紀錄」根除**：`bootstrap/admin.js` 原本只要 `admin_today_sessions`/`admin_cancelled_sessions` 空表就種 demo 列（含 production！刪了重啟又長回來）→ 改為僅非 production 種；production 反向自動清除固定 demo id（SE001-4/SX001-2，重啟即消失），`demo_cleanup_prod.sql` 同步涵蓋。使用者在正式「扣課復活」看到的舊測試紀錄即此來源。
  - **測試時間脆弱性修正**：self_checkin_mode 情境 9 的「今日預約課堂」改排 NOW()（原 +1 小時在接近午夜時跨日導致誤判）。
- 2026-07-14：U13 雙軌簽到（新系統過渡期：舊生/教練未養成預約習慣 → 免預約自助簽到模式）：
  - **模式開關**：`course_periods.checkin_mode`——`booking`（預約制，預設，行為完全不變）｜`self`（免預約自助簽到）。schema：migration 030＋coreSchema bootstrap（含 CHECK constraint）。
  - **自助簽到本質＝簽到當下補建真實課堂**：`POST /api/checkins/self`（家長）同交易建 `course_sessions`（`created_via='self_checkin'`、status=completed、時間=當下）＋勾選學員的 `checkin_records`（共班一次一堂多筆簽到）→ 堂數計算/教練今日課程與上課紀錄/學習歷程/報表/儀表板 WS 即時通知全部沿用既有資料路徑，零分岔。教練今日課程查詢不 JOIN slots，自助課堂自然出現。
  - **防呆三層**：①同一期每日限一次＝`uq_sessions_self_checkin_daily` partial unique index（`course_period_id + self_checkin_date` 台灣營運日）DB 硬保證，雙擊/斷網重送/多裝置並發不可能扣兩堂；②堂數上限＝非取消課堂數 ≥ total_sessions → 409 `NO_SESSIONS_LEFT`；③advisory lock `self-checkin:<period>` 序列化。其他守門：mode/active/到期/學員歸屬（403 `STUDENT_NOT_IN_PERIOD`）。
  - **撤銷（營運決策：家長不可自撤）**：櫃檯在「簽到驗證」頁對「自助」來源列按撤銷 → `DELETE /api/admin/checkins/self-sessions/:id`：刪該堂全部簽到、課堂轉 cancelled_normal、`self_checkin_date` 清 NULL（釋放當日名額、家長可重簽）、堂數自動歸還（真相=checkin_records）、audit 掛 anchor 報名單；教練已寫上課紀錄則 409 擋下。
  - **後台管理（新頁「簽到模式管理」/checkin-modes，場館營運分組）**：進行中期別逐列（場館/教練/學員/組別/期別/堂數/模式徽章 🔵預約制 🟠自助簽到/今日已簽標記）＋單期切換＋整館批次切換（`PATCH /api/admin/periods/:id/checkin-mode`、`POST /api/admin/periods/checkin-mode/bulk`，admin/manager，每次切換寫 audit）。「簽到驗證」頁每列加來源徽章（自助/家長/教練/櫃檯）。
  - **家長端**：`/courses/mine`、`GET /courses/:id` 回 `checkin_mode`＋`self_checked_in_today`；self 模式課程卡按鈕改「今日上課簽到」（已簽顯示「今日已簽到 ✓」禁用）＋「查看上課紀錄」；`SelfCheckinModal` 開啟即重抓伺服器最新狀態（防畫面過期）、勾選到課小孩（預設全選）、409/錯誤碼專屬文案、簽到後 refetch 列表。網路失敗可安心重按（DB 冪等）。
  - **驗證**：新增 `tests/e2e/self_checkin_mode.js` 17 項斷言全過（預約制守恆/切換+audit/管理清單/2 孩一堂/同日重複擋/卡片狀態/撤銷+當日重簽/堂數上限/越權/整館批次）；回歸 family_shared_period、reconcile_payment_proof_visibility、admin_manual_deduction、checkout_multi_student_periods、smoke-admin 全過。admin＋LIFF 前端已重建。
  - **上架步驟**：正式庫套 migration 029+030（或重啟讓 bootstrap 套用）→ 部署 → 後台「簽到模式管理」把目標期別/場館切成自助簽到。
  - **（同日追加）過渡保護——已簽到/已排課程的銜接**：切換模式不動任何既有資料（已簽堂數照算、已排課堂保留且計入上限、家長仍可從上課紀錄對既排課堂逐堂簽到）。`POST /checkins/self` 加兩道守門：①同一期「今天」已有任何簽到（含預約課堂由家長/教練/櫃檯簽）→ 409 `ALREADY_CHECKED_IN_TODAY`，杜絕跨模式一天雙扣；②今天已排未簽的預約課堂 → 直接簽進該堂（回應 `reused_booked_session=true`，不另建課堂，預約課堂不會變幽靈堂）。容量檢查移到「僅新建課堂時」執行（簽進既有課堂不增加課堂數）。e2e 擴充至 21 項斷言全過。
  - **（同日追加）自助簽到改為全站預設**（migration 031＋bootstrap）：營運決策——所有場館所有課程直接用自助簽到。①既有全部課程期一次性切為 self；②`checkin_mode` 欄位預設值改 'self'（對帳開通的新期別自動繼承）；③一次性切換以 `system_flags['u13_self_checkin_default_20260714']` 冪等——migration 與 bootstrap 誰先跑都只切一次，之後管理者手動切回 booking 不會被部署重啟覆蓋。production 部署重啟即自動生效，無需手動跑 SQL。後台「簽到模式管理」切換功能不受影響。開發庫已套用驗證（10 期全 self、重啟不重複覆蓋）；`tests/e2e/self_checkin_mode.js` 補「新開課預設 self」斷言、守恆情境改明確種 booking，重跑全過。
- 2026-07-14：上架前家長端資料健檢＋清理：
  - **健檢結論**：242 位真實 LINE 綁定家長（Ragic Z01 鏡像）資料乾淨——電話無重複、學員無同名重複、無堂數/到期/退費殘留異常；且**無任何真實課程交易**（近 14 天活動全為測試帳號），上架後真實課程自零開始走新路徑，無舊資料顯示風險。修復 script dry-run＝0 組即因於此。
  - **清理**（`scripts/cleanup_orphan_demo_periods_20260714.sql`，經使用者核准執行）：刪除 7 個「無學員掛載」孤兒/demo 課程期（5 個 anchor 報名已不存在、1 個掛 demo 帳號、1 個無 anchor；全部 0 簽到/0 轉讓/0 扣課），並釋放其占用的 4 個教練時段（fk_slot_session 先解除連結再刪）。複查：孤兒期別 0、懸空時段 0，餘 2 個健康 demo 期別供測試。demo 報名列（CP10xx）不動——demo seed 會重建，正式環境清 demo 用既有 `server/scripts/demo_cleanup_prod.sql`。
- 2026-07-14：U12 家庭共班修復（同家長多小孩報一對二以上被膨脹成每人一期）：
  - **問題**：家長端報名按「學員 × 期數」拆單（U10 發票精度設計），但 U11 開通橋 `ensureSoloCoursePeriod` 對每筆子訂單各建一個 `course_period` → 3 位小孩報一對三 1 期（6 堂共學）變成 3 期 18 堂、可各自約滿 6 堂。團報與櫃檯手動建檔不受影響（前者以 group_order_id 共用、後者不按學員拆單）。跨家長組合僅存在於團報路徑，本修復不觸及。
  - **schema**：`course_periods` 加 `enrollment_batch_id` + partial unique index `uq_course_periods_batch_period (enrollment_batch_id, period_number)`（coreSchema bootstrap + `db/migrations/029_family_shared_course_period.sql`）。
  - **開通橋**：`ensureSoloCoursePeriod` 遇「同批同期多筆兄弟訂單且課型 max_students>1」→ 比照團報守門（本期全部兄弟訂單 confirmed 才開）、advisory lock `batch-period:<batch>` 序列化、以 (batch, period_number) 冪等 get-or-create **一個**共用 period（6 堂、金額=兄弟加總、admin_enrollment_id=第一筆），全部小孩綁同一 period。混版保護：舊版已建的單人 period 會被「收編」不重建。一對一（max_students=1）多小孩維持各自獨立 period（各 6 堂，語意本來就對）。試上排除。
  - **顯示**：`courses.js` /mine 與 GET /:id 的 period 解析加入 batch 分支（group → batch → admin_enrollment_id 三層 COALESCE；/:id 重構為與 /mine 同款 LATERAL）；/mine 把「已開通、共用同一 period」的兄弟子訂單合併成一張卡（學員合併、金額加總、`sub_order_ids`/`sub_order_count` 標示）。
  - **報名驗證**：一對 N（N≥2）單次報名學員數 > N → 400 `STUDENT_COUNT_EXCEEDS_COURSE_TYPE`（一對一不設限）。
  - **既有髒資料修復**：`scripts/merge_family_shared_periods.js`（dry-run 預設 / `--execute` / 非開發庫需 `--production-confirmed`）：同批同期多 period → 併入最早那個，搬移 sessions（簽到隨行）/session_records/manual_lesson_deductions/transfer_records/promotion_usages/lesson_plans/course_evaluations/聊天室訊息後刪除其餘；教練/場館/課型不一致或 RESTRICT 撞鍵之群組自動跳過交人工；合併後超訂（已排 > 購買堂數）列警示。
  - **驗證**：新增 `tests/e2e/family_shared_period.js`（共用守門、單一 period 6 堂、卡片合併、明細解析、一對一守恆、超額擋單）＋修復 script 於真 PG 造 bug 資料 dry-run/execute 全驗證；回歸 `checkout_multi_student_periods`/`enrollment_idempotency`/`checkout_idempotency`/`checkout_group_isolation`/`admin_checkout_scope_cancel`/`admin_sessions_regression`/`reconcile_payment_proof_visibility`/`group_payment_proof` 全數通過。
  - **整期退費（營運規則：退費整班整期處理，不會有單一小孩中途退出）**：`refund-preview`/`refund` 遇家庭共班（period 有 enrollment_batch_id）→ 整批兄弟訂單 FOR UPDATE 鎖定後同交易一起退（各筆按共用 period 剩餘比例計退款、逐筆入帳可對回發票）、共用 period 轉 `refunded`、未來未上課 sessions 取消（`cancelled_normal`）並釋出教練時段；已退/已取消不可重複退（400）。preview 回應加 `family_shared`/`sibling_refunds`/`sibling_ids`（additive）。一般單筆退費行為不變。
  - **已出席堂數改 DISTINCT session**：`courses.js` /mine 與 /:id 原本數 checkin_records「列數」——共班一堂多位小孩簽到會被算成多堂；改 `COUNT(DISTINCT course_sessions.id)`（與 sessions.js 團體課計法一致），單生課程數值不變。
  - **後台退費 UI**：`RefundPage` 接 preview 的 `family_shared`——彈窗顯示「家庭共班・整期退費」琥珀色警示（N 筆一併退、期關閉、預約取消釋出時段）、原應收改顯示整期合計（preview 新增 `batch_final_price` 與 sibling `final_price`）、成功 toast 顯示整期筆數與合計。admin 前端已重建（index-C0BCSbyY.js）。
  - **資料庫預設時區 → Asia/Taipei**：應用層原本已三重覆蓋（`server/index.js` process.env.TZ、`models/db.js` 每條 pool 連線 SET TIME ZONE、cron timezone 選項、前端 +8 固定換算），但 DB 預設值是 GMT——維運 script／psql／測試裸連線的 `NOW()::date` 等日期邊界會差 8 小時。coreSchema bootstrap + migration 029 加 `ALTER DATABASE ... SET timezone 'Asia/Taipei'`（無 owner 權限時警告不中斷），開發庫已套用生效。
  - **待辦（營運面）**：部署後先跑修復 script dry-run 檢視報告再 execute；已被家長分開約滿的課需依警示與家長協調取消多排堂數。
- 2026-07-03：Z01/Z02/Z03 同步缺陷修復（上線前資料清洗後遺症排除）：
  - **場館名稱容錯解析**：Ragic Z01 館別存「三重商工/三民高中」，本地 venues（H05 同步）名稱是「三重商工 (test)/三民高中 (tx)」→ by-name 永遠查無 → `primary_venue_id` 被靜默解析成 NULL（實測 4 位已綁定家長中招；Z03 內 1,289 筆屬這兩館），下次登入會被 `LOCAL_VENUE_REFRESH_FAILED` 擋下。`parentSync._normalizeVenueName`（去尾端括號備註）+ `loadVenuesMap` 增設 byNormName 第三層對照（正規化撞名視為 ambiguous 不配對）。已驗證 4 位家長 venue 全部回填。
  - **唯一鍵防線（後台不再出現 duplicate key 同步失敗）**：(a) `upsertLocalParent` 寫入包 SAVEPOINT，撞 `parents_line_uid_key`（並發綁定競態）時放棄寫 UID 重試一次，其餘欄位照常同步；(b) `upsertLocalStudents` 寫入前先解除「掛在別的家長名下」的同 `ragic_record_id` 佔用（撞 `uq_students_ragic_record_id` 的真因，7/1 兩次排程失敗即此），並以 per-student SAVEPOINT 隔離——單一學員撞鍵只跳過該位，不再炸整筆家長同步。
  - **Z03 畢業邊界釐清**：背景 `pull` 僅讀取 Ragic、分類 Z03、同步已完成鏡像，不回寫 Ragic；使用者註冊/綁定流程才可在本人 LINE 驗證與認領驗證後回寫 UID/補齊欄位，並立即 `refreshParentMirrorFromRagic` 建立本地 parents/students、標記 Z03 resolved。手動 pull 只作初期資料修補/批次收斂，不是使用者登入的必要步驟。
  - **停止學員 soft-delete 斷鏈**：舊版權威同步把「Ragic 權威清單已移除」的本地學員標 `is_active=FALSE`，但若該學員仍有課程/簽到/轉讓 FK，LIFF 學員清單會消失、課程關聯仍存在，造成配對斷鏈。新策略不再 soft-delete 學員：權威移除時只硬刪「無業務 FK」的本地殘留；有 FK 的列保留關聯，不自動復活歷史軟刪資料，也不寫回 Z01。
  - **登入/註冊流程加固**：(a) `parent-line-login` UID 查無時新增「電話反查備援」——本地已綁此 UID 的家長改用電話反查 Ragic，命中同 UID 就照常登入，防 Ragic UID 搜尋偶發失準時誤刪本地資料＋誤踢重新綁定；(b) `refreshParentMirrorFromRagic` 場館解析不到改為大聲 log、不再丟 `LOCAL_VENUE_REFRESH_FAILED` 硬擋登入（場館值由 H05 同步＋夜間 pull 自動收斂）。
  - **註冊認領放寬（解 Z03 舊客戶註冊牆）**：Z03 池 3,314 位學員只有 33% 在 Ragic 存有身分證字號，原規則（姓名＋身分證都對上才放行）把 2/3 舊客戶永遠擋在 409。`parent-register-line` 的 found→update 認領改為：Ragic 有身分證 → 仍須姓名＋身分證全對（防冒用不變）；Ragic「本來就沒存身分證」→ 姓名精確對上即放行（電話＋學員姓名雙要素），audit 記 `passed_no_id_on_file` 供稽核。流程即為使用者定義的「電話進 Z03 比對 → 命中帶出該筆學生資料（refresh 合併 Z01 子表＋Z02 落地本地）→ 七必填〔姓名/身份/場館/電話/Email/LINE UID/性別〕齊全落 Z01」。
  - **LIFF 開啟時自動刷新（me/sync 接線）**：`AuthContext` 掛載時（每次開啟 App）若已登入家長，自動呼叫既有的 `POST /parents/me/sync`（後端節流 + Ragic 失敗降級回 DB 鏡像）更新本地快取，不再吃 localStorage 舊資料；token 過期由既有 401 靜默重驗攔截器換新重試，使用者無感。合併時去敏（line_uid 不落地）。LIFF 已重建（index-BGsmBsoO.js）。
  - 注意：production 需重新 Publish 才會帶上以上程式修復；發布後隔天 01:30 pull 會自動回填本地 venue/鏡像與整理 Z03（不回寫 Ragic），或可在後台 Ragic 狀態頁手動觸發。已驗證：LIFF build PASS、後端語法檢查 PASS、`smoke:ragic-auth` 9/9 PASS（write smoke disabled）。
- 2026-07-01：`/admin/manual-enroll` 手動報名建檔頁 9 項調整：
  - 註冊館別下拉改用前端 `venues.filter(v => v.is_active !== false)` 只列啟用中場館（後端 `POST /api/admin/enrollments` 仍允許對停用館建檔補歷史資料，不動）；授課教練下拉改成可打字搜尋（`SearchCombobox` 通用元件補上可傳入文案的 props，沿用既有 `coaches` state 做 client-side filter，不加新後端端點）；拔掉「班級名稱」「作業型態」「程度說明」三個從未被讀回顯示過的欄位；「購買總堂數」改成「購買期數」輸入（畫面即時顯示「N 期 × 6 堂 = 總堂數」，送出時仍換算成 `total_sessions` 給後端，後端拆單邏輯不用改）；「報名指定時間」拿掉不再讓使用者填，不送 `submitted_at`，讓後端沿用既有「沒收到就用當下時間」預設；新增唯讀「資料建立人」欄位（`admin_enrollments` 新增 `created_by TEXT REFERENCES admin_users(id)`，比照 `promotions.created_by` 樣式，一律由後端從 JWT `req.adminUser.sub` 決定、不接受前端傳值；`readEnrollment()` 一併 LEFT JOIN `admin_users` 回傳 `created_by_name`）。
  - **自動判斷組別＋價格**：新增 `useEffect` 依賴選取學員數（`studentNames.length`）與課程需求列表，用 `course_type_configs` 的 `min_students`/`max_students` 比對後自動套用組別（連動既有價格帶入邏輯 `onCourseType`）；`courseTypeTouchedRef` 追蹤「使用者是否已手動選過」，一旦手動選過就不再被學員數變動覆蓋，「清空課程」會重置這個追蹤讓下一筆（通常是下一位客戶）重新套用自動判斷。
  - 已用 Playwright 跑過完整互動流程驗證（搜尋家長→勾學員驗證 N=1/N=2 自動選組別＋價格連動→手動覆蓋保護→教練搜尋→2 期送出正確產生 2 張訂單），全程無 console/page error。
- 2026-07-01：學員編輯拿掉「先顯示個資才能編輯」兩步驟 + 新增學員資料稽核紀錄：
  - **編輯體驗**：`RagicZ01Modal.jsx`/`RagicZ02Modal.jsx` 裡身分證字號/血型不再依賴頁面層級 `reveal` state 渲染成唯讀遮罩——`CustomerStudentsPage.jsx`/`CustomerParentsPage.jsx` 的 `openEditor()` 改成一律用 `reveal=true` 抓資料（點「編輯」本身就是有明確對象、可稽核的操作，不用再多一道「顯示個資」手續），兩個 modal 內的欄位改成永遠可編輯。列表顯示的遮罩（DataTable 欄位）與後端 `looksMasked()` 寫入防呆維持不動，跟編輯行為脫鉤。
  - **稽核紀錄**：新表 `student_audit_logs`（`student_id`、`action`、`by_user`、`by_role`、`changes` JSONB diff，比照既有 `course_type_config_audit_logs` 樣式）；共用 helper `diffChanges()`/`writeStudentAudit()` 放進 `routes/admin/_customerShared.js`。三個會修改 `students` 的寫入點都接上：`routes/parents.js`（家長自己編輯/新增學員，`by_role:'parent'`）、`routes/admin/customerStudents.js`（櫃檯/管理員直接編輯）、`routes/admin/customerParents.js`（家長頁裡巢狀編輯學員子表，沿用同一個交易 client 確保稽核寫入不脫離交易）。新增 `GET /api/admin/customer-students/:id/audit-logs`，`RagicZ02Modal.jsx` 新增「編輯紀錄」區塊呈現 before/after diff。已對 dev DB 直接跑過寫入/讀取驗證。
- 2026-07-01：新增 Z01 家長/學員 Ragic→本地排程拉取同步 + Z01↔Z03 資料品質偵測（可做部分）：
  - **拉取同步**：`services/ragic.js` 補上 `getAllParents()`（原本已寫但漏了 `module.exports`，執行期才會炸 `getAllParents is not a function`，這次一併修正）；`services/ragicAdmin.js` 新增 `_pullParentsStudentsImpl()`，繞過 `_syncWithLock`（那是設計給即時 LIFF request 用的 409 防護，排程背景任務沒有活人可以 409；真正安全網是 `upsertLocalParent` SQL 裡 `line_uid = COALESCE(既有值, 新值)` 的永不覆蓋語意），改用批次預載（`parentSync.js` 新增 `loadVenuesMap`/`loadStudentsByParentPhone`，`upsertLocalParent`/`upsertLocalStudents` 加可選預載參數，省掉逐筆序列查詢），`reactivate:false`（比照 `POST /me/sync` 既有作法，排程刷新不應復活軟刪除的家長）。排程 `01:00`（台北，排在既有 02:00 backup job 之前，讓 backup job 推送前先補齊 `ragic_record_id`，避免誤判成新客戶而重複建檔）。**已對真實 Ragic + dev DB 跑過**：1,379 筆家長/學員 14 秒同步完成（優化前逐筆查詢粗估要 20-45 分鐘）。
  - **品質偵測（部分）**：新表 `ragic_z01_quarantine`（`z01_ragic_record_id` 唯一鍵、phone、bad_name、`z03_ragic_record_id`、`resolved_at`）；`isPlaceholderParentName()` 偵測姓名欄位是純電話號碼的舊資料（已證實 6/30 匯入的 511 筆舊生裡 433 筆家長姓名欄位存的是電話號碼）；`_quarantineBadZ01NamesImpl()` 排程 `01:10` 掃描並記錄（實測 512 筆命中）。Z01 治癒不用另寫——`PATCH /api/parents/me` 早就會把改過的姓名同步寫回 Z01（`syncParentProfileStrict`），這次只在該次 PATCH 成功後加一段：偵測到「原本是佔位亂填名、現在被改成正常姓名」就把 `ragic_z01_quarantine` 對應那筆標 `resolved_at`（`routes/parents.js`）。**卡住待續**：實際 Z01→Z03 推送、Z03 側清理，因為 Z03 表單（Ragic 端另行建置中）的欄位 ID 尚未確認，標了 `TODO(Z03)`，等表單資訊到位再補。
  - `bootstrap/coreSchema.js` 新增上述表格 DDL（idempotent，已用完整 bootstrap 重跑驗證）；`routes/admin/ragicStatus.js` 的 `JOB_RUNNERS` 新增 `pull`/`quarantine` 對應（`RagicStatusPage.jsx` 前端不用改，通用渲染 `FORM_META`）。
- 2026-06-04：正式 DB demo 資料改用「啟動時 flag-gated bootstrap」自動套用（`server/bootstrap/demoSeed.js`）。
  - **原因**：`executeSql({environment:"production"})` 唯讀、使用者也難對正式 DB 跑 psql，所以光交付 SQL 腳本資料進不了正式站（教練名單看不到測試教練即因正式 DB 從未跑過 seed）。但部署後 app 對正式 DB 有讀寫權 → 沿用既有 `bootstrap/admin.js`、`coreSchema.js` 模式，啟動時依環境變數執行同一份已驗證 SQL。
  - **開關（Replit Secrets）**：`DEMO_SEED=seed`（或 `1`）→ 跑 `demo_seed_prod.sql`；`DEMO_SEED=cleanup` → 跑 `demo_cleanup_prod.sql`；未設則不動作。改值後需 **Publish / 重啟** 才生效。
  - **流程**：測前設 `DEMO_SEED=seed` + `ALLOW_DEMO_LOGIN=1` → Publish；測後設 `DEMO_SEED=cleanup` → Publish（清資料）→ 再移除 `DEMO_SEED` 與 `ALLOW_DEMO_LOGIN`。bootstrap 以 `pool.query` 一次送出整支 BEGIN…COMMIT，失敗只 console.error 不擋 server 啟動。
- 2026-06-04：正式 DB demo 測試資料腳本（`server/scripts/demo_seed_prod.sql` + `demo_cleanup_prod.sql`）。
  - **用途**：在正式站用 demo 帳號測「家長報名→後台換教練」與「團購邀請連結加入」兩流程。鐵則：只寫 local 表不回寫 Ragic；資料標 `(測試帳號)`；全 idempotent。
  - **限制**：`executeSql({environment:"production"})` 唯讀，無法直接寫 prod → 交付腳本由使用者跑 `psql "$PROD_DATABASE_URL" -f ...`；腳本內以手機/名稱/`ragic_employee_id` self-resolve id（不照抄 dev UUID，dev/prod 不同 DB）。已對 dev 跑完整循環驗證（cleanup→0→seed→精確數→再 seed 不變）。
  - **seed 內容**：venue B 教練帳號、`(測試帳號)教練`(0605065)/`教練2`(0605066)（coaches+coach_venues+admin_staff role=coach+admin_staff_venues）、`(測試帳號)家長`(0912345678)/`家長2`(0922222222)+學員、venue B 轉帳帳號（僅空白時填）、教練1 active period（未來 confirmed session，供換教練/轉讓）+completed period+待填評鑑、教練2 active period+今日 session+slots+published lesson_plan、團購 forming 一對三(2/3) leader=家長 join_token=`demotestgroup3invite0001`（家長2 不加入，留給邀請連結測試）。
  - **團購邀請連結**：`https://liff.line.me/<LIFF_ID_PARENT>/group/join/demotestgroup3invite0001`（站內 fallback：`https://daos-tutoring-courses.replit.app/liff/group/join/demotestgroup3invite0001`）。
  - **測前**：prod Secrets 設 `ALLOW_DEMO_LOGIN=1`（測完務必刪）；測後跑 cleanup 腳本（marker-scoped，venue B 轉帳帳號僅在等於測試值時還原為空）。
- 2026-06-03：U11 批次修補（workflow 調查+對抗驗證後逐項實作）：
  - **#1 分享連結加入跑到別人的團（critical）**：根因為 `afterAuth`（localStorage `daos.afterAuth`）殘留舊團 join 路徑——登出、手動登出守衛早退、登入失敗分支都沒清，下次自動登入被 `takeAfterAuth` 取用→導向舊團（「人數/名字算錯」其實是進錯團，後端計數正確）。修法：`afterAuth.js` 新增 `clearAfterAuth()`；`AuthContext.logout()`、`LoginPage` 手動登出守衛 + 兩個 error 分支都呼叫清除。純前端，已重 build LIFF。**未改** `location.state.from`（LIFF redirect 會遺失）與後端計數（無關）。
  - **#2 正式環境 F-M02 等清單看不到**：非舊 bundle、非角色 gating，而是 manager/staff 帳號**無場館(venue scope)** → fail-closed 全空（影響 F-M02/今日課程/簽到/團購審核等 8 個 scoped 路由）。預覽 seed 帳號有場館 'B' 故正常；正式真實帳號沒有。**資料修復**（非改碼）：見 `scripts/fix_staff_venue_scope.sql`，於 Production DB 診斷後補 `admin_staff_venues`（有 staff_id）或 `admin_users.venue_id`（無 staff_id），補後重新登入。
  - **#3 一般報名計價硬編碼**：`enrollments.js` 刪除寫死的 `BASE_PRICES`，改在交易內讀 `course_type_configs.base_price`（`Number()` 轉型、不加 is_active 過濾以與 courses.js/groupOrders.js 一致、fail-closed 回 400 `PRICE_NOT_CONFIGURED`），與報名頁試算/團報同源。
  - **#4 一般報名對帳沒建課期**：`admin/enrollments.js` 新增 `ensureSoloCoursePeriod()`（與 `ensureGroupCoursePeriod` 以 `group_order_id` 守門互斥），reconcile 交易內呼叫：教練(coach_id 空時以名+venue 反查)、家長(phone)、學員(parent_id+name get-or-create) 解析後冪等建 `course_period` + 綁 `course_period_enrollments`；缺教練/家長未註冊→warn 不阻擋對帳。`coreSchema.js` 加容錯 partial unique index `uq_course_periods_admin_enrollment`。**只建 period+enrollments，不建 course_sessions**→對帳後聊天室/學習歷程即可見，教練課表/上課紀錄仍需選槽排課（與團報一致）。已對真 PG 跑 rolled-back 交易驗證（教練反查、學員一既有一新建、冪等、零寫入）。
  - **#5 缺家長端選槽 API**：`routes/slots.js` 新增 `POST /api/slots/:id/book`（requireParent），只新增不動教練端：advisory lock + 歸屬驗證(course_period_enrollments→students.parent_id) + period active/容量/教練場館一致檢查；依同期家庭數分流 `bookSlot1v1`(即時 confirmed)/`bookSlot1vN`(暫鎖待同組確認)。**選槽不動 `used_sessions`**（全系統以 checkin_records 計數，無任何 +1 處，動它會算重）。前端選槽頁為後續單元。
  - **#6 E2E 落後**：`path_a_purchase.js` reconcile 補發票欄位 + audit 改前綴比對；`_lib.js` 加**檔案 token 快取**（跨 spawnSync 子行程共用、4 分 TTL），`run_all.js` 開跑前清快取——同帳號整輪只登入一次，不再打爆後台登入限流(5次/5分)。純測試層、不動正式碼。path_a 已對 running server 驗證通過。
  - **#7 死 API client**：移除 `client/liff/src/api/auth.js` 的 `bindLineUid()`（呼叫不存在的 `/auth/bind-line`、零呼叫點）；不補後端（會復活未驗證 parentId 綁定的不安全設計）。已重 build LIFF。
  - **#8 移除 501 stub 路由**：刪除 `server/index.js` 對 payments/students/refunds/notifications 的掛載 + 4 個 stub 檔（零呼叫者，實際功能都在具名路由）。注意：`notification_logs` 表仍未接線，屬 backlog。
  - **注意**：後端變更需重啟 server 才在預覽生效（dev nodemon 本環境未自動 reload）；發布(Publish)會自動帶上。前端 #1/#7 已是 `server/public/liff` 靜態檔，預覽即時生效。
- 2026-06-02：一般報名重做（U10：期數 + 計價×人數×期數 + 證明事後上傳 + 報名狀態頁）：
  - **計價**：費用 = 單期單生價(base×教練倍率) × **學生數** × **期數**（先前不隨人數/期數變動的 bug）。前端 `useEnrollmentPricing` 接 `studentCount`/`periodCount` 縮放、`PriceBreakdown` 顯示「單生價 × N 生 × M 期 = 小計」；後端 `enrollments.js` server-authoritative 重算 `unitPrice × studentCount × periodCount`、`promo preview` 用 scaled originalPrice + periodCount、落地 `admin_enrollments.period_count`+`coach_id`。
  - **版面**：`EnrollmentPage` 新增「購買期數」選擇器（放在組別之後、學員之前）。
  - **證明改事後上傳**：送出報名**不再需要證明/末5碼**（移除 `BankTransferBlock`、`canSubmit` 不再卡 proof）；後端 `payment_proof_url` 改非必填（帶了才驗格式）。送出後導到**報名狀態頁**。
  - **報名狀態頁** `EnrollStatusPage`（`/enroll-status/:id`）：顯示應繳金額、轉帳帳號（複製）、上傳匯款證明、狀態徽章（待繳款→已上傳待櫃台確認→已確認）；若屬團報則導去團購狀態頁（可見其他家庭繳費狀態）。`courses.js` 新增 `GET /:id`（單筆狀態，限本人）+ `POST /:id/payment-proof`（事後上傳，限本人/pending）+ `/mine` 回 `payment_proof_url`/`period_count`。`MyCoursesPage` 待對帳卡片改導向報名狀態頁。
- 2026-06-02：團報金流改流程（U10 里程碑1：家長端；後台里程碑2待做）：
  - **證明時機**：發起/加入**不再收證明**（`GroupMemberFields` 移除上傳欄、`memberFieldsReady` 不再要 proof、create/join 後端不再擋 `PAYMENT_PROOF_REQUIRED`）。改為**送審後各家於團購狀態頁自行上傳**。
  - **新端點** `POST /api/group-orders/:id/my-proof`：本團成員上傳/更換自己證明（forming/submitted 可；櫃檯已 `payment_confirmed` 後鎖定）。
  - **每家應繳金額**：`loadOrderWithMembers` 帶 `base_price`+coach 倍率，`shapeMember` 算 `amount_due = 單期單生價 × 該家學生數 × 期數`；狀態頁逐家顯示金額 + 證明狀態（未上傳/已上傳待確認/帳款已確認）。
  - **狀態頁**：自己那筆可上傳/更換證明；送審警語與 ConfirmModal 改為「送審後名單鎖定，等候期間各家先轉帳並上傳證明，櫃檯核對後建課」。
  - **Schema（idempotent）**：`group_order_members` 加 `proof_uploaded_at / payment_confirmed / payment_confirmed_at / payment_confirmed_by`；`group_orders` 加 `roster_approved / roster_approved_at / roster_approved_by`（供里程碑2）。
  - **里程碑2（待做）**：後台逐家「確認帳款」+「核准名單(需全員上傳)」+ 兩者成立自動建檔（含把先前的 reconcile 建課橋改接到此自動建檔）+ 後台團報標記。**現階段後台仍走舊 approve/reconcile**。
- 2026-06-02：團報人數上下限修正（依課程組別，非寫死 1–6）：
  - **Bug**：團購容量先前寫死 `GROUP_MIN/MAX=1/6`，與課程組別脫鉤，違反 U5 原始規格（「每品相人數上下限、後台可設定」）。1對2 應為學生數 1–2、1對3 為 2–3（`course_type_configs`）。
  - **修正**：`groupOrders.js` 發起時 `min_students/max_students` 改讀 `course_type_configs`；加入/送審沿用 `group_orders` 落地值（自動正確）。常數改名 `DRAFT_MAX_STUDENTS`（僅草稿陣列防呆絕對上限）。
  - **前端**：`GroupMemberFields` 加 `maxStudents` 上限（達上限擋選 + 顯示「已選 X/max」）；`GroupCreatePage` 傳 `courseType`、`GroupJoinPage` 傳剩餘可加入數，與一般報名「0/N」一致。團主可選滿（不擋，依使用者決策）。
  - 注意：**修正前建立的舊團報單**仍存著 1–6（顯示「開團需 1–6 人」），需新建一筆才會看到正確區間。
  - demo：新增第二測試家庭 `custom2`/`custom2`（0922222222，學員 測試-學員A/B）供「他人加入團報」測試。
- 2026-06-02：團報 U9（複數期數 + 對帳自動開通課程期，含教練端可見）：
  - **複數期數**：`group_orders` / `admin_enrollments` 新增 `period_count`（idempotent，預設 1，範圍 1–6）。發起頁 `GroupCreatePage` 加「購買期數」選擇器 + 草稿/還原一併帶 period_count；`groupOrders.js` POST 收驗（`normalizePeriodCount`）並落地；`shapeOrder`/`/mine`/admin 列表與詳情皆回傳 period_count；`GroupStatusPage` 與後台 `GroupOrdersPage` 顯示「· N 期」徽章。核准建 `admin_enrollments` 時價格 = 單期價 × 學生數 × **期數**。名單鎖定沿用送審後狀態機（4.5 / 4.7）。
  - **對帳自動開通課程期（補上架構 v7 §9.1 Step 7「立即自動開通」缺口）**：`admin/enrollments.js` reconcile 交易內新增 `ensureGroupCoursePeriod()` —— **僅針對團報**（`group_order_id` 有值）以 `group_order_id` 做冪等 get-or-create 一個**共用** `course_period`（`status='active'`、`coach_id`/`venue_id`/`course_type` 取自報名、`total_sessions = 每期堂數 × 期數`、`expires_at = 365 × 期數` 天、金額 = 整團費用總和），並把該成員 `group_order_members.student_ids` 加入 `course_period_enrollments`（`ON CONFLICT DO NOTHING`）。一般報名路徑**完全不變**（`period_count` 預設 1，且 `group_order_id` 為 NULL 時直接 return）。教練端課表讀 `course_periods`/`course_sessions`，自此團報核准+對帳後教練看得到、家長進得了「已開通課程期」可選槽。
  - **已驗證**：對真實 PG 16 在 rolled-back 交易內實跑 partial-index `ON CONFLICT (group_order_id) WHERE group_order_id IS NOT NULL` get-or-create —— ALTER 冪等、第一次建立/第二次不重建、`expires_at`=365×3、`total_sessions`=6×3，零寫入。前端 liff/admin build 通過、後端語法檢查通過。
  - **未完成/待真人點測**：教練端「選槽建 session」UI 流程（架構 v7 §9.2）本身是否已實作未在本輪驗證；一般報名（非團報）的 admin_enrollments→course_period 橋仍為系統既有缺口（students 僅存姓名、無 UUID），不在本輪範圍。
- 2026-06-02：前端韌性補強：
  - **未完成團報橫幅**：新增 `client/liff/src/components/IncompleteGroupOrdersBanner.jsx`，掛在 `HomePage` 頂部。並行載入 `groupOrdersApi.getDraft()`（填到一半的草稿）+ `groupOrdersApi.mine()`（status=forming 揪團中 / submitted 審核中），各自提供「繼續填寫」「查看 / 繼續」入口；無未完成項目時回傳 null 不顯示。避免家長中斷後找不到入口而重複建立團報。
  - **ErrorBoundary**：`client/liff` 與 `client/admin` 各新增 `components/ErrorBoundary.jsx`，於各自 `main.jsx` 包住根節點，元件樹拋例外時顯示友善錯誤頁而非白屏。
- 2026-06-02：四項調整：
  - **(1~2) Ragic 欄位/表單對應集中＋凍結**：新增 `server/config/ragicSchema.js` 作為唯一真實來源（表單路徑 / Field ID / LINE UID 綁定欄位 / H01 角色關鍵字）。`services/ragic.js`、`services/ragicAdmin.js`、`scripts/ragic-auth-smoke.js` 一律改 import，消除先前 `1003633`(H01) / `1006846`(Z01) 重複定義 3 份的漂移風險。角色抓取：櫃台→staff、教練→coach 取自 H01；主管(manager) 仍由後台手動指派。`docs/ragic_api.md` 標註凍結點。
  - **(3) 團報草稿暫存**：新增資料表 `group_order_drafts`（每位家長一筆 JSONB 草稿，`coreSchema.js` idempotent 建表）；`routes/groupOrders.js` 新增 `GET/PUT/DELETE /api/group-orders/draft`（parent JWT，需排在 `/:id` 之前）；`GroupCreatePage` 進頁面還原 + debounce 自動暫存，建立團購成功後自動清草稿。
  - **(4) 拔掉一對一(1V1)團報入口**：`EnrollmentPage` 在 `courseType===1` 隱藏「發起團購」區塊；`GroupCreatePage` 與後端 `POST /api/group-orders` 同步擋掉 1V1（防呆，前後端一致）。
- 2026-05-03：Phase 5 全功能完成 + 後台編輯報名 + 多組家庭綁定（見上方 Phase 5 補強節）。
- 2026-05-02：完成 LIFF Phase 1（任務 #7）。實作 7 個正式頁面 + 2 個 placeholder、6 個全域元件、雙 Context（Auth/Toast）、7 個 API 模組與 mock dataset、共用 utils；新增 `react-hook-form` 依賴、`postcss.config.js`；修正 `main.jsx` 加上無 LIFF_ID 的 dev fallback。`vite build` 通過（158 modules，401KB / 127KB gzip）。後端 19 個 stub 路由不變，LIFF 全程走 mock 模式以驗證 happy path；後續可由 `VITE_USE_MOCK=false` 切到真實 API，並透過 501 自動 fallback 機制漸進實作後端。
- 2026-05-02：完成 SurveyJS Creator 評估報告，結論為「**不建議整合**」（授權費 USD $589/dev/年、套件巨大、與 Ragic 雙向同步設計衝突）。完整分析詳見 `docs/eval/surveyjs-creator.md`，含替代方案比較與分階段建議。
- 2026-05-02：補完 `docs/ragic_api.md` 的 H01／H05／Z01／Z02 欄位對照（含 Field ID、表單 metadata、API Key 環境變數說明）。Z02 段落標註附件來源欄位疑似與 Z01 重複，待使用者確認真實欄位後再行更新。
- 2026-05-02：修復部署。將 `.replit` 部署目標從 `cloudrun` 改為 `autoscale`，新增 build 指令同時建置 server / admin / liff。`server/index.js` 加入靜態檔案服務（`/admin`、`/liff`）與 SPA fallback、根路徑轉址，並把 listen 綁到 `0.0.0.0`。為 `client/admin/` 補齊 `index.html`、`src/main.jsx`、`src/App.jsx`、`src/index.css` 最小骨架；為 `server/routes/` 19 個尚未實作的 route 建立暫時 stub（回傳 501 Not Implemented），讓 server 能正常啟動。
- 2026-05-02：完成 Admin 後端實作（任務 #12）。把 `server/routes/admin.js` 從 501 stub 換成 7 個子路由（auth/staff/venues/settings/courseIntros/enrollments/sessions），response shape 與 `client/admin/src/api/mock.js` 1:1 對齊。新增 `db/migrations/002_admin_tables.sql`（9 張 `admin_*` 表）、`server/bootstrap/admin.js`（啟動時 idempotent 建表 + seed 3 帳號 / 3 場館 / 6 員工 / 7 設定 / 3 課介 / 24 報名 + audit logs / 4 今日 session / 2 已取消時段；密碼 bcrypt 雜湊）、`server/middlewares/adminAuth.js`（JWT 簽 / 驗 / 角色 RBAC，使用 `JWT_SECRET`）、`server/services/ragicAdmin.js`（H01/H05 best-effort 同步，無 Ragic credential 時 noop）。`client/admin/src/api/client.js` 加 axios interceptor 自動帶 Bearer token、遇 401 自動登出。對帳 / 退費 / 復活 都寫 `admin_enrollment_audit_logs`（by_user/reason/refund_amount，退費理由必填）。E2E 測試：3 帳號登入、staff/manager/admin RBAC、reconcile/refund/refund-preview/revive、staff multiplier 1.0–1.5 校驗、settings PATCH 持久化全部通過；`VITE_USE_MOCK=false` build 後 mock 模組 0 出現於 bundle，靜態檔由 Express 直送 `/admin/`。
- 2026-05-02：完成 Admin Phase 3（任務 #11）。把 `client/admin/` 從一行 placeholder 擴成 13 頁完整桌機後台：登入 + Dashboard + Settings(F-A01) + Staff(F-A02) + Venues(F-A03) + CourseIntros(F-A04/F-M06) + Reconcile(F-M02) + Enrollments(F-R02) + Refund(F-R04) + Sessions(F-R01) + Checkin(F-R03) + Revive(F-M05)；含 9 個共用元件、雙 Context（Auth/Toast）、7 個 domain API 模組與 24 筆 mock 資料、`/api/admin/*` 自動 fallback 到 mock。每頁 ≤ 250 行；`vite build` 117 modules → 265KB / 86KB gzip。煙霧測試 `/admin/*`、SPA fallback、501 stub、LIFF 隔離全部通過。後端 17 條 endpoint 仍為 501 stub，後續任務 #12 接手實作真實 backend。
