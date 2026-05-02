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
- 登入：手機 → `GET /api/coaches/by-phone` 回傳 coach + JWT (12 小時)；token 存 `localStorage.daos.user.token`，axios interceptor 自動附 `Authorization: Bearer …`
- 登入端點安全緩解：per-IP 速率限制（5 attempts / 5min → 429）+ 失敗紀錄 console.warn；**LINE id_token 雙因素驗證為 follow-up #23**（追蹤項）
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
- Target：`autoscale`（單一服務）
- Build：依序 `npm install` server、admin、liff，並把兩個前端 build 到 `server/public/{admin,liff}`。LIFF build 階段會把 `LIFF_ID` 透過 `VITE_LIFF_ID` 注入給 Vite，前端用 `import.meta.env.VITE_LIFF_ID` 初始化 LIFF SDK。
- Run：`cd server && npm start`（`node index.js`）
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

## LIFF 前端進度

### Phase 1（核心購課流程）— 已完成
位於 `client/liff/src/`，使用 React 18 + Vite + Tailwind + react-router-dom + react-hook-form。

**已實作的頁面（`pages/`）：**
- `LoginPage.jsx` — 手機輸入 → mock 比對 Z01 → 找到設 parent / 找不到導去註冊
- `RegisterPage.jsx` — 家長表單 + 多筆學員子表單（`useFieldArray` 動態增減）
- `HomePage.jsx` — 三組別卡片 + 進行中優惠橫幅
- `VenueSelectPage.jsx` — 場館選單
- `CoachListPage.jsx` — 教練清單，資深教練金色徽章 + 已套修課係數的費用
- `EnrollmentPage.jsx` — 報名核心：組別切換、自身學員勾選、1對多時的同組家長手機查詢與學員勾選、優惠自動試算、銀行帳號一鍵複製、轉帳末 5 碼驗證、ConfirmModal 摘要
- `EnrollmentSuccessPage.jsx` — 「報名成功，等待對帳」結果頁
- `MyCoursesPage.jsx` — 課程列表，支援「全部 / 待對帳 / 進行中 / 已結束」分頁與堂數進度條
- `ChatPage.jsx`、`ProfilePage.jsx` — Phase 4／5 之前的 placeholder（Profile 已有學員清單與登出）

**全域元件（`components/`）：** `AppLayout`（手機寬度容器 + Header + 條件式 BottomNav）、`BottomNav`、`CoachCard`、`CourseCard`（catalog/period 雙模式）、`LoadingSpinner`、`ConfirmModal`、SVG 圖示元件。

**狀態與 API：**
- `context/AuthContext.jsx` — 用 `localStorage` 暫存 parent，跨分頁 `storage` 事件同步
- `context/ToastContext.jsx` — success / error / info / warning 四色 Toast
- `api/client.js` — 統一入口 `callApi()`：mock 模式直接回 mock，真實模式碰到 501 自動 fallback 到 mock 並 console.warn
- `api/mock.js` — 三場館、四教練、三家長、三筆已開通課程、兩個優惠的完整 mock dataset（含 1v1/1v2/1v3 三種狀態的 `CoursePeriod`）
- `api/{auth,parents,coaches,courses,enrollments,venues,promotions}.js` — 各 domain 模組
- `utils/format.js` — `formatTWD`（NT$ 千分位）、`formatTWDate`（含「週X」）、`isValidTWPhone`、`isValidLast5`、`isValidTWId`、課程狀態 / 組別 label 與顏色

**樣式約束（已落地）：**
- 全部使用 Tailwind `brand-{primary,teal,green,amber,gold}` token，無 hex 字面值
- 行動優先 `max-w-[390px]` 居中容器，桌面兩側留 `bg-gray-100`
- 字型 Noto Sans TC + Inter（`index.css` 已載 Google Fonts）
- 報名流程頁有 Header + 返回按鈕；tab 頁有 BottomNav
- LIFF SDK：`main.jsx` 加上「無 `VITE_LIFF_ID` → 跳過 liff.init 直接 mount」的 dev fallback，部署環境注入 ID 後行為不變

