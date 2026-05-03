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
- LIFF：LINE Console 只建 **1 個** LIFF App，Endpoint URL 設 `https://daos-tutoring-courses.replit.app/liff/`（無 `#`，前端為 BrowserRouter）。家長分享 `https://liff.line.me/<LIFF_ID>`、教練分享 `https://liff.line.me/<LIFF_ID>/coach`，LIFF SDK 會把 `/coach` path 自動接到 Endpoint URL 後面送給前端。
- `LIFF_URL` 環境變數設 `https://liff.line.me/<LIFF_ID>`（無結尾斜線，無 `#`）；cron / learn 會自動接 `/my-courses`、`/evaluation/:id`、`/history/:periodId`、`/referral` 等路徑。
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

## Phase 5：學習歷程 + 期末評鑑 + 教練考核 (任務 #16 已完成)
DB：新增 `tag_categories` / `tag_library` / `coach_personal_tags` / `lesson_plans` / `session_records` / `session_record_versions` / `session_record_tags` / `course_evaluations` / `eval_thresholds`；於 `coaches` 補 `intro_review_note` / `intro_submitted_at` / `intro_reviewed_at` / `intro_reviewed_by`。Bootstrap 自動 seed 4 分類 × 16 預設標籤、3 條預設考核門檻（avg_overall≥4 / avg_teaching≥4 / renew_rate≥0.6，window 3 個月）。

API：
- `/api/learn/*`（教練+家長）：`GET/PUT/POST plans/:periodId(/publish)`、`GET/PUT/POST records/by-session/:id(/submit|/copy-prev|/versions)`、`GET tags`、`POST/DELETE personal-tags/:id`、`POST uploads`、家長 `GET history/:periodId`。
- `/api/evaluations/*`（家長）：`mine` / `:id` / `:id/submit`（4 維評分 + 文字 + 續報意願）。
- `/api/admin/learn/*`：tag/category CRUD（F-A08）、coach-eval 報表（F-M09，月趨勢 + 評語）、threshold CRUD（F-A09）、coach intros 審核 approve/reject（F-C06）。
- 寫入 `lesson_plans.publish` / `session_records.submit` 觸發 LINE 通知（`coursePlanPublished` / `sessionRecordPublished`）。

Cron：每日 10:00 期末邀請 + 7 天提醒兩個 job 已實作（`evaluationInvite` Flex 推播 + `course_evaluations.reminder_sent_at`）。

LIFF：教練 `/coach/plan/:periodId`（LessonPlanFormPage：5 區塊草稿/發佈）、`/coach/record/:sessionId`（SessionRecordFormPage：點標籤帶入文案、媒體上傳、複製前一堂、submit 版本化）；家長 `/history/:periodId`（時間軸 + 列印）、`/evaluation/:id`（4 維 ★ + 續報意願）；CoachSessionPage 增加「填課前規劃 / 填授課記錄」CTA、MyCoursesPage 點卡片進入學習歷程。

Admin：Sidebar 新增「學習歷程」群組 → `/tags`（F-A08，分類 + 標籤 CRUD）、`/coach-eval`（F-M09，總覽 + 詳細報表）、`/eval-threshold`（F-A09，可調整最低值與觀察月數）、`/coach-intros-review`（F-C06，待審 / 已退回 / 已上架 tab）。

Mock：`liff` mockDb 新增 `lessonPlan/saveLessonPlan/publishLessonPlan/sessionRecord/saveSessionRecord/submitSessionRecord/copyPrevRecord/learnTags/learningHistory/myEvaluations/evaluationDetail/submitEvaluation`，斷網／無資料時仍可走完 happy path。

Builds：admin 304KB / liff 480KB（gzip 96 / 148）。所有 UI 頁面 ≤ 250 行（最大 SessionRecordFormPage 178）。煙霧：admin login → /admin/learn/{tags=4 cats|coach-eval=4|intros=4|thresholds=3} 全 200。

