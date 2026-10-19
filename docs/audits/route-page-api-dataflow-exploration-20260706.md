# 路由、頁面跳轉、API 資料流探索稿

日期：2026-07-06  
狀態：唯讀探索稿，供 Web 版 GPT 討論與後續設計書使用  
範圍：Admin 後台、LIFF 家長端、LIFF 教練端、後端 API、Ragic/LINE/DB 資料流

## 0. 使用方式

這份文件不是修正設計書，也不是實作提案。它是目前程式碼現況的盤點，目的是讓後續討論可以先建立共同事實：

- 哪些角色可以進哪些頁面。
- 未登入、角色不符、401 時會怎麼跳轉。
- 前端 API caller 對應到哪些後端 handler。
- API 打到的資料來源是 DB、Ragic、LINE、檔案系統，或混合流程。
- 哪些流程可能出現「前端成功，但外部同步其實沒有完成」。

建議在 Web 版 GPT 討論時，以這份文件為背景，再另外提出想要的產品規則，例如：

- Ragic 狀態要定義成「連線正常」還是「資料同步完成」。
- 哪些操作必須強同步，哪些可以接受背景同步。
- 路由權限要以「可直接輸入 URL」還是「有沒有導航入口」為準。
- Mock 模式是否允許出現在正式部署。

## 1. 探索摘要

本輪探索使用唯讀方式完成，沒有修改程式、沒有 build、沒有啟動服務。盤點結果：

| 項目 | 數量 |
|---|---:|
| Admin React routes | 36 |
| LIFF React routes | 34 |
| 後端 Express handlers | 219 |
| 前端 API callers/wrappers | 203 |
| 前端 caller 找不到後端 handler | 0 |
| route 檔未 mount | 0 |
| 後端 handler 無靜態前端 caller | 8 |

初步結論：

- 前端 caller 與後端 handler 靜態比對沒有發現 missing backend。
- Admin 與 LIFF API client 預設 mock，是目前最大「看似成功但沒有打後端」風險。
- Ragic 相關流程混合了強同步、背景同步、本地優先同步三種語意，需要在設計書中明確定義。
- Admin 與 LIFF 都存在「有 route 但導航或回跳語意不一致」的情況。
- `/api/admin/ragic-status/purge-ghosts` 有具體 handler 風險：內部引用 `require('../../db')`，但專案其他 DB import 多使用 `models/db`，目前看起來可能執行時 500。

## 2. 系統入口

### 2.1 Admin

- 前端入口：`client/admin/src/main.jsx`
- Router basename：`/admin`
- 程式內 route `/login` 實際 URL 是 `/admin/login`
- 後端 static：`server/public/admin`
- SPA fallback：`/admin/*`
- API base：`/api/admin`

### 2.2 LIFF

- 前端入口：`client/liff/src/main.jsx`
- Router basename：`/liff`
- 程式內 route `/coach` 實際 URL 是 `/liff/coach`
- 後端 static：`server/public/liff`
- SPA fallback：`/liff/*`
- API base：`/api`

### 2.3 後端 API mount

主要 mount：

- `/api/auth`
- `/api/venues`
- `/api/coaches`
- `/api/coach-portal`
- `/api/parents`
- `/api/courses`
- `/api/slots`
- `/api/sessions`
- `/api/checkins`
- `/api/promotions`
- `/api/enrollments`
- `/api/group-orders`
- `/api/uploads`
- `/api/referrals`
- `/api/transfers`
- `/api/chat`
- `/api/learn`
- `/api/evaluations`
- `/api/admin`

Admin 子 mount：

- `/api/admin/auth`
- `/api/admin/staff`
- `/api/admin/coaches`
- `/api/admin/venues`
- `/api/admin/settings`
- `/api/admin/course-intros`
- `/api/admin/enrollments`
- `/api/admin/sessions`
- `/api/admin/checkins`
- `/api/admin/chat`
- `/api/admin/periods`
- `/api/admin/learn`
- `/api/admin/promotions`
- `/api/admin/mgm-stats`
- `/api/admin/transfers`
- `/api/admin/reports`
- `/api/admin/uploads`
- `/api/admin/course-types`
- `/api/admin/group-orders`
- `/api/admin/ragic-status`
- `/api/admin/ragic-staging`
- `/api/admin/ragic-z03`
- `/api/admin/customer-parents`
- `/api/admin/customer-students`

