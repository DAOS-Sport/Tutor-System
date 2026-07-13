# Parent Identity Release-Candidate Evidence — 2026-07-13

Verdict: **READY_FOR_CANARY**. This is not approval for a full release. The deployed allowlist → 5% → 20% → 50% → 100% canary has not run.

## A. Frozen baseline regression evidence

- Live read-only reconciliation: `1096 fetched = 238 linked + 856 Z03 pending + 0 reconciliation pending + 2 manual review + 0 ignored + 0 retryable + 0 non-retryable`; `missing_source_count=0`; live/shadow source sets match exactly.
- Record 149 remains `PENDING_Z03`, exact field `1006846` is blank, and all 8 student rows remain classified. Chat URL/display text is not identity evidence.
- Existing local member login: zero Ragic calls, including Ragic-offline regression.
- Local-first commit precedes every Ragic write; outbox processing is post-commit and gated by `RAGIC_PARENT_OUTBOX` plus live schema freshness.
- Frozen suites passed: `parent_identity_closure_test` (4), `ragic_z01_z03_split_claim` (6), `parent_local_first_registration`, and `ragic_z03_tombstone_test`.

## B. Isolated release file list

- Source branch: `feat/upload-counts-revive-sessions`
- Base/previous stable commit: `6049880c29739c5e020fb37b23b28963865336e6`
- RC branch: `release/parent-identity-rc-hardening`
- Exact allowlist: `parent-identity-release-files.txt`
- Preserved and unstaged unrelated work: `excluded-unrelated-files.txt`
- No admin UI, coach/front-desk/staff auth, scheduling, attendance, deductions, payment/refund, course calculation, or entitlement code is in the allowlist. The two admin backend compatibility routes are limited to disabling destructive Z03 operations.

## C. Ragic schema freshness evidence

Final live `def=1` verification:

| Evidence | Actual |
|---|---|
| fetched_at | `2026-07-13T14:50:59.234Z` |
| endpoint | `https://ap7.ragic.com/xinsheng/general-information/6?api&def=1` |
| sheet path / id | `https://ap7.ragic.com/xinsheng/general-information/6` / `6` |
| HTTP | `200` |
| response SHA-256 | `89b5f55e0e32f3cdac6ac60edf9265dcb31de2414f6754fa290ab84dea3ed5b8` |
| field | `1006846` / `家教系統uid` |
| attributes | `noDup=true`, `must=false`, `ro=false` |
| schema version | unavailable from Ragic (`null`); exact definition and response metadata retained |
| correlation id | `933b7de7-6067-4233-ab14-ea9be6252064` |
| TTL expiry | `2026-07-13T15:05:59.234Z` (15 minutes) |

Verification runs at worker startup, every five minutes, and by the deployment command `NODE_PATH=./server/node_modules node scripts/verify-ragic-z01-uid-schema.js`. Missing/wrong/non-unique/read-only/stale schema returns `RAGIC_SCHEMA_NOT_VERIFIED` and pauses remote writes only. It never falls back to another field or blocks local login.

## D. ACCOUNT_RECOVERY state machine

```text
ACCOUNT_RECOVERY_REQUIRED
  -> ACCOUNT_RECOVERY_VERIFYING
  -> ACCOUNT_RECOVERY_VERIFIED
  -> ACCOUNT_REBIND_PENDING
  -> ACCOUNT_REBOUND (local transaction committed)
  -> ACCOUNT_REBIND_SYNC_PENDING / SYNCED (claim + audit sync state)

invalid/expired/excessive attempts -> REQUIRED or ACCOUNT_RECOVERY_LOCKED
identity/source/concurrency revalidation failure -> full rebind rollback
                                              -> ACCOUNT_RECOVERY_FAILED audit transaction
```

No OTP provider exists in the project, so no OTP was invented. Completion is admin-only and requires the short-lived parent recovery token, reviewer, reason, and evidence reference. Defaults are 15-minute TTL, five attempts, and five new requests per phone per hour. The token is hash-stored, checked on replay, and cannot perform a second mutation.

