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

### Migration instructions

Superseded by "Release readiness (2026-10-15)" below, which orders the permission checks
and the denial checks before any admin grant.

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

## Release readiness (2026-10-15)

### 1. Shared environment, verified read-only

Checked through the connected Supabase tools on project `lahahztitoqjumrxjcim`
("Paper Trellis + Verastar", the only active Verastar project; `citwmyotcgiyexpkhpsp` is
INACTIVE and no database branches exist). Catalog reads only; nothing was changed.

| What | Finding |
|---|---|
| `private.beta_admins`, `public.beta_survey_responses` | do not exist |
| `beta_survey_submit`, `beta_admin_check`, `beta_admin_stats`, `private.beta_payload_count` | do not exist (no function of these names in any schema) |
| Migration history | no `beta_admin` entry; latest entries are the four 2026-10-14 repairs (`20261014192744` to `20261014192812`) |
| 2026-10-14 release | **applied**, contrary to the "not yet executed" header in `docs/SPONSORED_ACCESS_DEPLOY.md` § 0: `digest_claim_release`, `digest_local_day` and `gmail_alias_fail_verify` exist with the expected grants, and all five edge functions were redeployed at 2026-10-14 ~20:00 UTC |
| Prerequisites for this migration | schema `private` exists (owner postgres); `evidence_cache_trusted` exists; `sponsored_accounts.cohort` is not selectable by `authenticated` (only `user_id, active, ends_at`) |
| Default privileges | functions created by postgres in `public` get EXECUTE for `anon`, `authenticated`, `service_role` by default; the global function default is revoked (only postgres); tables in `public` default to `anon`/`authenticated` insert, select, update. The migration's explicit revokes cover all three. |
| `authenticated` USAGE on schema `private` | **true** live (false in the local fixture). Denial of `private.beta_admins` and the helper therefore rests on the table and function privileges, which the check script verifies directly. |
| Data on record | 5 sponsored accounts (3 active); events: 80 `digest_scheduled_run`, 51 `digest_run`, 32 `digest_opened`, 5 `sponsored_enrolled`; 49 `evidence_cache_trusted` rows; 145 auth users |
| Enrollment switches | `spending_paused = false`, `enrollment_paused = false`, `enrollment_limit = 100` |
| Invites | 5 rows: `beta-2026` (1/100, no expiry), `founder` (1/1), `friends` (1/6, expires 2026-12-31), two 2026-10-12 QA codes (one revoked, one open 1/1). Codes themselves were not read out. |
| Frontend | Netlify site `verastar` → `https://verastar.papertrellis.com`, production deploy from branch `main` at `c65fc47`, published 2026-10-14 19:17 UTC, framework vite, `manual_deploy = false`. A merge to `main` must be treated as a production deploy. The read-only API reports `deploy_source = "api"`, so whether the trigger is the GitHub integration or a CLI push could not be confirmed. |

Conclusion: no earlier version was applied anywhere, so the in-place migration stands and no
corrective migration is needed.

### 2. Release procedure (ordered; nothing here has been executed)

Checks come before the grant. Steps 2 to 4 happen with an empty allowlist.

1. **Frontend first, or together.** The client tolerates a missing migration: `beta_admin_check`
   errors read as "not admin" and a failed `beta_survey_submit` is swallowed. Merging to `main`
   deploys the frontend; apply the migration at any point after, in a quiet moment.
2. **Apply** `supabase/migrations/20261015120000_beta_admin_dashboard_survey.sql` once, in its
   own transaction, as postgres (SQL editor or `supabase db push`). Dependencies are already
   live (step 1 of the table above).
3. **Run** `supabase/ops/beta_admin_release_checks.sql` as postgres. It verifies, read-only:
   objects and RLS; owner postgres, `SECURITY DEFINER` on the three RPCs, `SECURITY INVOKER` on
   the helper, `search_path = ''` on all four; EXECUTE on every RPC and the helper for `anon`,
   `authenticated`, `service_role` and PUBLIC; no client write grant on the survey table and no
   client access to `private.beta_admins`; the column list participants can select (status
   columns only, never `cohort` or the four answers); exactly one policy (own-row select);
   the allowlist is empty; and, impersonating a signed-in non-admin and then `anon` with the
   allowlist empty, that `beta_admin_check` is false, `beta_admin_stats` and the helper are
   refused (42501), and `beta_survey_submit` is refused for an account with no sponsored row and
   writes nothing. It ends with `ALL CHECKS PASSED` or raises on the first failure. Locally it
   passes on a database built from every migration.
4. **Live denial through the real gateway** (smoke-test plan, part B, below) with a signed-in
   non-admin account: no "Beta admin" entry in Settings; `rpc('beta_admin_stats', …)` answers
   42501; `from('beta_survey_responses').select('cohort')` is refused.
5. **Only then grant**: `insert into private.beta_admins (user_id, note) values ('<your
   auth.users.id>', 'owner');` Re-run step 3's privilege sections if you like; the allowlist
   check will now report one row, which is expected after this step.