## Phase 6 (上)：優惠活動 + 折價券 + 購課套用 (任務 #17 已完成)
DB：新增 `promotions` / `promotion_usages` / `promotion_audit_logs`（migration 006 + coreSchema bootstrap）。
- promotions 欄位：name / description / type(`PERCENTAGE`|`FIXED_AMOUNT`) / discount_value(NUMERIC，PERCENTAGE 為「保留比例」0..1) / min_threshold_type(`PERIOD_COUNT`) / min_threshold_value / applicable_course_types(INTEGER[]) / applicable_venue_ids(VARCHAR[]) / coupon_code(UNIQUE，NULL=自動套用) / start_date / end_date / max_uses / current_uses / status(`draft`/`pending_review`/`active`/`rejected`/`archived`) / 審核欄位 + 軌跡。
- promotion_usages：parent_id / promotion_id / course_period_id + 三欄金額供對帳；`recordUsage()` 由 enrollment 流程在交易內呼叫。

API：
- 公開 `/api/promotions`（GET 進行中自動套用列表，coupon code 不外露） 與 `/api/promotions/preview`（POST：原價 + 組別 + 場館 + 可選 couponCode → 最佳折抵；coupon 錯誤回 400 + code）。
- 後台 `/api/admin/promotions`：list / create(draft) / detail(含 audit + usage stats) / patch / submit / approve(admin) / reject(admin, note) / archive；另有 `/active` 給 R05。Manager 建草稿 → 送審 → admin 核准 → active。

服務：`server/services/promotions.js` 內含 `listActivePromotions` / `previewBestDiscount`（自動 + 折價券分支，scope/threshold/exhausted/window 全檢查）/ `recordUsage`（寫 promotion_usages + UPDATE current_uses）。

LIFF：購課頁 `useEnrollmentPricing` 改為純 base/multiplier 結構 + 內建呼叫 `promotionsApi.preview` 拿最佳折抵；新增折價券輸入區（套用 / 取消，錯誤訊息直顯紅字）；EnrollmentPage create payload 帶 promotion 區塊（promotion_id + discount + coupon_code）供未來 enrollment 寫入時 call `recordUsage`。HomePage 橫幅維持讀 `/api/promotions`。

Admin：Sidebar 新增「行銷與優惠」群組 → `/promotions`（F-M07/F-A05：篩選 + 表格 + 狀態流轉按鈕，退回需備註）、`/promotions-active`（F-R05：唯讀進行中）；`PromotionFormModal` 支援自訂或自動產生折價券代碼、組別/場館多選 chips、起迄日驗證。

Mock：LIFF mockDb 新增 `previewPromotion`，含 WELCOME10 折價券測試代碼，斷網仍可走完試算流程。

煙霧：admin login → 建立 → submit → approve → /api/promotions/active 與 /api/promotions（LIFF 公開）皆出現該活動；preview 自動套用 11700 → 11115（折抵 585）；coupon=WELCOME10 → 折抵 500；coupon=NOPE 回 COUPON_INVALID 400。

## Phase 6 (下)：MGM 推薦連結 + 推薦統計 (任務 #18 已完成)
DB：新增 `referral_records`（migration 007 + coreSchema bootstrap，皆 idempotent）。token UNIQUE、`UNIQUE(referee_phone, coach_id) WHERE referee_phone IS NOT NULL` partial index 防同手機重複推薦同教練；status 流轉 `pending → registered → trial_paid → checked_in → reward_issued`。同步補 `parents.email/gender`、`students.id_number/gender`、seed `TRIAL50` 體驗課 5 折 promo。

服務：`server/services/referrals.js` 含 `createLink`（產 token、寫 record）、`findByToken`（含 referrer + coach 摘要）、`bindReferee`（註冊時若 ref_token 有效且非自推薦 → 寫 referee_parent_id + status=registered）、`markTrialPaid`（enrollment 提交時更新）、`issueRewardForEnrollment`（簽到時建立 9 折 `MGM***` promotion code、寫 reward_promotion_id、推 LINE Flex `mgmRewardIssued`）。所有狀態轉換可在外層交易內呼叫。

API：
- 公開 `GET /r/:token` → 302 redirect 到 `/liff/register?ref=<token>`（QR / LINE 分享進入點）。
- LIFF (parent JWT)：`POST /api/referrals` 產連結、`GET /api/referrals/by-token/:token` 顯示推薦資訊（不需登入）、`GET /api/referrals/mine` 我的推薦清單。
- LIFF：`POST /api/parents` 接受 `ref_token` → 註冊成功後綁定 referee。
- LIFF：`POST /api/enrollments` 在交易內驗證 `TRIAL50` 僅限受推薦的 referee + 對應教練（否則 400 `COUPON_OUT_OF_SCOPE`），通過則 `markTrialPaid`。
- 後台：`POST /api/admin/sessions/checkin {enrollmentId}` → 寫 `experience_checked_in_at` + 觸發 `issueRewardForEnrollment`（staff 限本場館）。
- 後台：`GET /api/admin/mgm-stats?coachId&venueId&from&to` → 漏斗統計（`total / byStatus / conversionRate / coachRanking[]`）。

