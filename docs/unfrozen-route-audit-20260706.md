# Unfrozen Route Audit - 2026-07-06

Scope: `server/index.js`, `server/routes/**`, `client/liff/src/App.jsx`, `client/admin/src/App.jsx`, and `client/**/src/api/**`.

## 判準

- 「硬性凍結」= 有 route manifest、統一 `mount()`/referee、以及 CI drift guard；目前 repo 只有清冊文件，沒有這些強制機制。
- 因此以硬性凍結判準看，現行 219 個 Express handler 全部仍是未硬凍結。
- 「文件漂移」= 目前實際 handler 存在，但 `docs/route-map-audit.md` 舊清冊沒有列到。
- `Guard / note` 只是目前 auth/role/scope 型態，不等於已硬性凍結；欄位已合併檔頂 `router.use(...)` 和行內 guard。

## 摘要

| Metric | Value |
| --- | --- |
| Backend Express handlers | 219 |
| `/api/...` handlers | 214 |
| Frontend API wrapper/direct calls | 203 |
| Frontend API calls without backend handler | 0 |
| Route files not mounted | 0 |
| Backend handlers without static frontend caller | 8 |
| LIFF React routes | 34 |
| Admin React routes | 36 |
| Added since docs/route-map-audit.md | 4 |
| Removed since docs/route-map-audit.md | 0 |

## 文件漂移 / 過時點

- `docs/route-map-audit.md` 仍是 2026-07-02 的 215 backend / 199 frontend API caller；現況是 219 / 203。
- `docs/route-freeze-inventory.html` 寫 admin/LIFF 頁面 33/31；現況 audit 是 36/34。
- `docs/route-freeze-inventory.html` 寫 admin 25 子模組；現況 `server/routes/admin.js` 實際 mount 是 24，`_customerShared` 是 helper。
- `docs/route-freeze-inventory.html` 仍把 R9/R3/R4 當風險列在 route 清冊；現況程式碼已修，`docs/路由.html` 也記錄已修。
- `docs/路由.html` 寫 LIFF 家長 route 已改 `/parent` 前綴；現況 source 仍是 `/liff` basename 下的 `/`, `/login`, `/my-courses` 等路徑。

## 前端文件漏列 / 標示不準

| Kind | Route / API | Source | Issue |
| --- | --- | --- | --- |
| React route | `/liff/coach/chat` | `client/liff/src/App.jsx:148` | LIFF 頁面矩陣未列；實際為 coach JWT via `RequireCoach` |
| React route | `/liff/coach/chat/:roomId` | `client/liff/src/App.jsx:157` | LIFF 頁面矩陣未列；實際為 coach JWT via `RequireCoach` |
| React route | `/admin/login` | `client/admin/src/App.jsx:45` | 後台頁面矩陣未列 public login 入口 |
| Reachability | `/liff/chat`, `/liff/chat/:roomId` | `client/liff/src/App.jsx:93`, `client/liff/src/App.jsx:100` | BottomNav 標 `comingSoon` 不導頁，但家長 JWT 可直接 URL 進入 |
| Role label | `/liff/chat`, `/liff/chat/:roomId` | `client/liff/src/App.jsx:89` | 文件寫「家長或教練 JWT」，source 實際在 `RequireParent` 底下 |
| API caller | `GET /api/group-orders/mine` | `client/liff/src/api/groupOrders.js:12` | 後端清冊未精確列出 |
| API caller | `POST /api/group-orders/by-token/:token/join` | `client/liff/src/api/groupOrders.js:26` | 文件寫成 `/:id/join`，source/後端實際是 by-token join |
| API caller | `POST /api/group-orders/:id/my-proof` | `client/liff/src/api/groupOrders.js:43` | 後端清冊未列 |
| API caller | `GET /api/transfers/mine` | `client/liff/src/api/transfers.js:4` | 後端清冊只列 `POST /transfers` 與 `PATCH /:id/cancel` |
| API caller | `GET /api/learn/tags` | `client/liff/src/api/learn.js:27` | 後端清冊只粗列 `/learn/plans` 與 `/records/*` |
| API caller | `POST /api/learn/personal-tags` | `client/liff/src/api/learn.js:29` | 後端清冊未精確列出 |
| API caller | `DELETE /api/learn/personal-tags/:id` | `client/liff/src/api/learn.js:31` | 後端清冊未精確列出 |
| API caller | `POST /api/learn/uploads` | `client/liff/src/api/learn.js:36` | 後端清冊未精確列出 |
| API caller | `POST /api/admin/auth/change-password` | `client/admin/src/api/auth.js:8` | admin auth row 只標 login，未列 change-password |

## Ragic 連線狀態假同步風險

