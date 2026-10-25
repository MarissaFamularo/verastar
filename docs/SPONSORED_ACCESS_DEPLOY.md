# Sponsored access: deploy checklist

*Companion to [SPONSORED_ACCESS_SPEC.md](SPONSORED_ACCESS_SPEC.md). One-time setup on the
shared Verastar / PaperTrellis Supabase project.*

**Status 2026-09-17:** steps 1, 2, 4, 4b and the cron job were applied to the production
project from this session. Still to do by hand: the two function secrets (step 3), the
first smoke test, enrollment, and the reference collection.

## 0. Deploy order for the 2026-10-14 server repairs

**Status 2026-10-15 (read-only check of the project):** executed. The four migrations are in
the migration history (`20261014192744` to `20261014192812`), their functions exist with the
expected grants, and the edge functions were redeployed on 2026-10-14. The steps below are kept
as the record of that release.

The beta audit's server findings (docs/BETA_TEST_PLAN.md § H) are implemented as local code
and migration files; nothing has been deployed or applied. Same shape as the spending
cutover ([SPENDING_CONTRACT.md](SPENDING_CONTRACT.md) § 10): **functions first, then
migrations, fail-closed in between.** Before starting, `npm test`, `npm run lint`,
`node scripts/check-spending-contract.mjs` and the Deno tests must be green on the commit
being deployed, and `supabase/tests/run_spending_tests.sh` plus
`run_gmail_alias_tests.sh` must pass on a disposable local database.

1. **Deploy the functions** from the repo root, with the committed `supabase/config.toml`
   (it pins `verify_jwt` and the import map per function, so no `--no-verify-jwt` or
   `--import-map` flag is needed; passing them anyway is harmless):

   ```bash
   supabase functions deploy model digest-run redeem-invite gmail-canonical-otp --project-ref lahahztitoqjumrxjcim
   ```

   Between this step and step 3 the new code fails closed against the old schema:
   - `digest-run` calls `digest_claim_release`, which does not exist yet, only on the
     "claimed but nothing to run" path; that call is swallowed and the claim goes stale
     (240 s) instead of being released. Ticks still run. `last_attempt_at`,
     `attempt_day` and `attempts_today` are missing from the schedule read, so the
     select fails and every tick answers `schedules unavailable` (503, nothing runs)
     until the migration lands. Deploy during a quiet hour, or `cron.unschedule` first.
   - `gmail-canonical-otp` calls `gmail_alias_fail_verify` after a wrong code; the RPC
     error reads as zero attempts left, so a single wrong code burns the ticket (stricter
     than the final behavior, never looser).
   - `redeem-invite` reads `sponsor_invites.ends_at`, which already exists; the RPC still
     ignores it until step 3, so the preflight is the only end-date check for that window.
   - `model` wording changes need no schema.
2. **Drain** at least the paid-plan wall clock (400 s) so no old isolate is mid-run.
3. **Apply the four migrations**, in file order, each in its own transaction:
   `20261014120000_invite_ends_at.sql`, `20261014121000_digest_attempts.sql`,
   `20261014122000_gmail_otp_failures.sql`, `20261014123000_evidence_cache_column_grants.sql`.
   The column-grant migration refuses a client `select *` on either cache table; the
   deployed app (commit 189c78a or later) reads named columns, so deploy the frontend
   first if it is older than that.
4. **Verify**: `has_function_privilege('authenticated', ...)` is false for
   `redeem_sponsor_invite`, `digest_claim_finish`, `digest_claim_release`,
   `digest_local_day` and `gmail_alias_fail_verify`;
   `has_column_privilege('authenticated', 'public.evidence_cache_trusted', 'created_by', 'select')`
   is false; the next cron tick answers 200 with `ran`; `supabase/ops/spending_health.sql`
   shows nothing new. Compare the deployed `digest-run` bundle with the manifest's
   `bundleSha256` as in the contract's § 10 step 5.
5. **Rollback** is forward-only, as for the spending cutover: re-run the previous
   definition of a function from its earlier migration (each new migration's header
   names it); never redeploy an older function.

Not in this release: the invite-attempt ledger is open PR 22 and lands separately.

## 1. Apply the migrations

