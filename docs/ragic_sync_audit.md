# Ragic Sync Audit — Phase 1 Diagnosis (2026-07-08)

## 0. Scope and method

Read-only diagnosis, per the fix brief's Phase 1 instruction ("先做診斷，不准直接亂改"). No code was
changed while producing this document.

Covered in full: `server/services/ragic.js`, `server/config/ragicSchema.js`,
`server/services/ragicFreshness.js`, `server/services/ragicWriter.js`, `server/services/ragicAdmin.js`
(all 3960 lines), `server/services/parentSync.js`, `server/services/parentRefresh.js`,
`server/services/ragicWriteback.js`, `server/cron/index.js`, `server/cron/lock.js`,
`server/routes/admin/ragicStatus.js`, `server/routes/admin/ragicStaging.js`,
`server/routes/admin/ragicZ03.js`, `server/routes/ragicWebhook.js`, `server/routes/admin/staff.js`,
`server/routes/admin/venues.js`, `server/routes/auth.js` (Ragic-touching sections),
`server/scripts/ragic-auth-smoke.js`, all 5 `tests/ragic_*_test.js` files, `tests/perf/ragic_concurrency.js`,
`server/bootstrap/coreSchema.js` (Ragic tables), and the project's own prior investigation docs
`docs/ragic-recon-investigation-20260707.md` and `docs/ragic-freshness-canary-20260707.md`.

**This is not a greenfield system.** On 2026-07-07 (one day before this audit) the team ran its own
read-only investigation, decided a data-authority matrix, and shipped a real rearchitecture: per-form
shadow tables (`ragic_h01_shadow`/`ragic_h05_shadow`/`ragic_z01_shadow`/`ragic_h23_shadow`), a
write-read freshness-canary proof, a staging/admin-approval workflow (`ragic_staging_changes`), and
per-record error isolation for several (not all) sync loops. Several things this fix brief assumes are
missing are **already implemented** — see §5. The brief's own numbered problems (嫌疑1–6) are also
already triaged in the prior doc; this audit does not re-litigate those, only reconciles them against
current `HEAD` and adds what's new.

## 1. Root-cause ranking for the reported 224,509ms H01_STAFF sync + stale_read

Ranked by evidence strength, most to least likely:

**#1 — The freshness-canary retry loop re-fetches the ENTIRE paginated snapshot on every retry, not just the canary record.**
`server/services/ragicFreshness.js:206-230` (`runCanaryWriteReadProof`): on a stale canary read it retries
up to `RAGIC_FRESHNESS_RETRIES` (default 5, line 58) times with exponential backoff
`backoffMs * 2^(retries-1)` (`RAGIC_FRESHNESS_BACKOFF_MS` default 1000ms, line 59 → 1s/2s/4s/8s/16s ≈ 31s
of sleep alone), and **each retry calls `fetchSnapshot()` again** (line 222-228), which for H01 re-runs
`queryAllPagedWithIntegrity` from offset 0 (`ragic.js:240-260`) — a full re-page of the table, plus a
boundary-mismatch recheck GET. Worst case: 1 initial + 5 retries = **up to 6 full paginated H01 fetches**,
each bound by the 60s axios timeout, plus 31s of backoff sleep, before giving up and returning
`stale_read: true`. This composes very plausibly to the reported 224,509ms and directly explains the
`stale_read` symptom. This mechanism was added yesterday (`docs/ragic-freshness-canary-20260707.md`) —
it is very likely the actual regression, not the pre-existing pagination/auth/timeout config.
**Same mechanism is worse for Z01**: `getAllParentsWithIntegrityAndFreshness` passes `concurrency=3`
(`ragic.js:448-449`), so each of those up-to-6 full-snapshot re-fetches internally fans out 3 concurrent
GETs (`ragic.js:247-249` `Promise.all`).

**#2 — This is very unlikely to be a raw Ragic-API-limits problem for H01 specifically.** H01 is ~262
records — well under the 1000/request default and the 200-per-page config here (2 pages). A prior fix
(comment at `ragicAdmin.js:825-829`, already shipped) diagnosed and fixed a **different** 78–116s H01
slowdown that turned out to be N+1 **local Postgres** queries per staff row (500+ sequential round trips),
not Ragic — that fix already dropped sync to sub-second for the reconcile step. The 224,509ms figure is
new and larger than that old bug ever produced, which is additional circumstantial evidence it's coming
from the freshness-canary layer added afterward, not from Ragic pagination itself.