| Area | Source | Issue | Current fix in this pass |
| --- | --- | --- | --- |
| Ragic status logic | `server/routes/admin/ragicStatus.js:53` | 狀態頁原本主要回本地 `ragic_sync_log` / env / admin toggle；`POST /sync` 又是 202 背景執行，因此 UI 可能顯示已排入或最後成功，但沒有證明 Ragic API 此刻真的可讀。 | 新增 `live_probe`：`GET /api/admin/ragic-status` 會透過 Ragic API 對 H01/H05/Z01/Z02 做 `limit=1` 輕量讀取，回傳 `ok/empty/error`、筆數與耗時。 |
| Ragic API helper | `server/services/ragic.js` | 既有狀態頁 ping parents/students 用不存在 key 查詢，通常 0 筆，不足以判斷資料表是否真有回資料。 | 新增不走快取的 `probeForm()`；0 筆標 `empty`，避免被誤認成功同步。 |
| UI visibility | `client/admin/src/pages/RagicStatusPage.jsx` | Admin 只能看最後同步結果，無法分辨「本地 job 成功」與「Ragic API 現在可讀」。 | 新增「即時 Ragic API 驗證」區塊，顯示各表單 API 狀態、筆數、耗時、錯誤與快取標記。 |

## 文件漂移 - 舊清冊未列的實際後端 handler

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| POST | /api/admin/ragic-status/purge-ghosts | server/routes/admin/ragicStatus.js:120 | inline: requireAdminAuth, requireAdminRole |
| DELETE | /api/admin/ragic-z03/:id | server/routes/admin/ragicZ03.js:91 | file-level: requireAdminAuth, requireAdminRole |
| PATCH | /api/admin/ragic-z03/:id/draft | server/routes/admin/ragicZ03.js:52 | file-level: requireAdminAuth, requireAdminRole |
| GET | /api/admin/ragic-z03/stats | server/routes/admin/ragicZ03.js:23 | file-level: requireAdminAuth, requireAdminRole |

## 舊清冊已有但目前不存在

None.

## 後端 handler 無靜態前端 caller

| Method | Path | Source | Reason in audit |
| --- | --- | --- | --- |
| POST | /api/admin/periods/:id/activate | server/routes/admin/periods.js:18 | canonical activation seam for future callers; no current admin API wrapper |
| POST | /api/admin/sessions/checkin | server/routes/admin/sessions.js:276 | MGM/checkin finalization endpoint; current CheckinPage uses list/verify/backfill routes |
| POST | /api/admin/venues/sync | server/routes/admin/venues.js:68 | legacy one-step venue sync; current admin UI uses /sync-ragic |
| GET | /api/auth/line-config-debug | server/routes/auth.js:122 | manual debug endpoint; env gated by DEBUG_LINE_AUTH in production |
| POST | /api/auth/parent-login | server/routes/auth.js:269 | legacy endpoint; default 410 unless ALLOW_LEGACY_PARENT_LOGIN=1 outside production |
| GET | /api/coach-portal/auth/line/callback | server/routes/coachPortal.js:152 | external LINE OAuth callback; not called by frontend JS |
| DELETE | /api/parents/me/students/:id | server/routes/parents.js:704 | intentional 405 guard; frontend deletion removed |
| PATCH | /api/transfers/:id/cancel | server/routes/transfers.js:65 | backend/service supports cancel; no current LIFF API wrapper or UI caller |

## 全部未硬凍結後端 handler