`supabase/migrations/20260917180000_sponsored_access.sql`,
`20260917190000_digest_schedules.sql` and `20260917200000_sponsor_invites.sql`, once, from the SQL editor or `supabase db push`.
Creates `sponsored_accounts`, `sponsor_config`, `evidence_cache`, `reference_papers`,
`model_spend`, `digest_schedules`. Then run the Supabase security advisors: every new table
has RLS on, and only `sponsored_accounts` (own row, three columns), `evidence_cache` and
`reference_papers` grant anything to `authenticated`.

## 2. Set the cap values (never in code)

```sql
insert into sponsor_config (default_daily_cap_usd, default_monthly_cap_usd, global_monthly_ceiling_usd)
values (<daily>, <monthly>, <global>);
```

Values come from the private plan. Change later with `update sponsor_config set ... where id`.

## 3. Secrets

In the project's Edge Function secrets: `ANTHROPIC_API_KEY` = the sponsor key, and
`DIGEST_CRON_SECRET` = a long random string that only pg_cron knows. pg_cron reads its copy
from Supabase Vault as `verastar_digest_cron_secret` (step 4b); the two values must match.
`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected by the
platform. Optional, for emailing the morning digest (docs/DIGEST_DELIVERY.md):
`RESEND_API_KEY`, `DIGEST_EMAIL_FROM`, `DIGEST_EMAIL_REPLY_TO`, `APP_URL`; with the first
two unset, `digest-run` sends nothing.

## 4. Deploy the function

```bash
supabase functions deploy model --no-verify-jwt
```

`--no-verify-jwt` because the function verifies the user itself (`auth.getUser()`) and must
be able to answer the SDK's CORS preflight. Since 2026-10-14 the committed
`supabase/config.toml` records this per function (`verify_jwt = false` for `model`,
`digest-run`, `redeem-invite`, `match-npi`; `true` for `gmail-canonical-otp`), so a plain
`supabase functions deploy <name>` reproduces the live gateway settings; the flag is kept
in these commands as a belt-and-braces reminder. Smoke test with a signed-in sponsored account:
the Settings "Test connection" ping should return `pong`, and `model_spend` should gain a
row with `purpose = 'ping'`. A non-sponsored account must get a 403.

## 4b. Deploy the scheduler and its cron job

> **Proposed change, 2026-10-09 (not deployed).** The spending safeguards replace the
> jsDelivr pin below: `npm run bundle:functions` now writes
> `supabase/functions/digest-run/app.bundle.js` plus `app.bundle.manifest.js`, and
> `digest-run/index.ts` imports the bundle relatively, so the CLI deploys it with the
> function. The cutover deploys the new `model`, `digest-run` and `redeem-invite` FIRST
> (they fail closed against the old schema), drains old workers, then applies the
> migration, verifies, and configures values: see
> [SPENDING_CONTRACT.md](SPENDING_CONTRACT.md) § Cutover. Until that release, the text
> below describes what is live.

```bash
supabase functions deploy digest-run --no-verify-jwt --import-map supabase/functions/deno.json --project-ref lahahztitoqjumrxjcim
```

`--import-map` was required while there was no `supabase/config.toml`: without it the CLI
did not upload the shared `deno.json` and the deploy failed with `Relative import path
"linkedom" not prefixed with / or ./ or ../` (2026-09-30). The committed config now sets
`import_map = "./functions/deno.json"` for every function; the flag is redundant but harmless. Deploy from a checkout of
current `main` (`git pull` first) so the pinned bundle below is the one you just committed.

All functions share `supabase/functions/deno.json` (the import map). `digest-run` needs the
app's own pipeline modules; `npm run bundle:functions` bundles them into
`public/server/app.bundle.js`, which Netlify serves with the frontend and the function
is committed, and `digest-run/index.ts` imports it from jsDelivr pinned to a commit
(`https://cdn.jsdelivr.net/gh/MarissaFamularo/verastar@<sha>/public/server/app.bundle.js`).
The edge runtime resolves remote imports at deploy time and only from an allowlist of hosts
(Netlify is not on it; jsDelivr is). A pipeline change reaches the scheduler by rebuilding
the bundle, committing, updating the pin to the new commit, and redeploying `digest-run`.

Store the cron secret in Supabase Vault (Dashboard → Integrations → Vault → Add secret,
name `verastar_digest_cron_secret`, value = the same string as the `DIGEST_CRON_SECRET`
Edge Function secret). Or in SQL:

```sql
select vault.create_secret('<DIGEST_CRON_SECRET>', 'verastar_digest_cron_secret',
  'x-cron-secret for verastar-digest-run; must equal Edge secret DIGEST_CRON_SECRET');
```

