# Inactivity counting and bounded recovery

A finished digest with papers counts as missed only after its completion day in
the reader's timezone has passed, and only when another scheduled run is eligible.
`inactivity_counted_at` stores its stable `ranAt` (legacy `savedAt` fallback).
Repeated discovery failures and retries cannot count that digest again. Unfinished
and empty digests do not count. Today's finished digest cannot cause a pause before
its delivery hour. Existing delivery claims, attempt limits and spending guards
are unchanged.

The service-only `digest_inactivity_update` RPC locks the schedule and digest,
compares the claim, checkpoint, counter, pause, engagement and relevant digest
version, and commits the checkpoint with the counter. A stale observation fails
closed before model work or a pause notification. A seventh distinct missed
digest stores seven and atomically pauses/releases its claim. The existing weekly
notification cap remains. A persisted pause requires reader activity at or after
the pause, a supported manual run, or an explicit operator correction to resume;
changing only a counter no longer silently resumes it.

## Release order

1. Run `npm test`, `npm run lint`, `npm run build`,
   `node scripts/check-spending-contract.mjs`, and
   `node scripts/check-netlify-headers.mjs`. Run
   `supabase/tests/run_beta_admin_tests.sh` against a disposable localhost database.
   It includes real SQL privilege, stale-state, repair and concurrent-session tests.
2. Merge the reviewed change after CI passes.
3. Apply `20261106112838_inactivity_once_per_digest.sql` before deploying digest-run.
   It adds schema and a service-only RPC; it does not reset any account.
4. Deploy digest-run from that merged source, retaining its existing authentication
   configuration and all current dependencies. Read back and compare every file.
5. Allow previous workers to drain (at least the runtime's 400-second maximum).
   Check normal cron health. Do not invoke a digest to verify deployment.
6. Apply an account repair only with explicit authorization and a fresh reviewed
   manifest. A deployment by itself never authorizes an account reset.

## November 6 authorized repair

`supabase/repairs/reset_inactivity_20261106.sql` is an operator script, never a
migration. The private manifest is supplied through a transaction-local setting;
no account identifiers or contact details belong in the repository.

The protected cohort includes **any** schedule with a current pause or a pause /
pause-notification event strictly before November 3 midnight America/New_York
(`2026-11-03T05:00:00Z`). A later re-pause does not remove that protection.
For the reviewed cohort, preserve 24 schedules in full, reset 21 eligible counters
(8 nonzero), and clear only the five explicitly authorized newer automatic pauses.
Four of those five have email enabled; one has email disabled and must stay so.

Refresh all schedule states and pause evidence immediately before execution.
Verify the same exact five automatic inactivity pauses, with no user-directed
opt-out or ambiguous history. Build the manifest with `cutoff`, `total_count`,
`protected_count`, `eligible_count`, `resume_count`, `nonzero_count`, sorted UUID
arrays `protected_ids`, `eligible_ids`, `resume_ids`, the full schedule map
`preferences` (`enabled` and `email_digest`), and `pause_times` for the five resumes.
Execute in a single SERIALIZABLE transaction with no reader JWT:

```sql
begin isolation level serializable;
-- Bind the reviewed JSON value through the operator's SQL client.
select set_config('verastar.inactivity_repair_manifest', :manifest, true);
-- Execute the reviewed repair file here.
commit;
```

The script locks all schedules and refuses any cohort, preference, pause-origin,
timestamp or count mismatch, or any eligible claim (including a stale claim).
Wait for normal work and refresh rather than clearing claims. It baselines the
current digest identity so resetting cannot immediately recount an older digest.
It changes only `unopened_streak`, `inactivity_counted_at`, the five `paused_at`
values and `updated_at`. In-transaction assertions preserve every protected row
and every unrelated field, including opt-outs, hours, engagement, attempts and
delivery markers. It returns aggregate counts. Any error must roll back.

After commit, verify aggregate state, preferences and ordinary cron behavior.
Automatic runs and deliveries may resume within existing windows; do not force
messages or runs. Previously completed/delivered days stay guarded. Rollback of
data requires the reviewed before snapshot and fresh reconciliation of any natural
work since the repair. Do not roll back to the old handler while expecting these
counting guarantees; leave the additive schema in place.