### server/index.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| GET | / | server/index.js:117 | public/static/redirect |
| GET | /admin/* | server/index.js:106 | public/static/redirect |
| GET | /health | server/index.js:75 | public health |
| GET | /liff/* | server/index.js:110 | public/static/redirect |
| GET | /r/:token | server/index.js:78 | public/static/redirect |

### server/routes/admin.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| ALL | /api/admin/* | server/routes/admin.js:45 | 404/410 fallback |

### server/routes/admin/auth.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| POST | /api/admin/auth/change-password | server/routes/admin/auth.js:93 | inline: requireAdminAuth |
| POST | /api/admin/auth/login | server/routes/admin/auth.js:30 | public or handler-internal check; no route-lock manifest |

### server/routes/admin/chat.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| GET | /api/admin/chat/alerts | server/routes/admin/chat.js:158 | inline: requireAdminAuth, requireAdminRole |
| PATCH | /api/admin/chat/alerts/:id | server/routes/admin/chat.js:197 | inline: requireAdminAuth, requireAdminRole |
| GET | /api/admin/chat/keywords | server/routes/admin/chat.js:82 | inline: requireAdminAuth, requireAdminRole |
| POST | /api/admin/chat/keywords | server/routes/admin/chat.js:95 | inline: requireAdminAuth, requireAdminRole |
| DELETE | /api/admin/chat/keywords/:id | server/routes/admin/chat.js:146 | inline: requireAdminAuth, requireAdminRole |
| PATCH | /api/admin/chat/keywords/:id | server/routes/admin/chat.js:115 | inline: requireAdminAuth, requireAdminRole |
| GET | /api/admin/chat/rooms | server/routes/admin/chat.js:42 | inline: requireAdminAuth, requireAdminRole |
| GET | /api/admin/chat/rooms/:id/messages | server/routes/admin/chat.js:55 | inline: requireAdminAuth, requireAdminRole |

### server/routes/admin/checkins.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| GET | /api/admin/checkins | server/routes/admin/checkins.js:21 | inline: requireAdminAuth |

### server/routes/admin/coaches.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| ALL | /api/admin/coaches/* | server/routes/admin/coaches.js:28 | 404/410 fallback |

### server/routes/admin/courseIntros.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| GET | /api/admin/course-intros | server/routes/admin/courseIntros.js:16 | inline: requireAdminAuth |
| PATCH | /api/admin/course-intros/:type | server/routes/admin/courseIntros.js:36 | inline: requireAdminAuth |

### server/routes/admin/courseTypes.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| GET | /api/admin/course-types | server/routes/admin/courseTypes.js:58 | inline: requireAdminAuth, requireAdminRole |
| POST | /api/admin/course-types | server/routes/admin/courseTypes.js:77 | inline: requireAdminAuth, requireAdminRole |
| DELETE | /api/admin/course-types/:type | server/routes/admin/courseTypes.js:249 | inline: requireAdminAuth, requireAdminRole |
| PATCH | /api/admin/course-types/:type | server/routes/admin/courseTypes.js:136 | inline: requireAdminAuth, requireAdminRole |
| GET | /api/admin/course-types/:type/audit-logs | server/routes/admin/courseTypes.js:269 | inline: requireAdminAuth |

### server/routes/admin/customerParents.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| GET | /api/admin/customer-parents | server/routes/admin/customerParents.js:85 | inline: requireAdminAuth |
| POST | /api/admin/customer-parents | server/routes/admin/customerParents.js:138 | inline: requireAdminAuth |
| GET | /api/admin/customer-parents/:id | server/routes/admin/customerParents.js:118 | inline: requireAdminAuth |
| PATCH | /api/admin/customer-parents/:id | server/routes/admin/customerParents.js:146 | inline: requireAdminAuth |

### server/routes/admin/customerStudents.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| GET | /api/admin/customer-students | server/routes/admin/customerStudents.js:56 | inline: requireAdminAuth |
| GET | /api/admin/customer-students/:id | server/routes/admin/customerStudents.js:87 | inline: requireAdminAuth |
| PATCH | /api/admin/customer-students/:id | server/routes/admin/customerStudents.js:154 | inline: requireAdminAuth |
| GET | /api/admin/customer-students/:id/audit-logs | server/routes/admin/customerStudents.js:107 | inline: requireAdminAuth |

### server/routes/admin/enrollments.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| GET | /api/admin/enrollments | server/routes/admin/enrollments.js:467 | inline: requireAdminAuth |
| POST | /api/admin/enrollments | server/routes/admin/enrollments.js:332 | inline: requireAdminAuth, requireAdminRole |
| PATCH | /api/admin/enrollments/:id | server/routes/admin/enrollments.js:518 | inline: requireAdminAuth, requireAdminRole |
| POST | /api/admin/enrollments/:id/reconcile | server/routes/admin/enrollments.js:757 | inline: requireAdminAuth, requireAdminRole |
| POST | /api/admin/enrollments/:id/refund | server/routes/admin/enrollments.js:950 | inline: requireAdminAuth, requireAdminRole |
| GET | /api/admin/enrollments/:id/refund-preview | server/routes/admin/enrollments.js:936 | inline: requireAdminAuth, requireAdminRole |

### server/routes/admin/groupOrders.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| GET | /api/admin/group-orders | server/routes/admin/groupOrders.js:41 | inline: requireAdminAuth |
| GET | /api/admin/group-orders/:id | server/routes/admin/groupOrders.js:93 | inline: requireAdminAuth |
| POST | /api/admin/group-orders/:id/approve | server/routes/admin/groupOrders.js:155 | inline: requireAdminAuth |
| POST | /api/admin/group-orders/:id/reject | server/routes/admin/groupOrders.js:253 | inline: requireAdminAuth |

### server/routes/admin/learn.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| GET | /api/admin/learn/coach-eval | server/routes/admin/learn.js:110 | file-level: requireAdminAuth; inline: requireAdminRole |
| GET | /api/admin/learn/coach-eval/:coachId | server/routes/admin/learn.js:117 | file-level: requireAdminAuth; inline: requireAdminRole |
| GET | /api/admin/learn/intros | server/routes/admin/learn.js:152 | file-level: requireAdminAuth; inline: requireAdminRole |
| POST | /api/admin/learn/intros/:coachId/approve | server/routes/admin/learn.js:169 | file-level: requireAdminAuth; inline: requireAdminRole |
| POST | /api/admin/learn/intros/:coachId/reject | server/routes/admin/learn.js:182 | file-level: requireAdminAuth; inline: requireAdminRole |
| POST | /api/admin/learn/tag-categories | server/routes/admin/learn.js:49 | file-level: requireAdminAuth; inline: requireAdminRole |
| DELETE | /api/admin/learn/tag-categories/:id | server/routes/admin/learn.js:64 | file-level: requireAdminAuth; inline: requireAdminRole |
| GET | /api/admin/learn/tags | server/routes/admin/learn.js:41 | file-level: requireAdminAuth; inline: requireAdminRole |
| POST | /api/admin/learn/tags | server/routes/admin/learn.js:69 | file-level: requireAdminAuth; inline: requireAdminRole |
| DELETE | /api/admin/learn/tags/:id | server/routes/admin/learn.js:104 | file-level: requireAdminAuth; inline: requireAdminRole |
| PATCH | /api/admin/learn/tags/:id | server/routes/admin/learn.js:86 | file-level: requireAdminAuth; inline: requireAdminRole |
| GET | /api/admin/learn/thresholds | server/routes/admin/learn.js:123 | file-level: requireAdminAuth; inline: requireAdminRole |
| PUT | /api/admin/learn/thresholds | server/routes/admin/learn.js:127 | file-level: requireAdminAuth; inline: requireAdminRole |

### server/routes/admin/mgmStats.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| GET | /api/admin/mgm-stats | server/routes/admin/mgmStats.js:15 | file-level: requireAdminAuth, requireAdminRole |

### server/routes/admin/periods.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| POST | /api/admin/periods/:id/activate | server/routes/admin/periods.js:18 | inline: requireAdminAuth, requireAdminRole |

### server/routes/admin/promotions.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| GET | /api/admin/promotions | server/routes/admin/promotions.js:73 | file-level: requireAdminAuth; inline: requireAdminRole |
| POST | /api/admin/promotions | server/routes/admin/promotions.js:128 | file-level: requireAdminAuth; inline: requireAdminRole |
| DELETE | /api/admin/promotions/:id | server/routes/admin/promotions.js:206 | file-level: requireAdminAuth; inline: requireAdminRole |
| GET | /api/admin/promotions/:id | server/routes/admin/promotions.js:106 | file-level: requireAdminAuth; inline: requireAdminRole |
| PATCH | /api/admin/promotions/:id | server/routes/admin/promotions.js:162 | file-level: requireAdminAuth; inline: requireAdminRole |
| POST | /api/admin/promotions/:id/activate | server/routes/admin/promotions.js:259 | file-level: requireAdminAuth |
| POST | /api/admin/promotions/:id/approve | server/routes/admin/promotions.js:261 | file-level: requireAdminAuth |
| POST | /api/admin/promotions/:id/archive | server/routes/admin/promotions.js:267 | file-level: requireAdminAuth |
| POST | /api/admin/promotions/:id/reject | server/routes/admin/promotions.js:262 | file-level: requireAdminAuth |
| POST | /api/admin/promotions/:id/submit | server/routes/admin/promotions.js:260 | file-level: requireAdminAuth |
| GET | /api/admin/promotions/active | server/routes/admin/promotions.js:91 | file-level: requireAdminAuth; inline: requireAdminRole |

### server/routes/admin/ragicStaging.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| GET | /api/admin/ragic-staging | server/routes/admin/ragicStaging.js:29 | file-level: requireAdminAuth, requireAdminRole |
| POST | /api/admin/ragic-staging/:id/approve | server/routes/admin/ragicStaging.js:39 | file-level: requireAdminAuth, requireAdminRole |
| POST | /api/admin/ragic-staging/:id/reject | server/routes/admin/ragicStaging.js:65 | file-level: requireAdminAuth, requireAdminRole |
| POST | /api/admin/ragic-staging/bulk-approve | server/routes/admin/ragicStaging.js:76 | file-level: requireAdminAuth, requireAdminRole |
| GET | /api/admin/ragic-staging/count | server/routes/admin/ragicStaging.js:20 | file-level: requireAdminAuth, requireAdminRole |

### server/routes/admin/ragicStatus.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| GET | /api/admin/ragic-status | server/routes/admin/ragicStatus.js:53 | inline: requireAdminAuth, requireAdminRole |
| POST | /api/admin/ragic-status/purge-ghosts | server/routes/admin/ragicStatus.js:120 | inline: requireAdminAuth, requireAdminRole |
| POST | /api/admin/ragic-status/sync | server/routes/admin/ragicStatus.js:75 | inline: requireAdminAuth, requireAdminRole |
| POST | /api/admin/ragic-status/toggle | server/routes/admin/ragicStatus.js:162 | inline: requireAdminAuth, requireAdminRole |

### server/routes/admin/ragicZ03.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| GET | /api/admin/ragic-z03 | server/routes/admin/ragicZ03.js:40 | file-level: requireAdminAuth, requireAdminRole |
| DELETE | /api/admin/ragic-z03/:id | server/routes/admin/ragicZ03.js:91 | file-level: requireAdminAuth, requireAdminRole |
| PATCH | /api/admin/ragic-z03/:id | server/routes/admin/ragicZ03.js:70 | file-level: requireAdminAuth, requireAdminRole |
| POST | /api/admin/ragic-z03/:id/dismiss | server/routes/admin/ragicZ03.js:79 | file-level: requireAdminAuth, requireAdminRole |
| PATCH | /api/admin/ragic-z03/:id/draft | server/routes/admin/ragicZ03.js:52 | file-level: requireAdminAuth, requireAdminRole |
| GET | /api/admin/ragic-z03/stats | server/routes/admin/ragicZ03.js:23 | file-level: requireAdminAuth, requireAdminRole |

### server/routes/admin/reports.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| GET | /api/admin/reports/coach-options | server/routes/admin/reports.js:46 | file-level: requireAdminAuth, requireAdminRole |
| GET | /api/admin/reports/discounts | server/routes/admin/reports.js:104 | file-level: requireAdminAuth, requireAdminRole |
| GET | /api/admin/reports/learning-completion | server/routes/admin/reports.js:174 | file-level: requireAdminAuth, requireAdminRole |
| GET | /api/admin/reports/mgm-conversion | server/routes/admin/reports.js:134 | file-level: requireAdminAuth, requireAdminRole |
| GET | /api/admin/reports/revenue | server/routes/admin/reports.js:55 | file-level: requireAdminAuth, requireAdminRole |
| GET | /api/admin/reports/sessions | server/routes/admin/reports.js:80 | file-level: requireAdminAuth, requireAdminRole |

### server/routes/admin/sessions.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| GET | /api/admin/sessions | server/routes/admin/sessions.js:49 | inline: requireAdminAuth |
| POST | /api/admin/sessions/:id/backfill-checkin | server/routes/admin/sessions.js:243 | inline: requireAdminAuth |
| POST | /api/admin/sessions/:id/revive | server/routes/admin/sessions.js:192 | inline: requireAdminAuth, requireAdminRole |
| GET | /api/admin/sessions/cancelled | server/routes/admin/sessions.js:174 | inline: requireAdminAuth, requireAdminRole |
| POST | /api/admin/sessions/checkin | server/routes/admin/sessions.js:276 | inline: requireAdminAuth |
| GET | /api/admin/sessions/today | server/routes/admin/sessions.js:97 | inline: requireAdminAuth |
| GET | /api/admin/sessions/verify-checkin | server/routes/admin/sessions.js:119 | inline: requireAdminAuth |

### server/routes/admin/settings.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| GET | /api/admin/settings | server/routes/admin/settings.js:30 | inline: requireAdminAuth, requireAdminRole |
| PATCH | /api/admin/settings | server/routes/admin/settings.js:39 | inline: requireAdminAuth, requireAdminRole |

### server/routes/admin/staff.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| GET | /api/admin/staff | server/routes/admin/staff.js:293 | inline: requireAdminAuth, requireAdminRole |
| POST | /api/admin/staff | server/routes/admin/staff.js:421 | inline: requireAdminAuth, requireAdminRole |
| GET | /api/admin/staff/:id | server/routes/admin/staff.js:399 | inline: requireAdminAuth, requireAdminRole |
| PATCH | /api/admin/staff/:id | server/routes/admin/staff.js:506 | inline: requireAdminAuth, requireAdminRole |
| GET | /api/admin/staff/:id/password-hint | server/routes/admin/staff.js:796 | inline: requireAdminAuth, requireAdminRole |
| POST | /api/admin/staff/:id/reset-password | server/routes/admin/staff.js:731 | inline: requireAdminAuth, requireAdminRole |
| GET | /api/admin/staff/coaches | server/routes/admin/staff.js:345 | inline: requireAdminAuth, requireAdminRole |
| POST | /api/admin/staff/sync | server/routes/admin/staff.js:329 | inline: requireAdminAuth, requireAdminRole |

### server/routes/admin/transfers.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| GET | /api/admin/transfers | server/routes/admin/transfers.js:30 | inline: requireAdminAuth, requireAdminRole |
| POST | /api/admin/transfers/:id/approve | server/routes/admin/transfers.js:63 | inline: requireAdminAuth, requireAdminRole |
| POST | /api/admin/transfers/:id/reject | server/routes/admin/transfers.js:73 | inline: requireAdminAuth, requireAdminRole |

### server/routes/admin/uploads.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| POST | /api/admin/uploads/image | server/routes/admin/uploads.js:46 | inline: requireAdminAuth |
| POST | /api/admin/uploads/invoice | server/routes/admin/uploads.js:42 | inline: requireAdminAuth |

### server/routes/admin/venues.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| GET | /api/admin/venues | server/routes/admin/venues.js:53 | inline: requireAdminAuth, requireAdminRole |
| PATCH | /api/admin/venues/:id | server/routes/admin/venues.js:147 | inline: requireAdminAuth, requireAdminRole |
| PATCH | /api/admin/venues/:id/active | server/routes/admin/venues.js:101 | inline: requireAdminAuth, requireAdminRole |
| POST | /api/admin/venues/sync | server/routes/admin/venues.js:68 | inline: requireAdminAuth, requireAdminRole |
| POST | /api/admin/venues/sync-ragic | server/routes/admin/venues.js:80 | inline: requireAdminAuth, requireAdminRole |

### server/routes/auth.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| ALL | /api/auth/* | server/routes/auth.js:907 | 404/410 fallback |
| POST | /api/auth/demo-login | server/routes/auth.js:48 | public or handler-internal check; no route-lock manifest |
| GET | /api/auth/line-config-debug | server/routes/auth.js:122 | public or handler-internal check; no route-lock manifest |
| POST | /api/auth/parent-bind-phone | server/routes/auth.js:372 | public or handler-internal check; no route-lock manifest |
| POST | /api/auth/parent-line-login | server/routes/auth.js:330 | public or handler-internal check; no route-lock manifest |
| POST | /api/auth/parent-login | server/routes/auth.js:269 | public or handler-internal check; no route-lock manifest |
| POST | /api/auth/parent-register-line | server/routes/auth.js:553 | public or handler-internal check; no route-lock manifest |

### server/routes/chat.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| GET | /api/chat/period/:coursePeriodId/room | server/routes/chat.js:95 | inline: requireLiffUser |
| GET | /api/chat/rooms | server/routes/chat.js:83 | inline: requireLiffUser |
| GET | /api/chat/rooms/:id | server/routes/chat.js:130 | inline: requireLiffUser |
| GET | /api/chat/rooms/:id/messages | server/routes/chat.js:141 | inline: requireLiffUser |
| POST | /api/chat/rooms/:id/messages | server/routes/chat.js:210 | inline: requireLiffUser |
| POST | /api/chat/rooms/:id/read | server/routes/chat.js:250 | inline: requireLiffUser |
| POST | /api/chat/rooms/:id/upload | server/routes/chat.js:228 | inline: requireLiffUser |

### server/routes/checkins.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| POST | /api/checkins | server/routes/checkins.js:16 | inline: requireParent |

### server/routes/coachPortal.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| POST | /api/coach-portal/auth/exchange | server/routes/coachPortal.js:212 | public or handler-internal check; no route-lock manifest |
| GET | /api/coach-portal/auth/line | server/routes/coachPortal.js:136 | public or handler-internal check; no route-lock manifest |
| GET | /api/coach-portal/auth/line/callback | server/routes/coachPortal.js:152 | public or handler-internal check; no route-lock manifest |
| GET | /api/coach-portal/auth/line/status | server/routes/coachPortal.js:123 | public or handler-internal check; no route-lock manifest |
| GET | /api/coach-portal/auth/line/token-info/:token | server/routes/coachPortal.js:201 | public or handler-internal check; no route-lock manifest |
| POST | /api/coach-portal/link-by-name | server/routes/coachPortal.js:240 | public or handler-internal check; no route-lock manifest |
| POST | /api/coach-portal/logout | server/routes/coachPortal.js:350 | public or handler-internal check; no route-lock manifest |
| GET | /api/coach-portal/session | server/routes/coachPortal.js:331 | public or handler-internal check; no route-lock manifest |

### server/routes/coaches.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| GET | /api/coaches | server/routes/coaches.js:53 | public or handler-internal check; no route-lock manifest |
| GET | /api/coaches/:id | server/routes/coaches.js:240 | inline: requireCoach |
| PUT | /api/coaches/:id/bio | server/routes/coaches.js:255 | inline: requireCoach |
| GET | /api/coaches/:id/media | server/routes/coaches.js:273 | inline: requireCoach |
| POST | /api/coaches/:id/media | server/routes/coaches.js:282 | inline: requireCoach |
| DELETE | /api/coaches/:id/media/:mediaId | server/routes/coaches.js:346 | inline: requireCoach |
| PATCH | /api/coaches/:id/media/reorder | server/routes/coaches.js:324 | inline: requireCoach |
| POST | /api/coaches/:id/media/upload | server/routes/coaches.js:298 | inline: requireCoach |
| GET | /api/coaches/by-line-uid | server/routes/coaches.js:194 | inline: byLineUidRateLimit |
| GET | /api/coaches/by-phone | server/routes/coaches.js:100 | inline: byPhoneRateLimit |

### server/routes/courses.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| GET | /api/courses/:id | server/routes/courses.js:250 | inline: requireParent |
| POST | /api/courses/:id/cancel | server/routes/courses.js:426 | inline: requireParent |
| POST | /api/courses/:id/payment-proof | server/routes/courses.js:374 | inline: requireParent |
| ALL | /api/courses/* | server/routes/courses.js:479 | 404/410 fallback |
| GET | /api/courses/base-price | server/routes/courses.js:228 | inline: requireParent |
| GET | /api/courses/lessons | server/routes/courses.js:13 | inline: requireParent |
| GET | /api/courses/mine | server/routes/courses.js:76 | inline: requireParent |
| GET | /api/courses/types | server/routes/courses.js:202 | public or handler-internal check; no route-lock manifest |

### server/routes/enrollments.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| POST | /api/enrollments | server/routes/enrollments.js:31 | file-level: requireParent |

### server/routes/evaluations.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| GET | /api/evaluations/:id | server/routes/evaluations.js:28 | inline: requireParent |
| POST | /api/evaluations/:id/submit | server/routes/evaluations.js:40 | inline: requireParent |
| GET | /api/evaluations/mine | server/routes/evaluations.js:18 | inline: requireParent |

### server/routes/groupOrders.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| POST | /api/group-orders | server/routes/groupOrders.js:431 | file-level: requireParent |
| GET | /api/group-orders/:id | server/routes/groupOrders.js:567 | file-level: requireParent |
| POST | /api/group-orders/:id/cancel | server/routes/groupOrders.js:776 | file-level: requireParent |
| POST | /api/group-orders/:id/my-proof | server/routes/groupOrders.js:680 | file-level: requireParent |
| POST | /api/group-orders/:id/submit | server/routes/groupOrders.js:726 | file-level: requireParent |
| GET | /api/group-orders/by-token/:token | server/routes/groupOrders.js:299 | file-level: requireParent; inline: optionalParent, previewRateLimit |
| POST | /api/group-orders/by-token/:token/join | server/routes/groupOrders.js:583 | file-level: requireParent |
| POST | /api/group-orders/by-token/:token/lookup-phone | server/routes/groupOrders.js:319 | file-level: requireParent; inline: optionalParent, lookupRateLimit |
| DELETE | /api/group-orders/draft | server/routes/groupOrders.js:420 | file-level: requireParent |
| GET | /api/group-orders/draft | server/routes/groupOrders.js:386 | file-level: requireParent |
| PUT | /api/group-orders/draft | server/routes/groupOrders.js:401 | file-level: requireParent |
| GET | /api/group-orders/mine | server/routes/groupOrders.js:533 | file-level: requireParent |

### server/routes/learn.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| GET | /api/learn/history/:periodId | server/routes/learn.js:140 | inline: requireParent |
| POST | /api/learn/personal-tags | server/routes/learn.js:124 | inline: requireParent, requireCoach |
| DELETE | /api/learn/personal-tags/:id | server/routes/learn.js:131 | inline: requireParent, requireCoach |
| GET | /api/learn/plans/:periodId | server/routes/learn.js:43 | inline: requireCoach |
| PUT | /api/learn/plans/:periodId | server/routes/learn.js:54 | inline: requireCoach |
| POST | /api/learn/plans/:periodId/publish | server/routes/learn.js:61 | inline: requireCoach |
| GET | /api/learn/records/by-session/:sessionId | server/routes/learn.js:72 | inline: requireCoach |
| PUT | /api/learn/records/by-session/:sessionId | server/routes/learn.js:86 | inline: requireCoach |
| GET | /api/learn/records/by-session/:sessionId/copy-prev | server/routes/learn.js:101 | inline: requireCoach |
| POST | /api/learn/records/by-session/:sessionId/submit | server/routes/learn.js:93 | inline: requireCoach |
| GET | /api/learn/records/by-session/:sessionId/versions | server/routes/learn.js:108 | inline: requireCoach |
| GET | /api/learn/tags | server/routes/learn.js:119 | inline: requireParent, requireCoach |
| POST | /api/learn/uploads | server/routes/learn.js:161 | inline: requireCoach |

### server/routes/parents.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| POST | /api/parents | server/routes/parents.js:711 | public or handler-internal check; no route-lock manifest |
| ALL | /api/parents/* | server/routes/parents.js:795 | 404/410 fallback |
| GET | /api/parents/me | server/routes/parents.js:390 | inline: requireParent |
| PATCH | /api/parents/me | server/routes/parents.js:451 | inline: requireParent |
| POST | /api/parents/me/students | server/routes/parents.js:523 | inline: requireParent |
| DELETE | /api/parents/me/students/:id | server/routes/parents.js:704 | inline: requireParent |
| PATCH | /api/parents/me/students/:id | server/routes/parents.js:621 | inline: requireParent |
| POST | /api/parents/me/sync | server/routes/parents.js:407 | inline: requireParent |

### server/routes/promotions.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| GET | /api/promotions | server/routes/promotions.js:14 | inline: optionalParent |
| POST | /api/promotions/preview | server/routes/promotions.js:39 | inline: optionalParent |

### server/routes/referrals.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| POST | /api/referrals | server/routes/referrals.js:18 | inline: requireParent |
| GET | /api/referrals/by-token/:token | server/routes/referrals.js:37 | inline: requireParent |
| GET | /api/referrals/mine | server/routes/referrals.js:54 | inline: requireParent |

### server/routes/sessions.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| GET | /api/sessions/:id | server/routes/sessions.js:178 | inline: requireCoach |
| ~~POST~~ | ~~/api/sessions/:id/checkins~~ | **已於 2026-08-10 移除（教練代簽）** | ~~inline: requireCoach~~ |
| GET | /api/sessions/coach/:coachId/today | server/routes/sessions.js:17 | inline: requireCoach |
| GET | /api/sessions/coach/:coachId/week | server/routes/sessions.js:49 | inline: requireCoach |

### server/routes/slots.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| POST | /api/slots | server/routes/slots.js:113 | inline: requireCoach |
| DELETE | /api/slots/:id | server/routes/slots.js:171 | inline: requireParent, requireCoach |
| PATCH | /api/slots/:id/block | server/routes/slots.js:151 | inline: requireCoach |
| POST | /api/slots/:id/book | server/routes/slots.js:269 | inline: requireParent |
| PATCH | /api/slots/:id/unblock | server/routes/slots.js:161 | inline: requireCoach |
| POST | /api/slots/batch | server/routes/slots.js:126 | inline: requireCoach |
| GET | /api/slots/coach/:coachId | server/routes/slots.js:77 | inline: requireCoach |
| GET | /api/slots/period/:coursePeriodId | server/routes/slots.js:188 | inline: requireParent |
| POST | /api/slots/preview-conflict | server/routes/slots.js:180 | inline: requireParent, requireCoach |

### server/routes/transfers.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| POST | /api/transfers | server/routes/transfers.js:24 | file-level: requireParent |
| PATCH | /api/transfers/:id/cancel | server/routes/transfers.js:65 | file-level: requireParent |
| GET | /api/transfers/mine | server/routes/transfers.js:15 | file-level: requireParent |

### server/routes/uploads.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| POST | /api/uploads/payment-proof | server/routes/uploads.js:36 | inline: requireParent |

### server/routes/venues.js

| Method | Path | Source | Guard / note |
| --- | --- | --- | --- |
| GET | /api/venues | server/routes/venues.js:35 | public or handler-internal check; no route-lock manifest |
| GET | /api/venues/:id | server/routes/venues.js:55 | public or handler-internal check; no route-lock manifest |

## Frontend React Routes

### LIFF

| Path | Source |
| --- | --- |
| /liff | client/liff/src/App.jsx:91 |
| /liff/* | client/liff/src/App.jsx:161 |
| /liff/book-slot/:periodId | client/liff/src/App.jsx:130 |
| /liff/chat | client/liff/src/App.jsx:93 |
| /liff/chat/:roomId | client/liff/src/App.jsx:100 |
| /liff/coach | client/liff/src/App.jsx:145 |
| /liff/coach-portal | client/liff/src/App.jsx:80 |
| /liff/coach/chat | client/liff/src/App.jsx:148 |
| /liff/coach/chat/:roomId | client/liff/src/App.jsx:157 |
| /liff/coach/plan/:periodId | client/liff/src/App.jsx:155 |
| /liff/coach/profile | client/liff/src/App.jsx:149 |
| /liff/coach/record/:sessionId | client/liff/src/App.jsx:156 |
| /liff/coach/schedule | client/liff/src/App.jsx:146 |
| /liff/coach/session/:id | client/liff/src/App.jsx:152 |
| /liff/coach/students | client/liff/src/App.jsx:147 |
| /liff/coaches | client/liff/src/App.jsx:105 |
| /liff/course/:id | client/liff/src/App.jsx:125 |
| /liff/demo | client/liff/src/App.jsx:75 |
| /liff/enroll | client/liff/src/App.jsx:108 |
| /liff/enroll-status/:id | client/liff/src/App.jsx:115 |
| /liff/enroll-success | client/liff/src/App.jsx:111 |
| /liff/evaluation/:id | client/liff/src/App.jsx:132 |
| /liff/group/:id | client/liff/src/App.jsx:122 |
| /liff/group/join/:token | client/liff/src/App.jsx:84 |
| /liff/group/new | client/liff/src/App.jsx:119 |
| /liff/history/:periodId | client/liff/src/App.jsx:128 |
| /liff/login | client/liff/src/App.jsx:74 |
| /liff/my-courses | client/liff/src/App.jsx:92 |
| /liff/my-lessons | client/liff/src/App.jsx:98 |
| /liff/profile | client/liff/src/App.jsx:94 |
| /liff/referral | client/liff/src/App.jsx:135 |
| /liff/register | client/liff/src/App.jsx:76 |
| /liff/transfer/new | client/liff/src/App.jsx:138 |
| /liff/venue | client/liff/src/App.jsx:102 |

### Admin

| Path | Source |
| --- | --- |
| /admin | client/admin/src/App.jsx:48 |
| /admin/* | client/admin/src/App.jsx:99 |
| /admin/alerts | client/admin/src/App.jsx:83 |
| /admin/chat-logs | client/admin/src/App.jsx:82 |
| /admin/checkin | client/admin/src/App.jsx:78 |
| /admin/coach-eval | client/admin/src/App.jsx:93 |
| /admin/coach-intros-review | client/admin/src/App.jsx:95 |
| /admin/coaches | client/admin/src/App.jsx:56 |
| /admin/course-intros | client/admin/src/App.jsx:58 |
| /admin/course-types | client/admin/src/App.jsx:59 |
| /admin/customer-parents | client/admin/src/App.jsx:66 |
| /admin/customer-students | client/admin/src/App.jsx:67 |
| /admin/dashboard | client/admin/src/App.jsx:49 |
| /admin/enrollments | client/admin/src/App.jsx:72 |
| /admin/eval-threshold | client/admin/src/App.jsx:94 |
| /admin/group-orders | client/admin/src/App.jsx:60 |
| /admin/keywords | client/admin/src/App.jsx:84 |
| /admin/login | client/admin/src/App.jsx:45 |
| /admin/manual-enroll | client/admin/src/App.jsx:70 |
| /admin/mgm-stats | client/admin/src/App.jsx:89 |
| /admin/promotions | client/admin/src/App.jsx:87 |
| /admin/promotions-active | client/admin/src/App.jsx:88 |
| /admin/ragic-staging | client/admin/src/App.jsx:62 |
| /admin/ragic-status | client/admin/src/App.jsx:61 |
| /admin/ragic-z03 | client/admin/src/App.jsx:63 |
| /admin/reconcile | client/admin/src/App.jsx:71 |
| /admin/refund | client/admin/src/App.jsx:73 |
| /admin/reports | client/admin/src/App.jsx:50 |
| /admin/revive | client/admin/src/App.jsx:79 |
| /admin/sessions | client/admin/src/App.jsx:77 |
| /admin/settings | client/admin/src/App.jsx:53 |
| /admin/sop | client/admin/src/App.jsx:96 |
| /admin/staff | client/admin/src/App.jsx:54 |
| /admin/tags | client/admin/src/App.jsx:92 |
| /admin/transfers | client/admin/src/App.jsx:74 |
| /admin/venues | client/admin/src/App.jsx:57 |

## Reproduce

```bash
node server/scripts/route-audit.js
node server/scripts/route-audit.js --json
```