**#3 — No naming=EID / listing=true / subtables=0 anywhere** (confirmed, zero occurrences across the
whole codebase). This adds real per-request payload weight (H01 full records including subtable
expansion) but is a known, already-triaged issue (嫌疑3 in the prior doc) with a large blast radius to fix
(see §8 decision 2) — it's a contributing-but-secondary factor, not the primary explanation for a
224-second single run.

**#4 — Global Ragic-account concurrency is not actually 1.** Confirmed concrete, dated violations (not
hypothetical): `server/cron/index.js:326-329` fires `syncStaffFromRagic()` and `syncVenuesFromRagic()`
**concurrently via `Promise.allSettled`, unconditionally, every 10 minutes** — a standing baseline of 2
simultaneous Ragic connections regardless of timing. Separately, the process runs on UTC (verified in
this sandbox; no `TZ` override anywhere in the repo), and the three nightly jobs pass an explicit
`{timezone:'Asia/Taipei'}` while the `*/10` H01/H05 dispatcher does not — so 00:30/01:30 Asia/Taipei
(16:30/17:30 UTC) land exactly on a `*/10` tick, meaning the H01/H05 dispatcher and the nightly
backup/pull job can legitimately fire in the same minute with **zero mutual exclusion**, since the
existing `_singleflight`/`_inflight` guard (`ragicAdmin.js:3391-3411`) dedupes only by job **name**
(`staff`≠`venues`≠`backup`≠`pull`), not globally. This wouldn't by itself produce 224s on a quiet system,
but under real concurrent load against Ragic's account-level GET queue (max 50, and Ragic's own guidance
to wait for one response before sending the next) it compounds #1's effect.

## 2. Call-site inventory

