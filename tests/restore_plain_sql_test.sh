#!/usr/bin/env bash
set -euo pipefail
# Synthetic fixtures only; the caller must select a task-owned loopback cluster.
: "${TEST_DATABASE_URL:?set a loopback disposable test database}"
case "$TEST_DATABASE_URL" in postgresql://*@127.0.0.1:*/tutor_audit_test) ;; *) echo 'refusing non-isolated target' >&2; exit 2 ;; esac
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PREFIX="restore_test_$$"
BASE_URL="${TEST_DATABASE_URL%/*}"
RESTORE_TEST_TMP=$(mktemp -d)
cleanup() {
  for suffix in source target bad; do dropdb --if-exists "--maintenance-db=$TEST_DATABASE_URL" "${PREFIX}_${suffix}" >/dev/null; done
  rm -f -- "$RESTORE_TEST_TMP/fixture.sql.gz" "$RESTORE_TEST_TMP/bad.sql" "$RESTORE_TEST_TMP/restore.log"
  rmdir -- "$RESTORE_TEST_TMP"
}
trap cleanup EXIT
for suffix in source target bad; do createdb "--maintenance-db=$TEST_DATABASE_URL" "${PREFIX}_${suffix}"; done
psql "$BASE_URL/${PREFIX}_source" -X -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE parents(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text NOT NULL UNIQUE);
CREATE TABLE children(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, parent_id bigint NOT NULL REFERENCES parents(id), active boolean NOT NULL, at timestamptz NOT NULL);
INSERT INTO parents(name) VALUES ('還原測試');
INSERT INTO children(parent_id,active,at) VALUES (1,true,'2026-09-18T10:30:00+08:00');
SQL
pg_dump --format=plain --no-owner --no-privileges "$BASE_URL/${PREFIX}_source" | gzip -9 > "$RESTORE_TEST_TMP/fixture.sql.gz"
RESTORE_DATABASE_URL="$BASE_URL/${PREFIX}_target" bash "$ROOT/scripts/restore_db.sh" "$RESTORE_TEST_TMP/fixture.sql.gz" --confirm-database "${PREFIX}_target" > "$RESTORE_TEST_TMP/restore.log"
[[ $(psql "$BASE_URL/${PREFIX}_target" -XAt -c "SELECT count(*) FROM children c JOIN parents p ON p.id=c.parent_id WHERE p.name='還原測試' AND active AND at='2026-09-18T02:30:00Z'") == 1 ]]
[[ $(psql "$BASE_URL/${PREFIX}_target" -XAt -c "INSERT INTO parents(name) VALUES ('sequence check') RETURNING id" | head -1) == 2 ]]
if psql "$BASE_URL/${PREFIX}_target" -X -v ON_ERROR_STOP=1 -c "INSERT INTO children(parent_id,active,at) VALUES(999,true,now())" >/dev/null 2>&1; then echo 'foreign key missing'; exit 1; fi
if RESTORE_DATABASE_URL="$BASE_URL/${PREFIX}_target" bash "$ROOT/scripts/restore_db.sh" "$RESTORE_TEST_TMP/fixture.sql.gz" --confirm-database "${PREFIX}_target" >/dev/null 2>&1; then echo 'nonempty overwrite allowed'; exit 1; fi
if RESTORE_DATABASE_URL="$BASE_URL/${PREFIX}_bad" bash "$ROOT/scripts/restore_db.sh" "$RESTORE_TEST_TMP/fixture.sql.gz" --confirm-database wrong >/dev/null 2>&1; then echo 'confirmation ignored'; exit 1; fi
printf 'CREATE TABLE rollback_probe(id int);\nSELECT missing_column;\n' > "$RESTORE_TEST_TMP/bad.sql"
if RESTORE_DATABASE_URL="$BASE_URL/${PREFIX}_bad" bash "$ROOT/scripts/restore_db.sh" "$RESTORE_TEST_TMP/bad.sql" --confirm-database "${PREFIX}_bad" >/dev/null 2>&1; then echo 'invalid SQL accepted'; exit 1; fi
[[ $(psql "$BASE_URL/${PREFIX}_bad" -XAt -c "SELECT to_regclass('public.rollback_probe') IS NULL") == t ]]
echo 'PASS: plain SQL gzip restore, Unicode, timestamp, sequence, FK, target guards and failure rollback'