**Mock 模式控制：** `import.meta.env.VITE_USE_MOCK !== 'false'`（預設 true）。Phase 2+ 後端真實實作後，build 時加 `VITE_USE_MOCK=false` 即切回真實 API；若後端某 endpoint 還沒實作回 501，client 會自動 fallback 到 mock 並印 warning，不會打斷使用者操作。

### Phase 1 與後端的銜接點（給後續任務）
這些 endpoint 目前由 `server/routes/*.js` 全部回 501 stub。Phase 1 LIFF 已用 mock 補位，後續任務只要把這些 endpoint 實作好（並讓 response shape 對齊 `client/liff/src/api/mock.js`），LIFF 就能無縫切換：
| Endpoint | 模組 | mock 回應 |
|---|---|---|
| `GET /api/venues` | `routes/venues.js` | `mockDb.venues()` |
| `GET /api/venues/:id` | 同上 | `mockDb.venue(id)` |
| `GET /api/coaches?venueId=` | `routes/coaches.js` | `mockDb.coaches({ venueId })` |
| `GET /api/coaches/:id` | 同上 | `mockDb.coach(id)` |
| `GET /api/promotions` | `routes/promotions.js` | `mockDb.promotions()` |
| `GET /api/parents/by-phone?phone=` | `routes/parents.js` | `mockDb.parentByPhone(phone)` |
| `POST /api/parents` | 同上 | `mockDb.createParent(body)` |
| `GET /api/courses/base-price?courseType=` | `routes/courses.js` | `{ original_price }` |
| `GET /api/courses/mine?parentId=` | 同上 | `mockDb.myCourses(parentId)` |
| `POST /api/enrollments` | 暫無對應檔（可放 `routes/courses.js` 子路由或新增 `enrollments.js`） | `mockDb.createEnrollment(body)` |
| `POST /api/auth/bind-line` | `routes/auth.js` | `{ ok: true, bound_at }` |

### Phase 2-6 待辦（不在本 Phase 1 範圍）
- Phase 2：選槽日曆（`SlotCalendar`）、簽到（`CheckinPage`）、自助取消
- Phase 3：教練端 LIFF（排課總表 F-C02、學員管理）
- Phase 4：聊天室（含 WebSocket、關鍵字警示）
- Phase 5：學習歷程（資深教練專屬）、期末評鑑、`StarRating`
- Phase 6：MGM 推薦、後台管理（admin/）

## 後台 Admin 進度

### Phase 3（後台管理基礎）— 已完成
位於 `client/admin/src/`，使用 React 18 + Vite + Tailwind + react-router-dom。桌機優先 Sidebar Layout，每頁 ≤ 250 行。

**響應式行為（明確的設計取捨）：**
- 主要使用情境是場館主管 / 管理員在桌機上做日常營運，因此採桌機優先設計。
- Sidebar (`w-64`) 套用 `hidden md:flex`，斷點 `md` (≥ 768px) 以上才顯示；< 768px 時 Sidebar 會被完全隱藏，目前**不**提供漢堡選單或抽屜替代方案。
- 平板（768px – 1023px）可正常使用所有功能；手機（< 768px）僅能看到 Header + 內容區，無法切換頁面 — 預期由 LIFF 行動端覆蓋家長 / 教練的手機情境，後台手機支援列為後續任務範圍。

**架構：**
- `main.jsx` — 用 `BrowserRouter basename="/admin"` 包 `<AuthProvider>` + `<ToastProvider>`
- `App.jsx` — 13 條 route，全部走 `<RequireAuth roles=[...]>` 守門
- `components/AppLayout.jsx` — Sidebar (w-64) + Header (h-16) + main scroll 區
- `components/Sidebar.jsx` — 4 群組 nav，依 `useAuth().role` 動態 hide/show 項目
- `components/Header.jsx` — 顯示姓名、角色 badge、登出按鈕
- `components/RequireAuth.jsx` — 未登入導 `/login`；已登入但無權限顯示拒絕畫面
- `components/{DataTable,StatusBadge,PageHeader,ConfirmDialog,LoadingSpinner}.jsx` — 通用元件

