# DAOS 家教課程系統 — Replit 開發筆記

## 專案概要
- 公司：駿斯運動事業股份有限公司 — 夢想體育學院
- 系統：個家教課程系統（DAOS Tutoring System）
- 主要使用者：教練、家長／學員（透過 LINE LIFF）、行政後台
- 主要外部系統：Ragic（人事／場館／家長學員資料來源）、LINE（Login + Messaging）

## 架構與目錄
- `server/` — Node.js + Express API
  - `routes/`、`services/`（含 `ragic.js`、`line.js`、`promotions.js`、`slots.js`、`websocket.js`、`learning.js`、`referrals.js`、`transfers.js`）
  - `models/`、`middlewares/`（`adminAuth.js`、`coachAuth.js`、`auth.js`）
  - `cron/`、`bootstrap/`（`adminBootstrap.js` + `coreSchema.js` 啟動時自動建表 + 種子）
- `client/`
  - `liff/` — 學員／教練 LIFF Web App（React + Vite + Tailwind）
  - `admin/` — 後台 Web App（React + Vite + Tailwind，桌機優先 sidebar）
- `db/migrations`、`db/seeds`
- `docs/` — 完整需求／規格文件（見 `README.md` 索引）

## 環境變數
- 主要 Key 都在 `.env.example`，正式部署時請放 Replit Secrets。
- Ragic：`RAGIC_API_KEY`、`RAGIC_BASE_URL`（必填，否則 sync noop；目前 `https://ap7.ragic.com`）、`RAGIC_FORM_H01/H05/Z01/Z02`、選用 `RAGIC_CACHE_TTL_MS`。
- 認證：`JWT_SECRET`（≥16 chars，production 必填）、`ADMIN_BOOTSTRAP_PASSWORD`（production 必填，套用到 admin/manager/staff 三個 seed 帳號）、`ADMIN_FORCE_RESET_ON_BOOT`（dev 用）。
- LINE：`LINE_LOGIN_CHANNEL_ID/SECRET`、`LINE_MESSAGING_TOKENS`（多場館逗號分隔）、`VITE_LIFF_ID_PARENT/COACH`、`LIFF_URL_PARENT`（cron 推播 deeplink base）、`REQUIRE_LINE_ID_TOKEN`。
- 注意 H01 與 H05/Z01/Z02 的 Ragic AP_Name 不同（H01 用 `standardzhtw`，其餘用 `xinsheng`），表單路徑前綴各自獨立。

## 部署設定
- 正式網址：`https://daos-tutoring-courses.replit.app`
- LIFF：LINE Console 建 **2 個** LIFF App（家長端 + 教練端，掛同一個 LINE Login Channel 下），兩個 Endpoint URL 都設 `https://daos-tutoring-courses.replit.app/liff/`（無 `#`，前端為 BrowserRouter）。家長分享 `https://liff.line.me/<LIFF_ID_PARENT>`、教練分享 `https://liff.line.me/<LIFF_ID_COACH>/coach`。前端 `main.jsx` 會偵測 path 自動挑要 init 哪個 LIFF。
- Target：`autoscale`（單一服務）。Build：依序 `npm install` server / admin / liff，把兩個前端 build 到 `server/public/{admin,liff}`。前端 LIFF ID 用 Replit secret 直接命名為 `VITE_LIFF_ID_PARENT/COACH`（Vite 自動撿 `VITE_*`）。
- Run：`cd server && npm start`（`node index.js`）
- Express 同時提供：
  - `/api/*` → 後端 API
  - `/admin/*` → 後台 SPA（含 React Router fallback）
  - `/liff/*` → LIFF SPA（含 React Router fallback）
  - `/` → 預設 302 轉 `/admin/`；query 帶 `liff.*` 參數時改導 `/liff/` 並保留 query
  - `/health` → 健康檢查
