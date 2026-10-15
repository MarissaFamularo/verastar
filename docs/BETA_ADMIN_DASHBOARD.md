# Beta admin dashboard and signup survey

*Branch `beta-admin-dashboard-survey`. Plan recorded before implementation; the status
section at the end is updated as work lands.*

## Plan

1. **Boundaries.** No change to the verifier, thresholds, paper selection, summary
   generation, digest visibility, retries, scheduling, or any edge function. Nothing is
   deployed or applied; the one migration is additive and proposed for review.
2. **Authorization.** The repository has no server-side notion of an admin. The migration
   adds `private.beta_admins`, an allowlist with no client grants that an operator fills
   by SQL. Both RPCs below check it with `auth.uid()`. The page renders nothing without a
   server answer, and the data RPC refuses non-admins with `42501`.
3. **Data endpoints.** Two `SECURITY DEFINER` functions in schema `public`, callable only
   by `authenticated`:
   - `beta_admin_check()` → boolean (is the caller on the allowlist).
   - `beta_admin_stats(p_from, p_to)` → jsonb of aggregates for `[p_from, p_to)`.
   Metrics are computed only from records that already exist: `sponsored_accounts`,
   `events` (`digest_scheduled_run`, `digest_run`, `digest_opened`),
   `evidence_cache_trusted`, and the new survey table. The digest pipeline is untouched.
4. **Survey storage.** `public.beta_survey_responses`, one row per `(user_id, wave)` with
   `wave = 'signup'` now and `'day30'` reserved for a later task. Written only through
   `beta_survey_submit(...)`, which validates option codes, copies the cohort label from
   `sponsored_accounts`, and inserts with `on conflict do nothing` (idempotent; first
   write wins). Users may `select` their own row (RLS). No free text, no beta code.
5. **Client.** A `BetaSurvey` component offered once after a redemption that answers
   `enrolled`; skip and submit both record a row; any failure is swallowed and the app
   continues. An `AdminDashboard` view reachable from Settings only when
   `beta_admin_check()` is true, with a date range defaulting to the last 30 days.
6. **Tests.** SQL contract tests on a disposable database (authorization, idempotency,
   validation, metric arithmetic with retries and empty results). Vitest unit tests for
   the survey component, the dashboard metric formatting, and the gating logic.
