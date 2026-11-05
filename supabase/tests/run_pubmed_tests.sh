#!/usr/bin/env bash
# Run against a DISPOSABLE local database prepared by run_beta_admin_tests.sh.
# No linked project or production URL accepted. Apply the outage migration once first.
set -euo pipefail
cd "$(dirname "$0")/../.."
case "${PGHOST:-}" in 127.0.0.1|localhost|::1) ;; *) echo 'local DB required' >&2; exit 2;; esac
case "${PGDATABASE:-}" in verastar_outage*) ;; *) echo 'disposable outage DB required' >&2; exit 2;; esac
PSQL=${PSQL:-/opt/homebrew/opt/postgresql@16/bin/psql}
export PSQL
"$PSQL" -X -v ON_ERROR_STOP=1 -f supabase/tests/pubmed_outage.sql
python3 supabase/tests/pubmed_concurrency.py
