# Route Map Audit

Generated at: 2026-07-02T07:38:20.024Z

## Method

- Source of truth: `server/index.js`, `server/routes/**`, `client/liff/src/App.jsx`, `client/admin/src/App.jsx`, and `client/**/src/api/**`.
- Matching is static and code-derived. External callbacks and manual debug URLs are classified separately instead of guessed as dead code.
- Dynamic frontend template segments are normalized to `:param`; query-string helpers are stripped before matching.

## Summary

| Metric | Value |
| --- | --- |
| Backend Express handlers | 215 |
| Frontend API wrapper/direct calls | 199 |
| Frontend API calls without backend handler | 0 |
| Route files not mounted | 0 |
| Backend handlers without static frontend caller | 8 |
| LIFF React routes | 34 |
| Admin React routes | 36 |

## Top-Level Backend Mounts

| Mount | Require | Source |
| --- | --- | --- |
| /api/auth | ./routes/auth | server/index.js:54 |
| /api/venues | ./routes/venues | server/index.js:55 |
| /api/coaches | ./routes/coaches | server/index.js:56 |
| /api/coach-portal | ./routes/coachPortal | server/index.js:57 |
| /api/parents | ./routes/parents | server/index.js:58 |
| /api/courses | ./routes/courses | server/index.js:59 |
| /api/slots | ./routes/slots | server/index.js:60 |
| /api/sessions | ./routes/sessions | server/index.js:61 |
| /api/checkins | ./routes/checkins | server/index.js:62 |
| /api/promotions | ./routes/promotions | server/index.js:63 |
| /api/enrollments | ./routes/enrollments | server/index.js:64 |
| /api/group-orders | ./routes/groupOrders | server/index.js:65 |
| /api/uploads | ./routes/uploads | server/index.js:66 |
| /api/referrals | ./routes/referrals | server/index.js:67 |
| /api/transfers | ./routes/transfers | server/index.js:68 |
| /api/chat | ./routes/chat | server/index.js:69 |
| /api/learn | ./routes/learn | server/index.js:70 |
| /api/evaluations | ./routes/evaluations | server/index.js:71 |
| /api/admin | ./routes/admin | server/index.js:72 |

## Admin Sub-Mounts

| Mount | Require | Source |
| --- | --- | --- |
| /api/admin/auth | ./admin/auth | server/routes/admin.js:19 |
| /api/admin/staff | ./admin/staff | server/routes/admin.js:20 |
| /api/admin/coaches | ./admin/coaches | server/routes/admin.js:21 |
| /api/admin/venues | ./admin/venues | server/routes/admin.js:22 |
| /api/admin/settings | ./admin/settings | server/routes/admin.js:23 |
| /api/admin/course-intros | ./admin/courseIntros | server/routes/admin.js:24 |
| /api/admin/enrollments | ./admin/enrollments | server/routes/admin.js:25 |
| /api/admin/sessions | ./admin/sessions | server/routes/admin.js:26 |
| /api/admin/checkins | ./admin/checkins | server/routes/admin.js:27 |
| /api/admin/chat | ./admin/chat | server/routes/admin.js:28 |
| /api/admin/periods | ./admin/periods | server/routes/admin.js:29 |
| /api/admin/learn | ./admin/learn | server/routes/admin.js:30 |
| /api/admin/promotions | ./admin/promotions | server/routes/admin.js:31 |
| /api/admin/mgm-stats | ./admin/mgmStats | server/routes/admin.js:32 |
| /api/admin/transfers | ./admin/transfers | server/routes/admin.js:33 |
| /api/admin/reports | ./admin/reports | server/routes/admin.js:34 |
| /api/admin/uploads | ./admin/uploads | server/routes/admin.js:35 |
| /api/admin/course-types | ./admin/courseTypes | server/routes/admin.js:36 |
| /api/admin/group-orders | ./admin/groupOrders | server/routes/admin.js:37 |
| /api/admin/ragic-status | ./admin/ragicStatus | server/routes/admin.js:38 |
| /api/admin/ragic-staging | ./admin/ragicStaging | server/routes/admin.js:39 |
| /api/admin/ragic-z03 | ./admin/ragicZ03 | server/routes/admin.js:40 |
| /api/admin/customer-parents | ./admin/customerParents | server/routes/admin.js:41 |
| /api/admin/customer-students | ./admin/customerStudents | server/routes/admin.js:42 |

## Frontend Route Graph

### LIFF (`basename=/liff`)

