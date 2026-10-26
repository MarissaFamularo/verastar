#!/usr/bin/env bash
# Build a DISPOSABLE database and run the spending/scheduler/invite SQL tests against it.
# Refuses anything but a local server. Usage:
#   PGHOST=127.0.0.1 PGPORT=54329 PGUSER=postgres supabase/tests/run_spending_tests.sh
# Needs PostgreSQL 15+ client/server binaries (PSQL/CREATEDB/DROPDB override the paths).
set -euo pipefail
cd "$(dirname "$0")/../.."
BIN=${PGBIN:-/opt/homebrew/opt/postgresql@16/bin}
PSQL=${PSQL:-$BIN/psql}
case "${PGHOST:-}" in
  127.0.0.1|localhost|::1|/*) ;;
  *) echo "Refusing: PGHOST must be a local server (got '${PGHOST:-unset}')" >&2; exit 2 ;;
esac
DB=${SPENDING_TEST_DB:-verastar_spending_test}
export LC_ALL=C PGDATABASE=$DB PSQL
"$BIN/dropdb" --if-exists "$DB"
"$BIN/createdb" "$DB"
for f in supabase/tests/spending_fixture.sql \
         supabase/migrations/20260721000000_kv_events_with_rls.sql \
         supabase/migrations/20260911201707_harden_library_writes.sql \
         supabase/migrations/20260917180000_sponsored_access.sql \
         supabase/migrations/20260917190000_digest_schedules.sql \
         supabase/migrations/20260917200000_sponsor_invites.sql \
         supabase/migrations/20261009120000_beta_spending_safeguards.sql \
         supabase/migrations/20261010120000_digest_write_guard.sql \
         supabase/migrations/20261010130000_scheduler_hold.sql \
         supabase/migrations/20261012180000_spend_release.sql \
         supabase/migrations/20261014120000_invite_ends_at.sql \
         supabase/migrations/20261014121000_digest_attempts.sql \
         supabase/migrations/20261014123000_evidence_cache_column_grants.sql \
         supabase/migrations/20261018120000_invite_attempt_ledger.sql \
         supabase/migrations/20261025120000_digest_unopened_pause.sql; do
  "$PSQL" -X -q -v ON_ERROR_STOP=1 -f "$f" >/dev/null 2>&1 || { echo "migration failed: $f" >&2; "$PSQL" -X -q -v ON_ERROR_STOP=1 -f "$f"; exit 1; }
done
"$PSQL" -X -q -v ON_ERROR_STOP=1 -f supabase/tests/spending_contract.sql 2>&1 | grep -E "^psql.*(ERROR|FAIL)|PASS" || true
"$PSQL" -X -q -v ON_ERROR_STOP=1 -f supabase/tests/spending_contract.sql >/dev/null 2>&1
python3 supabase/tests/spending_concurrency.py
[ -n "${KEEP_DB:-}" ] || "$BIN/dropdb" "$DB"