6. **Confirm** in the app: Settings shows "Beta admin" for the granted account; the counts
   match a direct `select public.beta_admin_stats(now() - interval '30 days', now())` run as
   that user; the 30-day defaults cover existing records (see the data on record above).
7. **Rollback** is the five statements in the migration header; the frontend needs no change
   to survive them.

### 3. Live smoke-test plan (for approval; nothing executed)

**Environment.** The production project `lahahztitoqjumrxjcim` and its deployed edge
functions. There is no staging project or database branch, so every record below is a real
row on the shared database. The frontend can be either `https://verastar.papertrellis.com`
after the merge, or the branch run locally (`npm run dev` with `.env` pointing at the
production URL and anon key) before the merge; the plan is the same. No digest is run and no
model call is made: the tester stops at "You are all set" and never presses Continue, because
the interview step that follows makes paid model calls.

**Accounts** (all created by the tester; none exist today).

| Account | Purpose | Notes |
|---|---|---|
| QA-1, a fresh non-Gmail address you control | sign-in, redemption, survey **submit**, idempotency | Gmail addresses take the canonical-Gmail path; use a plain mailbox for the first run. |
| QA-2, a second fresh address | sign-in, redemption, survey **skip**, non-admin denial after redemption | |
| QA-3, a third fresh address | signed-in but never redeems | non-beta denial: survey RPC and admin RPC both refused |
| Your own account | admin grant and dashboard check, after parts A and B | the only account that ever enters `private.beta_admins` |

Redemption requires an NPI receipt. The receipt is not unique across accounts, so the tester's
own NPI can be matched on QA-1 and QA-2.

**Records created or changed, in order.**

1. One invite row for the test: `insert into sponsor_invites (code, cohort, max_uses,
   expires_at, note) values ('<new code>', 'smoke-qa-20261015', 2, now() + interval '7 days',
   'release smoke test')`. Same pattern as the two 2026-10-12 QA codes.
2. By the test itself: two `auth.users`, two `sponsored_accounts` rows (cohort
   `smoke-qa-20261015`), `events` rows (`app_opened`, `invite_attempt`, `npi_attempt`,
   `sponsored_enrolled`), and two `beta_survey_responses` rows (one completed, one skipped).
   QA-3 creates one `auth.users` row and `app_opened` events only.
3. Cleanup, after the run: `update sponsor_invites set revoked_at = now() where cohort =
   'smoke-qa-20261015'`; `update sponsored_accounts set active = false where cohort =
   'smoke-qa-20261015'` (the 2026-10-12 QA accounts were left inactive the same way);
   `delete from beta_survey_responses where cohort = 'smoke-qa-20261015'` so the dashboard's
   counts are not seeded with test answers. The auth users may stay. No `digest_schedules`
   row is created by this plan, so cron never picks these accounts up; deactivating them makes
   that doubly true.

**Access changes.** Exactly one: your user id inserted into `private.beta_admins` at part C.
Nothing else is granted, no edge function is redeployed, no secret changes.

**Part A, sign-in and redemption** (QA-1, then QA-2). Open the app signed out → "Set up my
digest" → email code sign-in with the QA address → connect step → enter the smoke code →
NPI step with the tester's NPI → redemption answers enrolled → the survey appears.
Expected: `sponsored_accounts` row created; `events.type = 'sponsored_enrolled'` written.

**Part A, survey.** QA-1 answers all four and sends: a `beta_survey_responses` row with
`status = 'completed'`, `survey_version = 'signup-v1'`, `cohort = 'smoke-qa-20261015'`, four
option codes. QA-2 presses "Skip for now": a row with `status = 'skipped'` and null answers.
Both land on "You are all set". Stop there and sign out.

**Part A, idempotency.** Signed in as QA-1, from the browser console: `await
supabase.rpc('beta_survey_submit', { p_wave: 'signup', p_version: 'signup-v1', p_status:
'skipped', p_answers: {} })` answers `{ status: 'already', recorded_status: 'completed' }`
and the row is unchanged. Repeat as QA-2 with a completed payload: `already` /
`skipped`.

**Part B, denials** (before any grant). As QA-2: Settings shows no "Beta admin"; console
`rpc('beta_admin_check')` is `false`; `rpc('beta_admin_stats', { p_from, p_to })` fails with
code 42501; `from('beta_survey_responses').select('status')` returns the own row and
`.select('cohort')` is refused (permission denied). As QA-3 (never redeemed):
`rpc('beta_survey_submit', …)` fails with 42501 and no row appears. Signed out (anon key only):
`rpc('beta_admin_check')` is refused.

**Part C, admin** (your account). Insert the allowlist row, reload, open Settings: "Beta admin"
appears; the dashboard loads the last 30 days; "Surveys completed" and "Surveys skipped" each
read 1 as recorded while the QA rows exist; the four answer tables show the QA-1 choices. Then
run the cleanup above and confirm the survey rows read 0.

