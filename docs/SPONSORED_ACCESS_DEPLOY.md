# Sponsored access: deploy checklist

*Companion to [SPONSORED_ACCESS_SPEC.md](SPONSORED_ACCESS_SPEC.md). Everything below is a
one-time setup on the shared Verastar / PaperTrellis Supabase project. Nothing here was
applied automatically; the migration was validated against a throwaway Postgres 16 with
the two earlier migrations in place, and the app's suite covers the proxy's pure logic.
The edge function itself has not yet run on Deno: step 4 is where that happens.*

## 1. Apply the migration

`supabase/migrations/20260917180000_sponsored_access.sql`, once, from the SQL editor or
`supabase db push`. Creates `sponsored_accounts`, `sponsor_config`, `evidence_cache`,
`reference_papers`, `model_spend`. Then run the Supabase security advisors: every new table
has RLS on, and only `sponsored_accounts` (own row, three columns), `evidence_cache` and
`reference_papers` grant anything to `authenticated`.

## 2. Set the cap values (never in code)

```sql
insert into sponsor_config (default_daily_cap_usd, default_monthly_cap_usd, global_monthly_ceiling_usd)
values (<daily>, <monthly>, <global>);
```

Values come from the private plan. Change later with `update sponsor_config set ... where id`.

## 3. Secrets

In the project's Edge Function secrets: `ANTHROPIC_API_KEY` = the sponsor key. `SUPABASE_URL`,
`SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected by the platform.

## 4. Deploy the function

```bash
supabase functions deploy model --no-verify-jwt
```

`--no-verify-jwt` because the function verifies the user itself (`auth.getUser()`) and must
be able to answer the SDK's CORS preflight. Smoke test with a signed-in sponsored account:
the Settings "Test connection" ping should return `pong`, and `model_spend` should gain a
row with `purpose = 'ping'`. A non-sponsored account must get a 403.

## 5. Enroll accounts

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