The successful transaction locks the canonical parent and old/new UID hashes; rechecks phone, exact student, Ragic source and new-UID uniqueness; replaces the old binding; compare-and-set updates the parent; writes the rebind audit and claim state; and enqueues one exact-record `PATCH` containing only field `1006846`. A failure rolls the whole mutation back, leaving the old UID active. Existing old JWTs naturally expire under the frozen JWT contract; the old UID cannot issue a new session after rebind.

## E. Source 6504 recovery trace

The production-like trace was read-only and stored no raw UID in logs:

- Source 6504 exists, is present in the latest pull, and is `TRUE_LINE_UID_PRESENT_WITH_CONFLICT / MANUAL_REVIEW`.
- One canonical parent candidate is proven; canonical `ragic_record_id=6504`.
- Ragic and local UID SHA-256 values differ, so direct overwrite is prohibited.
- Isolated `ZZ6504` regression entered through the active LIFF `/parent-bind-phone` API: the first call requested claim verification; exact phone+student evidence returned a short-lived recovery reference/code; unverified overwrite was blocked; changed identity caused full rollback plus FAILED audit; manual evidence verified; concurrent completions produced one commit and one idempotent replay; invalid post-commit replay was blocked; old binding became REPLACED; exactly one new ACTIVE binding remained; audit fields were complete; Ragic timeout retained local new-UID login; retry patched the same record once; duplicate delivery performed zero writes.

The live source 6504 record was not mutated during hardening or dry-run.

## F. Priority 4–6 implementation

| Priority | Decision rule | Safe no-decision behavior |
|---|---|---|
| 4 | Unique canonical student evidence from local student Ragic reference, student source link, Z03 source row, or persisted canonical-student mapping | Multiple sources pointing to the same student become aliases; names/national IDs/row order never select a source |
| 5 | Only an explicit Z01 registration link that resolves to the canonical group member | Discovered `group_orders`, `group_order_members`, `admin_enrollments`, external order and Ragic columns do not by themselves prove Z01 ownership; current live schema therefore returns `NO_EXPLICIT_Z01_REGISTRATION_REFERENCE` |
| 6 | Exactly one blank `1006846` candidate and every other source has audited `MERGED/INVALID_SOURCE/ARCHIVED/SUPERSEDED`, reason and timestamp | Any active/unclassified source returns `NO_DECISION` |

No winner persists all aliases against one canonical parent/student, creates no Ragic Z01, performs no remote UID write, and uses `DATA_RECONCILIATION_PENDING`. Enrollment/rights tables are not written by resolution.

## G. Source 6786 resolution trace

Live read-only state currently has one active source 6786; its persisted source link, exact current `1006846`, and canonical parent Ragic ID all agree, so Priority 1 already wins. Isolated `ZZ6786` fixtures prove Priority 4, Priority 5 safe `NO_DECISION`, Priority 6, and the no-winner alias/reconciliation paths without changing the live source.

## H–J. Test manifest, commands, outputs, concurrency and replay

- Manifest: `tests/release/parent_identity_release_manifest.json`
- Machine-readable results: `tests/release/evidence/parent_identity_release_results_2026-07-13.json`
- T01–T25: **25 PASS / 0 FAIL**. Each manifest row contains its own test ID, file, name, standalone command, expected result, actual result, and evidence key.
- Supplemental PASS: schema mismatch/stale/worker gate; account recovery rollback/replay/concurrency/rate-limit; source-claim concurrency; outbox non-retryable block and duplicate delivery; national-ID no-overwrite; no `passed_not_on_file`; no hard delete; no UID clearing; canary configuration.
- Database-backed tests exercise real PostgreSQL transactions, locks, unique constraints, rollback and outbox rows; transactions/constraints are not globally mocked.

## K. Rights before/after

Both hashes: `1af3a53f07124cbecf1ea34a78318cd51cfd7f0f5ebb59504162429233c4a714`.