Then, in the SQL editor with the `pg_cron` and `pg_net` extensions enabled, schedule the
job. It reads the secret from Vault at run time, so the secret never appears in `cron.job`
or in `cron.job_run_details`:

```sql
select cron.schedule(
  'verastar-digest-run',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := '<PROJECT_URL>/functions/v1/digest-run',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets
                        where name = 'verastar_digest_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
```

Never paste the secret into `cron.schedule` itself. To rotate it, set the new value in both
places: the Edge secret `DIGEST_CRON_SECRET` and the Vault secret (`select
vault.update_secret(id, '<new>') from vault.secrets where name = 'verastar_digest_cron_secret';`).
A mismatch shows up as `net._http_response` rows with status 401 and body
`{"error":"unauthorized"}`. With matching values, every tick returns 200 with a `ran` field.

Each tick runs at most one account for up to about 100 seconds of reading and hands the
rest to the next tick, so a digest of eight papers completes within two or three ticks and
a cohort of fifty spreads across the morning. Smoke test: enroll your own account (step 5),
set a schedule in Settings, press "Run now", and check `digest_schedules.last_result` and
`events where type = 'digest_scheduled_run'`. The first real run is the untested surface:
the parsing path runs on linkedom instead of the browser's DOMParser, validated on JATS
and PubMed XML shapes in Node, not yet against a live NCBI response on Deno.

## 5. Enroll accounts

Preferred: an invite code per cohort. Deploy `redeem-invite` alongside the others
(`supabase functions deploy redeem-invite --no-verify-jwt --import-map supabase/functions/deno.json`; it imports `@supabase/supabase-js` bare, like `digest-run`), then:

```sql
insert into sponsor_invites (code, cohort, max_uses, expires_at, ends_at, note)
values ('<code from the consent confirmation page>', 'pilot-1', 50, '<enrollment close>', '<study end>', 'cohort one');
```

Store every code in CAPITALS (e.g. `FRIENDS-1`). The app upper-cases whatever is typed before
sending it, and the server match is exact, so a lower-case code in this table can never be redeemed.

A participant signs in, enters the code under Settings → "Have an access code?" (or on the
onboarding connect step), and their `sponsored_accounts` row is created with the cohort and
end date. Five attempts per user per hour; the code is checked only server-side.

Fallback, one account by hand:

```sql
insert into sponsored_accounts (user_id, cohort, ends_at, note)
values ('<auth.users.id>', 'pilot-1', '<study end>', '<free text>');
```

The user sees the change on next app load. Removing sponsorship: `update ... set active = false`.
Per-account overrides: `daily_cap_usd`, `monthly_cap_usd` (null = config default).

## 6. Populate the reference collection

Freeze the extraction version and selected model before preparing Starter content. The
browser's Add a paper route no longer writes shared cache entries. Legacy `evidence_cache`
rows and private evaluation reports are not eligible Starter cache entries.

For each clinically reviewed seed paper, first confirm a matching row in
`evidence_cache_trusted`: the current extraction version, hash of the exact source input
the reader will fetch, and genuine `digest-run` provenance from the bundled server runner.
Do not label an imported evaluation report as scheduler-produced or restamp an older
extraction. The scheduler is the current trusted writer; targeted cache preparation must
be included in the separately authorized release procedure, with its spending bounds.

Only after that read-back, add the corresponding shelf entry:

```sql
insert into reference_papers (specialty, pmid, rank, note) values ('vascular-surgery', '<pmid>', 1, '<why>');
```

A new account seeds from these shelves without a model call. A shelf row alone does not
prove readiness: validate a new account's saved paper and current verifier result using
the actual trusted-cache hit. Papers not yet in the cache
are retried with backoff (seeding stays open, it does not complete), so populate the cache
first; accounts waiting on an empty shelf pick it up at their next app open after the
cooldown.

## 7. What to watch

- `model_spend`: spend per user per day (`sum(usd) group by user_id, date_trunc('day', ts)`),
  and `cache_hit` rate.
- `events where type = 'cap_reached'`: who is hitting caps, and whether the daily value is too low.
- `events where type = 'badge_reported'`: every one is a potential false verify; adjudicate each.
  Deduplicate retries by `payload->>'reportId'`. Free-text feedback is `type = 'beta_feedback'`.
- `digest_schedules.last_result` and `events where type = 'digest_scheduled_run'`: whether
  mornings are landing, and `skipped: cap reached` or `last digest unopened` patterns.