LIFF：`RegisterPage` 讀 `?ref=` 顯示推薦人 + 教練資訊，註冊成功後若綁定成功 → 寫 `localStorage.daos.pendingCoupon = {coupon: 'TRIAL50', coachId}` 並導去 `/coaches/:coachId`。`EnrollmentPage` 讀 pendingCoupon 同教練自動套用，提交成功清除。新增 `ReferralPage`（場館內教練清單 → 一鍵產生連結 → 複製 / LINE 分享，下方列我的推薦紀錄含狀態徽章），HomePage 加綠色 entry banner。

Admin：Sidebar「行銷與優惠」新增 `/mgm-stats`（admin/manager 可見），`MgmStatsPage` 含日期 + 場館 + 教練篩選、4 張 KPI、狀態分布 chips、教練被推薦排行表（含轉換率）。

安全：MGM 9 折獎勵券於 `promotions` 新增 `eligible_parent_id` 欄位綁定持有者；`previewBestDiscount` / `recordUsage` 強制比對 `parentId`，非持有者回 `COUPON_NOT_OWNER`；自動套用流程跳過所有私人券。`/api/promotions/preview` 加 `optionalParent` 中介層自動帶入 JWT 中的 parentId。狀態機防重發：`issueRewardForEnrollment` 在交易內 `SELECT FOR UPDATE` referral row → 顯式三段式 `trial_paid → checked_in → reward_issued`，並以 `reward_promotion_id IS NULL` 條件式 UPDATE 杜絕並發重發。`bindReferee` 僅允許 `status='pending' AND referee_phone IS NULL` 的 row 被佔用（單次綁定，避免覆寫前綁定）。`markTrialPaid` 以 `(refereeParentId, coachId)` 為 scope，避免跨教練誤更新。

煙霧：health 200 / `/r/abc123` → 302 / `/api/referrals/by-token/...` 404（unknown token）/ `/api/admin/mgm-stats` 401（未登入）/ `/api/promotions/preview` 200 / liff & admin 靜態頁 200。Builds：admin 324KB、liff 491KB（gzip 101 / 151）。所有新頁 ≤ 250 行（最大 RegisterPage 168）。

## Phase 7：課程轉讓 + 報表 + 上課記錄 + LINE cron + 教練介紹優化 (任務 #19 已完成)
DB：`server/bootstrap/coreSchema.js` 新增 `transfer_records`（pending_review/approved/rejected/cancelled，from→to phone 對應，sessions_remaining 快照、reason 必填、reviewer 軌跡）與 `notification_log`（UNIQUE `(kind, ref_id, recipient_uid)` 避免 cron 重複推播）。bootstrap idempotent，psql 驗證通過。

服務／路由：
- `server/services/transfers.js`：建立／審核交易內處理 sessions_remaining 過戶（from -=、to += 或 create row）、寫 admin_enrollment_audit_logs、status FSM 防重複審核。
- `server/routes/transfers.js`（parent JWT）：POST 建立、GET /mine、PATCH /:id/cancel；自動以 to_phone 解析 to_parent_id。
- `server/routes/admin/transfers.js`：GET 列表（status/q 篩選）、PATCH /:id/approve | /reject（限 admin/manager）；通過 LINE 推 `transferReviewed` 給雙方。
- `server/routes/admin/reports.js`：5 endpoints — `/revenue`（依場館 / 月份）、`/sessions`（場館 / 教練上課堂數）、`/discounts`（每張券折抵總額 + 使用次數）、`/mgm-conversion`（複製 mgm-stats 漏斗 + 按月）、`/learning-completion`（plan/record 完成率）。皆支援 from/to/venueId/coachId 篩選。
- `server/routes/courses.js` 新增 GET `/lessons`（parent JWT）：列出自己孩子各 enrollment 的剩餘堂數，給 LIFF 課程轉讓 / 我的課堂頁。
- LINE templates 新增：`transferRequest`（推給家長 + 主管）、`transferReviewed`（雙方）、`mgmTrialTodayReminder`。

