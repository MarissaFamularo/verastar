#!/usr/bin/env bash
# Build a DISPOSABLE database and check private-schema default privileges.
# Refuses anything but a local server. Usage:
#   PGHOST=/var/run/postgresql PGUSER=postgres supabase/tests/run_private_default_privileges.sh
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
DB=${PRIVATE_PRIVILEGES_TEST_DB:-verastar_private_privileges_test}
export LC_ALL=C PGDATABASE=$DB PSQL
"$DROPDB" --if-exists "$DB"
"$CREATEDB" "$DB"
"$PSQL" -X -q -v ON_ERROR_STOP=1 -f supabase/tests/private_default_privileges_fixture.sql
"$PSQL" -X -q -v ON_ERROR_STOP=1 -f supabase/tests/private_default_privileges.sql
[ -n "${KEEP_DB:-}" ] || "$DROPDB" "$DB"
echo "PASS: private default privileges"