**13 個頁面：**
| Path | 元件 | 對應 spec | 角色 |
|---|---|---|---|
| `/login` | `LoginPage` | — | 公開 |
| `/dashboard` | `DashboardPage` | 自製概覽 | 全部 |
| `/settings` | `SettingsPage` | F-A01 系統設定 | admin |
| `/staff` | `StaffPage` | F-A02 員工管理 | admin |
| `/venues` | `VenuesPage` | F-A03 場館設定 | admin |
| `/course-intros` | `CourseIntrosPage` | F-A04 / F-M06 課程介紹 | admin/manager |
| `/reconcile` | `ReconcilePage` | F-M02 待對帳 | admin/manager |
| `/enrollments` | `EnrollmentsPage` | F-R02 所有報名 | 全部（櫃檯依 venue_id 過濾） |
| `/refund` | `RefundPage` | F-R04 退課 | admin/manager |
| `/sessions` | `SessionsPage` | F-R01 今日課程 | 全部 |
| `/checkin` | `CheckinPage` | F-R03 簽到驗證 | 全部 |
| `/revive` | `RevivePage` | F-M05 退課復活 | admin/manager |

**狀態與 API：**
- `context/AuthContext.jsx` — 用 `localStorage(daos.admin.user)` 暫存 user，跨分頁 `storage` 事件同步；提供 `isAdmin/isManager/isStaff` 旗標
- `context/ToastContext.jsx` — 與 LIFF 同款 4 色 Toast
- `api/client.js` — `callApi()` 走 `/api/admin/*`；`USE_MOCK = VITE_USE_MOCK !== 'false'`；遇 501 自動 fallback 到 mock
- `api/mock.js` — 集中 mock dataset：3 登入帳號、3 場館、6 員工（含 4 教練 + 1 主管 + 1 櫃檯）、24 筆 enrollment（pending_payment 8、confirmed 3、active 9、cancelled 2、refunded 2）、4 個今日 sessions、2 個已取消時段、課介 1/2/3、全域 settings 7 個欄位
- `api/{auth,staff,venues,settings,courseIntros,enrollments,sessions}.js` — domain modules

**Mock 帳號（密碼 = 帳號）：**
- `admin / admin` — 系統管理員（看得到 13 頁全部）
- `manager / manager` — 場館主管（板橋館，無系統設定 / 員工 / 場館 三頁；但保有課程介紹 F-M06）
- `staff / staff` — 行政櫃檯（板橋館，僅可見 Dashboard / Enrollments(讀) / Sessions / Checkin 四頁；不可見對帳、退課、復活、所有系統設定；且報名清單依 `venue_id` 過濾）

### Admin Phase 3 與後端的銜接點 ✅ 已實作（任務 #12）
`server/routes/admin.js` 已改為 mount 7 個子路由（`server/routes/admin/{auth,staff,venues,settings,courseIntros,enrollments,sessions}.js`），所有 response shape 與 `client/admin/src/api/mock.js` 完全一致。
- 認證：`POST /api/admin/auth/login` 用 bcrypt 比對 `admin_users.password_hash`，回傳 JWT（`JWT_SECRET`，預設 7 天），前端 `client/admin/src/api/client.js` 攔截器自動帶 `Authorization: Bearer`，遇 401 清 localStorage 並導回 `/admin/login`。
- **production 安全規則**：
  1. `JWT_SECRET`（≥ 16 chars）為必要 env；缺少時 `assertSecretConfigured()` 在 startup 直接 throw → process exit。non-production 才允許 fallback secret（會 log 警告）。
  2. `admin/admin`、`manager/manager`、`staff/staff` 這類 well-known 弱密碼**只**在 non-production 自動 seed。production 必須提供 `ADMIN_BOOTSTRAP_PASSWORD`（會套用到三個 seed 帳號）；若缺，user seed 自動跳過並提示 operator 手動建帳號。
