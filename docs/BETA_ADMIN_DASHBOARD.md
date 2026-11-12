# Beta admin dashboard and signup survey

Design of the admin-only beta dashboard and the optional signup survey: authorization,
data endpoints, storage, metric definitions and known limits.

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

## Design

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
- `scripts/shell-scenarios/` — drives the real app shell against a simulated backend with
  synthetic accounts (see that README).

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

### Known limits

- **Admin authorization did not exist.** The allowlist table is new; until you insert your user id
  nobody can open the dashboard. Decide whether a SQL-managed allowlist is acceptable for the beta.
- **Verifier reasons** cannot be reported without adding instrumentation to the pipeline (excluded).
- **Delivered digests** were not recorded when this dashboard was built. Since the delivery
  change (docs/DIGEST_DELIVERY.md) each emailed digest is a `digest_emailed` event; the RPC
  does not count it yet.
- **Survey only on the onboarding connect step.** A code redeemed later from Settings does not offer it.
- **Small cells.** With few users a per-option count of 1 identifies that user's answer to the admin.
  The survey copy and the dashboard both say so; answers are account-linked, not anonymous.
- **Day-30 wave** is built (`20261111120000_beta_survey_day30.sql`); see "Day-30 survey" below.

### Day-30 survey

Same table, same rules as signup: option codes only, first write wins, answers linked to
the account and never readable back by the participant. One difference: **the day-30 wave
cannot be skipped.** `beta_survey_submit` refuses a day-30 `skipped` status, so beta
testers are asked until they answer.

- **Who and when.** Opens 30 days after `sponsored_accounts.created_at`. The server refuses a
  day-30 answer before then (`beta_survey_submit`), so the app and the email only decide when
  to ask. An account whose access ended may still answer.
- **Questions.** The three habit questions from signup, word for word (`read_frequency`,
  `weekly_time`, `confidence`), plus `digest_fit` ("How well do the papers in your digest
  match your work?", 1–5) and `if_gone` ("How would you feel if you could no longer use
  Verastar?": very / somewhat / not disappointed, or stopped using it). No `reason`.
- **Where it is asked.** A card above the digest while `beta_survey_day30_state()` says
  eligible and nothing recorded. It has no Skip; "Not now" (on the card and in the open
  form) hides it for that visit and records nothing, so it returns on the next one. Every
  digest email from day 30 carries one tracked line (click kind `survey`, link
  `?survey=day30`, which opens the form directly) until the account answers. After
  answering, the card offers the existing "Send feedback" box for anything in words.
- **Dashboard.** `beta_survey30_stats()` (admins only, all time, test accounts excluded):
  accounts past day 30, how many of them have answered, the five answer tables, and the paired change
  for accounts that completed both waves: confidence higher / same / lower and weekly time
  less / same / more. Direction only, no per-account values. Small cells identify people,
  as with signup.

### Share clicks

`paper_share_clicked` records one invocation of the existing paper Share handler,
including cancellation or unavailable sharing. The payload contains only the UI surface;
`events.user_id` attributes it to the signed-in account under existing RLS. It does
not record recipients, clipboard data, paper text, or successful delivery. Telemetry
is fire-and-forget and does not delay native sharing or email opening.

The Paper sharing section shows total clicks and distinct sharers in the selected
half-open time range. Like adoption, it includes enrolled beta accounts only, excludes
the smoke cohort and accounts excluded at enrollment, and applies explicit test
intervals at event time. Pre-enrollment and future events are excluded. Historical
`paper_shared` outcome events remain meaningful adoption activity but are never
backfilled as clicks. No retained click events means Not available, rather than
asserting zero before instrumentation existed.

Release prerequisite: apply `20261015233845_share_click_metrics.sql` before releasing
the frontend. It replaces `beta_release_stats` with the same admin/range checks,
adds aggregate counts and earliest-retained coverage, and recognizes clicks as adoption
activity. No new table, changed RLS policy, backfill, or production application is
part of this change. Before migration, the new rows safely display Not available.

### Digest email (2026-10-26)

`20261026151000_beta_email_engagement_metrics.sql` (proposed, not applied). Every link in
the digest and pause emails goes through the signed `digest-click` function, which records
`digest_link_clicked` (docs/DIGEST_DELIVERY.md § Engagement). Since the digest is read by
email, a click is meaningful use: it counts toward "Used in last 72 hours", "Returned
users" and week-1 retention exactly like an in-app digest open.

The RPC gains an `email` block, with the same enrolled-beta population and test
exclusions as `shares`: `clicks` and `clickers` (digest_link_clicked in range),
`unsubscribes` (distinct accounts with `digest_email_unsubscribed` in range), `resumes`
(the pause email's button, `digest_resume_clicked`), and `email_off_now` (enrolled
accounts with `email_digest` off, not range-dependent). The overview shows an "Email
unsubscribes" card; the detailed view has a "Digest email" section. Limits: there is no
open pixel, so reading without clicking is invisible, and mail gateways that pre-follow
links for scanning are recorded as clicks.