| Path | Source |
| --- | --- |
| /liff | client/liff/src/App.jsx:89 |
| /liff/* | client/liff/src/App.jsx:159 |
| /liff/book-slot/:periodId | client/liff/src/App.jsx:128 |
| /liff/chat | client/liff/src/App.jsx:91 |
| /liff/chat/:roomId | client/liff/src/App.jsx:98 |
| /liff/coach | client/liff/src/App.jsx:143 |
| /liff/coach-portal | client/liff/src/App.jsx:78 |
| /liff/coach/chat | client/liff/src/App.jsx:146 |
| /liff/coach/chat/:roomId | client/liff/src/App.jsx:155 |
| /liff/coach/plan/:periodId | client/liff/src/App.jsx:153 |
| /liff/coach/profile | client/liff/src/App.jsx:147 |
| /liff/coach/record/:sessionId | client/liff/src/App.jsx:154 |
| /liff/coach/schedule | client/liff/src/App.jsx:144 |
| /liff/coach/session/:id | client/liff/src/App.jsx:150 |
| /liff/coach/students | client/liff/src/App.jsx:145 |
| /liff/coaches | client/liff/src/App.jsx:103 |
| /liff/course/:id | client/liff/src/App.jsx:123 |
| /liff/demo | client/liff/src/App.jsx:73 |
| /liff/enroll | client/liff/src/App.jsx:106 |
| /liff/enroll-status/:id | client/liff/src/App.jsx:113 |
| /liff/enroll-success | client/liff/src/App.jsx:109 |
| /liff/evaluation/:id | client/liff/src/App.jsx:130 |
| /liff/group/:id | client/liff/src/App.jsx:120 |
| /liff/group/join/:token | client/liff/src/App.jsx:82 |
| /liff/group/new | client/liff/src/App.jsx:117 |
| /liff/history/:periodId | client/liff/src/App.jsx:126 |
| /liff/login | client/liff/src/App.jsx:72 |
| /liff/my-courses | client/liff/src/App.jsx:90 |
| /liff/my-lessons | client/liff/src/App.jsx:96 |
| /liff/profile | client/liff/src/App.jsx:92 |
| /liff/referral | client/liff/src/App.jsx:133 |
| /liff/register | client/liff/src/App.jsx:74 |
| /liff/transfer/new | client/liff/src/App.jsx:136 |
| /liff/venue | client/liff/src/App.jsx:100 |

### Admin (`basename=/admin`)

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

## Orphan / Mismatch Audit

### Frontend API Calls Without Backend Handler

None found.

### Route Files Not Mounted

None found.

### Backend Handlers Without Static Frontend Caller

| Method | Path | Source | Classification |
| --- | --- | --- | --- |
| POST | /api/admin/periods/:id/activate | server/routes/admin/periods.js:18 | canonical activation seam for future callers; no current admin API wrapper |
| POST | /api/admin/sessions/checkin | server/routes/admin/sessions.js:276 | MGM/checkin finalization endpoint; current CheckinPage uses list/verify/backfill routes |
| POST | /api/admin/venues/sync | server/routes/admin/venues.js:68 | legacy one-step venue sync; current admin UI uses /sync-ragic |
| GET | /api/auth/line-config-debug | server/routes/auth.js:117 | manual debug endpoint; env gated by DEBUG_LINE_AUTH in production |
| POST | /api/auth/parent-login | server/routes/auth.js:264 | legacy endpoint; default 410 unless ALLOW_LEGACY_PARENT_LOGIN=1 outside production |
| GET | /api/coach-portal/auth/line/callback | server/routes/coachPortal.js:152 | external LINE OAuth callback; not called by frontend JS |
| DELETE | /api/parents/me/students/:id | server/routes/parents.js:399 | intentional 405 guard; frontend deletion removed |
| PATCH | /api/transfers/:id/cancel | server/routes/transfers.js:65 | backend/service supports cancel; no current LIFF API wrapper or UI caller |

## Full Backend Route Inventory

| Method | Path | Guard Detected | Source |
| --- | --- | --- | --- |
| GET | / |  | server/index.js:117 |
| GET | /admin/* |  | server/index.js:106 |
| ALL | /api/admin/* |  | server/routes/admin.js:45 |
| POST | /api/admin/auth/change-password | requireAdminAuth | server/routes/admin/auth.js:93 |
| POST | /api/admin/auth/login |  | server/routes/admin/auth.js:30 |
| GET | /api/admin/chat/alerts | requireAdminAuth, requireAdminRole | server/routes/admin/chat.js:158 |
| PATCH | /api/admin/chat/alerts/:id | requireAdminAuth, requireAdminRole | server/routes/admin/chat.js:197 |
| GET | /api/admin/chat/keywords | requireAdminAuth, requireAdminRole | server/routes/admin/chat.js:82 |
| POST | /api/admin/chat/keywords | requireAdminAuth, requireAdminRole | server/routes/admin/chat.js:95 |
| DELETE | /api/admin/chat/keywords/:id | requireAdminAuth, requireAdminRole | server/routes/admin/chat.js:146 |
| PATCH | /api/admin/chat/keywords/:id | requireAdminAuth, requireAdminRole | server/routes/admin/chat.js:115 |
| GET | /api/admin/chat/rooms | requireAdminAuth, requireAdminRole | server/routes/admin/chat.js:42 |
| GET | /api/admin/chat/rooms/:id/messages | requireAdminAuth, requireAdminRole | server/routes/admin/chat.js:55 |
| GET | /api/admin/checkins | requireAdminAuth | server/routes/admin/checkins.js:21 |
| ALL | /api/admin/coaches/* |  | server/routes/admin/coaches.js:28 |
| GET | /api/admin/course-intros | requireAdminAuth | server/routes/admin/courseIntros.js:16 |
| PATCH | /api/admin/course-intros/:type | requireAdminAuth | server/routes/admin/courseIntros.js:36 |
| GET | /api/admin/course-types | requireAdminAuth, requireAdminRole | server/routes/admin/courseTypes.js:58 |
| POST | /api/admin/course-types | requireAdminAuth, requireAdminRole | server/routes/admin/courseTypes.js:77 |
| DELETE | /api/admin/course-types/:type | requireAdminAuth, requireAdminRole | server/routes/admin/courseTypes.js:249 |
| PATCH | /api/admin/course-types/:type | requireAdminAuth, requireAdminRole | server/routes/admin/courseTypes.js:136 |
| GET | /api/admin/course-types/:type/audit-logs | requireAdminAuth | server/routes/admin/courseTypes.js:269 |
| GET | /api/admin/customer-parents | requireAdminAuth | server/routes/admin/customerParents.js:78 |
| POST | /api/admin/customer-parents | requireAdminAuth | server/routes/admin/customerParents.js:128 |
| GET | /api/admin/customer-parents/:id | requireAdminAuth | server/routes/admin/customerParents.js:111 |
| PATCH | /api/admin/customer-parents/:id | requireAdminAuth | server/routes/admin/customerParents.js:156 |
| GET | /api/admin/customer-students | requireAdminAuth | server/routes/admin/customerStudents.js:50 |
| GET | /api/admin/customer-students/:id | requireAdminAuth | server/routes/admin/customerStudents.js:81 |
| PATCH | /api/admin/customer-students/:id | requireAdminAuth | server/routes/admin/customerStudents.js:148 |
| GET | /api/admin/customer-students/:id/audit-logs | requireAdminAuth | server/routes/admin/customerStudents.js:101 |
| GET | /api/admin/enrollments | requireAdminAuth | server/routes/admin/enrollments.js:451 |
| POST | /api/admin/enrollments | requireAdminAuth, requireAdminRole | server/routes/admin/enrollments.js:316 |
| PATCH | /api/admin/enrollments/:id | requireAdminAuth, requireAdminRole | server/routes/admin/enrollments.js:502 |
| POST | /api/admin/enrollments/:id/reconcile | requireAdminAuth, requireAdminRole | server/routes/admin/enrollments.js:741 |
| POST | /api/admin/enrollments/:id/refund | requireAdminAuth, requireAdminRole | server/routes/admin/enrollments.js:928 |
| GET | /api/admin/enrollments/:id/refund-preview | requireAdminAuth, requireAdminRole | server/routes/admin/enrollments.js:914 |
| GET | /api/admin/group-orders | requireAdminAuth | server/routes/admin/groupOrders.js:41 |
| GET | /api/admin/group-orders/:id | requireAdminAuth | server/routes/admin/groupOrders.js:93 |
| POST | /api/admin/group-orders/:id/approve | requireAdminAuth | server/routes/admin/groupOrders.js:155 |
| POST | /api/admin/group-orders/:id/reject | requireAdminAuth | server/routes/admin/groupOrders.js:253 |
| GET | /api/admin/learn/coach-eval | requireAdminRole | server/routes/admin/learn.js:110 |
| GET | /api/admin/learn/coach-eval/:coachId | requireAdminRole | server/routes/admin/learn.js:117 |
| GET | /api/admin/learn/intros | requireAdminRole | server/routes/admin/learn.js:152 |
| POST | /api/admin/learn/intros/:coachId/approve | requireAdminRole | server/routes/admin/learn.js:169 |
| POST | /api/admin/learn/intros/:coachId/reject | requireAdminRole | server/routes/admin/learn.js:182 |
| POST | /api/admin/learn/tag-categories | requireAdminRole | server/routes/admin/learn.js:49 |
| DELETE | /api/admin/learn/tag-categories/:id | requireAdminRole | server/routes/admin/learn.js:64 |
| GET | /api/admin/learn/tags | requireAdminRole | server/routes/admin/learn.js:41 |
| POST | /api/admin/learn/tags | requireAdminRole | server/routes/admin/learn.js:69 |
| DELETE | /api/admin/learn/tags/:id | requireAdminRole | server/routes/admin/learn.js:104 |
| PATCH | /api/admin/learn/tags/:id | requireAdminRole | server/routes/admin/learn.js:86 |
| GET | /api/admin/learn/thresholds | requireAdminRole | server/routes/admin/learn.js:123 |
| PUT | /api/admin/learn/thresholds | requireAdminRole | server/routes/admin/learn.js:127 |
| GET | /api/admin/mgm-stats |  | server/routes/admin/mgmStats.js:15 |
| POST | /api/admin/periods/:id/activate | requireAdminAuth, requireAdminRole | server/routes/admin/periods.js:18 |
| GET | /api/admin/promotions | requireAdminRole | server/routes/admin/promotions.js:57 |
| POST | /api/admin/promotions | requireAdminRole | server/routes/admin/promotions.js:112 |
| DELETE | /api/admin/promotions/:id | requireAdminRole | server/routes/admin/promotions.js:186 |
| GET | /api/admin/promotions/:id | requireAdminRole | server/routes/admin/promotions.js:90 |
| PATCH | /api/admin/promotions/:id | requireAdminRole | server/routes/admin/promotions.js:144 |
| POST | /api/admin/promotions/:id/activate |  | server/routes/admin/promotions.js:239 |
| POST | /api/admin/promotions/:id/approve |  | server/routes/admin/promotions.js:241 |
| POST | /api/admin/promotions/:id/archive |  | server/routes/admin/promotions.js:247 |
| POST | /api/admin/promotions/:id/reject |  | server/routes/admin/promotions.js:242 |
| POST | /api/admin/promotions/:id/submit |  | server/routes/admin/promotions.js:240 |
| GET | /api/admin/promotions/active | requireAdminRole | server/routes/admin/promotions.js:75 |
| GET | /api/admin/ragic-staging |  | server/routes/admin/ragicStaging.js:29 |
| POST | /api/admin/ragic-staging/:id/approve |  | server/routes/admin/ragicStaging.js:39 |
| POST | /api/admin/ragic-staging/:id/reject |  | server/routes/admin/ragicStaging.js:48 |
| POST | /api/admin/ragic-staging/bulk-approve |  | server/routes/admin/ragicStaging.js:59 |
| GET | /api/admin/ragic-staging/count |  | server/routes/admin/ragicStaging.js:20 |
| GET | /api/admin/ragic-status | requireAdminAuth, requireAdminRole | server/routes/admin/ragicStatus.js:53 |
| POST | /api/admin/ragic-status/sync | requireAdminAuth, requireAdminRole | server/routes/admin/ragicStatus.js:75 |
| POST | /api/admin/ragic-status/toggle | requireAdminAuth, requireAdminRole | server/routes/admin/ragicStatus.js:110 |
| GET | /api/admin/ragic-z03 |  | server/routes/admin/ragicZ03.js:20 |
| PATCH | /api/admin/ragic-z03/:id |  | server/routes/admin/ragicZ03.js:31 |
| POST | /api/admin/ragic-z03/:id/dismiss |  | server/routes/admin/ragicZ03.js:40 |
| GET | /api/admin/reports/coach-options |  | server/routes/admin/reports.js:46 |
| GET | /api/admin/reports/discounts |  | server/routes/admin/reports.js:104 |
| GET | /api/admin/reports/learning-completion |  | server/routes/admin/reports.js:174 |
| GET | /api/admin/reports/mgm-conversion |  | server/routes/admin/reports.js:134 |
| GET | /api/admin/reports/revenue |  | server/routes/admin/reports.js:55 |
| GET | /api/admin/reports/sessions |  | server/routes/admin/reports.js:80 |
| GET | /api/admin/sessions | requireAdminAuth | server/routes/admin/sessions.js:49 |
| POST | /api/admin/sessions/:id/backfill-checkin | requireAdminAuth | server/routes/admin/sessions.js:243 |
| POST | /api/admin/sessions/:id/revive | requireAdminAuth, requireAdminRole | server/routes/admin/sessions.js:192 |
| GET | /api/admin/sessions/cancelled | requireAdminAuth, requireAdminRole | server/routes/admin/sessions.js:174 |
| POST | /api/admin/sessions/checkin | requireAdminAuth | server/routes/admin/sessions.js:276 |
| GET | /api/admin/sessions/today | requireAdminAuth | server/routes/admin/sessions.js:97 |
| GET | /api/admin/sessions/verify-checkin | requireAdminAuth | server/routes/admin/sessions.js:119 |
| GET | /api/admin/settings | requireAdminAuth, requireAdminRole | server/routes/admin/settings.js:30 |
| PATCH | /api/admin/settings | requireAdminAuth, requireAdminRole | server/routes/admin/settings.js:39 |
| GET | /api/admin/staff | requireAdminAuth, requireAdminRole | server/routes/admin/staff.js:270 |
| POST | /api/admin/staff | requireAdminAuth, requireAdminRole | server/routes/admin/staff.js:394 |
| GET | /api/admin/staff/:id | requireAdminAuth, requireAdminRole | server/routes/admin/staff.js:372 |
| PATCH | /api/admin/staff/:id | requireAdminAuth, requireAdminRole | server/routes/admin/staff.js:479 |
| GET | /api/admin/staff/:id/password-hint | requireAdminAuth, requireAdminRole | server/routes/admin/staff.js:761 |
| POST | /api/admin/staff/:id/reset-password | requireAdminAuth, requireAdminRole | server/routes/admin/staff.js:696 |
| GET | /api/admin/staff/coaches | requireAdminAuth, requireAdminRole | server/routes/admin/staff.js:318 |
| POST | /api/admin/staff/sync | requireAdminAuth, requireAdminRole | server/routes/admin/staff.js:302 |
| GET | /api/admin/transfers | requireAdminAuth, requireAdminRole | server/routes/admin/transfers.js:30 |
| POST | /api/admin/transfers/:id/approve | requireAdminAuth, requireAdminRole | server/routes/admin/transfers.js:63 |
| POST | /api/admin/transfers/:id/reject | requireAdminAuth, requireAdminRole | server/routes/admin/transfers.js:73 |
| POST | /api/admin/uploads/image | requireAdminAuth | server/routes/admin/uploads.js:46 |
| POST | /api/admin/uploads/invoice | requireAdminAuth | server/routes/admin/uploads.js:42 |
| GET | /api/admin/venues | requireAdminAuth, requireAdminRole | server/routes/admin/venues.js:53 |
| PATCH | /api/admin/venues/:id | requireAdminAuth, requireAdminRole | server/routes/admin/venues.js:142 |
| PATCH | /api/admin/venues/:id/active | requireAdminAuth, requireAdminRole | server/routes/admin/venues.js:101 |
| POST | /api/admin/venues/sync | requireAdminAuth, requireAdminRole | server/routes/admin/venues.js:68 |
| POST | /api/admin/venues/sync-ragic | requireAdminAuth, requireAdminRole | server/routes/admin/venues.js:80 |
| ALL | /api/auth/* |  | server/routes/auth.js:885 |
| POST | /api/auth/demo-login |  | server/routes/auth.js:47 |
| GET | /api/auth/line-config-debug |  | server/routes/auth.js:117 |
| POST | /api/auth/parent-bind-phone |  | server/routes/auth.js:404 |
| POST | /api/auth/parent-line-login |  | server/routes/auth.js:329 |
| POST | /api/auth/parent-login |  | server/routes/auth.js:264 |
| POST | /api/auth/parent-register-line |  | server/routes/auth.js:569 |
| GET | /api/chat/period/:coursePeriodId/room | requireLiffUser | server/routes/chat.js:95 |
| GET | /api/chat/rooms | requireLiffUser | server/routes/chat.js:83 |
| GET | /api/chat/rooms/:id | requireLiffUser | server/routes/chat.js:130 |
| GET | /api/chat/rooms/:id/messages | requireLiffUser | server/routes/chat.js:141 |
| POST | /api/chat/rooms/:id/messages | requireLiffUser | server/routes/chat.js:210 |
| POST | /api/chat/rooms/:id/read | requireLiffUser | server/routes/chat.js:250 |
| POST | /api/chat/rooms/:id/upload | requireLiffUser | server/routes/chat.js:228 |
| POST | /api/checkins | requireParent | server/routes/checkins.js:16 |
| POST | /api/coach-portal/auth/exchange |  | server/routes/coachPortal.js:212 |
| GET | /api/coach-portal/auth/line |  | server/routes/coachPortal.js:136 |
| GET | /api/coach-portal/auth/line/callback |  | server/routes/coachPortal.js:152 |
| GET | /api/coach-portal/auth/line/status |  | server/routes/coachPortal.js:123 |
| GET | /api/coach-portal/auth/line/token-info/:token |  | server/routes/coachPortal.js:201 |
| POST | /api/coach-portal/link-by-name |  | server/routes/coachPortal.js:240 |
| POST | /api/coach-portal/logout |  | server/routes/coachPortal.js:350 |
| GET | /api/coach-portal/session |  | server/routes/coachPortal.js:331 |
| GET | /api/coaches |  | server/routes/coaches.js:53 |
| GET | /api/coaches/:id | requireCoach | server/routes/coaches.js:240 |
| PUT | /api/coaches/:id/bio | requireCoach | server/routes/coaches.js:255 |
| GET | /api/coaches/:id/media | requireCoach | server/routes/coaches.js:273 |
| POST | /api/coaches/:id/media | requireCoach | server/routes/coaches.js:282 |
| DELETE | /api/coaches/:id/media/:mediaId | requireCoach | server/routes/coaches.js:346 |
| PATCH | /api/coaches/:id/media/reorder | requireCoach | server/routes/coaches.js:324 |
| POST | /api/coaches/:id/media/upload | requireCoach | server/routes/coaches.js:298 |
| GET | /api/coaches/by-line-uid | byLineUidRateLimit | server/routes/coaches.js:194 |
| GET | /api/coaches/by-phone | byPhoneRateLimit | server/routes/coaches.js:100 |
| GET | /api/courses/:id | requireParent | server/routes/courses.js:249 |
| POST | /api/courses/:id/cancel | requireParent | server/routes/courses.js:419 |
| POST | /api/courses/:id/payment-proof | requireParent | server/routes/courses.js:367 |
| ALL | /api/courses/* |  | server/routes/courses.js:470 |
| GET | /api/courses/base-price | requireParent | server/routes/courses.js:227 |
| GET | /api/courses/lessons | requireParent | server/routes/courses.js:12 |
| GET | /api/courses/mine | requireParent | server/routes/courses.js:75 |
| GET | /api/courses/types |  | server/routes/courses.js:201 |
| POST | /api/enrollments |  | server/routes/enrollments.js:31 |
| GET | /api/evaluations/:id | requireParent | server/routes/evaluations.js:28 |
| POST | /api/evaluations/:id/submit | requireParent | server/routes/evaluations.js:40 |
| GET | /api/evaluations/mine | requireParent | server/routes/evaluations.js:18 |
| POST | /api/group-orders |  | server/routes/groupOrders.js:432 |
| GET | /api/group-orders/:id |  | server/routes/groupOrders.js:568 |
| POST | /api/group-orders/:id/cancel |  | server/routes/groupOrders.js:777 |
| POST | /api/group-orders/:id/my-proof |  | server/routes/groupOrders.js:681 |
| POST | /api/group-orders/:id/submit |  | server/routes/groupOrders.js:727 |
| GET | /api/group-orders/by-token/:token | optionalParent, previewRateLimit | server/routes/groupOrders.js:300 |
| POST | /api/group-orders/by-token/:token/join |  | server/routes/groupOrders.js:584 |
| POST | /api/group-orders/by-token/:token/lookup-phone | optionalParent, lookupRateLimit | server/routes/groupOrders.js:320 |
| DELETE | /api/group-orders/draft |  | server/routes/groupOrders.js:421 |
| GET | /api/group-orders/draft |  | server/routes/groupOrders.js:387 |
| PUT | /api/group-orders/draft |  | server/routes/groupOrders.js:402 |
| GET | /api/group-orders/mine |  | server/routes/groupOrders.js:534 |
| GET | /api/learn/history/:periodId | requireParent | server/routes/learn.js:140 |
| POST | /api/learn/personal-tags | requireParent, requireCoach | server/routes/learn.js:124 |
| DELETE | /api/learn/personal-tags/:id | requireParent, requireCoach | server/routes/learn.js:131 |
| GET | /api/learn/plans/:periodId | requireCoach | server/routes/learn.js:43 |
| PUT | /api/learn/plans/:periodId | requireCoach | server/routes/learn.js:54 |
| POST | /api/learn/plans/:periodId/publish | requireCoach | server/routes/learn.js:61 |
| GET | /api/learn/records/by-session/:sessionId | requireCoach | server/routes/learn.js:72 |
| PUT | /api/learn/records/by-session/:sessionId | requireCoach | server/routes/learn.js:86 |
| GET | /api/learn/records/by-session/:sessionId/copy-prev | requireCoach | server/routes/learn.js:101 |
| POST | /api/learn/records/by-session/:sessionId/submit | requireCoach | server/routes/learn.js:93 |
| GET | /api/learn/records/by-session/:sessionId/versions | requireCoach | server/routes/learn.js:108 |
| GET | /api/learn/tags | requireParent, requireCoach | server/routes/learn.js:119 |
| POST | /api/learn/uploads | requireCoach | server/routes/learn.js:161 |
| POST | /api/parents |  | server/routes/parents.js:406 |
| ALL | /api/parents/* |  | server/routes/parents.js:490 |
| GET | /api/parents/me | requireParent | server/routes/parents.js:137 |
| PATCH | /api/parents/me | requireParent | server/routes/parents.js:196 |
| POST | /api/parents/me/students | requireParent | server/routes/parents.js:254 |
| DELETE | /api/parents/me/students/:id | requireParent | server/routes/parents.js:399 |
| PATCH | /api/parents/me/students/:id | requireParent | server/routes/parents.js:326 |
| POST | /api/parents/me/sync | requireParent | server/routes/parents.js:153 |
| GET | /api/promotions | optionalParent | server/routes/promotions.js:14 |
| POST | /api/promotions/preview | optionalParent | server/routes/promotions.js:39 |
| POST | /api/referrals | requireParent | server/routes/referrals.js:18 |
| GET | /api/referrals/by-token/:token | requireParent | server/routes/referrals.js:37 |
| GET | /api/referrals/mine | requireParent | server/routes/referrals.js:54 |
| GET | /api/sessions/:id | requireCoach | server/routes/sessions.js:178 |
| ~~POST~~ | ~~/api/sessions/:id/checkins~~ | ~~requireCoach~~ | **已於 2026-08-10 移除（教練代簽）** |
| GET | /api/sessions/coach/:coachId/today | requireCoach | server/routes/sessions.js:17 |
| GET | /api/sessions/coach/:coachId/week | requireCoach | server/routes/sessions.js:49 |
| POST | /api/slots | requireCoach | server/routes/slots.js:113 |
| DELETE | /api/slots/:id | requireParent, requireCoach | server/routes/slots.js:171 |
| PATCH | /api/slots/:id/block | requireCoach | server/routes/slots.js:151 |
| POST | /api/slots/:id/book | requireParent | server/routes/slots.js:269 |
| PATCH | /api/slots/:id/unblock | requireCoach | server/routes/slots.js:161 |
| POST | /api/slots/batch | requireCoach | server/routes/slots.js:126 |
| GET | /api/slots/coach/:coachId | requireCoach | server/routes/slots.js:77 |
| GET | /api/slots/period/:coursePeriodId | requireParent | server/routes/slots.js:188 |
| POST | /api/slots/preview-conflict | requireParent, requireCoach | server/routes/slots.js:180 |
| POST | /api/transfers |  | server/routes/transfers.js:24 |
| PATCH | /api/transfers/:id/cancel |  | server/routes/transfers.js:65 |
| GET | /api/transfers/mine |  | server/routes/transfers.js:15 |
| POST | /api/uploads/payment-proof | requireParent | server/routes/uploads.js:36 |
| GET | /api/venues |  | server/routes/venues.js:31 |
| GET | /api/venues/:id |  | server/routes/venues.js:47 |
| GET | /health |  | server/index.js:75 |
| GET | /liff/* |  | server/index.js:110 |
| GET | /r/:token |  | server/index.js:78 |

## Full Frontend API Call Inventory

| Method | Path | Kind | Source |
| --- | --- | --- | --- |
| POST | /api/admin/auth/change-password | callApi | client/admin/src/api/auth.js:8 |
| POST | /api/admin/auth/login | callApi | client/admin/src/api/auth.js:6 |
| GET | /api/admin/chat/alerts | callApi | client/admin/src/api/chat.js:26 |
| PATCH | /api/admin/chat/alerts/:param | callApi | client/admin/src/api/chat.js:28 |
| GET | /api/admin/chat/keywords | callApi | client/admin/src/api/chat.js:14 |
| POST | /api/admin/chat/keywords | callApi | client/admin/src/api/chat.js:16 |
| DELETE | /api/admin/chat/keywords/:param | callApi | client/admin/src/api/chat.js:20 |
| PATCH | /api/admin/chat/keywords/:param | callApi | client/admin/src/api/chat.js:18 |
| GET | /api/admin/chat/rooms | callApi | client/admin/src/api/chat.js:7 |
| GET | /api/admin/chat/rooms/:param/messages | callApi | client/admin/src/api/chat.js:9 |
| GET | /api/admin/checkins | callApi | client/admin/src/api/checkins.js:7 |
| GET | /api/admin/course-intros | callApi | client/admin/src/api/courseIntros.js:5 |
| PATCH | /api/admin/course-intros/:param | callApi | client/admin/src/api/courseIntros.js:7 |
| GET | /api/admin/course-types | callApi | client/admin/src/api/courseTypes.js:5 |
| POST | /api/admin/course-types | callApi | client/admin/src/api/courseTypes.js:6 |
| DELETE | /api/admin/course-types/:param | callApi | client/admin/src/api/courseTypes.js:8 |
| PATCH | /api/admin/course-types/:param | callApi | client/admin/src/api/courseTypes.js:7 |
| GET | /api/admin/course-types/:param/audit-logs | callApi | client/admin/src/api/courseTypes.js:9 |
| GET | /api/admin/customer-parents | callApi | client/admin/src/api/customers.js:19 |
| POST | /api/admin/customer-parents | callApi | client/admin/src/api/customers.js:23 |
| GET | /api/admin/customer-parents/:param | callApi | client/admin/src/api/customers.js:21 |
| PATCH | /api/admin/customer-parents/:param | callApi | client/admin/src/api/customers.js:25 |
| GET | /api/admin/customer-students | callApi | client/admin/src/api/customers.js:31 |
| GET | /api/admin/customer-students/:param | callApi | client/admin/src/api/customers.js:33 |
| PATCH | /api/admin/customer-students/:param | callApi | client/admin/src/api/customers.js:35 |
| GET | /api/admin/customer-students/:param/audit-logs | callApi | client/admin/src/api/customers.js:37 |
| GET | /api/admin/enrollments | callApi | client/admin/src/api/enrollments.js:6 |
| POST | /api/admin/enrollments | callApi | client/admin/src/api/enrollments.js:10 |
| PATCH | /api/admin/enrollments/:param | callApi | client/admin/src/api/enrollments.js:17 |
| POST | /api/admin/enrollments/:param/reconcile | callApi | client/admin/src/api/enrollments.js:28 |
| POST | /api/admin/enrollments/:param/refund | callApi | client/admin/src/api/enrollments.js:38 |
| GET | /api/admin/enrollments/:param/refund-preview | callApi | client/admin/src/api/enrollments.js:35 |
| GET | /api/admin/group-orders | callApi | client/admin/src/api/groupOrders.js:5 |
| GET | /api/admin/group-orders/:param | callApi | client/admin/src/api/groupOrders.js:6 |
| POST | /api/admin/group-orders/:param/approve | callApi | client/admin/src/api/groupOrders.js:7 |
| POST | /api/admin/group-orders/:param/reject | callApi | client/admin/src/api/groupOrders.js:8 |
| GET | /api/admin/learn/coach-eval | callApi | client/admin/src/api/learn.js:21 |
| GET | /api/admin/learn/coach-eval/:param | callApi | client/admin/src/api/learn.js:23 |
| GET | /api/admin/learn/intros | callApi | client/admin/src/api/learn.js:32 |
| POST | /api/admin/learn/intros/:param/approve | callApi | client/admin/src/api/learn.js:34 |
| POST | /api/admin/learn/intros/:param/reject | callApi | client/admin/src/api/learn.js:36 |
| POST | /api/admin/learn/tag-categories | callApi | client/admin/src/api/learn.js:7 |
| DELETE | /api/admin/learn/tag-categories/:param | callApi | client/admin/src/api/learn.js:9 |
| GET | /api/admin/learn/tags | callApi | client/admin/src/api/learn.js:5 |
| POST | /api/admin/learn/tags | callApi | client/admin/src/api/learn.js:11 |
| DELETE | /api/admin/learn/tags/:param | callApi | client/admin/src/api/learn.js:15 |
| PATCH | /api/admin/learn/tags/:param | callApi | client/admin/src/api/learn.js:13 |
| GET | /api/admin/learn/thresholds | callApi | client/admin/src/api/learn.js:24 |
| PUT | /api/admin/learn/thresholds | callApi | client/admin/src/api/learn.js:26 |
| GET | /api/admin/mgm-stats | callApi | client/admin/src/api/mgmStats.js:5 |
| GET | /api/admin/promotions | callApi | client/admin/src/api/promotions.js:14 |
| POST | /api/admin/promotions | callApi | client/admin/src/api/promotions.js:16 |
| DELETE | /api/admin/promotions/:param | callApi | client/admin/src/api/promotions.js:22 |
| GET | /api/admin/promotions/:param | req | client/admin/src/api/promotions.js:15 |
| PATCH | /api/admin/promotions/:param | callApi | client/admin/src/api/promotions.js:17 |
| POST | /api/admin/promotions/:param/activate | callApi | client/admin/src/api/promotions.js:19 |
| POST | /api/admin/promotions/:param/approve | req | client/admin/src/api/promotions.js:25 |
| POST | /api/admin/promotions/:param/archive | callApi | client/admin/src/api/promotions.js:20 |
| POST | /api/admin/promotions/:param/reject | req | client/admin/src/api/promotions.js:26 |
| POST | /api/admin/promotions/:param/submit | req | client/admin/src/api/promotions.js:24 |
| GET | /api/admin/promotions/active | callApi | client/admin/src/api/promotions.js:13 |
| GET | /api/admin/ragic-staging | http.get | client/admin/src/api/ragicStaging.js:8 |
| POST | /api/admin/ragic-staging/:param/approve | http.post | client/admin/src/api/ragicStaging.js:18 |
| POST | /api/admin/ragic-staging/:param/reject | http.post | client/admin/src/api/ragicStaging.js:22 |
| POST | /api/admin/ragic-staging/bulk-approve | http.post | client/admin/src/api/ragicStaging.js:26 |
| GET | /api/admin/ragic-staging/count | http.get | client/admin/src/api/ragicStaging.js:13 |
| GET | /api/admin/ragic-status | http.get | client/admin/src/api/ragicStatus.js:10 |
| POST | /api/admin/ragic-status/sync | http.post | client/admin/src/api/ragicStatus.js:17 |
| POST | /api/admin/ragic-status/toggle | http.post | client/admin/src/api/ragicStatus.js:26 |
| GET | /api/admin/ragic-z03 | http.get | client/admin/src/api/ragicZ03.js:6 |
| PATCH | /api/admin/ragic-z03/:param | http.patch | client/admin/src/api/ragicZ03.js:10 |
| POST | /api/admin/ragic-z03/:param/dismiss | http.post | client/admin/src/api/ragicZ03.js:14 |
| GET | /api/admin/reports/coach-options | callApi | client/admin/src/api/reports.js:7 |
| GET | /api/admin/reports/discounts | callApi | client/admin/src/api/reports.js:13 |
| GET | /api/admin/reports/learning-completion | callApi | client/admin/src/api/reports.js:21 |
| GET | /api/admin/reports/mgm-conversion | callApi | client/admin/src/api/reports.js:15 |
| GET | /api/admin/reports/revenue | callApi | client/admin/src/api/reports.js:9 |
| GET | /api/admin/reports/sessions | callApi | client/admin/src/api/reports.js:11 |
| GET | /api/admin/sessions | callApi | client/admin/src/api/sessions.js:9 |
| POST | /api/admin/sessions/:param/backfill-checkin | callApi | client/admin/src/api/sessions.js:23 |
| POST | /api/admin/sessions/:param/revive | callApi | client/admin/src/api/sessions.js:27 |
| GET | /api/admin/sessions/cancelled | callApi | client/admin/src/api/sessions.js:25 |
| GET | /api/admin/sessions/today | callApi | client/admin/src/api/sessions.js:6 |
| GET | /api/admin/sessions/verify-checkin | callApi | client/admin/src/api/sessions.js:20 |
| GET | /api/admin/settings | callApi | client/admin/src/api/settings.js:5 |
| PATCH | /api/admin/settings | callApi | client/admin/src/api/settings.js:7 |
| GET | /api/admin/staff | callApi | client/admin/src/api/staff.js:15 |
| POST | /api/admin/staff | callApi | client/admin/src/api/staff.js:35 |
| GET | /api/admin/staff/:param | callApi | client/admin/src/api/staff.js:18 |
| PATCH | /api/admin/staff/:param | callApi | client/admin/src/api/staff.js:37 |
| GET | /api/admin/staff/:param/password-hint | callApi | client/admin/src/api/staff.js:45 |
| POST | /api/admin/staff/:param/reset-password | callApi | client/admin/src/api/staff.js:41 |
| GET | /api/admin/staff/coaches | callApi | client/admin/src/api/staff.js:25 |
| POST | /api/admin/staff/sync | callApi | client/admin/src/api/staff.js:39 |
| GET | /api/admin/transfers | callApi | client/admin/src/api/transfers.js:5 |
| POST | /api/admin/transfers/:param/approve | callApi | client/admin/src/api/transfers.js:7 |
| POST | /api/admin/transfers/:param/reject | callApi | client/admin/src/api/transfers.js:10 |
| POST | /api/admin/uploads/image | callApi | client/admin/src/api/courseIntros.js:12 |
| POST | /api/admin/uploads/invoice | callApi | client/admin/src/api/enrollments.js:22 |
| GET | /api/admin/venues | callApi | client/admin/src/api/venues.js:5 |
| PATCH | /api/admin/venues/:param | callApi | client/admin/src/api/venues.js:7 |
| PATCH | /api/admin/venues/:param/active | callApi | client/admin/src/api/venues.js:10 |
| POST | /api/admin/venues/sync-ragic | callApi | client/admin/src/api/venues.js:14 |
| POST | /api/admin/venues/sync-ragic | callApi | client/admin/src/api/venues.js:20 |
| POST | /api/auth/demo-login | callApi | client/liff/src/api/auth.js:59 |
| POST | /api/auth/parent-bind-phone | callApi | client/liff/src/api/auth.js:21 |
| POST | /api/auth/parent-line-login | callApi | client/liff/src/api/auth.js:8 |
| POST | /api/auth/parent-line-login | axios.post | client/liff/src/api/client.js:32 |
| POST | /api/auth/parent-register-line | callApi | client/liff/src/api/auth.js:31 |
| GET | /api/chat/period/:param/room | callApi | client/liff/src/api/chat.js:26 |
| GET | /api/chat/rooms | callApi | client/liff/src/api/chat.js:18 |
| GET | /api/chat/rooms/:param | callApi | client/liff/src/api/chat.js:22 |
| GET | /api/chat/rooms/:param/messages | callApi | client/liff/src/api/chat.js:37 |
| POST | /api/chat/rooms/:param/messages | callApi | client/liff/src/api/chat.js:45 |
| POST | /api/chat/rooms/:param/read | callApi | client/liff/src/api/chat.js:53 |
| POST | /api/chat/rooms/:param/upload | http.post | client/liff/src/api/chat.js:68 |
| POST | /api/checkins | callApi | client/liff/src/api/checkins.js:8 |
| POST | /api/coach-portal/auth/exchange | portalHttp.post | client/liff/src/api/coachPortal.js:25 |
| GET | /api/coach-portal/auth/line | const-url | client/liff/src/api/coachPortal.js:40 |
| GET | /api/coach-portal/auth/line/status | portalHttp.get | client/liff/src/api/coachPortal.js:18 |
| GET | /api/coach-portal/auth/line/token-info/:param | portalHttp.get | client/liff/src/api/coachPortal.js:22 |
| POST | /api/coach-portal/link-by-name | portalHttp.post | client/liff/src/api/coachPortal.js:29 |
| POST | /api/coach-portal/logout | portalHttp.post | client/liff/src/api/coachPortal.js:36 |
| GET | /api/coach-portal/session | portalHttp.get | client/liff/src/api/coachPortal.js:33 |
| GET | /api/coaches | callApi | client/liff/src/api/coaches.js:6 |
| GET | /api/coaches/:param | callApi | client/liff/src/api/coaches.js:9 |
| PUT | /api/coaches/:param/bio | callApi | client/liff/src/api/coaches.js:39 |
| GET | /api/coaches/:param/media | callApi | client/liff/src/api/coaches.js:44 |
| POST | /api/coaches/:param/media | callApi | client/liff/src/api/coaches.js:47 |
| DELETE | /api/coaches/:param/media/:param | callApi | client/liff/src/api/coaches.js:64 |
| PATCH | /api/coaches/:param/media/reorder | callApi | client/liff/src/api/coaches.js:60 |
| POST | /api/coaches/:param/media/upload | callApi | client/liff/src/api/coaches.js:55 |
| GET | /api/coaches/by-line-uid | callApi | client/liff/src/api/coaches.js:27 |
| GET | /api/coaches/by-phone | callApi | client/liff/src/api/coaches.js:14 |
| GET | /api/courses/:param | callApi | client/liff/src/api/courses.js:16 |
| POST | /api/courses/:param/cancel | callApi | client/liff/src/api/courses.js:25 |
| POST | /api/courses/:param/payment-proof | callApi | client/liff/src/api/courses.js:21 |
| GET | /api/courses/base-price | callApi | client/liff/src/api/courses.js:6 |
| GET | /api/courses/lessons | callApi | client/liff/src/api/lessons.js:4 |
| GET | /api/courses/mine | callApi | client/liff/src/api/courses.js:12 |
| GET | /api/courses/types | callApi | client/liff/src/api/courseTypes.js:13 |
| POST | /api/enrollments | callApi | client/liff/src/api/enrollments.js:6 |
| GET | /api/evaluations/:param | callApi | client/liff/src/api/learn.js:50 |
| POST | /api/evaluations/:param/submit | callApi | client/liff/src/api/learn.js:52 |
| GET | /api/evaluations/mine | callApi | client/liff/src/api/learn.js:49 |
| POST | /api/group-orders | callApi | client/liff/src/api/groupOrders.js:7 |
| GET | /api/group-orders/:param | callApi | client/liff/src/api/groupOrders.js:15 |
| POST | /api/group-orders/:param/cancel | callApi | client/liff/src/api/groupOrders.js:54 |
| POST | /api/group-orders/:param/my-proof | callApi | client/liff/src/api/groupOrders.js:43 |
| POST | /api/group-orders/:param/submit | callApi | client/liff/src/api/groupOrders.js:49 |
| GET | /api/group-orders/by-token/:param | callApi | client/liff/src/api/groupOrders.js:18 |
| POST | /api/group-orders/by-token/:param/join | callApi | client/liff/src/api/groupOrders.js:26 |
| POST | /api/group-orders/by-token/:param/lookup-phone | callApi | client/liff/src/api/groupOrders.js:22 |
| DELETE | /api/group-orders/draft | callApi | client/liff/src/api/groupOrders.js:38 |
| GET | /api/group-orders/draft | callApi | client/liff/src/api/groupOrders.js:32 |
| PUT | /api/group-orders/draft | callApi | client/liff/src/api/groupOrders.js:35 |
| GET | /api/group-orders/mine | callApi | client/liff/src/api/groupOrders.js:12 |
| GET | /api/learn/history/:param | callApi | client/liff/src/api/learn.js:44 |
| POST | /api/learn/personal-tags | callApi | client/liff/src/api/learn.js:29 |
| DELETE | /api/learn/personal-tags/:param | callApi | client/liff/src/api/learn.js:31 |
| GET | /api/learn/plans/:param | callApi | client/liff/src/api/learn.js:8 |
| PUT | /api/learn/plans/:param | callApi | client/liff/src/api/learn.js:10 |
| POST | /api/learn/plans/:param/publish | callApi | client/liff/src/api/learn.js:12 |
| GET | /api/learn/records/by-session/:param | callApi | client/liff/src/api/learn.js:16 |
| PUT | /api/learn/records/by-session/:param | callApi | client/liff/src/api/learn.js:18 |
| GET | /api/learn/records/by-session/:param/copy-prev | callApi | client/liff/src/api/learn.js:22 |
| POST | /api/learn/records/by-session/:param/submit | callApi | client/liff/src/api/learn.js:20 |
| GET | /api/learn/records/by-session/:param/versions | callApi | client/liff/src/api/learn.js:24 |
| GET | /api/learn/tags | callApi | client/liff/src/api/learn.js:27 |
| POST | /api/learn/uploads | callApi | client/liff/src/api/learn.js:36 |
| POST | /api/parents | callApi | client/liff/src/api/parents.js:6 |
| GET | /api/parents/me | callApi | client/liff/src/api/parents.js:8 |
| PATCH | /api/parents/me | callApi | client/liff/src/api/parents.js:10 |
| POST | /api/parents/me/students | callApi | client/liff/src/api/parents.js:12 |
| PATCH | /api/parents/me/students/:param | callApi | client/liff/src/api/parents.js:14 |
| POST | /api/parents/me/sync | callApi | client/liff/src/api/parents.js:18 |
| GET | /api/promotions | callApi | client/liff/src/api/promotions.js:5 |
| POST | /api/promotions/preview | callApi | client/liff/src/api/promotions.js:7 |
| POST | /api/referrals | callApi | client/liff/src/api/referrals.js:8 |
| GET | /api/referrals/by-token/:param | callApi | client/liff/src/api/referrals.js:13 |
| GET | /api/referrals/mine | callApi | client/liff/src/api/referrals.js:15 |
| GET | /api/sessions/:param | callApi | client/liff/src/api/sessions.js:13 |
| POST | /api/sessions/:param/checkins | callApi | client/liff/src/api/sessions.js:16 |
| GET | /api/sessions/coach/:param/today | callApi | client/liff/src/api/sessions.js:6 |
| GET | /api/sessions/coach/:param/week | callApi | client/liff/src/api/sessions.js:9 |
| POST | /api/slots | callApi | client/liff/src/api/slots.js:11 |
| DELETE | /api/slots/:param | callApi | client/liff/src/api/slots.js:23 |
| PATCH | /api/slots/:param/block | callApi | client/liff/src/api/slots.js:17 |
| POST | /api/slots/:param/book | callApi | client/liff/src/api/slots.js:34 |
| PATCH | /api/slots/:param/unblock | callApi | client/liff/src/api/slots.js:20 |
| POST | /api/slots/batch | callApi | client/liff/src/api/slots.js:14 |
| GET | /api/slots/coach/:param | callApi | client/liff/src/api/slots.js:7 |
| GET | /api/slots/period/:param | callApi | client/liff/src/api/slots.js:30 |
| POST | /api/slots/preview-conflict | callApi | client/liff/src/api/slots.js:26 |
| POST | /api/transfers | callApi | client/liff/src/api/transfers.js:6 |
| GET | /api/transfers/mine | callApi | client/liff/src/api/transfers.js:4 |
| POST | /api/uploads/payment-proof | callApi | client/liff/src/api/enrollments.js:12 |
| GET | /api/venues | callApi | client/liff/src/api/venues.js:5 |
| GET | /api/venues/:param | callApi | client/liff/src/api/venues.js:6 |
