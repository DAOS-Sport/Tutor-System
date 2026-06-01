---
name: Group-buy status transitions must be atomic
description: How to safely change group_orders.status under concurrent review.
---

`group_orders.status` flows `forming → submitted → approved|rejected` (plus `cancelled`).
Parent can cancel; staff can approve/reject concurrently.

**Rule:** Every status mutation must be a single conditional `UPDATE ... SET status=...
WHERE id=$1 AND status IN (<allowed-from-states>) RETURNING id`, then check `rowCount`.
Approve additionally wraps the row in a txn with `SELECT ... FOR UPDATE` because it also
creates per-member `admin_enrollments`.

**Why:** A non-transactional read-then-write (`SELECT` status, branch in JS, then
unconditional `UPDATE ... WHERE id`) lets a concurrent approve and a cancel/reject overwrite
each other's terminal state — e.g. enrollments get created (approved) while the order ends up
`cancelled`, leaving inconsistent business state.

**How to apply:** Never gate a status change only on a prior `SELECT`. Put the allowed
source states in the `UPDATE` WHERE clause and return 409 when `rowCount === 0`.