## 3. Admin 路由與角色

### 3.1 Auth 行為

- 未登入進受保護頁：導到 `/login`，實際 URL 是 `/admin/login`。
- 未登入回跳只保留 `loc.pathname`，不保留 query string。
- 已登入進 `/login`：導回 `state.from` 或 `/dashboard`。
- 角色不符：顯示「沒有權限存取此頁面」，不 redirect。
- 根路由 `/admin`：導 `/admin/dashboard`。
- 未知後台 route：導 `/admin/dashboard`。
- Admin API 一般 401：清 localStorage token，顯示登入過期訊息，hard redirect `/admin/login`。

### 3.2 Admin 可進頁面

`admin` 可進所有受保護頁：

- `/dashboard`
- `/reports`
- `/settings`
- `/staff`
- `/coaches`
- `/venues`
- `/course-intros`
- `/course-types`
- `/group-orders`
- `/ragic-status`
- `/ragic-staging`
- `/ragic-z03`
- `/customer-parents`
- `/customer-students`
- `/manual-enroll`
- `/reconcile`
- `/enrollments`
- `/refund`
- `/transfers`
- `/sessions`
- `/checkin`
- `/revive`
- `/chat-logs`
- `/alerts`
- `/keywords`
- `/promotions`
- `/promotions-active`
- `/mgm-stats`
- `/tags`
- `/coach-eval`
- `/eval-threshold`
- `/coach-intros-review`
- `/sop`

### 3.3 Manager 可進頁面

`manager` 可進：

- `/dashboard`
- `/reports`
- `/course-intros`
- `/group-orders`
- `/ragic-z03`
- `/customer-parents`
- `/customer-students`
- `/manual-enroll`
- `/reconcile`
- `/enrollments`
- `/refund`
- `/transfers`
- `/sessions`
- `/checkin`
- `/revive`
- `/chat-logs`
- `/alerts`
- `/promotions`
- `/promotions-active`
- `/mgm-stats`
- `/tags`
- `/coach-eval`
- `/coach-intros-review`
- `/sop`

### 3.4 Staff 可進頁面

`staff` 可進：

- `/dashboard`
- `/group-orders`
- `/ragic-z03`
- `/customer-parents`
- `/customer-students`
- `/manual-enroll`
- `/reconcile`
- `/enrollments`
- `/sessions`
- `/checkin`
- `/revive`
- `/promotions-active`
- `/sop`

### 3.5 Admin 導航與跳轉不一致

已發現：

- 沒有發現「Sidebar 有入口但 App 沒 route」。
- `/coaches` 有 App route，但 Sidebar 沒入口；實際會 redirect 到 `/staff?role=coach`。
- 因 `/staff` 是 admin-only，manager/staff 如果直接輸入 `/coaches`，會被導到 `/staff?role=coach` 後看到無權限。
- `ManualEnrollPage` 是 admin/manager/staff 都能進，但頁內有 `/course-types` 連結；`/course-types` 是 admin-only，所以 manager/staff 點入會被擋。

## 4. LIFF 路由與角色

### 4.1 LIFF 初始化

- `/liff/demo`、`/demo`、`?demo=1` 會跳過 LIFF init。
- `/coach...` 路徑會跳過 LIFF SDK，改走 coach portal OAuth。
- 其他家長/public route 會 init parent LIFF。
- parent LIFF 未登入 LINE 時會呼叫 `liff.login({ redirectUri: current })`。
- 若 coach LIFF ID 誤落在非 coach path，程式會改導到 `/liff/coach`。

### 4.2 Public / Guest 可進

- `/login`
- `/demo`
- `/register`
- `/coach-portal`
- `/group/join/:token`
- 未知 route `*` 會導 `/`

### 4.3 家長可進

- `/`
- `/my-courses`
- `/chat`
- `/profile`
- `/my-lessons`
- `/chat/:roomId`
- `/venue`
- `/coaches`
- `/enroll`
- `/enroll-success`
- `/enroll-status/:id`
- `/group/new`
- `/group/:id`
- `/course/:id`
- `/history/:periodId`
- `/book-slot/:periodId`
- `/evaluation/:id`
- `/referral`
- `/transfer/new`

