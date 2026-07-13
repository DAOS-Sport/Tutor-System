# Release Handover — 2026-07-12

## Status at pause

- **State:** `PAUSED_NOT_PUBLISHED`
- **Working branch:** `feat/upload-counts-revive-sessions`
- **Last committed baseline:** `94ca71b42a4fd8635a73733afa71fb1ecf04dbc8`
- **Rollback tag already created:** `pre-release-20260712-1048`
- **Production URL observed before work:** `https://daos-tutoring-courses.replit.app`
- **Observed production health build before work:** `57c6964` (not this worktree)
- **Current worktree:** intentionally dirty and **not committed**. Do not use `git reset`, `git checkout --`, or discard changes.

No production migration, deployment, push, or publish was performed. The local workspace database is `helium:5432/heliumdb`; it is a development/test target, not evidence of a production migration.

## What has been implemented in the uncommitted worktree

These changes are present but are not release-approved yet:

1. **F-M02 venue scope / cancellation**
   - Unified manager/staff multi-venue handling through `venue_ids` and shared admin authorization helpers.
   - Checkout list/detail/reconcile/cancel reject a checkout containing any out-of-scope child order.
   - The list returns stable child-level `venue_id`, `venue_name`, and aggregated `venues`.
   - F-M02 UI has venue filters, desktop/mobile venue badges, required cancellation reason, and only removes an item after API success.
   - Reconcile audit now derives the actor from JWT; it no longer accepts a client-supplied `by` value.

2. **Group proof / card UI**
   - Group proof handling separates member/group proof data, preserves omitted existing values, validates proof inputs, and locks member updates to avoid overwrite races.
   - Group cards now have visible normal/hover/selected/disabled/error borders.

3. **LINE bind compatibility**
   - `/liff/bind` is a real compatibility page.
   - Legacy callback aliases discard callback query data and redirect safely to the LIFF bind entry with no-store/no-referrer headers.
   - Existing UID → phone → student-claim flow remains the authentication path; full UID/token logging was reduced.

4. **Trial / on-site payment (partially complete)**
   - Added `order_kind=trial` and `payment_method=on_site` contract, server-side trial price calculation, pending-payment state, and front-end on-site checkout display.
   - Trial reconciliation opens one session instead of the normal six.
   - **Not yet release-ready:** request-id enforcement and early idempotency lookup must still be added before referral/promotion side effects (see blockers).

5. **Canonical `待分配` coach**
   - Added a canonical placeholder service (`__SYSTEM_UNASSIGNED_COACH__`) that upserts idempotently without deleting/merging legacy records.
   - Placeholder is excluded from coach counts, reports, commissions/evaluations, public introductions, and referrals.

6. **Manual deduction (in progress; not release-approved)**
   - Added `/api/admin/manual-deductions`, sidebar and route.
   - Uses transactions, idempotency ledger, course session, check-in record, enrollment audit, venue authorization, and shared-period fail-closed guard.
   - Newer changes also align capacity with non-cancelled scheduled sessions and the slot-booking coach advisory lock.
   - **Not yet integration-tested after the latest changes.**

7. **Startup/storage hardening**
   - Server startup was changed to finish admin/core schema bootstrap before opening the listening port, so health should not go green before schema is ready.
   - Frontend build script installs dev dependencies explicitly.
   - Production storage selection was improved, but the Replit proof-existence issue below still needs fixing.

## Database work

New migration: `db/migrations/021_release_ops_hardening.sql`

- It is intended to be additive, backward-compatible, and idempotent.
- It was preflighted inside `BEGIN ... ROLLBACK` successfully on `heliumdb`.
- It was also applied once to the local development/test database to enable local route testing.
- It was **not** applied to production.
- Do **not** use the existing `npm run db:migrate` blindly in production: `db/migrate.js` replays all SQL files and is not a safe production migration runner.

## Evidence collected so far

Passed:

