#!/usr/bin/env bash
# Build a DISPOSABLE database and run the Gmail alias audit and concurrency tests against it.
# Refuses anything but a local server. Usage:
#   PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres supabase/tests/run_gmail_alias_tests.sh
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
DB=${GMAIL_ALIAS_TEST_DB:-verastar_gmail_alias_test}
export LC_ALL=C PGDATABASE=$DB PSQL
"$DROPDB" --if-exists "$DB"
"$CREATEDB" "$DB"
"$PSQL" -X -q -v ON_ERROR_STOP=1 -f supabase/tests/gmail_alias_fixture.sql
"$PSQL" -X -q -v ON_ERROR_STOP=1 -f supabase/migrations/20261012213000_gmail_alias_hint.sql
"$PSQL" -X -q -v ON_ERROR_STOP=1 -f supabase/migrations/20261013050000_gmail_alias_hint_audit.sql
"$PSQL" -X -q -v ON_ERROR_STOP=1 -f supabase/migrations/20261013120000_gmail_alias_prepare.sql
"$PSQL" -X -q -v ON_ERROR_STOP=1 -f supabase/migrations/20261014122000_gmail_otp_failures.sql
"$PSQL" -X -q -v ON_ERROR_STOP=1 -f supabase/tests/gmail_alias_audit.sql
python3 supabase/tests/gmail_alias_concurrency.py
[ -n "${KEEP_DB:-}" ] || "$DROPDB" "$DB"