### 4.4 教練可進

- `/coach`
- `/coach/schedule`
- `/coach/students`
- `/coach/chat`
- `/coach/profile`
- `/coach/session/:id`
- `/coach/plan/:periodId`
- `/coach/record/:sessionId`
- `/coach/chat/:roomId`

### 4.5 LIFF Auth 與回跳

- 未登入進 protected route：依照 path 判斷。
- `/coach...` protected route 未登入：導 `/coach-portal`。
- 非教練 protected route 未登入：導 `/login`。
- 家長 route 只接受 `role === 'parent'`，否則導 `/login`。
- 教練 route 只接受 `role === 'coach'`，否則導 `/coach-portal`。
- 家長登入成功後主要使用 `takeAfterAuth('/')`，不是直接使用 `location.state.from`。
- 因此直接輸入 `/liff/my-courses` 未登入時，登入後可能回 `/`，不一定回原頁。
- 團購加入頁有特別 `setAfterAuth('/group/join/:token')`，所以登入後會回團購加入流程。

### 4.6 LIFF 401 行為

- API client 會略過登入、註冊、auth bootstrap request 的全域 redirect。
- 家長 401：先用 LINE id_token 靜默打 `/api/auth/parent-line-login` 換 JWT，成功後重試原 request。
- 家長靜默重登失敗：正式環境導 `/liff/login`，dev/demo host 可能導 `/liff/demo`。
- 教練 401：清 `daos.user`，導 `/liff/coach-portal`。

### 4.7 LIFF 導航與跳轉不一致

已發現：

- 家長 BottomNav 的「聊天」標成 coming soon，點擊不導頁。
- 但實際存在 `/chat` 與 `/chat/:roomId` route，其他頁面也可能導到聊天。
- `AppLayout.TAB_PATHS` 包含 `/my-lessons`，直接進 `/my-lessons` 會顯示 BottomNav，但 BottomNav 沒有 `/my-lessons` 入口。
- 首頁「上課記錄/簽到」入口實際導 `/my-courses`，不是 `/my-lessons`。
- `RequireAuth` 有帶 `state.from`，但家長登入成功不使用它，導致直接 URL 進入時回跳語意不穩定。

## 5. 前端 API client 行為

### 5.1 Admin API client

- Base URL：`/api/admin`
- Token：讀 `daos.admin.user`
- 一般 401：清 token，設 flash，hard redirect `/admin/login`
- `skipAuthRedirect` 可略過全域 401 redirect
- `VITE_USE_MOCK !== 'false'` 時使用 mock
- real mode 遇 501 會 fallback mock

### 5.2 LIFF API client

- Base URL：`/api`
- Token：讀 `daos.user`
- FormData 會移除手動 Content-Type，讓瀏覽器自己帶 boundary
- 家長 401 會先靜默重新登入並 retry 一次
- 教練 401 直接回 coach portal
- `VITE_USE_MOCK !== 'false'` 時使用 mock
- real mode 遇 501 會 fallback mock

### 5.3 目前最大假成功來源

目前最大「前端顯示成功但其實沒有打真後端」來源是 mock：

- Admin 與 LIFF 預設都是 mock。
- 只有 `VITE_USE_MOCK=false` 才會打真 API。
- real mode 遇 501 也會 fallback mock。
- Ragic status mock 會偽造 env、live_probe、forms 都 OK。
- mock sync 會用 timeout 後改成 success，並非真的打 Ragic。

## 6. Admin API 群組

Admin API base 是 `/api/admin`。

