# PubMed outages: behavior and release runbook

Status: proposed; this change has not been applied or deployed.

The November 5 incident exposed two independent faults: repeated ESearch failures
consumed the scheduler's 12 daily work attempts, and a different account's empty
run could clear the shared digest incident.

## Runtime behavior

- Scheduled discovery (including the signed-in “run mine now” endpoint) requires
  one database-owned PubMed lease across accounts. Healthy searches are serialized
  and paced; discovery releases its lease before model work. The four-minute lease
  expires if a worker dies. A stale token cannot publish success.
- Discovery uses one request per endpoint with a ten-second timeout. HTTP 408,
  429, 5xx, network errors and malformed/incomplete responses defer the scan.
  It stops on the first failing topic. No API key, email or query URL is included
  in the error. ESummary/EFetch failures cannot masquerade as an empty search.
- Outages wait 15 minutes, then 30 minutes, then 60 minutes between admitted
  probes. A longer Retry-After is respected up to 24 hours. The counter and clock
  survive worker restarts and midnight. Waiting ticks make no PubMed requests,
  send no alert, and consume no daily work attempts. They rotate queue fairness
  so an account waiting for search does not starve resumable work.
- Existing scheduling windows remain: work is eligible from one hour before the
  requested delivery hour through the existing twelve-hour catch-up window;
  outside it, new searches wait for the next eligible morning. The last successful
  digest and scan checkpoint remain intact during failed discovery. The selected
  search lookback remains the user's setting; this is not a historical backfill.
- Other errors retain the 12-attempt cap but now wait 15/30/60 minutes between
  automatic attempts. The proposed [completion allowance](DIGEST_ATTEMPT_CAP.md)
  lets a valid saved handoff finish within a separate finite bound. Manual runs still respect PubMed's shared outage gate.
  Existing spending holds, claim fences, and delivery-day compare-and-set remain.
  An uncertain email send is still not retried automatically.

## Recovery and notifications

An explicit upstream outage opens one incident immediately. Other failures retain
existing sustained-failure thresholds. The monitor remembers failures per account,
including unresolved service-written schedule failures at migration time.

A validated empty scan may resolve that account's failure, but cannot supply the
paper-bearing evidence for a shared recovery. An all-clear requires:

1. The PubMed circuit has closed after validated discovery.
2. No enabled, unpaused, active account remains failed.
3. A completed digest with papers, no failed paper results, and complete discovery
   occurred after the most recent failure, within the last 24 hours.
4. Thirty minutes have passed without a failure.

Silence, non-onboarded accounts, partial searches, and repeated monitor ticks do not
manufacture recovery. If all fields are genuinely quiet, the incident conservatively
stays open until paper-bearing work proves recovery. Repeated failures/ticks use the
existing unique incident/recovery outbox keys. A queued recovery is checked again
before dispatch, so a new failure suppresses a stale all-clear. The existing
at-most-once mail claim and uncertain-send hold are unchanged.

## Verification

The normal offline checks are:

```sh
npm ci --ignore-scripts
npm run bundle:functions
npm test
npm run lint
npm run build
node scripts/check-spending-contract.mjs
node scripts/check-netlify-headers.mjs
```

Use a disposable local PostgreSQL 16 instance only (no linked project):

```sh
export PGHOST=127.0.0.1 PGPORT=55439 PGUSER=postgres
KEEP_DB=1 BETA_ADMIN_TEST_DB=verastar_outage_test bash supabase/tests/run_beta_admin_tests.sh
PGDATABASE=verastar_outage_test bash supabase/tests/run_pubmed_tests.sh
```

The beta harness includes the new migration and outage contract. The separate outage
runner also races twelve independent service-role connections. Tests cover prolonged
failure, Retry-After, stale leases, attempt and delivery preservation, recovery
qualification, duplicate alerts, queued stale recovery, and client permissions.
A missing grant on the email-engagement test's temporary assertion helper is fixed
so the existing authenticated-role assertions can actually run; no application
privilege is changed by that test fixture fix.

## Authorized release steps

Do not run these as part of preparing the fix. Merge/deployment and any production
account edits require separate authorization.

1. Re-run checks against the reviewed commit. Apply
   `20261105103716_pubmed_outage_resilience.sql` after existing migrations, before
   deploying the worker. It adds service-owned retry columns, private operational
   tables, and service-only RPCs; it changes no cron or transport configuration.
2. Deploy `digest-run` with the checked-in regenerated bundle and manifest using
   the repository's existing function config/import map. The `beta-monitor` edge
   code is unchanged; its RPC behavior changes with the migration.
3. Observe normal cron traffic; do not manually invoke digests for a smoke test.
   Read the circuit, scheduler outcomes, monitor state and delivered-day/event
   records. Confirm no new `deferred`/`waiting` outcomes increase `attempts_today`,
   admitted probes follow `next_probe_at`, and each account/day is delivered once.
4. Inspect accounts already capped by the old worker separately. This migration
   deliberately does not reset their attempts, completion days, delivery markers,
   or spending holds. They resume on the next local day. A same-day reset would
   require a reviewed, separately authorized per-account action after confirming
   the earlier attempts were search-only and had no paid or uncertain delivery.
5. If an incident remains open, inspect unresolved active rows in
   `private.digest_health`; an empty cohort or lack of later paper evidence is not
   an all-clear. Do not force a success sample or blindly clear an outbox hold.

Read-only operational indicators (avoid selecting credentials or user content):

```sql
select failures, next_probe_at, lease_until, last_failure_at, last_success_at
from private.pubmed_circuit;
select state, opened_at, recovered_at, last_checked_at
from private.beta_incidents where check_name='digest';
select count(*) as waiting_accounts
from public.digest_schedules where last_result like 'waiting:%' or last_result like 'deferred:%';
```

If the new worker must be rolled back, leave the additive schema and stricter monitor
in place. Reverting the worker reintroduces rapid upstream retries, so coordinate a
separately approved pause of scheduled execution first if PubMed is still failing.
Do not discard the health ledger or reset delivery/spending state as rollback.