Cron（`server/cron/index.js` 取代 3 個 TODO）：
- 每小時：找 60–120 分鐘後即將開始的 sessions，依 enrollment → coach uid + parent uids 推 `sessionReminder`（帶 `scheduledAt` / `role`）。`notification_log` UNIQUE 鍵 `('session_reminder', sessionId, uid)` dedupe。
- 每日 09:00：剩餘 ≤2 堂或 30 天內到期的 enrollments → 推 `expiryReminder(remainingSessions)` 給家長。
- 每日 09:30：當天有體驗課的 MGM referee → 推 `mgmTrialTodayReminder` 給家長與被推薦教練。

LIFF：
- `TransferRequestPage`：選課程 → 填對方手機 + 堂數 + 理由 → submit。route 包在 `<AppLayout title="課程轉讓" showBackButton>`，內頁用簡單 h1（無 PageHeader 元件）。
- `MyLessonsPage`：列出每個孩子的所有課程剩餘堂數、到期日，內含「申請轉讓」連結。
- HomePage 加 2-button grid 進入「我的課堂」、「課程轉讓」。
- `CoachProfilePage` 頂部優化：漸層 primary→teal 卡片、資深 / 一般 徽章、收費倍率與可教場館 2-grid、若有 `intro_review_status` 顯示中文狀態。

Admin：
- `TransfersReviewPage`：tabs（全部 / 待審 / 通過 / 拒絕）+ q 搜尋、approve/reject inline form（review_note 必填）。
- `ReportsPage`：5 個 tabs 對應 5 endpoints，每 tab 共用 from/to/venueId/coachId 篩選列、表格 + 一鍵 CSV 匯出（utf-8 BOM，Excel 友善）。
- Sidebar「報表」「課程轉讓」分組（admin/manager only）；`App.jsx` 註冊 `/reports`、`/transfers`、parent LIFF `/transfer/new`、`/my-lessons`。

煙霧：DB schema psql 驗證通過；admin build 335KB / 104KB gzip、LIFF build 500KB / 154KB gzip（含 CoachProfile 改版）。Server 啟動 `[Cron] All cron jobs initialized` + `[core bootstrap] ready` 無錯。每個新頁 ≤ 250 行（最大 ReportsPage ~240）。

## Phase 8：整合測試 + Flex 全項驗證 + 效能基線 + UAT 上線準備 (任務 #20 已完成)

### 文件
- `docs/flex_message_checklist.md`：18 種 Flex Message 對應表（spec # → 模板函數 → 觸發點 → 接收者 → 驗證紀錄欄）。
- `docs/deploy_checklist.md`：上線前 8 大項檢查（Replit Secrets / LINE / Ragic / DB / Build / 備份 / 監控 / Cutover）。
- `docs/perf_baseline.md`：HTTP（autocannon）/ WS / 上傳 三個基線量測流程與表格樣板（驗收線：API P95 <500ms、WS P95 <200ms、上傳成功率 >99%）。
- `docs/uat_playbook.md`：行政 / 主管 / 教練 / 家長 4 角色共 14 條 UAT 案例 + P1/P2/P3 缺陷分級 + 簽核表。

### 程式碼
- `server/services/ragic.js` 加 in-process LRU+TTL 快取（預設 5 分鐘，可由 `RAGIC_CACHE_TTL_MS` 調整）：`getActiveCoaches/getCounterStaff/getAllStaff/getActiveVenues` 走 cache；`upsertParent/upsertStudent` 寫回後自動 invalidate `z01:` / `z02:`。
- `scripts/backup_db.sh`：每日 `pg_dump | gzip` → Replit Object Storage（建議在 Scheduled Deployments 03:00 執行）。配套 `scripts/_object_storage_upload.js` 在沒有 replit CLI 時改用 SDK。
- `tests/e2e/`：8 條路徑 (A 購課 / B 排課 / C 1vN / D 取消 / E 優惠 / F MGM / G 學習歷程 / H 轉讓) 各自 ≤ 30 行 smoke 腳本 + `run_all.js` 一鍵跑完，本機跑全部 ✅。
- `tests/perf/run_http_baseline.sh`、`ws_latency.js`、`upload_smoke.js`：核心 API 4 路徑 autocannon、WebSocket 100 ping P50/P95、100 次上傳成功率。
- `.env.example` 加 `RAGIC_CACHE_TTL_MS` / `BASE_URL` / `ADMIN_USERNAME` / `ADMIN_PASSWORD` 區塊。