| 前端 wrapper | 主要 endpoints | 主要資料來源 |
|---|---|---|
| `auth.js` | `POST /auth/login`, `POST /auth/change-password` | DB `admin_users`, JWT, bcrypt |
| `settings.js` | `GET/PATCH /settings` | DB settings |
| `staff.js` | `/staff`, `/staff/:id`, `/staff/coaches`, `/staff/sync`, password reset/hint | DB + Ragic H01 + LINE push |
| `venues.js` | `/venues`, `/venues/:id`, `/venues/:id/active`, `/venues/sync-ragic` | DB `admin_venues/venues` + Ragic H05 |
| `courseIntros.js` | `/course-intros`, `/course-intros/:courseType`, `/uploads/image` | DB + upload |
| `courseTypes.js` | `/course-types`, audit logs | DB |
| `customers.js` | `/customer-parents*`, `/customer-students*`, audit logs | DB + async Ragic writeback |
| `enrollments.js` | `/enrollments`, invoice upload, reconcile, refund | DB transaction + upload + LINE |
| `sessions.js` | `/sessions/today`, `/sessions`, verify/backfill/cancelled/revive | DB |
| `checkins.js` | `/checkins` | DB |
| `promotions.js` | active/list/detail/activate/archive/delete | DB |
| `chat.js` | rooms/messages/keywords/alerts | DB + WebSocket |
| `learn.js` | tags/categories/eval/threshold/intros review | DB + optional LINE |
| `reports.js` | revenue/sessions/discounts/MGM/learning | DB aggregation |
| `groupOrders.js` | list/detail/approve/reject | DB transaction + optional LINE/Ragic |
| `transfers.js` | list/approve/reject | DB + optional LINE |
| `ragicStatus.js` | status/sync/toggle/purge-ghosts | Ragic probe + sync log + DB |
| `ragicStaging.js` | list/count/approve/reject/bulk-approve | DB staging table |
| `ragicZ03.js` | stats/list/draft/resolve/dismiss/delete | DB Z03 queue + optional Ragic |
| `mgmStats.js` | `/mgm-stats` | DB aggregation |

## 7. LIFF API 群組

LIFF API base 是 `/api`。

| 前端 wrapper | 主要 endpoints | 主要資料來源 |
|---|---|---|
| `auth.js` | parent line login/bind/register/demo login | LINE id_token + Ragic Z01/Z02 + DB |
| `coachPortal.js` | OAuth status/exchange/link/session/logout | LINE OAuth + DB coaches |
| `parents.js` | create/me/update/students/sync | DB mirror + Ragic refresh/write |
| `courseTypes.js` | `/courses/types` | DB |
| `courses.js` | base price/mine/detail/payment-proof/cancel | DB + upload |
| `lessons.js` | `/courses/lessons` | DB |
| `coaches.js` | list/detail/by-phone/by-line-uid/bio/media | DB + upload |
| `venues.js` | list/detail | DB |
| `enrollments.js` | create enrollment, payment proof upload | DB + upload |
| `groupOrders.js` | create/mine/detail/token/join/draft/proof/submit/cancel | DB + Ragic/LINE best effort |
| `slots.js` | coach slots, block/unblock, preview, book | DB |
| `sessions.js` | coach today/week/session/checkins | DB |
| `checkins.js` | checkin | DB |
| `learn.js` | plans/records/tags/uploads/history | DB + upload + optional LINE |
| `evaluations` | mine/detail/submit | DB |
| `chat.js` | rooms/messages/read/upload/websocket | DB + upload + WebSocket |
| `referrals.js` | create/by-token/mine | DB + optional LINE |
| `transfers.js` | mine/create | DB + optional LINE |
| `promotions.js` | list/preview | DB |

## 8. Ragic 資料流分類

### 8.1 Ragic 連線與 status

`/api/admin/ragic-status` 主要回傳：

- env 是否存在
- missing env
- live probe
- cron 狀態
- forms 狀態
- sync log snapshot

live probe 目前主要覆蓋：

- H01
- H05
- Z01
- Z02

注意：live probe 能代表「Ragic form API 目前可讀」，不必然代表「本地資料已完成同步」。

### 8.2 強同步流程

這類流程比較接近「Ragic 成功才算成功」：

- 家長 LINE 登入/綁定/註冊涉及 Ragic Z01/Z02。
- 家長 profile/student 部分更新會直接寫 Ragic，再 refresh local mirror。
- 這些流程 Ragic 失敗時比較可能回前端錯誤。

設計討論重點：

- 哪些家長資料欄位應以 Ragic 為權威來源。
- Ragic 無法連線時，是否允許本地先存草稿。
- 前端要顯示「已儲存」還是「待同步」。

### 8.3 本地優先 + 背景 Ragic writeback

這類流程會先 commit 本地 DB，再排 background writeback：

