---
name: Enrollment subsystems are separate
description: DAOS has two distinct enrollment-related data models that are NOT linked by FK.
---

DAOS has two separate subsystems that both relate to "a student taking lessons":

1. **`admin_enrollments`** — the reconciliation / back-office table (對帳流程). Created by
   the admin enrollment flow and by group-buy approval. Carries price, payment proof,
   status (`pending_payment` etc.), `group_order_id`, `is_group_shared`.
2. **`course_periods` + `course_sessions` + `session_records`** — the booking / scheduling
   subsystem coaches interact with (週/月排課, 授課記錄). `course_sessions` carries
   `student_names` and links to `course_periods` (coach_id, venue_id, course_type).

**Why:** They are NOT joined by a foreign key. Group-buy approval creates `admin_enrollments`
rows only — it does NOT create `course_periods`/`course_sessions`. So you cannot reliably
walk from a group order to its session records via `group_order_id`.

**How to apply:** When a feature needs "the class roster" for session records, read
`course_sessions.student_names` directly (e.g. coach record form for whole-class fill). Do
not try to derive class membership from `group_order_id` through the session tables.
