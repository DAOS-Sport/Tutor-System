---
name: Demo-data teardown FK gotchas (DAOS schema)
description: Which FKs block deleting parents/coaches/students/periods, and the order/null-first steps a cleanup script must do.
---

# Cleanup-script FK hazards when deleting test entities

When writing a teardown that deletes test parents/coaches/students/periods, marker-scoping the deletes is not enough: **out-of-scope rows created during real testing** (reassignment, transfers, check-ins) hold RESTRICT / NO-ACTION FKs that abort the delete. Enumerate them up front with `pg_constraint` (filter `confdeltype` for `r`=RESTRICT and `a`=NO ACTION) rather than fixing errors one at a time.

Specific blockers in this schema:
- `course_sessions.availability_slot_id` ↔ `coach_availability_slots.booked_session_id` — **circular RESTRICT**. Set both cross-refs to NULL before deleting either side.
- `course_sessions.coach_id` (RESTRICT) — after a 換教練 reassignment a session can point at a test coach while its period belongs to someone else. NULL it before deleting coaches (queries use `COALESCE(cs.coach_id, cp.coach_id)`, so leaving it NULL is fine).
- `course_sessions.initiated_by_parent_id` (NO ACTION) — NULL it before deleting parents.
- `transfer_records` — RESTRICT on `from_parent_id`, `from_student_id`, `course_period_id`. Delete these rows early, before periods/students/parents.
- `checkin_records.student_id` (RESTRICT) — delete by student scope too, not only by test session.
- `students.parent_id` (RESTRICT) — delete students before parents.

**Why:** demo testing produces derived rows the seed never wrote; the teardown must cover them or it fails mid-transaction after the user has tested.

**How to apply:** wrap the whole teardown in one transaction; do NULL-the-cross-refs first, then delete leaf→root. Validate the full cycle on dev: cleanup → verify 0 → seed → verify exact counts → seed again → verify unchanged.

## Two more gotchas found while hardening
- `admin_enrollments` has **no FK** to parents/coaches/students for matching — it's denormalized (`parent_phone`, `parent_name`, `coach` are plain text). The live "家長報名" flow writes here, so teardown must marker-scope by those text columns (its `admin_enrollment_audit_logs` child cascades). Marker-scoping only by the normalized parents/coaches PKs misses it entirely.
- **Time-anchored seed rows are not idempotent under `ON CONFLICT (..., start_at)`**: re-running on a different day produces different `start_at`/`NOW()` values, so new rows accumulate. For demo data that must show "today", use **delete-then-insert** (scoped to the test coach/period, breaking the session↔slot circular ref first) instead of `ON CONFLICT DO NOTHING` — fixed row count every run AND re-anchors to the actual run day.