Legend: `qp`=APIKey query param (this codebase's only working auth — see §8 decision 1). All rows
confirmed `qp` unless noted. "Hot path" = runs synchronously inside an HTTP request/response cycle.

| # | File:Function | Method→Target | limit/offset | listing/subtables/naming | Timeout | Hot path? | Concurrent? | Errors classified? | Retry? | Run/offset tracked? |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | ragic.js `query()` (core) | GET any | n/a | no/no/no | 60s (`RAGIC_TIMEOUT_MS`) | depends on caller | no | yes (`_normalizeRagicError`) | **no** | no |
| 2 | ragic.js `queryAllPaged` | GET paged | yes | no/no/no | 60s/call | depends on caller | **yes**, `Promise.all` over `concurrency` offsets (default 1, Z01=3) | yes | no | no (restarts at offset 0 every call) |
| 3 | ragic.js `queryAllPagedWithIntegrity` | GET paged + boundary recheck | yes | no/no/no | 60s/call | depends on caller | same as #2 | yes | no | no |
| 4 | ragicFreshness.js `runCanaryWriteReadProof` | write nonce + read loop | n/a | no/no/no | 60s/call ×N | depends on caller | re-invokes #2/#3 concurrently on Z01 | yes | **yes — up to 5×, but re-fetches whole snapshot each time (see §1 #1)** | no |
| 5 | ragicAdmin.js `_shadowPullH01Impl`/`_shadowPullH05Impl`/`_shadowPullH23Impl`/`_shadowPullZ01Impl` | GET full snapshot → shadow table | yes | no/no/no | 60s×N (via #4) | no (cron/background) | H01/H05/H23 concurrency=1; Z01=3 | yes | via #4 | partial — row-count integrity check per run, no cross-run resume |
| 6 | ragicAdmin.js `_reconcileH01FromShadowImpl` | DB-only (reads shadow table) | n/a | n/a | n/a | no | no | yes, **per-record try/catch (fixed)** | n/a | n/a |
| 7 | ragicAdmin.js `_reconcileH05FromShadowImpl` | DB-only | n/a | n/a | n/a | no | no | yes, per-record (fixed) | n/a | n/a |
| 8 | ragicAdmin.js `_reconcileZ01FromShadowImpl` | DB-only | n/a | n/a | n/a | no | no | yes, per-record | n/a | n/a |
| 9 | ragicAdmin.js `_reconcileH23FromShadowImpl` | DB-only | n/a | n/a | n/a | no | no | **NO — whole-loop single BEGIN/COMMIT, see §4.2** | n/a | n/a |
| 10 | ragicAdmin.js `_runWithLog`/`_logSyncResult` | dispatcher wrapping #5+reconcile | n/a | n/a | n/a | **yes**, for 2 legacy routes (§4.3) | no | **NO — outer collapse-on-throw, see §4.1** | no | writes `ragic_sync_log` (per-job, no cross-entity run id, no page granularity) |
| 11 | cron/index.js `*/10` H01+H05 dispatcher | dispatch #5×2 | n/a | n/a | n/a | no | **yes — `Promise.allSettled`, unconditional, see §1 #4** | n/a | n/a | n/a |
| 12 | `routes/admin/ragicStatus.js` `POST /sync` | dispatch jobs | n/a | n/a | n/a | **no — fire-and-forget 202 + `setImmediate`, sequential** | no (deliberately sequential) | yes | n/a | reads `ragic_sync_log` |
| 13 | `routes/admin/ragicStatus.js` `GET /` → `getLiveRagicProbeSnapshot` | GET×5 (probe) | limit=1 | no/no/no | 60s | **yes, polled every 5s by admin UI** | **yes — `Promise.all` of 5 forms**, no singleflight | yes | no | n/a |
| 14 | `routes/admin/staff.js` `POST /sync` | full H01 sync | via #5 | via #5 | 60s×N | **yes — blocks response, legacy route** | no | via #10 | no | via #10 |
| 15 | `routes/admin/venues.js` `POST /sync` | full H05 sync | via #5 | via #5 | 60s×N | **yes — blocks response, legacy route** | no | via #10 | no | via #10 |
| 16 | `routes/admin/ragicStaging.js` approve/merge | single-record re-verify | n/a | no | 60s | **yes — inside open DB txn + `FOR UPDATE` row lock** | no | yes | no | n/a |
| 17 | `routes/admin/ragicStaging.js` bulk-approve | N× single-record | n/a | no | 60s×N, unbounded | **yes, O(N×60s), no batch cap** | no (sequential, correctly isolated per-id) | yes | no | n/a |
| 18 | `routes/ragicWebhook.js` `POST /:sheetCode` | N× single-record GET | n/a | no | 60s×N | **yes — not fire-and-forget, unbounded N** | no (sequential, correctly isolated) | yes | no | logs to `ragic_webhook_log` |
| 19 | `routes/admin/ragicZ03.js` `PATCH /:id/draft` | 1 + 2×students + 2 refresh | n/a | no | 60s×N | **yes** | no | yes (504 on timeout) | no | n/a |
| 20 | `routes/admin/ragicZ03.js` `PATCH /:id` | 1 write | n/a | no | 60s | yes | no | **no — generic 400 always, inconsistent with sibling route** | no | n/a |
| 21 | `parentRefresh.js` `refreshParentMirrorFromRagic` | 2-3 single-page GETs | no | no | 60s×2-3 | **yes — awaited in auth.js login/bind/register** | no | yes | no | n/a |
| 22 | `ragicWriteback.js` `scheduleWriteback` | 3-10 seq. round trips/item | no | no | 60s×N | **no — true fire-and-forget, not awaited by any of its 5 callers** | no (sequential) | yes | no | **no — only implicit `last_synced_at=NULL` + next 00:30 cron, no attempt-count/retry table** |
| 23 | `ragicAdmin.js` `diffVenuesFromRagic` / `applyVenueSync` | full H05 snapshot ×2 independently | yes | no | 60s×N ×2 | yes | via #4 | yes | via #4 | **applyVenueSync re-fetches instead of reusing diff's snapshot — TOCTOU, see §4.4** |
| 24 | `ragicAdmin.js` `_backupParentsStudentsImpl` | up to ~400 sequential writes | n/a | n/a | 60s×N | no (cron; unclear if any route awaits it) | no | yes, per-record | no | `BACKUP_BATCH_LIMIT=200` caps per run |
| 25 | `server/scripts/ragic-auth-smoke.js` | 2 reads (unconditional) + 1 write (env-gated) | no | no | 60s | n/a (CLI) | no | yes | no | n/a |

## 3. Confirmed bugs — genuinely new, not in the 2026-07-07 investigation doc

1. **`_reconcileH23FromShadowImpl` can report a false-positive nonzero `synced` count.** (`ragicAdmin.js:684-763`)
   Wraps its whole per-row loop in one `BEGIN`/`COMMIT`. On a mid-loop error it `ROLLBACK`s (undoing every
   `UPDATE`) but still returns `{synced: updated, ...}` using the pre-rollback in-memory counter — worse
   than collapsing to 0, it reports success that didn't happen. Same shape bug in `_shadowPullZ01Impl`
   (`ragicAdmin.js:2264-2295`, `synced` counted before a rollback). This is the same *class* as the
   already-confirmed 嫌疑4, but is a distinct instance the prior doc didn't catch (it only flagged
   `_syncStaffImpl`/`_syncVenuesImpl`, both of which are **already fixed**).

2. **`_runWithLog` has its own outer collapse-on-throw** (`ragicAdmin.js:3369-3389`, `synced:0` on any
   `impl()` throw), one layer above the per-record fixes in #1 — if a shadow-pull's freshness/integrity
   gate throws before reaching any per-record loop, this is the layer that actually reports the failure,
   and it's fine for that case, but it means the "run log" telemetry model is still fundamentally
   per-job, single-attempt, no cross-entity grouping (see §3 answer under `_runWithLog` finding).

3. **Two legacy admin endpoints still block the HTTP response on a full synchronous Ragic sync**:
   `POST /api/admin/staff/sync` (`routes/admin/staff.js:580-589`) and `POST /api/admin/venues/sync`
   (`routes/admin/venues.js:67-77`) — both `await syncStaffFromRagic('manual')` /
   `syncVenuesFromRagic('manual')` directly. The codebase has **already built and adopted** the correct
   fire-and-forget pattern elsewhere (`POST /api/admin/ragic-status/sync` — 202 + `setImmediate`); these
   two older routes were never migrated to it. Given §1's freshness-retry worst case, these can run long
   enough to exceed typical reverse-proxy/browser timeouts even when the sync eventually succeeds
   server-side.

4. **`GET /api/admin/ragic-status` (polled every 5s by the admin UI) synchronously blocks on 5 concurrent
   live Ragic probes** (`getLiveRagicProbeSnapshot`, `ragicAdmin.js:3425-3477`, `Promise.all` over
   H01/H23/H05/Z01/Z02) on cache miss (60s TTL), with no singleflight — concurrent admin tabs each
   independently trigger their own 5-way fan-out right as the cache goes stale.

5. **`applyVenueSync` independently re-fetches the full H05 snapshot instead of reusing `diffVenuesFromRagic`'s
   already-fetched one** (`ragicAdmin.js:3766-3904` vs `3718-3759`) — doubles the expensive freshness-retry
   cost for one admin preview→confirm click, and opens a TOCTOU window where the values actually written
   can differ from what the admin reviewed (flagged PLAUSIBLE, not fully proven against live timing).

6. **`cron/lock.js`'s DB-backed `job_locks`/`runWithLock` — purpose-built as the global serialization
   layer for exactly this concurrency problem — is entirely disconnected from the live scheduler.**
   `server/cron/index.js` never `require`s it; the described `ENABLE_CRON` gate and
   `POST /api/internal/jobs/:name/run` endpoint don't exist anywhere in the routes. This mechanism should
   very likely be reused for Phase 3 rather than building a parallel one.

7. **PII logged in plaintext**, inconsistent with this codebase's own stated redaction discipline
   (`parentSync.js:681` doc-comment: "嚴禁落地完整 PII"): raw phone numbers at `parentSync.js:314,319`,
   `parentRefresh.js:193-195,219-224`; raw student/parent names at `parentSync.js:472,482`; raw
   phone/name at `ragic.js:1065,1068,1095,1119-1121,1179,1181` (fires on nearly every login and every
   admin-triggered writeback); raw Postgres constraint-violation `err.detail` (can embed the offending
   value) at `ragicAdmin.js:2094,2123,2438`. This must be fixed as part of any Phase 2+ work per the
   brief's own hard limit on PII in logs.

8. **Webhook auth has an environment-dependent open door**: `ragicWebhook.js` `_authorized()` returns
   `true` for any request whenever `RAGIC_WEBHOOK_SECRET` is unset **and** `NODE_ENV !== 'production'` —
   i.e., no authentication at all in any non-production environment with no secret configured. Also, the
   secret comparison (`got === secret`) is not constant-time.

9. **Two independent in-process "job already running" guards** for the same job keys: `_kickoff`'s
   `_runningJobs`/`_lastKickoff` (`ragicAdmin.js:~1956-1971`) layered on top of `_singleflight`'s
   `_inflight` Map (`ragicAdmin.js:3391-3411`). Not observed to conflict, but not single-sourced —
   candidate for consolidation in Phase 3.

10. **Two Z03 routes classify errors inconsistently**: `PATCH /:id/draft` maps `RAGIC_TIMEOUT`→504;
    the sibling `PATCH /:id` (`resolveZ03Record`) always returns a generic 400 regardless of `err.code`.

## 4. Already fixed / already correct — do not re-implement

The fix brief assumes several things are broken that are, as of `HEAD`, already fixed. Re-doing these
would be wasted work or could reintroduce regressions:

- **Independent `is_coach`/`is_counter`/`is_lifeguard`.** Already computed independently
  (`ragicAdmin.js:906-908,991-993`) and stored as separate DB columns (not derived from the single
  `role` enum). The exact "S001 小林" case the brief cites by name is referenced in the code's own fix
  comment (`ragicAdmin.js:1046-1049`, labeled "A0 修法") as the bug this already fixed.
- **H23-unmatched-staff as a warning, not a failure.** `_reconcileH23FromShadowImpl` already returns
  `unmatched_staff_warning` + `unmatched_staff_warning_samples` (first 10) without failing the run
  (`ragicAdmin.js:756-762`). Gap: samples currently carry `ragic_record_id, shadow_key, emp_id, name,
  reason` — not quite the brief's exact requested field set (`employee_no, name, normalized_name, phone,
  source_form, reason`); this is a small field-list extension, not new logic. It's also currently
  one-directional (H23-row-has-no-matching-staff); there's no explicit surfaced warning for the reverse
  case (H01 staff exists, no H23 row ever matches them, multiplier silently stays at its last value) —
  worth adding.
- **Per-record error isolation** already exists for H01 staff (`_reconcileH01FromShadowImpl`), H05 venues
  (`_reconcileH05FromShadowImpl`), Z01/Z02 (`_reconcileZ01FromShadowImpl`), backup
  (`_backupParentsStudentsImpl`), and the webhook handler — all with per-record try/catch and (where
  relevant) per-record transactions, explicitly citing "嫌疑4 CONFIRMED 修復" in comments. Only H23's
  reconcile still has the old shape (§3.1).
- **`parents` DO have a `preservePending` guard**, symmetric with the one `students` has
  (`parentSync.js:178-294`, both UPSERT branches). The 2026-07-07 doc's "students have it, parents
  don't" claim (嫌疑6) predates a Jul 3 commit (`17c1476`) that already added it — the investigation doc
  is stale on this specific point and should be corrected/annotated, not re-fixed.
- **Field-ID-only enforcement on the write path.** `ragicWriter.js` already rejects any payload key that
  isn't a numeric Field ID (`_validatePayload`), rejects blocklisted fields, and validates LINE UID shape —
  covered by `tests/ragic_writer_test.js`. The brief's "field mapping must come from ragicSchema, not
  hardcoded Chinese names" requirement is already true for writes; it's only the **read** path that's
  Chinese-name-primary (§1 #3, tracked as an open decision, not a silent gap).
- **Manual "sync all" is already sequential, not `Promise.all`**, specifically to avoid parallel
  full-table Ragic hits (`routes/admin/ragicStatus.js:100-103`, explicit comment) — the team already
  reasoned about and designed around exactly this risk in that one route (just not in `cron/index.js`'s
  H01+H05 dispatcher, §1 #4).
- **`ragicWriteback.js` has no `setTimeout`** — it's an immediately-invoked async function, not a delayed
  fire-and-forget. It is nonetheless still effectively un-recoverable-with-attempt-tracking (§2 row 22) —
  the brief's underlying concern (no durable retry job) is valid, just not for the literal reason stated.

## 5. Test coverage already in place (for Phase 6 planning — do not duplicate)

No root `package.json`, no jest/mocha anywhere in the repo. All 5 `tests/ragic_*_test.js` files plus
`tests/perf/ragic_concurrency.js` are plain Node scripts using the built-in `assert` module, each run
individually: `node tests/ragic_data_no_visibility_test.js`, `node tests/ragic_freshness_test.js`,
`node tests/ragic_h01_line_uid_test.js`, `node tests/ragic_h23_coefficient_test.js`,
`node tests/ragic_writer_test.js`, `node tests/perf/ragic_concurrency.js`. `tests/README.md` is stale —
documents only `e2e/`+`perf/`, never mentions the 5 root-level Ragic tests (added Jul 6-7).

Already covered: PII redaction in staging DTOs/route outputs and H01 shadow ingestion
(`ragic_data_no_visibility_test.js`); canary write-read-proof round-trip/stale-abort/isolation
(`ragic_freshness_test.js` — **but does not assert fetchSnapshot call count during retries**, a real gap
given §1's root-cause hypothesis); H01 LINE UID field-ID-preferred + shape validation
(`ragic_h01_line_uid_test.js`); H23 coefficient field-ID-preferred + fallback
(`ragic_h23_coefficient_test.js`); write-path field-ID-only/URL-residue/blocklist enforcement via DI stubs,
no live HTTP (`ragic_writer_test.js`); in-process cache hit-rate under concurrent hot reads, no live Ragic
(`ragic_concurrency.js`, predates the 2026-07-07 shadow-table architecture, doesn't exercise it).

## 6. Open decisions requiring explicit sign-off before Phase 2–6 implementation

Mirroring this project's own existing practice of gating architecture changes on explicit decision-maker
confirmation (see "待 Chumg 決策" in `docs/ragic-recon-investigation-20260707.md`):

1. **Auth mechanism.** This codebase uses `APIKey=` as a URL query parameter, with a code comment stating
   `Authorization: Basic`/Bearer headers were tested and rejected by this Ragic account (guest error code
   106). The fix brief's "official rule" says Basic-auth header. **I will not switch this without your
   explicit confirmation** — flipping it incorrectly would break 100% of Ragic access, which is strictly
   worse than the current slowness. If you want it verified against live Ragic, that needs to happen via
   the smoke script against a non-production account, not a blind code change.
2. **`naming=EID` adoption.** Would fix the real "嫌疑3" display-name-fragility risk, but requires
   rewriting every Chinese-key read across `mapZ01Parent`, `parseZ01Students`, `mapZ02Student`,
   `_staffPayloadFromRagicRow`, `_mapRagicVenue`, and more (call sites enumerated in §2/§3) — large blast
   radius touching the core of the read path. Need your go-ahead on scope before I touch this.
3. **`listing=true` for full-sync reads.** Deliberately NOT used today (yesterday's freshness doc notes
   this explicitly) — `listing=true` only returns fields configured on Ragic's "Listing Page," which may
   not include everything the mappers need. I can't verify Ragic's current listing-page field config from
   code; enabling it needs either your confirmation the listing page has full field coverage, or a live
   check.
4. **Freshness-canary retry redesign** (the §1 root cause). The fix should very likely be: on a stale
   canary, re-check only the canary record (cheap single GET) and only re-run the full snapshot fetch
   once the canary is confirmed fresh — not re-fetch the whole snapshot on every retry. This changes the
   `runCanaryWriteReadProof` contract that was deliberately designed yesterday; I'd like confirmation this
   redesign direction is right before changing it.
5. **Reuse vs. rebuild for Phase 3.** Given `ragic_sync_log` + shadow tables + `ragic_staging_changes` +
   `job_locks`/`cron/lock.js` already exist (the last one unused), Phase 3 should extend these (add a
   cross-entity run id, add page-level rows, wire up the already-built `job_locks`) rather than create a
   parallel `ragic_sync_runs`/`ragic_sync_pages` schema from scratch. Confirming this reuse direction
   before I write migrations.
6. **`cron/index.js`'s concurrent H01+H05 dispatch** (§1 #4) — change to sequential (matching
   `ragicStatus.js`'s already-correct pattern) as part of Phase 3, or fold into the same global GET queue
   Phase 2 builds? Either works; want to confirm before choosing.