- WebSocket 透過同一個 HTTP server 啟動（`initWebSocket(server)`）。
- 備份：`scripts/backup_db.sh` 每日 `pg_dump | gzip` → Object Storage（建議 Scheduled Deployments 03:00 跑）。

## 文件
- 文件索引：`README.md`。
- Ragic 整合手冊：`docs/ragic_api.md`（含 H01/H05/Z01/Z02 完整欄位對照表 + Field ID）。
- 規格：`docs/architecture_v7.md`、`schema_v2.sql`、`brand_colors.md`（深海藍 #15316a 系）、`line_setup.md`、`flex_messages.md`、`flex_message_checklist.md`、`deploy_checklist.md`、`perf_baseline.md`、`uat_playbook.md`。
- 操作手冊：`docs/manuals/coach.md`。

## 自訂 Secondary Skills（`.local/secondary_skills/`，需用 `skillSearch` 引入）

| 名稱 | 用途 |
|------|------|
| `code-review-excellence` | 多語言 PR review 知識庫（React/Vue/Rust/TS/Java/Python/C++） |
| `ui-ux-pro-max` | UI 風格 / 色票 / 字體 / UX 指引資料庫；scripts 跑前需 `pip install rank-bm25 pandas numpy` |
| `frontend-design` | 避免「AI slop」、追求大膽設計美學的指引 |
| `brand-guidelines` | Anthropic 官方品牌規範 ⚠️ 僅做模板參考，DAOS 用 `docs/brand_colors.md` |
| `mcp-builder` | 建 MCP server 指引（暫未用） |
| `webapp-testing` | Playwright 工具組 ⚠️ runtime 未預裝，需 package-management 補 |
| `web-artifacts-builder` | claude.ai 單檔 HTML artifact 工具（暫未用） |

內建 `code_review` / `design` / `delegation` / `architect` 子代理人與上面並存，互補使用。

---

## Task #51：employees 表合併（已完成 2026-05-15）
**目的**：把 `coaches` / `admin_users` / `admin_staff` 三套並行的身分表合併成單一 `employees` 表（roles TEXT[] 多角色，roles=['system_admin'|'manager'|'counter'|'coach']），消除「同一人多筆」與資料漂移。

**Schema**（`server/bootstrap/coreSchema.js` 統一管理）：
- `employees`：UUID PK + `email/phone/line_uid/employee_number/ragic_employee_id` 各自 UNIQUE；`roles TEXT[] GIN index`；統一含 `password_hash` / `bio_rich_text` / `pricing_multiplier` / `is_senior` / `intro_review_*` / `is_active` 等欄位（239 rows：179 coach + 1 admin/manager/staff seed + 57 待派 Ragic 同步）。
- `coaches` 改為 view（`SELECT * FROM employees WHERE 'coach'=ANY(roles)`），舊 query 仍可讀。
- 角色映射（legacy ↔ employees）：`admin↔system_admin`、`manager↔manager`、`staff↔counter`、`coach↔coach`。`adminAuth.deriveLegacyRole(roles)` 給舊 route shim。

**Runtime 改動**（routes/services/cron/middlewares/bootstrap）全部改 employees + ANY(roles)：
- 認證：`server/routes/admin/auth.js`（email 取代 username）、`coachAuth/adminAuth/auth` middlewares、`AuthContext`(admin)。
- 後台：`admin/staff.js`、`admin/promotions.js`（含 audit JOIN + `$1::uuid` 顯式 cast）、`admin/coaches.js`、`admin/learn.js`。
- LIFF：`coaches.js` (by-phone / by-line-uid)。
- 同步：`services/ragicAdmin.js syncStaffFromRagic`（roles=[] 待派；非教練軟下架；舊 admin_staff 凍結）。
- Cron + 通知：`cron/index.js` + `routes/_chatNotify.js` 主管挑選用 `('system_admin'=ANY(roles) OR 'manager'=ANY(roles)) AND line_uid IS NOT NULL AND is_active=TRUE`。
- Bootstrap：`bootstrap/admin.js seedIfEmpty()` admin 帳號 INSERT INTO employees（email + roles[]，密碼用 ADMIN_BOOTSTRAP_PASSWORD 或 dev 弱密碼）。