- 授權（已在 server 端強制）：
  - admin only：`GET /staff`、`PATCH /staff/:id`、`GET /settings`、`PATCH /settings`、`PATCH /venues/:id`、`POST /sessions/:id/revive`
  - admin + manager：`GET /course-intros`、`PATCH /course-intros/:type`、`POST /enrollments/:id/reconcile`、`POST /enrollments/:id/refund`、`GET /sessions/cancelled`
  - 全角色（含 staff）：`GET /venues`（staff/manager 看不到 `line_token` / 銀行欄位）、`GET /enrollments`（staff 強制鎖在 `req.adminUser.venue_id`，忽略 client 端的 `venueId`）、`GET /sessions/today`（同 staff 場館鎖）、`GET /sessions/verify-checkin`（staff 跨館查詢一律回 `found:false`）
- Postgres：`db/migrations/002_admin_tables.sql` 建 9 張 `admin_*` 表（users/venues/staff/settings/course_intros/enrollments/enrollment_audit_logs/today_sessions/cancelled_sessions）。`server/bootstrap/admin.js` 在 server 啟動時 idempotent 建表 + 第一次空表時 seed（含 24 筆 enrollments + audit logs，密碼 bcrypt hash）。
- Audit log：對帳 / 退費 / 復活 都寫入 `admin_enrollment_audit_logs`（by_user / reason / refund_amount）。退費理由必填。
- Ragic 同步（best-effort）：`server/services/ragicAdmin.js` 在 `GET /staff` 與 `GET /venues` 時呼叫 H01 / H05 並 upsert 進系統 DB；無 Ragic credential 時 noop，失敗時 swallow + warn，不阻擋使用者操作。系統內部欄位（role / multiplier / is_senior / line_token / 銀行帳戶）一律以系統 DB 為準，不會被 Ragic 蓋掉。
- 前端切換：`VITE_USE_MOCK=false npx vite build` 會把 mock 模組整段 tree-shake 掉（dist 內 `mockDb` 為 0 個出現）；admin 13 頁全部走真實後端，重整後狀態保留。

下表為原 mock 對應表（response shape 不變）：

| Endpoint | mock 回應 |
|---|---|
| `POST /api/admin/auth/login` | `mockDb.login(username, password)` |
| `GET /api/admin/staff` | `mockDb.staff()` |
| `PATCH /api/admin/staff/:id` | `mockDb.updateStaff(id, patch)` |
| `GET /api/admin/venues` | `mockDb.venues()` |
| `PATCH /api/admin/venues/:id` | `mockDb.updateVenue(id, patch)` |
| `GET /api/admin/settings` | `mockDb.settings()` |
| `PATCH /api/admin/settings` | `mockDb.updateSettings(patch)` |
| `GET /api/admin/course-intros` | `mockDb.courseIntros()` |
| `PATCH /api/admin/course-intros/:type` | `mockDb.updateCourseIntro(type, patch)` |
| `GET /api/admin/enrollments?status=&search=&venueId=` | `mockDb.enrollments(filters)` |
| `POST /api/admin/enrollments/:id/reconcile` | `mockDb.reconcile(id, by)` |
| `GET /api/admin/enrollments/:id/refund-preview` | `mockDb.refundPreview(id)` |
| `POST /api/admin/enrollments/:id/refund` | `mockDb.refundEnrollment(id, reason, by)` |
| `GET /api/admin/sessions/today?venueId=` | `mockDb.todaySessions(venueId)` |
| `GET /api/admin/sessions/verify-checkin?phone=&periodId=` | `mockDb.verifyCheckin(q)` |
| `GET /api/admin/sessions/cancelled` | `mockDb.cancelledSessions()` |
| `POST /api/admin/sessions/:id/revive` | `mockDb.reviveSession(id)` |