```bash
git diff --check
node --check server/routes/admin/manualDeductions.js
node --check server/routes/admin/enrollments.js
node --check server/routes/admin/checkouts.js
node --check server/index.js
node --check server/services/objectStorage.js
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c 'BEGIN;' -f db/migrations/021_release_ops_hardening.sql -c 'ROLLBACK;'
NODE_PATH=server/node_modules node tests/e2e/admin_checkout_scope_cancel.js
```

The F-M02 E2E test passed all of these concrete cases with isolated rows that it cleaned up:

- anonymous and non-backoffice rejection;
- one-venue staff scope;
- three/multi-venue staff and scoped manager scope;
- admin cross-venue visibility;
- URL/query venue tampering;
- cancel reason/audit/original status;
- no pending-list removal until cancellation succeeds;
- duplicate cancel rejection.

Not yet run after the current worktree changes:

- full E2E suite;
- manual deduction integration test;
- trial/on-site idempotency integration test;
- group proof persistence integration test;
- frontend builds after final source changes;
- production smoke test;
- lint/typecheck (the repository has no configured lint/typecheck scripts or TypeScript project).

## Release blockers still open

Do not publish until every item below is resolved and tested.

1. **Enrollment idempotency is incomplete.**
   `POST /api/enrollments` must require a request ID, take a parent/request advisory lock, and return an existing checkout before promotions/referrals are evaluated. Without it, a retry involving `TRIAL50` can be rejected after the first request advances the referral state, and a request without a key can duplicate an order.

2. **Replit proof validation is unsafe.**
   `server/services/objectStorage.js` currently treats a correctly shaped key as existing for the Replit driver. Convert existence verification to an async SDK `exists()` check and await it in enrollment, checkout, course proof, and group proof routes. Fail closed on lookup failure. Also add a production startup/deploy gate that rejects local storage when a Replit shared bucket is required.

3. **Manual deduction must be E2E tested after its latest locking/capacity changes.**
   Test normal success, same request retry, a fully reserved-but-unchecked period, shared/group period rejection, out-of-scope user, and concurrent slot booking versus deduction. Preserve the legacy `checked_in_by_student_id` compatibility field rather than altering its old NOT NULL constraint.

4. **Production group-period index must be verified.**
   Local schema has the required unique partial index:

   ```sql
   CREATE UNIQUE INDEX uq_course_periods_group_order
   ON course_periods (group_order_id, period_number)
   WHERE group_order_id IS NOT NULL;
   ```

   The worktree now avoids an index-inference 500 and emits a diagnosable 409 for an incompatible legacy single-column index. But production must be preflighted before release; do not drop/rebuild its legacy index under this task’s additive-only migration constraint.

5. **Actual release access is unavailable in this environment.**
   GitHub CLI is unauthenticated and no Replit deploy/production-log connector or credential was available. A source push is not proof of deployment. Keep the final release state `BLOCKED` unless production deployment, post-deploy health, logs, and smoke tests can be performed.

## Safe continuation order

1. Read this file and `PROMPT_NEXT_SESSION.md`, then inspect `git status --short` and `git diff --check`.
2. Finish blockers 1–4 with focused patches only; do not refactor unrelated code.
3. Add isolated DB E2E tests for trial/on-site and manual deduction, with `finally` cleanup.
4. Run pure tests, route tests, frontend builds, and the existing full E2E suite only against the development/test database.
5. Re-check migration SQL in a rollback transaction and run a production **read-only** schema/config preflight.
6. Commit intentionally, retain `pre-release-20260712-1048`, and only publish if real Replit deployment authority and production smoke/log access exist.

## Known operational constraints

- Do not call the global migration runner on production.
- Do not restore national-ID verification.
- Do not hard-delete orders, cancellation history, proofs, group members, or duplicate legacy coaches.
- Keep `is_coach`, `is_counter`, and `is_lifeguard` independent.
- Keep auth/venue/ownership decisions in the existing shared `adminAuth` / RequireAuth path.
