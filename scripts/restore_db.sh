#!/usr/bin/env bash
# Restore a plain SQL (.sql or .sql.gz) backup into an empty, explicitly selected DB.
set -euo pipefail

if [[ $# -ne 3 || "$2" != '--confirm-database' || -z "${RESTORE_DATABASE_URL:-}" ]]; then
  echo 'Usage: RESTORE_DATABASE_URL=<isolated-target> bash scripts/restore_db.sh backup.sql[.gz] --confirm-database <target-db-name>' >&2
  exit 2
fi
BACKUP_FILE="$1"
EXPECTED_DB="$3"
if [[ ! -f "$BACKUP_FILE" ]]; then echo '[restore] backup file does not exist' >&2; exit 2; fi
if [[ -n "${DATABASE_URL:-}" && "$RESTORE_DATABASE_URL" == "$DATABASE_URL" ]]; then
  echo '[restore] target equals application DATABASE_URL; use a separate empty database' >&2
  exit 2
fi
ACTUAL_DB=$(psql "$RESTORE_DATABASE_URL" -XAt -v ON_ERROR_STOP=1 -c 'SELECT current_database()')
if [[ "$ACTUAL_DB" != "$EXPECTED_DB" ]]; then echo '[restore] database confirmation mismatch' >&2; exit 2; fi
OBJECTS=$(psql "$RESTORE_DATABASE_URL" -XAt -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','S','f')")
if [[ "$OBJECTS" != 0 ]]; then echo '[restore] target is not empty; refusing overwrite' >&2; exit 2; fi

RESTORE_TMP=$(mktemp -d)
trap 'rm -f -- "$RESTORE_TMP/backup.sql"; rmdir -- "$RESTORE_TMP"' EXIT
case "$BACKUP_FILE" in
  *.sql.gz) gzip -t -- "$BACKUP_FILE"; gzip -dc -- "$BACKUP_FILE" > "$RESTORE_TMP/backup.sql" ;;
  *.sql) cp -- "$BACKUP_FILE" "$RESTORE_TMP/backup.sql" ;;
  *) echo '[restore] expected plain SQL .sql or .sql.gz, not a pg_restore archive' >&2; exit 2 ;;
esac
if [[ "$(head -c 5 "$RESTORE_TMP/backup.sql")" == 'PGDMP' ]]; then
  echo '[restore] custom archive detected; this helper only accepts plain SQL' >&2
  exit 2
fi
# -X ignores user psqlrc, ON_ERROR_STOP fails on the first SQL error, and the
# single transaction rolls back the entire restore if any statement fails.
psql "$RESTORE_DATABASE_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f "$RESTORE_TMP/backup.sql"
echo "[restore] completed in database $ACTUAL_DB; verify counts, constraints and application reads before cutover"
