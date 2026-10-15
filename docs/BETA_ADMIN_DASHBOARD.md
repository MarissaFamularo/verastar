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

## Status (2026-10-15)

Implemented and tested on this branch; nothing deployed, applied, or merged.

### Files

- `supabase/migrations/20261015120000_beta_admin_dashboard_survey.sql` — additive: `private.beta_admins`,
  `public.beta_survey_responses` (RLS, own-row select only), `beta_survey_submit`, `beta_admin_check`,
  `beta_admin_stats`. Rollback statements are in the file header.
- `supabase/tests/beta_admin_dashboard.sql`, `supabase/tests/run_beta_admin_tests.sh` — 46 assertions on a
  disposable database.
- `src/lib/betaSurvey.js`, `src/components/BetaSurvey.jsx` — the survey; `src/lib/betaAdmin.js`,
  `src/components/AdminDashboard.jsx` — the dashboard; `src/lib/betaAdmin.fixture.js` — synthetic stats.
- `src/components/InviteCode.jsx` — `onEnrolled` now receives the redeem status (one line).
- `src/components/OnboardingQuiz.jsx` — offers the survey inline on the connect step after `enrolled`.
- `src/App.jsx` — Settings gains a "Beta admin" section when `beta_admin_check()` is true.
- `docs/screenshots/shell-*.png`, `shell-results.txt` — the real app shell driven by
  `scripts/shell-scenarios/` (simulated backend, synthetic accounts; see that README).

### Metric definitions

Range is half-open `[from, to)`; the UI sends inclusive local calendar dates, defaulting to the last
30 days. Server day grouping uses the UTC date.

| Key | Source | Definition |
|---|---|---|
| New / total / active beta users | `sponsored_accounts` | Code redeemed in range / ever / switched on and not past `ends_at` now. Registration is not activity. |
| Unique users who requested a digest | `events` | Distinct users with a manual scheduled tick (`digest_scheduled_run.manual`) or a non-showcase browser `digest_run` in range. Cron-only users are not requesters. |
| Scheduled digest-days | `events` | Distinct (user, UTC day) with a `digest_scheduled_run` tick. Outcome = phase of the last tick that day: done → generated; empty → empty; error/held/capped → failed; else unfinished. |
| Run / manual / failure / retry ticks | `events` | Every tick; ticks with `manual`; ticks ending error/held/capped; ticks after a failure tick on the same user-day. Retries are never requests. |
| Summaries | `events` | `papers` on done scheduled ticks + `papers` on non-append browser runs. Not unique papers. |
| Unique papers (PMIDs) | `evidence_cache_trusted` | Distinct PMIDs among first-time scheduler extractions in range. Scheduled runs only. |
| Digest opens | `events` | `digest_opened` rows (first open of a digest with results). Delivery is not recorded anywhere. |
| Verifier rejection reasons | none | **Not available.** Reasons live only inside kv JSON (latest digest, saved papers), not as dated events. |
| Survey | `beta_survey_responses` | Completed / skipped in range, completed all-time (independent of the range), per-question counts over completed rows. |

Every count is labelled "as recorded". Coverage is judged from `earliest_retained` (min timestamp
per record kind): the oldest row that still exists, which is not the start of instrumentation and
not proof that nothing was deleted. "Not available" is shown when a record kind has no retained
rows at all, or the range ends before its oldest retained row; a partial overlap shows the count
with an "oldest retained record" note. Verifier reasons are unavailable regardless of range. The
`events` table is editable by its owner under the existing RLS. Payload counters (`papers`,
`errors`) count only when they are plain integers of at most nine digits; anything else counts as
0 so one malformed row cannot fail the whole RPC.

### Tests run

- `npm test`: 134 files, 2565 passed, 3 expected fail, 15 todo (37 new tests across 5 new files).
- `npm run lint`: no new diagnostics. `npm run build`: ok.
- `supabase/tests/run_beta_admin_tests.sh` on local PostgreSQL 16: 46/46 ok.
- `supabase/tests/run_spending_tests.sh` (unchanged, pre-existing): one assertion fails between
  20:00 and 24:00 America/New_York because it compares `attempt_day` (schedule timezone) with the
  UTC date. Not touched; outside this task.

### Migration instructions (for review, not executed)

1. Review the migration file; it depends on `20261009120000_beta_spending_safeguards.sql`
   (`evidence_cache_trusted`) and `20261013040000_private_default_privileges.sql` (schema `private`).