### 煙霧
- `Start application` 啟動正常、`[Cron] All cron jobs initialized` + `[core bootstrap] ready`。
- `node tests/e2e/run_all.js` 8/8 PASS。
- 既有 admin (336KB) / liff (502KB) build 不變，本 phase 不動 client UI。

## Task #32：後台教練資料管理頁 (F-C-Admin) + Ragic 同步補強 (已完成)

### 根因
系統有兩張平行教練表：`coaches`（LIFF 用，UUID PK，含 bio / multiplier / specialties / intro_review_status）vs `admin_staff`（後台 HR 用，工號 PK，已由 `syncStaffFromRagic` 同步 H01）。後台沒有任何頁面讀 `coaches` → 「看不到完整教練清單」。`coaches` 表原本只由 `coreSchema.js` 寫死 4 筆假資料，從未從 Ragic 同步。

### 變更
- `server/services/ragicAdmin.js` 新增 `syncCoachesFromRagic()`：H01 在職 + 應徵職務含「教練」→ upsert 到 `coaches`，key=`ragic_employee_id`；只更新 `name/phone/email/is_active`，系統內部欄位（`is_senior/pricing_multiplier/bio_rich_text/specialties/intro_review_status/line_uid`）以後台手動編輯為準。不在 Ragic 在職教練名單中的列 → 標 `is_active=false`（軟刪除）。
- `server/services/ragicAdmin.js` 中 `syncVenuesFromRagic()` 加強：除了 `admin_venues` 之外，也鏡寫到 LIFF 用的 `venues` 表（同一個 id 對齊 FK），且不在 H05 履約中名單的 venue 標 `is_active=false`，避免後台一次清掉造成歷史 FK 斷裂。
- `server/routes/admin/coaches.js`（新檔）：`GET /` 列表（先 best-effort sync）、`GET /:id` 詳細（含 `coach_bio_media` + `coach_venues`）、`PATCH /:id` 改 email / is_senior / multiplier(1.0–1.5) / specialties / bio_rich_text / is_active / venue_ids（M:N 全量替換，TRANSACTION 包起來且驗證 venue 存在）。全 admin only。
- `server/routes/admin.js` mount `/api/admin/coaches`。
- `client/admin/`：新增 `pages/CoachesPage.jsx`（≤230 行，編輯 modal 含可教場館 chip 多選）+ `api/coaches.js` + `mock.js` `COACHES_ADMIN` 4 筆 + Sidebar「教練資料 (F-C-Admin)」+ App.jsx `/coaches` route（admin only）。
- `server/bootstrap/coreSchema.js` 清掉 'X' 假館（新莊館）+ 把 'X' 從教練 venue 名單移除（張嘉豪 ['B','C','X']→['B','C']、黃詩涵 ['C','X']→['C']）；既有 DB 不受影響（INSERT…ON CONFLICT DO NOTHING），新環境不再 seed 'X'。

### 重要注意
- H01 沒有「教練可教場館」欄位 → `coach_venues` (M:N) 由後台手動勾，不靠同步。
- 缺 `RAGIC_API_KEY`/`RAGIC_BASE_URL`（dev fallback）時，`syncCoachesFromRagic`/`syncVenuesFromRagic` 直接 noop，使用者不被擋。
- 既有 admin_staff F-A02 員工管理頁不變（`coaches` 與 `admin_staff` 暫時各管一半，未來可考慮整併另開 task）。

### 煙霧
- `psql` 確認 `coaches` 表 4 筆都在；`coach_venues` 後台 PATCH 後 M:N 替換正確（王志強 ['B','C']→['C']→['B','C'] 雙向驗證 OK）。
- PATCH 校驗：multiplier=2.5 → 400；venue_ids=['B','ZZZ'] → 400 + ROLLBACK；無 token → 401。
- `GET /api/admin/coaches/:id` 回傳含 `bio_media` 陣列。
- admin build 通過：347KB / 107KB gzip（+2KB）。