- Admin parent 編輯。
- Admin student 編輯。
- Group order 建單或加入時建立學生。
- Admin enrollment reconcile 後的部分 writeback。

特徵：

- 前端可能已經收到成功。
- Ragic writeback 失敗只 warn 或寫 log。
- 後續靠 daily backup/retry 類流程補。
- `last_synced_at = NULL` 可視為待同步或不同步狀態的線索。

設計討論重點：

- UI 是否需要顯示「本地已存、Ragic 待同步」。
- 是否要有 per-record sync status。
- 是否要禁止某些 high-risk 欄位走 best effort。

### 8.4 背景同步流程

這類流程的 response 不代表同步已完成：

- `POST /api/admin/ragic-status/sync` 回 202 accepted，真正 sync 在背景跑。
- Staff list GET 可能觸發 H01 背景 sync，但 response 是當下 DB snapshot。
- Cron 會定期做 H01/H05 sync。
- Cron 夜間 chain 做 backup local -> Ragic、pull Ragic -> local/Z03、quarantine。

設計討論重點：

- 「同步按鈕」按下後，前端應顯示 accepted、running、success、failed 哪些狀態。
- 成功定義是 job queued、job completed、records changed，還是 Ragic live probe OK。
- 是否需要同步 job id。

### 8.5 Staging 與 Z03

Ragic staging：

- 主要表：`ragic_staging_changes`
- 用於接收 Ragic 差異，等待 admin approve/reject/bulk approve。
- approve 後套用到本地正式表。

Ragic Z03：

- 主要用途是處理不完整或無法綁定的 Ragic Z01 資料。
- 有 stats/list/draft/resolve/dismiss/delete。
- resolve/draft 可能會再寫回 Ragic。

設計討論重點：

- staging 與 Z03 在 UI 上是否要合併成「待處理同步事件」。
- Z03 delete 是否只允許 admin。
- 每筆處理是否要有 audit trail。

## 9. LINE / LIFF 外部資料流

### 9.1 LINE 驗證與 OAuth

- 家長 LIFF 會使用 LINE id_token。
- 後端會向 LINE verify id_token。
- 教練端走 coach portal OAuth，不走一般 parent LIFF init。
- coach portal 有 OAuth callback endpoint。

### 9.2 LINE Push

LINE push 多數是 best effort，常見於：

- staff reset password。
- invoice 通知。
- learning plan/record publish。
- chat alert。
- referral reward。
- transfer notification。
- group order notification。
- cron reminder。

風險：

- 業務 API 成功不代表 LINE 已送達。
- 有些 cron notification 有 retry，有些只是 warn。
- 若 token by venue missing，push 會失敗。

設計討論重點：

- 哪些通知需要 delivery log。
- 哪些通知失敗要阻擋主流程。
- 是否要在 Admin UI 顯示通知送達狀態。

## 10. 檔案上傳與靜態資源

目前 upload 類 endpoint 包含：

- payment proof
- invoice
- chat upload
- learning upload
- coach media
- course intro image

特徵：

- 後端預設寫本機 `server/uploads`。
- 透過 `/uploads` static serve。
- 若部署環境檔案系統不是 durable storage，檔案可能不是長期可靠來源。

設計討論重點：

- 是否改用 object storage。
- 是否需要檔案 metadata table。
- 是否要對上傳檔案做權限保護，而不是直接 static serve。

## 11. 後端 handler 無靜態前端 caller

以下 handler 目前沒有靜態掃描到前端 caller：

| Method | Path | 備註 |
|---|---|---|
| POST | `/api/admin/periods/:id/activate` | 可能是歷史/保留端點 |
| POST | `/api/admin/sessions/checkin` | 可能是舊簽到端點 |
| POST | `/api/admin/venues/sync` | 現在前端主要使用 `/sync-ragic` |
| GET | `/api/auth/line-config-debug` | debug 端點 |
| POST | `/api/auth/parent-login` | 可能是舊 parent login |
| GET | `/api/coach-portal/auth/line/callback` | OAuth callback，非前端 axios caller |
| DELETE | `/api/parents/me/students/:id` | handler 回 405，不允許刪除 |
| PATCH | `/api/transfers/:id/cancel` | 可能是未接 UI |