2. Apply after the pending 2026-10-14 release, in its own transaction.
3. Enroll the admin: `insert into private.beta_admins (user_id, note) values ('<your auth.users.id>', 'owner');`
4. Verify: `has_function_privilege('anon', 'public.beta_admin_stats(timestamptz,timestamptz)', 'execute')`
   is false; `has_table_privilege('authenticated', 'private.beta_admins', 'select')` is false;
   `has_table_privilege('authenticated', 'public.beta_survey_responses', 'insert')` is false.
5. Deploy the frontend. No edge function changes.

### Unresolved dependencies and what to review

- **Admin authorization did not exist.** The allowlist table is new; until you insert your user id
  nobody can open the dashboard. Decide whether a SQL-managed allowlist is acceptable for the beta.
- **Verifier reasons** cannot be reported without adding instrumentation to the pipeline (excluded).
- **Delivered digests** are not recorded; only opens are.
- **Survey only on the onboarding connect step.** A code redeemed later from Settings does not offer it.
- **Small cells.** With few users a per-option count of 1 identifies that user's answer to the admin.
  The survey copy and the dashboard both say so; answers are account-linked, not anonymous.
- **Day-30 wave** is reserved in the schema (`wave = 'day30'`) but the RPC refuses it until built.

## Review fixes (commit after 1f5a3a8)

Findings from the review of 1f5a3a8 and what changed. The migration file is edited in place: it
was never applied anywhere.

1. **Bounded telemetry casts.** `private.beta_payload_count(payload, key)` accepts only
   `^[0-9]{1,9}$`; everything else (2147483648, 1e3, -1, 2.5, objects, null, missing) counts as 0.
   SQL tests insert twelve malformed rows across both event types and assert no error, the ticks
   and runs still count, and the values do not.
2. **Survey eligibility.** `beta_survey_submit` refuses a first response (42501, nothing stored)
   unless a `sponsored_accounts` row exists for the caller. The idempotent `already` reply for an
   existing row is unchanged and is tested for an account without eligibility.
3. **Cohort label hidden.** `beta_survey_responses` grants `authenticated` only
   `(user_id, wave, survey_version, status, responded_at)`; `cohort` and the answers are readable
   by the service role only. Tested for submit, skip, and cross-user reads; the client's only
   read (`betaSurveyRecorded`) selects `status`.
4. **Coverage semantics.** `first_seen` is renamed `earliest_retained`; every note and the
   dashboard intro say "as recorded" and "oldest retained record", not "records begin".
   "Completed, all time" no longer inherits the range's availability.
5. **Native radio groups.** One `fieldset`/`legend` and one `name` per question, labelled
   `<input type="radio">`, visible focus ring; the account-linkage copy replaces the previous
   wording. Keyboard-only completion is exercised in the app shell.

One more change found by the shell run: the dashboard's Update button is no longer `disabled`
while loading (a disabled control drops focus to the page body and the next Tab left the
Settings dialog); re-entry is refused in code instead, with a unit test.

### Checks run on the fix commit

| Check | Result |
|---|---|
| `npm test` | 134 files, 2567 passed, 3 expected fail, 15 todo |
| `npm run lint` / `npm run build` | no new diagnostics / ok |
| `supabase/tests/run_beta_admin_tests.sh` (local PostgreSQL 16) | 62/62 assertions |
| `scripts/shell-scenarios/shell.mjs` (simulated backend) | 47/47 assertions, 8 scenarios |
| `supabase/tests/run_spending_tests.sh` (pre-existing, unchanged) | see below |

### Pre-existing spending-suite failure (separate from this task)

`supabase/tests/spending_contract.sql` line 310 compares `attempt_day` (computed in the schedule's
timezone, default America/New_York) with the UTC date. Run at 20:27 New York time (00:27 UTC) it
fails on "a finished run stamps last_attempt_at and counts one attempt today", and because the
script runs under `ON_ERROR_STOP`, everything after that line did not run in that session: the
remaining attempt-stamp and release assertions, the scheduler-hold and recovery section, the
spend-release section, and `spending_concurrency.py`. Run again at 04:31 New York time the same
suite passed in full (SQL assertions plus 74 concurrency checks). Nothing in that suite or the
scheduler code was changed here; the failure is a time-of-day artifact of the test, not of the
migration under test.

### Simulated vs live evidence

Simulated (done): unit tests with mocked modules; SQL contract tests on a disposable local
database with the fixture roles and a stub `auth.uid()`; app-shell scenarios with a fake HTTP
backend and a seeded session. Live (not done, by instruction): the migration on the shared
project, the RPCs through the real PostgREST gateway and JWT verification, Supabase's own
`authenticated` default privileges, email sign-in, the real `redeem-invite` function, and the
survey offer after a real redemption. The first live check after applying the migration should be
the three `has_*_privilege` queries in the migration instructions plus one real skip from a
test account.
