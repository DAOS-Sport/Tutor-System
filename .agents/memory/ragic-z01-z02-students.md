---
name: Ragic Z01/Z02 student writes
description: How to persist parents+students into Ragic during registration; why the Z01 subtable is a trap.
---

# Ragic Z01 (parent) / Z02 (student) write model

**Rule:** To register a parent with students into Ragic, create the Z01 parent
record, then write each student as its own Z02 record with the parent's phone in
the `(報)行動電話` link field. The Z01 `項次/學員` subtable then auto-populates.

**Why:** Z01's student subtable (stid `1001119`) is NOT a writable subtable — it
is a Ragic *linked-records view* auto-derived from Z02 matched on parent phone.
Writing students there fails two ways:
- dotted-key POST (`1001119_<i>_<field>`) → returns `SUCCESS` but silently drops
  the rows (worst kind of failure — looks fine, nothing lands).
- two-step record-path POST → returns `INVALID 館別為必填`.
So the only reliable path is Z02.

**How to apply:**
- Z01 required fields (missing any → `INVALID 202`, the WHOLE write fails incl.
  parent): 性別(gender), Email, plus 身分/館別/line對話網址 (placeholders ok).
  Validate email+gender server-side *before* hitting Ragic so you return a clear
  400, not an opaque 502.
- Z02 required fields (missing any → `INVALID 202`): 學員編號 (new students have
  none → fall back to id_number), (報)身分 (default 一般身分), 血型 (default 不清楚),
  plus 學(性別)/出生年月日/身分證字號.
- Gender option fields (Z02 + Z01 subtable) only accept 生理男/生理女 — map 男/女.
- Ragic has NO dev/prod split (single external system). Any test write hits real
  Z01/Z02 — always clean up (delete by `_ragicId`, both forms). Listing has index
  lag; getParentByPhone returns a raw record whose `_subtable_1001119` is parsed
  by parseZ01Students.

**Partial-failure compensation:** Two-phase write (Z01 then Z02) can leave an
orphan Z01 parent carrying the lineUid if a Z02 write throws — that orphan then
blocks retry via `LINE_ALREADY_REGISTERED`. On Z02 failure, best-effort delete the
just-created Z01 parent + any Z02 students already written, then re-throw.

**Known still-broken (follow-up):** group-buy join `addStudentsToParentInRagic`
still uses the broken Z01 dotted subtable mechanism (called best-effort from
groupOrders), so it can silently drop students — should be rewritten to Z02 too.
No integration test asserts Z01 項次 visibility post-write (only HTTP SUCCESS).
