# DAOS 家教課程系統 — Replit 開發筆記

## 專案概要
- 公司：駿斯運動事業股份有限公司 — 夢想體育學院
- 系統：個家教課程系統（DAOS Tutoring System）
- 主要使用者：教練、家長／學員（透過 LINE LIFF）、行政後台
- 主要外部系統：Ragic（人事／場館／家長學員資料來源）、LINE（Login + Messaging）

## 架構與目錄
- `server/` — Node.js + Express API
  - `routes/`、`services/`（含 `ragic.js`、`line.js`、`promotions.js`、`slots.js`、`websocket.js`）、`models/`、`middlewares/`、`cron/`
- `client/`
  - `liff/` — 學員／教練 LIFF Web App（React）
  - `admin/` — 後台 Web App（React）
- `db/migrations`、`db/seeds`
- `docs/` — 完整需求／規格文件（見 README 文件索引）

## 環境變數
- 主要 Key 都在 `.env.example`，正式部署時請放 Replit Secrets。
- Ragic 相關：`RAGIC_API_KEY`、`RAGIC_BASE_URL`、`RAGIC_FORM_H01/H05/Z01/Z02`。
- 注意 H01 與 H05/Z01/Z02 的 Ragic AP_Name 不同（H01 用 `standardzhtw`，其餘用 `xinsheng`），表單路徑前綴各自獨立。

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
| `/course-intros` | `CourseIntrosPage` | F-A04 / F-M06 課程介紹 | admin |
| `/reconcile` | `ReconcilePage` | F-M02 待對帳 | 全部 |
| `/enrollments` | `EnrollmentsPage` | F-R02 所有報名 | 全部 |
| `/refund` | `RefundPage` | F-R04 退課 | admin/manager |
| `/sessions` | `SessionsPage` | F-R01 今日課程 | 全部 |
| `/checkin` | `CheckinPage` | F-R03 簽到驗證 | 全部 |
| `/revive` | `RevivePage` | F-M05 退課復活 | admin/manager |

**狀態與 API：**
- `context/AuthContext.jsx` — 用 `localStorage(daos.admin.user)` 暫存 user，跨分頁 `storage` 事件同步；提供 `isAdmin/isManager/isStaff` 旗標
- `context/ToastContext.jsx` — 與 LIFF 同款 4 色 Toast
- `api/client.js` — `callApi()` 走 `/api/admin/*`；`USE_MOCK = VITE_USE_MOCK !== 'false'`；遇 501 自動 fallback 到 mock
- `api/mock.js` — 集中 mock dataset：3 員工帳號、3 場館、6 員工、5 筆 enrollment、4 個今日 sessions、2 個已取消時段、課介 1/2/3、全域 settings 7 個欄位
- `api/{auth,staff,venues,settings,courseIntros,enrollments,sessions}.js` — domain modules

**Mock 帳號（密碼 = 帳號）：**
- `admin / admin` — 系統管理員（看得到 13 頁全部）
- `manager / manager` — 場館主管（板橋館，無系統設定 4 頁）
- `staff / staff` — 行政櫃檯（板橋館，無退課/復活，且報名/對帳清單依 `venue_id` 過濾）

### Admin Phase 3 與後端的銜接點
這些 endpoint 目前由 `server/routes/admin.js` 全部回 501 stub。Phase 3 admin UI 已用 mock 補位，後續任務只要把這些 endpoint 實作好（response shape 對齊 `client/admin/src/api/mock.js`），admin 就能無縫切換：

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