**舊表 DROP**（CASCADE，備份 `/tmp/admin_legacy_backup_*.sql`）：`admin_users` (3 rows) / `admin_staff` (360 rows) / `coaches_v7_backup` (179 rows)。`db/migrations/002_admin_tables.sql` 中對應的 CREATE TABLE 段也已刪除（保留註解說明）。其他 admin_* 表（venues/settings/course_intros/enrollments/audit/today_sessions/cancelled_sessions）保留不動。

**煙霧**（post-DROP）：health 200、admin/manager/staff 三帳號 login OK、`/admin/staff` 239 rows、`/admin/venues` 25 rows、promo detail audit_logs 帶 `by_name='系統管理員'`、coach by-phone 拿到 token、IDOR 跨 coach PUT bio 403、cron 主管 SQL 0 throw、log 0 error、三表 DROP 後重啟未被 bootstrap 重建。

**已知副發現（非本任務 scope，後續處理）**：venues GET 端點對 manager/staff role 仍曝露 `line_token` / `account_number` 機敏欄位，與原註解不符 — 需在 `routes/admin/venues.js` 加 `requireAdminRole('admin')` gate 才會收斂。

---

## 已完成功能階段一覽

| 任務 | 範圍 | 重點 |
|------|------|------|
| #7 | LIFF Phase 1 — 核心購課流程 | 7 頁面（Login/Register/Home/VenueSelect/CoachList/Enrollment/MyCourses）+ Auth/Toast Context + mock dataset；`max-w-[390px]` 行動容器 + `brand-*` Tailwind token |
| #12 | Admin Phase 3 — 後台管理基礎 | 13 頁 + Sidebar/Header/RequireAuth；3 角色（admin/manager/staff）+ JWT；audit log；Ragic best-effort sync |
| #14 | 教練端 LIFF | 手機 + LIFF id_token 雙因素登入、12h JWT、5 attempts/5min rate limit、`requireCoachOwner` IDOR；`pg_advisory_xact_lock` slot 並發保護 |
| #16 | Phase 5 — 學習歷程 + 期末評鑑 + 教練考核 | tag_categories/tag_library/lesson_plans/session_records(版本化)/course_evaluations/eval_thresholds；F-A08/F-A09/F-M09/F-C04/F-C05/F-C06/F-S06/F-S12 |
| #17 | Phase 6 上 — 優惠 + 折價券 + 套用 | promotions（PERCENTAGE/FIXED_AMOUNT，draft→pending→active）+ promotion_usages + audit；`previewBestDiscount` 自動 + coupon 雙分支；F-M07/F-A05/F-R05 |
| #18 | Phase 6 下 — MGM 推薦 | referral_records FSM `pending→registered→trial_paid→checked_in→reward_issued`；`TRIAL50` 體驗 + 9 折 `MGM***` 獎勵券（`eligible_parent_id` 持有者綁定 + `SELECT FOR UPDATE` 防重發）；`/r/:token` 短連結 |
| #19 | Phase 7 — 轉讓 + 報表 + 上課記錄 + LINE cron + 教練介紹 | transfer_records FSM；admin reports 5 endpoints（revenue/sessions/discounts/mgm-conversion/learning-completion）+ CSV；session_reminder / expiry / mgm_trial 三個 cron + notification_log dedupe |
| #20 | Phase 8 — 整合測試 + 效能基線 + UAT | `tests/e2e/` 8 路徑 + `run_all.js`、`tests/perf/` autocannon + WS + upload；docs/{flex_message_checklist,deploy_checklist,perf_baseline,uat_playbook}.md |
| #32 | F-C-Admin 後台教練資料管理 + Ragic sync 補強 | `syncCoachesFromRagic()` upsert `coaches.is_active`；後台 CoachesPage M:N 可教場館 chips；`coach_venues` 後台手動勾不靠同步 |
| #34 | 教練端 LIFF 自動登入 + Ragic LINE userid sync | H01「LINE userid」欄 → `coaches.line_uid`（COALESCE 不覆寫）；`GET /api/coaches/by-line-uid` + `verifyLineIdToken().sub` 防偽造；`liff.isInClient()` → 自動登入 |
| #37 | 修復 Ragic 同步沒在跑 | (1) `RAGIC_BASE_URL` 缺 → noop；(2) 認證改 `?APIKey=` query；(3) 欄位 fallback `員工編號/手機/E-mail` + H05 `部門編號/部門名稱/完整地址 + 銀行 4 欄`；coaches 4→177、venues 3→24 |
| Phase 5 補強 | 後台編輯報名（EditEnrollmentModal）+ 多組家庭多 LINE 綁定 | `admin_enrollments.extra_parent_phones` + `notes`；`/courses/mine` 用 `phone OR ANY(extra_parent_phones)` |
| **#51** | **employees 表合併（見上節詳細）** | **3 套身分表 → 1 套 + roles[] 多角色** |

