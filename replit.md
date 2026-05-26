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
- 由 Express 同時提供：
  - `/api/*` → 後端 API
  - `/admin/*` → 後台 SPA（含 React Router fallback）
  - `/liff/*` → LIFF SPA（含 React Router fallback）
  - `/` → 預設 302 轉到 `/admin/`；若 query 帶有 `liff.*` 參數（LINE 開啟 LIFF 時會附），則改導到 `/liff/` 並保留 query
  - `/health` → 健康檢查
- WebSocket 透過同一個 HTTP server 啟動（`initWebSocket(server)`）。

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
- 2026-05-03：Phase 5 全功能完成 + 後台編輯報名 + 多組家庭綁定（見上方 Phase 5 補強節）。
- 2026-05-02：完成 LIFF Phase 1（任務 #7）。實作 7 個正式頁面 + 2 個 placeholder、6 個全域元件、雙 Context（Auth/Toast）、7 個 API 模組與 mock dataset、共用 utils；新增 `react-hook-form` 依賴、`postcss.config.js`；修正 `main.jsx` 加上無 LIFF_ID 的 dev fallback。`vite build` 通過（158 modules，401KB / 127KB gzip）。後端 19 個 stub 路由不變，LIFF 全程走 mock 模式以驗證 happy path；後續可由 `VITE_USE_MOCK=false` 切到真實 API，並透過 501 自動 fallback 機制漸進實作後端。
- 2026-05-02：完成 SurveyJS Creator 評估報告，結論為「**不建議整合**」（授權費 USD $589/dev/年、套件巨大、與 Ragic 雙向同步設計衝突）。完整分析詳見 `docs/eval/surveyjs-creator.md`，含替代方案比較與分階段建議。
- 2026-05-02：補完 `docs/ragic_api.md` 的 H01／H05／Z01／Z02 欄位對照（含 Field ID、表單 metadata、API Key 環境變數說明）。Z02 段落標註附件來源欄位疑似與 Z01 重複，待使用者確認真實欄位後再行更新。
- 2026-05-02：修復部署。將 `.replit` 部署目標從 `cloudrun` 改為 `autoscale`，新增 build 指令同時建置 server / admin / liff。`server/index.js` 加入靜態檔案服務（`/admin`、`/liff`）與 SPA fallback、根路徑轉址，並把 listen 綁到 `0.0.0.0`。為 `client/admin/` 補齊 `index.html`、`src/main.jsx`、`src/App.jsx`、`src/index.css` 最小骨架；為 `server/routes/` 19 個尚未實作的 route 建立暫時 stub（回傳 501 Not Implemented），讓 server 能正常啟動。
- 2026-05-02：完成 Admin 後端實作（任務 #12）。把 `server/routes/admin.js` 從 501 stub 換成 7 個子路由（auth/staff/venues/settings/courseIntros/enrollments/sessions），response shape 與 `client/admin/src/api/mock.js` 1:1 對齊。新增 `db/migrations/002_admin_tables.sql`（9 張 `admin_*` 表）、`server/bootstrap/admin.js`（啟動時 idempotent 建表 + seed 3 帳號 / 3 場館 / 6 員工 / 7 設定 / 3 課介 / 24 報名 + audit logs / 4 今日 session / 2 已取消時段；密碼 bcrypt 雜湊）、`server/middlewares/adminAuth.js`（JWT 簽 / 驗 / 角色 RBAC，使用 `JWT_SECRET`）、`server/services/ragicAdmin.js`（H01/H05 best-effort 同步，無 Ragic credential 時 noop）。`client/admin/src/api/client.js` 加 axios interceptor 自動帶 Bearer token、遇 401 自動登出。對帳 / 退費 / 復活 都寫 `admin_enrollment_audit_logs`（by_user/reason/refund_amount，退費理由必填）。E2E 測試：3 帳號登入、staff/manager/admin RBAC、reconcile/refund/refund-preview/revive、staff multiplier 1.0–1.5 校驗、settings PATCH 持久化全部通過；`VITE_USE_MOCK=false` build 後 mock 模組 0 出現於 bundle，靜態檔由 Express 直送 `/admin/`。
- 2026-05-02：完成 Admin Phase 3（任務 #11）。把 `client/admin/` 從一行 placeholder 擴成 13 頁完整桌機後台：登入 + Dashboard + Settings(F-A01) + Staff(F-A02) + Venues(F-A03) + CourseIntros(F-A04/F-M06) + Reconcile(F-M02) + Enrollments(F-R02) + Refund(F-R04) + Sessions(F-R01) + Checkin(F-R03) + Revive(F-M05)；含 9 個共用元件、雙 Context（Auth/Toast）、7 個 domain API 模組與 24 筆 mock 資料、`/api/admin/*` 自動 fallback 到 mock。每頁 ≤ 250 行；`vite build` 117 modules → 265KB / 86KB gzip。煙霧測試 `/admin/*`、SPA fallback、501 stub、LIFF 隔離全部通過。後端 17 條 endpoint 仍為 501 stub，後續任務 #12 接手實作真實 backend。