設計討論重點：

- 是否要保留、文件化、或刪除 deprecated endpoint。
- debug endpoint 是否應限制環境或 admin 權限。
- OAuth callback 不應被誤判為 unused。

## 12. 已知不一致與風險清單

### 12.1 路由/導航

- Admin `/coaches` 有 route 無 sidebar，且 redirect 到 admin-only `/staff?role=coach`。
- Admin `ManualEnrollPage` 對所有後台角色開放，但內部連結 `/course-types` 是 admin-only。
- Admin 未登入回跳不保留 query string。
- LIFF 家長聊天 route 存在，但 BottomNav 顯示 coming soon 且不導頁。
- LIFF `/my-lessons` 有 route 與 layout 支援，但 BottomNav 沒入口。
- LIFF 家長登入後不一定回到原本 protected URL。

### 12.2 API/資料流

- Admin/LIFF API client 預設 mock，正式環境若 env 沒設好會造成假資料成功。
- real mode 遇 501 fallback mock，可能掩蓋未完成 API。
- Ragic status mock 會假裝全部 OK。
- Ragic live probe OK 不代表資料已同步完成。
- 多個 Ragic writeback 是 best effort，前端成功不代表 Ragic 成功。
- LINE push 多數 best effort，主流程成功不代表通知送達。
- 檔案上傳目前偏本機檔案系統，部署 durability 需要確認。

### 12.3 具體可能 bug

- `/api/admin/ragic-status/purge-ghosts` 內部疑似 import 錯 DB module，可能執行時 500。

## 13. 討論用問題清單

可以把以下問題拿去 Web 版 GPT 討論，轉成設計書要求。

### 13.1 角色與路由

- 每個角色的可進頁面，是以「route guard」為準，還是以「Sidebar/BottomNav 入口」為準？
- manager/staff 直接輸入 admin-only URL 時，要顯示無權限、導回 dashboard，還是隱藏並記錄？
- Admin 未登入後登入，是否必須完整保留 pathname + query string？
- LIFF 家長未登入後登入，是否必須回原 protected URL？
- LIFF 家長聊天到底是 coming soon 還是已開放？
- `/my-lessons` 與 `/my-courses` 是否要合併或重新命名？

### 13.2 Ragic 狀態

- Ragic 連線狀態要顯示幾層？
  - env configured
  - API reachable
  - form readable
  - last sync job success
  - pending writeback count
  - stale record count
- Ragic sync 按鈕的成功定義是什麼？
  - request accepted
  - job completed
  - records changed
  - no pending errors
- 哪些 Ragic 寫入必須 blocking？
- 哪些 Ragic 寫入可以 best effort？
- 如果 Ragic 寫入失敗，前端要顯示錯誤、待同步、還是成功但警告？

### 13.3 Mock 與正式環境

- 正式環境是否應完全禁止 mock？
- 501 fallback mock 是否只允許開發環境？
- UI 是否要明確顯示目前使用 mock 還是真 API？
- Ragic status mock 是否應改成明確「模擬資料」而不是 all green？

### 13.4 API 與資料權威

- Parent/student 欄位哪些以 Ragic 為主，哪些以 Replit DB 為主？
- Purchase/enrollment/course/session/checkin 是否只以 Replit DB 為主？
- Ragic pull 到 local 時，衝突要覆蓋、staging、還是保留 local？
- 是否需要每筆 parent/student 顯示 `last_synced_at`、`sync_status`、`last_sync_error`？

### 13.5 通知與上傳

- LINE push 失敗是否需要重試佇列？
- 哪些通知要讓 Admin 看見送達狀態？
- 上傳檔案是否要從 local disk 改成 object storage？
- `/uploads` 是否需要權限保護？

## 14. 後續設計書建議章節

如果要回來做設計書，建議輸出成以下結構：

1. 目標與非目標
2. 角色與權限矩陣
3. 路由與回跳規格
4. API caller/handler 對照表
5. 資料權威來源規格
6. Ragic 狀態模型
7. Ragic 同步 job 狀態模型
8. Mock/正式環境防呆規格
9. LINE 通知可靠性規格
10. 檔案上傳與存取規格
11. 需要修正的既有不一致
12. 驗收測試清單