**Out of scope here**, per instruction: redemption from Settings for an existing account,
survey invitations to existing users, the day-30 wave, welcome emails, any digest or model
call.

### 4. Approval needed before any of this runs

Merging the branch (which deploys the frontend), applying the migration to the shared
project, creating the smoke invite and accounts, inserting the allowlist row, and the cleanup
statements are all actions on live systems. None has been taken.

## Release log (2026-10-15)

Executed with the owner's approval of 2026-10-15. All times UTC.

1. **Migration applied to the production project** `lahahztitoqjumrxjcim` through the Supabase
   MCP SQL executor, in four chunks (allowlist table; survey table with grants and policy;
   helper, admin-check and survey-submit functions; stats function), each with
   `lock_timeout = '5s'`. Object definitions, grants and the policy are identical to
   `supabase/migrations/20261015120000_beta_admin_dashboard_survey.sql` at 0c523b0; only the
   outer `begin`/`commit` and the one `drop policy if exists` (no policy existed) were omitted.
   The `apply_migration` tool and one large `execute_sql` batch timed out at the tool's 60 s
   limit three times without reaching the database (verified: no objects, no history row, no
   session); smaller batches went through immediately. A history row
   `20261015120000 beta_admin_dashboard_survey` was inserted into
   `supabase_migrations.schema_migrations` so the CLI treats the file as applied.
2. **Release checks** (`supabase/ops/beta_admin_release_checks.sql`, sections 1 to 5) passed on
   production with the allowlist empty: objects and RLS; owner postgres, SECURITY DEFINER on
   the three RPCs, SECURITY INVOKER on the helper, empty `search_path` on all four; EXECUTE
   matrix for anon / authenticated / service_role / PUBLIC; no client writes on the survey
   table; participant column access limited to status columns; one own-row select policy;
   impersonated non-admin: check false, stats 42501, survey submit 42501 for a non-beta
   account, helper 42501; anon 42501; nothing written.
3. **Functional probe on real data**, inside one block that raised at its end so every write
   rolled back (both tables held 0 rows before and after): a real inactive QA account was
   temporarily allowlisted and, impersonated through the RPCs, got a full stats payload for
   the last 30 days (5 sponsored accounts, 80 scheduled ticks over 25 user-days, 23
   generated, 126 scheduled summaries, 6 browser runs, 32 opens, 49 cached extractions);
   survey submit answered `recorded` then `already` with the first status kept; the own-row
   `status` read worked and a `cohort` read was refused (42501).
4. **Merged** `beta-admin-dashboard-survey` into `main` as `96dccee`; Netlify production
   deploy `6ad0e96da318f584b4d6b1be` from that commit published at 14:56:00 UTC to
   https://verastar.papertrellis.com.
5. **Bundle verification.** The container's egress proxy refuses the Supabase host and the
   Netlify hosts, so the deployed page could not be fetched from here. Instead the same commit
   was built with `vite build` and served with `vite preview`, and the 47 app-shell
   scenarios ran against that production bundle with the fake backend: all passed.

### Completed later the same day (owner approvals of 2026-10-15)

6. **Admin grant.** The founder account was inserted into `private.beta_admins`;
   `beta_admin_check()` answers true for it and `beta_admin_stats` returns the live payload.
7. **Gateway-level anonymous checks** (after the environment's network policy allowed the
   Supabase host): with the anon key, all three RPCs and the survey table answer 42501, and
   schema `private` is not exposed by the API at all.
8. **Live walk-through on production** with the owner-approved sample account
   (mchughbot@gmail.com). Reset before the run: its profile record was renamed
   (`profile/me` → `profile/me.pre-smoke-20261015`, recoverable) and its sponsored-access row
   (cohort `beta-2026`, invite `BETA-105E0CEFA2`) removed through a single-row delete; a
   one-use invite in cohort `smoke-qa-20261015` was created. Then, in a real Chromium against
   https://verastar.papertrellis.com: sign-in with the emailed six-digit code (read from the
   mchughbot inbox), redemption through the deployed `redeem-invite` function (`enrolled`),
   the survey offered on the connect step, four answers sent, "You are all set" shown, no page
   errors, and the run stopped before Continue (no model call). Production rows after the run:
   one `beta_survey_responses` row (`completed`, `signup-v1`, cohort `smoke-qa-20261015`,
   codes `find_papers, weekly, 30_60m, 4`), the sponsored row in cohort `smoke-qa-20261015`,
   invite uses 1/1, events `invite_attempt` and `sponsored_enrolled`. The owner's dashboard
   payload now reports one completed survey with those answer counts. These test records are
   left in place and are identifiable by the cohort label.

Still not exercised live: a survey **skip** through the UI (covered by the simulated shell
run and the SQL tests) and the dashboard page viewed in a browser as the owner (the owner
verifies that by opening Settings → Beta admin).
