#!/usr/bin/env bash
# Disposable database for the M1–M3 audit. Refuses anything but a local server.
#   sudo -u postgres env PGHOST=/var/run/postgresql PGBIN=/usr/bin supabase/tests/run_security_audit_tests.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
BIN=${PGBIN:-/usr/bin}
PSQL=${PSQL:-$BIN/psql}
case "${PGHOST:-}" in
  127.0.0.1|localhost|::1|/*) ;;
  *) echo "Refusing: PGHOST must be a local server (got '${PGHOST:-unset}')" >&2; exit 2 ;;
esac
DB=${SECURITY_TEST_DB:-verastar_security_audit_test}
export LC_ALL=C PGDATABASE=$DB PSQL
"$BIN/dropdb" --if-exists "$DB"
"$BIN/createdb" "$DB"
run() {
  "$PSQL" -X -q -v ON_ERROR_STOP=1 -f "$1" >/dev/null 2>&1 || { echo "failed: $1" >&2; "$PSQL" -X -v ON_ERROR_STOP=1 -f "$1"; exit 1; }
}
run supabase/tests/spending_fixture.sql
run supabase/migrations/20260721000000_kv_events_with_rls.sql
run supabase/tests/security_collab_fixture.sql
run supabase/migrations/20261013140000_invite_attempt_ledger.sql
run supabase/migrations/20261013140100_collab_write_guards.sql
# Idempotent: a second apply must not duplicate attempts or fail policy replacement.
run supabase/migrations/20261013140000_invite_attempt_ledger.sql
run supabase/migrations/20261013140100_collab_write_guards.sql
"$PSQL" -X -q -v ON_ERROR_STOP=1 -f supabase/tests/security_audit.sql
echo "PASS security audit SQL"
[ -n "${KEEP_DB:-}" ] || "$BIN/dropdb" "$DB"