## 變更紀錄
- 2026-05-02：完成 LIFF Phase 1（任務 #7）。實作 7 個正式頁面 + 2 個 placeholder、6 個全域元件、雙 Context（Auth/Toast）、7 個 API 模組與 mock dataset、共用 utils；新增 `react-hook-form` 依賴、`postcss.config.js`；修正 `main.jsx` 加上無 LIFF_ID 的 dev fallback。`vite build` 通過（158 modules，401KB / 127KB gzip）。後端 19 個 stub 路由不變，LIFF 全程走 mock 模式以驗證 happy path；後續可由 `VITE_USE_MOCK=false` 切到真實 API，並透過 501 自動 fallback 機制漸進實作後端。
- 2026-05-02：完成 SurveyJS Creator 評估報告，結論為「**不建議整合**」（授權費 USD $589/dev/年、套件巨大、與 Ragic 雙向同步設計衝突）。完整分析詳見 `docs/eval/surveyjs-creator.md`，含替代方案比較與分階段建議。
- 2026-05-02：補完 `docs/ragic_api.md` 的 H01／H05／Z01／Z02 欄位對照（含 Field ID、表單 metadata、API Key 環境變數說明）。Z02 段落標註附件來源欄位疑似與 Z01 重複，待使用者確認真實欄位後再行更新。
- 2026-05-02：修復部署。將 `.replit` 部署目標從 `cloudrun` 改為 `autoscale`，新增 build 指令同時建置 server / admin / liff。`server/index.js` 加入靜態檔案服務（`/admin`、`/liff`）與 SPA fallback、根路徑轉址，並把 listen 綁到 `0.0.0.0`。為 `client/admin/` 補齊 `index.html`、`src/main.jsx`、`src/App.jsx`、`src/index.css` 最小骨架；為 `server/routes/` 19 個尚未實作的 route 建立暫時 stub（回傳 501 Not Implemented），讓 server 能正常啟動。
- 2026-05-02：完成 Admin 後端實作（任務 #12）。把 `server/routes/admin.js` 從 501 stub 換成 7 個子路由（auth/staff/venues/settings/courseIntros/enrollments/sessions），response shape 與 `client/admin/src/api/mock.js` 1:1 對齊。新增 `db/migrations/002_admin_tables.sql`（9 張 `admin_*` 表）、`server/bootstrap/admin.js`（啟動時 idempotent 建表 + seed 3 帳號 / 3 場館 / 6 員工 / 7 設定 / 3 課介 / 24 報名 + audit logs / 4 今日 session / 2 已取消時段；密碼 bcrypt 雜湊）、`server/middlewares/adminAuth.js`（JWT 簽 / 驗 / 角色 RBAC，使用 `JWT_SECRET`）、`server/services/ragicAdmin.js`（H01/H05 best-effort 同步，無 Ragic credential 時 noop）。`client/admin/src/api/client.js` 加 axios interceptor 自動帶 Bearer token、遇 401 自動登出。對帳 / 退費 / 復活 都寫 `admin_enrollment_audit_logs`（by_user/reason/refund_amount，退費理由必填）。E2E 測試：3 帳號登入、staff/manager/admin RBAC、reconcile/refund/refund-preview/revive、staff multiplier 1.0–1.5 校驗、settings PATCH 持久化全部通過；`VITE_USE_MOCK=false` build 後 mock 模組 0 出現於 bundle，靜態檔由 Express 直送 `/admin/`。
- 2026-05-02：完成 Admin Phase 3（任務 #11）。把 `client/admin/` 從一行 placeholder 擴成 13 頁完整桌機後台：登入 + Dashboard + Settings(F-A01) + Staff(F-A02) + Venues(F-A03) + CourseIntros(F-A04/F-M06) + Reconcile(F-M02) + Enrollments(F-R02) + Refund(F-R04) + Sessions(F-R01) + Checkin(F-R03) + Revive(F-M05)；含 9 個共用元件、雙 Context（Auth/Toast）、7 個 domain API 模組與 24 筆 mock 資料、`/api/admin/*` 自動 fallback 到 mock。每頁 ≤ 250 行；`vite build` 117 modules → 265KB / 86KB gzip。煙霧測試 `/admin/*`、SPA fallback、501 stub、LIFF 隔離全部通過。後端 17 條 endpoint 仍為 501 stub，後續任務 #12 接手實作真實 backend。