| Table/metric | Before | After |
|---|---:|---:|
| course_periods rows / total / used / amount | `10 / 66 / 9 / 127555.00` | unchanged |
| course_period_enrollments rows | `3` | unchanged |
| group_orders / members | `3 / 3` | unchanged |
| admin_enrollments rows / total / used / amount | `139 / 96 / 26 / 1264596.00` | unchanged |

## L. Canary configuration

Configuration: `config/parent-identity-canary.json`.

Required flags preserve the existing fast path/local-first behavior, enable V2/outbox only for canary, and keep legacy/destructive/passed-not-on-file paths off. Phase 1 uses UID-hash/phone/source allowlists including 149, 6504 and 6786. Phase 2 requires explain → dry-run → local transaction → outbox → login validation → rights comparison for known complaints. Phase 3 applies only when local `line_uid` is not found and advances 5% → 20% → 50% → 100%. Existing-user login is never percentage-gated.

## M. Monitoring and rollback thresholds

Configuration: `config/parent-identity-monitoring.json`; read-only checker: `NODE_PATH=./server/node_modules node scripts/parent-identity-canary-status.js`.

Advance only after two consecutive 15-minute clean windows. Immediate application rollback/flag-off conditions are any existing-user Ragic call, login-rate drop, unexpected logout, hard delete, UID clearing, duplicate canonical parent, duplicate active UID, missing source, or unapproved rights delta. Outbox warns at 300 seconds and rolls back at 900 seconds; schema failure pauses only remote UID writes.

Final local DB status was `DB_INVARIANTS_PASS`: duplicate canonical phone `0`, duplicate active UID `0`, duplicate active source link `0`, and missing source `0`. Deployment telemetry must supply login-rate, Ragic-call, logout and rights-delta metrics during canary.

## N. Application rollback rehearsal

- Previous build: `6049880c29739c5e020fb37b23b28963865336e6`
- RC runtime fingerprint: `6049880c29739c5e020fb37b23b28963865336e6+b72ad77e9f2831c8`
- Rehearsed at: `2026-07-13T14:49:50.159Z`
- Actual sequence: add detached previous-build worktree; start RC auth harness; create existing/new local sessions and one pending outbox; start previous-build auth harness against the additive DB; validate both logins and pre-release token; verify old app leaves outbox untouched; restart RC; drain once; verify duplicate delivery performs no second write.
- Counts before / after rollback: parents `2/2`, students `2/2`, outbox `1/1`, source links `0/0`. After RC redeploy: links `1`, Ragic writes `1`.
- No destructive down migration, table drop, claim/source deletion, outbox clear, or UID clear occurred.

## O. Release diff summary

The release is restricted to parent LIFF login/registration, additive migrations 022–024, exact Z01/Z03 identity services, schema/outbox/recovery workers, narrow non-destructive Z03 backend compatibility routes, canary/monitoring scripts, and release tests/evidence. The final commit is staged strictly from `parent-identity-release-files.txt`; excluded dirty paths remain unstaged.

## P. Remaining risks

1. No deployed canary windows have run, so application telemetry thresholds are unproven in the target runtime.
2. Recovery uses the approved manual-review path because the project has no OTP provider; operational reviewer/evidence quality remains a human control.
3. Ragic schema evidence intentionally expires after 15 minutes. Startup/periodic verification must be healthy before enabling the outbox.
4. The repository's legacy `db/migrate.js` replays every historical SQL file and is not safe on an already-migrated database. This RC used the targeted additive command `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/024_parent_identity_release_hardening.sql`; the canary runbook must use the targeted/additive deployment path, not replay migration 001.
5. Test runs emit a non-failing `pg` deprecation warning for a pre-existing concurrent `client.query()` pattern; no test or transaction failed because of it.

## Q. Final verdict

**READY_FOR_CANARY**

`READY_FOR_FULL_RELEASE` is explicitly not granted. It requires completion of all configured canary stages with no rollback condition.
