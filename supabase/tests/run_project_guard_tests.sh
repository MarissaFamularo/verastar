#!/usr/bin/env bash
# Disposable database for the H1/H2 project guards. Refuses anything but a local server.
#   sudo -u postgres env PGHOST=/var/run/postgresql supabase/tests/run_project_guard_tests.sh
# Does not touch a linked Supabase project.
set -euo pipefail
cd "$(dirname "$0")/../.."
PSQL=${PSQL:-psql}
CREATEDB=${CREATEDB:-createdb}
DROPDB=${DROPDB:-dropdb}
case "${PGHOST:-}" in
  127.0.0.1|localhost|::1|/*) ;;
  *) echo "Refusing: PGHOST must be a local server (got '${PGHOST:-unset}')" >&2; exit 2 ;;
esac
DB=${PROJECT_GUARD_TEST_DB:-verastar_project_guard_test}
export LC_ALL=C PGDATABASE=$DB PSQL
"$DROPDB" --if-exists "$DB"
"$CREATEDB" "$DB"
run() {
  "$PSQL" -X -q -v ON_ERROR_STOP=1 -f "$1" >/dev/null 2>&1 || { echo "failed: $1" >&2; "$PSQL" -X -v ON_ERROR_STOP=1 -f "$1"; exit 1; }
}
run supabase/tests/spending_fixture.sql
run supabase/tests/project_guard_fixture.sql
run supabase/migrations/20261013152000_project_link_and_column_guards.sql
# A second apply must replace the same policies and trigger, not add another.
run supabase/migrations/20261013152000_project_link_and_column_guards.sql
"$PSQL" -X -q -v ON_ERROR_STOP=1 -f supabase/tests/project_guard.sql
echo "PASS project guard SQL"
[ -n "${KEEP_DB:-}" ] || "$DROPDB" "$DB"
