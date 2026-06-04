---
name: Production DB is read-only via tooling
description: executeSql/database skill against production can only READ; prod writes must be delivered as scripts for the user to run.
---

# Production DB writes can't be done from the agent

`executeSql({ environment: "production" })` (and the database skill's prod path) is **READ-ONLY**. Any INSERT/UPDATE/DELETE against the production database fails.

**Why:** Platform safety guard — agents can inspect prod data but cannot mutate it.

**How to apply:** When a task needs production data changes (seeding demo data, fixing a column, backfilling), do NOT try to write prod directly. Instead:
- Author idempotent SQL scripts (seed + cleanup).
- Validate them against the **dev** DB (heliumdb), which has the identical schema, by reading the file and running it via `executeSql` (no environment arg).
- Hand the scripts to the user to run against prod (`psql "$PROD_DATABASE_URL" -f ...`).
- Never copy dev UUIDs into prod scripts — prod and dev are different databases with different PKs. Self-resolve ids inside the script by stable business keys (phone, name, ragic_employee_id).
