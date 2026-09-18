# Sponsored access: deploy checklist

*Companion to [SPONSORED_ACCESS_SPEC.md](SPONSORED_ACCESS_SPEC.md). One-time setup on the
shared Verastar / PaperTrellis Supabase project.*

**Status 2026-09-17:** steps 1, 2, 4, 4b and the cron job were applied to the production
project from this session. Still to do by hand: the two function secrets (step 3), the
first smoke test, enrollment, and the reference collection.

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
`DIGEST_CRON_SECRET` = a long random string that only pg_cron knows. `SUPABASE_URL`,
`SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected by the platform.

## 4. Deploy the function

```bash
supabase functions deploy model --no-verify-jwt
```

`--no-verify-jwt` because the function verifies the user itself (`auth.getUser()`) and must
be able to answer the SDK's CORS preflight. Smoke test with a signed-in sponsored account:
the Settings "Test connection" ping should return `pong`, and `model_spend` should gain a
row with `purpose = 'ping'`. A non-sponsored account must get a 403.

## 4b. Deploy the scheduler and its cron job

```bash
supabase functions deploy digest-run --no-verify-jwt
```

All functions share `supabase/functions/deno.json` (the import map). `digest-run` needs the
app's own pipeline modules; `npm run bundle:functions` bundles them into
`public/server/app.bundle.js`, which Netlify serves with the frontend and the function
is committed, and `digest-run/index.ts` imports it from jsDelivr pinned to a commit
(`https://cdn.jsdelivr.net/gh/MarissaFamularo/verastar@<sha>/public/server/app.bundle.js`).
The edge runtime resolves remote imports at deploy time and only from an allowlist of hosts
(Netlify is not on it; jsDelivr is). A pipeline change reaches the scheduler by rebuilding
the bundle, committing, updating the pin to the new commit, and redeploying `digest-run`. Then, in the SQL editor with the `pg_cron` and
`pg_net` extensions enabled:

```sql
select cron.schedule(
  'verastar-digest-run',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := '<PROJECT_URL>/functions/v1/digest-run',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '<DIGEST_CRON_SECRET>'),
    body := '{}'::jsonb
  );
  $$
);
```

Each tick runs at most one account for up to about 100 seconds of reading and hands the
rest to the next tick, so a digest of eight papers completes within two or three ticks and
a cohort of fifty spreads across the morning. Smoke test: enroll your own account (step 5),
set a schedule in Settings, press "Run now", and check `digest_schedules.last_result` and
`events where type = 'digest_scheduled_run'`. The first real run is the untested surface:
the parsing path runs on linkedom instead of the browser's DOMParser, validated on JATS
and PubMed XML shapes in Node, not yet against a live NCBI response on Deno.

## 5. Enroll accounts

Preferred: an invite code per cohort. Deploy `redeem-invite` alongside the others
(`supabase functions deploy redeem-invite --no-verify-jwt`), then:

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

Run each seed paper once through the app (Add a paper) from a sponsored account, which
stores its extraction in `evidence_cache`. Then:

```sql
insert into reference_papers (specialty, pmid, rank, note) values ('vascular-surgery', '<pmid>', 1, '<why>');
```

A new account's first boot seeds from these shelves without a model call. Papers not yet
in the cache are skipped, so populate the cache first.

## 7. What to watch

- `model_spend`: spend per user per day (`sum(usd) group by user_id, date_trunc('day', ts)`),
  and `cache_hit` rate.
- `events where type = 'cap_reached'`: who is hitting caps, and whether the daily value is too low.
- `events where type = 'badge_reported'`: every one is a potential false verify; adjudicate each.
- `digest_schedules.last_result` and `events where type = 'digest_scheduled_run'`: whether
  mornings are landing, and `skipped: cap reached` or `last digest unopened` patterns.