## 變更紀錄
- 2026-05-02：完成 LIFF Phase 1（任務 #7）。實作 7 個正式頁面 + 2 個 placeholder、6 個全域元件、雙 Context（Auth/Toast）、7 個 API 模組與 mock dataset、共用 utils；新增 `react-hook-form` 依賴、`postcss.config.js`；修正 `main.jsx` 加上無 LIFF_ID 的 dev fallback。`vite build` 通過（158 modules，401KB / 127KB gzip）。後端 19 個 stub 路由不變，LIFF 全程走 mock 模式以驗證 happy path；後續可由 `VITE_USE_MOCK=false` 切到真實 API，並透過 501 自動 fallback 機制漸進實作後端。
- 2026-05-02：完成 SurveyJS Creator 評估報告，結論為「**不建議整合**」（授權費 USD $589/dev/年、套件巨大、與 Ragic 雙向同步設計衝突）。完整分析詳見 `docs/eval/surveyjs-creator.md`，含替代方案比較與分階段建議。
- 2026-05-02：補完 `docs/ragic_api.md` 的 H01／H05／Z01／Z02 欄位對照（含 Field ID、表單 metadata、API Key 環境變數說明）。Z02 段落標註附件來源欄位疑似與 Z01 重複，待使用者確認真實欄位後再行更新。
- 2026-05-02：修復部署。將 `.replit` 部署目標從 `cloudrun` 改為 `autoscale`，新增 build 指令同時建置 server / admin / liff。`server/index.js` 加入靜態檔案服務（`/admin`、`/liff`）與 SPA fallback、根路徑轉址，並把 listen 綁到 `0.0.0.0`。為 `client/admin/` 補齊 `index.html`、`src/main.jsx`、`src/App.jsx`、`src/index.css` 最小骨架；為 `server/routes/` 19 個尚未實作的 route 建立暫時 stub（回傳 501 Not Implemented），讓 server 能正常啟動。
- 2026-05-02：完成 Admin 後端實作（任務 #12）。把 `server/routes/admin.js` 從 501 stub 換成 7 個子路由（auth/staff/venues/settings/courseIntros/enrollments/sessions），response shape 與 `client/admin/src/api/mock.js` 1:1 對齊。新增 `db/migrations/002_admin_tables.sql`（9 張 `admin_*` 表）、`server/bootstrap/admin.js`（啟動時 idempotent 建表 + seed 3 帳號 / 3 場館 / 6 員工 / 7 設定 / 3 課介 / 24 報名 + audit logs / 4 今日 session / 2 已取消時段；密碼 bcrypt 雜湊）、`server/middlewares/adminAuth.js`（JWT 簽 / 驗 / 角色 RBAC，使用 `JWT_SECRET`）、`server/services/ragicAdmin.js`（H01/H05 best-effort 同步，無 Ragic credential 時 noop）。`client/admin/src/api/client.js` 加 axios interceptor 自動帶 Bearer token、遇 401 自動登出。對帳 / 退費 / 復活 都寫 `admin_enrollment_audit_logs`（by_user/reason/refund_amount，退費理由必填）。E2E 測試：3 帳號登入、staff/manager/admin RBAC、reconcile/refund/refund-preview/revive、staff multiplier 1.0–1.5 校驗、settings PATCH 持久化全部通過；`VITE_USE_MOCK=false` build 後 mock 模組 0 出現於 bundle，靜態檔由 Express 直送 `/admin/`。
- 2026-05-02：完成 Admin Phase 3（任務 #11）。把 `client/admin/` 從一行 placeholder 擴成 13 頁完整桌機後台：登入 + Dashboard + Settings(F-A01) + Staff(F-A02) + Venues(F-A03) + CourseIntros(F-A04/F-M06) + Reconcile(F-M02) + Enrollments(F-R02) + Refund(F-R04) + Sessions(F-R01) + Checkin(F-R03) + Revive(F-M05)；含 9 個共用元件、雙 Context（Auth/Toast）、7 個 domain API 模組與 24 筆 mock 資料、`/api/admin/*` 自動 fallback 到 mock。每頁 ≤ 250 行；`vite build` 117 modules → 265KB / 86KB gzip。煙霧測試 `/admin/*`、SPA fallback、501 stub、LIFF 隔離全部通過。後端 17 條 endpoint 仍為 501 stub，後續任務 #12 接手實作真實 backend。