---

## 變更紀錄
- 2026-05-15：**修 production cold-start outage**（2026-05-15 04:58 GMT+8 outage，1 日 uptime 83%）。`server/index.js` 啟動順序改為 `listen` 先開（`/health` 立刻 200）→ `bootstrapAdmin/bootstrapCore` 在 background 執行。原本 cold instance 上 bootstrap 常 >10s，autoscale health-check timeout 反覆殺 instance 造成 ~4hr 中斷。Dev smoke 通過後須重新 publish 才會套到 production。如要徹底避免 cold-start，可改 Reserved VM 或設 autoscale `minInstances=1`。
- 2026-05-15：**Task #51 employees 表合併完成**。三表合一（coaches/admin_users/admin_staff → employees with roles TEXT[]）；coaches 改 view；DROP 舊表 + CASCADE 清掉 462 rows legacy；bootstrap admin seed 改寫 employees；`db/migrations/002_admin_tables.sql` 同步清掉 admin_users/admin_staff CREATE TABLE。post-DROP 8 條 smoke 全綠（admin/coach login + staff/venues list + promo audit + IDOR + cron）。
- 2026-05-11：正式環境登入修正 + Phase 5 全面驗證。`admin_users` 密碼 hash 直接更新（dream0935314711）；`client/admin/src/pages/LoginPage.jsx` 的 Mock hint 改為 `USE_MOCK && ...` 條件顯示；admin/liff 以 `VITE_USE_MOCK=false` 重建（admin 385KB/gzip 122KB，liff 505KB/gzip 155KB）。Phase 5 全端點 smoke：tags=4cats/16tags、thresholds=3、coach-eval=175 coaches。
- 2026-05-03：Phase 5 全功能完成 + 後台編輯報名 + 多組家庭綁定。
- 2026-05-02：完成 LIFF Phase 1（任務 #7），含 react-hook-form 依賴、`postcss.config.js`、`main.jsx` 無 LIFF_ID dev fallback；vite build 401KB / 127KB gzip。
- 2026-05-02：SurveyJS Creator 評估報告 — 結論「不建議整合」（USD $589/dev/年、套件巨大、與 Ragic 雙向同步衝突）。完整見 `docs/eval/surveyjs-creator.md`。
- 2026-05-02：補完 `docs/ragic_api.md` H01/H05/Z01/Z02 欄位對照（含 Field ID）。
- 2026-05-02：修部署 — `.replit` 從 `cloudrun` 改 `autoscale`，`server/index.js` 加靜態檔案 + SPA fallback + 根路徑轉址、listen 綁 `0.0.0.0`；補齊 admin client 骨架；server/routes/ 19 個 stub 回 501。
