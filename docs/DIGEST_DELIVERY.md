# Digest delivery and the unopened-digest pause

Design and release notes for emailing the morning digest and for replacing the
freeze-after-one-unopened rule with a pause after seven. Proposed 2026-10-25; nothing
here is deployed or applied until the release steps below are run.

## Why

The beta opened on 2026-10-18 and by 2026-10-25 had 49 enrolled clinicians (cohorts
`beta-npi`, `beta-intl`). The funnel from the project's own tables:

| Step | n |
|---|---|
| Enrolled | 49 |
| Finished onboarding with north stars | 44 |
| Schedule on | 40 |
| Received a digest with results | 40 |
| Opened a digest, any day | 36 |
| Saved a paper, any day | 17 |
| Returned to the app after enrollment day | 11 |
| Returned on two or more later days | 4 |

Activation was fine. Two mechanics then stopped everyone:

1. **Nothing was delivered.** The scheduler wrote each digest to `kv` and no channel told
   the reader. `docs/BETA_ADMIN_DASHBOARD.md` said so: "Delivery is not recorded anywhere."
2. **One unopened digest froze the account.** `schedulerMayRun` (src/lib/digestStore.js)
   refused to replace a finished digest nobody had opened, and `digestGate` returned
   `last digest unopened`. On 2026-10-25, 39 of 40 enabled beta schedules sat on an
   unopened digest; 32 had not run for two days or more. The founder account, opened
   daily, never hit this.

A digest day costs about $0.23 per account (median $0.21, max $0.62 over 86 account-days),
so cost was never the constraint.

## What changes

### Pause after seven, not freeze after one

`digest_schedules` gains two service-role-written columns
(`supabase/migrations/20261025120000_digest_unopened_pause.sql`):

- `unopened_streak`: consecutive finished digests with papers that were replaced without
  being opened.
- `paused_at`: set when the streak reaches `PAUSE_AFTER_UNOPENED` (7).

`digest-run/handler.js` computes the next streak from the stored digest each time it
considers an account (`nextUnopenedStreak`, pure, tested):

| Previous digest | Streak |
|---|---|
| finished, with papers, opened or engaged with (see Engagement) | 0 |
| finished, with papers, no sign of the reader since it was built | +1 |
| empty (no papers) | unchanged |
| scheduler run still mid-flight | unchanged |
| none, or not a daily record | unchanged |
| any, when the reader pressed "run now" | 0 |

If the next streak would reach 7 and the tick is not manual, the account is paused:
`paused_at` is stamped once, a `digest_paused` event is recorded, and one pause email is
sent. Otherwise the unopened digest is replaced like any other, and the new streak is
stamped at claim time (fenced on the claim token), which also clears `paused_at`.

Resuming needs no new action: the app stamps `openedAt` when a digest is shown, the next
tick computes streak 0, and the run proceeds at the usual hour. "Run now" resumes too, and
so does any of the engagement signals below, including the pause email's button.

### Engagement: email readers are not "unopened" (2026-10-26)

Counting only in-app opens was wrong once the digest was emailed: a reader who reads the
email every morning and never visits the site looked abandoned and would have been paused
after seven days, with an "unopened" notice that was not true (first possible pause about
2026-11-03). Engagement is now any of:

| Signal | Where it is recorded |
|---|---|
| Opening the digest in the app | `openedAt` on the stored record (unchanged) |
| A click on any link in a digest or pause email | `digest-click` stamps `digest_schedules.engaged_at`, records `digest_link_clicked` |
| The pause email's "No, don't pause me" button | `digest-resume` stamps `engaged_at`, clears the pause, records `digest_resume_clicked` |
| A Settings save (any change to the schedule block) | trigger stamps `engaged_at` |
| "Run now" | manual run, streak 0 (unchanged) |

`nextUnopenedStreak(record, current, { manual, engagedAt })` resets to 0 when the record
was opened or `engaged_at` is at or after the record's build time (`ranAt`, else
`savedAt`). An earlier engagement does not count for a later digest. A record with no
build time counts any engagement: a wrong pause is the worse mistake.

**`engaged_at`** (`20261026150000_digest_engagement.sql`) is readable by the reader and
never writable by them. A `before insert or update` trigger stamps it from the database
clock when the writer is the row's own signed-in reader (`auth.uid() = user_id`), which is
exactly the Settings upsert. Service-role writes (digest-run, the unsubscribe link) have no
`auth.uid()` and do not count; `digest-click` and `digest-resume` set it explicitly.

**The click-through link** (`_shared/digestClick.js`, `supabase/functions/digest-click/`).
Every link in the digest email (PubMed, full text, "Open in Verastar") and the pause
email's app link is rewritten to

    digest-click?u=<account>&k=<paper|fulltext|open|pause-open>&p=<paper id>&to=<destination>&t=<HMAC>

The HMAC (SHA-256, `DIGEST_UNSUBSCRIBE_SECRET`, prefix `digest-click:`) covers the account,
kind, paper id and destination together, so the function cannot be used as an open
redirect and nobody without the secret can mark another account engaged. A valid GET
records `digest_link_clicked` with `{ paper_id, kind }`, stamps `engaged_at`, and answers
302 to the signed destination with `Referrer-Policy: no-referrer`. Recording is best effort:
a database failure still redirects. HEAD redirects without recording. A bad token is a 400
page with a link to the app and no redirect. A link that fails to sign at send time is
printed untracked, and the email still goes.

**The resume button** (`digest-resume`, helpers in `_shared/unsubscribe.js`). Same
construction as the unsubscribe link with its own `digest-resume:` prefix, so neither
token works as the other. GET or POST with a valid token clears `paused_at`, sets
`unopened_streak` to 0, stamps `engaged_at`, records `digest_resume_clicked`, and shows
"Thanks. Your digest is back on". A schedule the reader switched off in Settings stays off,
and the page says so. HEAD changes nothing.

### The pause email

Rewritten around the resume button: "We haven't seen a click on your Verastar digest in a
week, so we've paused it", then the button **No, don't pause me. I like these digests!**,
then that doing nothing leaves it paused (no digests built or emailed, nothing deleted), and
that opening Verastar or pressing "Run now" also starts it again. Without the secret
there is no signed button and the email falls back to an "Open Verastar" button.

`schedulerMayRun` is unchanged (it is in the app bundle); the handler now passes
`mayRun: true`, so the gate's `last digest unopened` reason is no longer produced.

### A late morning waits for the next morning

`digestGate` gains one rule: a scheduled run may start at or after the reader's hour and
up to `CATCH_UP_HOURS` (12) after it, not later. A scheduler that missed a 6 am run still
makes it up at noon; it does not email "Good morning" at 11 pm. "Run now" and a run already
in flight ignore the window. This also shapes the release: the 39 accounts the old rule
froze run at their next morning hour, not in a burst the evening the function deploys.

### The monitor follows the new rule

`private.beta_expected_digest_due` (`20261025121000_beta_monitor_due_pause.sql`) encoded
the freeze: an account on an unopened digest was not expected to run, and opening it
"activated" the account. After the release that model would have been silent about the
unopened accounts and loud for the whole first morning (each catch-up run looked days
overdue until it finished; that is also the "schedule: failed" seen at 2026-10-25 23:05Z
during one catch-up run). The new model expects a run or attempt on every local day at
the reader's hour, unless `paused_at` is set; a run in flight counts as an attempt; a
missed earlier slot keeps the account overdue so a dead scheduler cannot read as
recovered for two hours each morning; activation after the hour is due at activation
within the catch-up window and at the next slot after it. The migration re-activates every
enabled schedule (`monitor_started_at = now()`) because the expectation changed then.

**Cost bound.** An account can now spend up to seven digest-days without a single open,
about $1.60 at the observed average, inside the $3.00 daily and $25 monthly caps.

### Built early, delivered at the hour

The reader's hour is when the email lands. A scheduled build may start up to
`BUILD_LEAD_HOURS` (1) before it, which absorbs the morning queue, and every cron tick
first delivers any digest that finished today for an account whose hour has passed and
whose day is not yet delivered. `digest_schedules.delivered_day` records the local day
handled; it is claimed with a compare-and-set before anything is sent, so overlapping
ticks cannot both send and a failed send is not retried that day. A build that finishes
after the hour (a long queue, an outage) is delivered on the tick that finishes it: late
beats missing. A "run now" digest is delivered at the hour like any other, since it is
the day's digest. An empty digest, or an account with the email off, claims the day and
sends nothing. The in-app digest appears as soon as it is built.

### What the email holds

The handler reads the stored digest back and sends it (`../_shared/digestEmail.js`):

- Subject: the top paper's title.
- Body: up to five items in digest order; title, authors, journal, year; the triage
  finding, labelled **"Checked against the source text."** only when the triage check
  verdict is `supported`, otherwise **"Not checked against the source text; read the
  abstract."**; the relevance line; the PubMed link; the open-access link when one exists.
  A finding the number guard withheld is omitted. Every link goes through `digest-click`
  (see Engagement).
- Footer: why the reader gets it (their hour and timezone), the signed unsubscribe link,
  the Settings switch, and a reply line when a reply-to address is configured.

Nothing is generated at send time. No model call, no new numbers, no new citations: the
email shows exactly what the app would show. A run that lost its claim delivers nothing.

Outcomes are events on the account: `digest_emailed` (`papers`, `provider_id`),
`digest_email_failed` (`error`), `digest_paused` (`streak`), `digest_pause_emailed`,
`digest_pause_email_failed`, `digest_link_clicked` (`paper_id`, `kind`),
`digest_resume_clicked` (`via`). A send failure never fails the run.

Resend is already the project's mail service: Supabase Auth sends sign-in codes through
its SMTP relay and `beta-monitor` sends alerts through the same relay with the `SMTP_*`
function secrets. A Resend SMTP password is a Resend API key, so `digest-run/index.ts`
reuses it over the HTTP API: when `SMTP_HOST` is Resend, the key is `SMTP_PASSWORD` and the
sender is `SMTP_FROM`; `RESEND_API_KEY` and `DIGEST_EMAIL_FROM` override either. With no
credentials at all the scheduler behaves exactly as before, minus the freeze.

### Opting out

Three ways, all leaving the in-app digest running:

- **Settings.** "Email me the digest" next to "Run automatically", stored as
  `digest_schedules.email_digest` (default on). The handler sends nothing, and records
  nothing, for an account with it off; that includes the pause notice.
- **The footer link.** `digest-unsubscribe?u=<account id>&t=<HMAC-SHA256 of the id under
  DIGEST_UNSUBSCRIBE_SECRET>`, signed by `digest-run` (`_shared/unsubscribe.js`) and
  honoured by the `digest-unsubscribe` function with no sign-in: one click turns
  `email_digest` off (creating an all-off row when the account has none), records
  `digest_email_unsubscribed`, and shows a plain confirmation page. A wrong token is a
  400 page and changes nothing. The founder mailing uses the same link.
- **The mail client's own button.** Every email carries `List-Unsubscribe` and
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058) pointing at the same
  link; Gmail and Apple Mail POST to it.

Without `DIGEST_UNSUBSCRIBE_SECRET` the emails carry no link or headers and name the
Settings switch only, links are not tracked, and the pause email has no resume button;
the founder script refuses to run without it.

### Settings

The morning-digest block says digests are emailed and explains the pause in terms of any
sign of the reader (a digest opened, a link clicked in the email, a change on that page);
a paused row shows "Paused since" with how to resume. `digestRefusalMessage` knows the new
reason. Saving the block counts as engagement.

## Files

- `supabase/migrations/20261025120000_digest_unopened_pause.sql`
- `supabase/migrations/20261025121000_beta_monitor_due_pause.sql`; tests in
  `supabase/tests/beta_release.sql` via `run_beta_admin_tests.sh`
- `supabase/functions/model/logic.js` (`CATCH_UP_HOURS`), `src/lib/sponsorLogic.test.js`
- `supabase/functions/_shared/digestEmail.js`, `src/lib/digestEmail.test.js`
- `supabase/functions/_shared/unsubscribe.js`, `supabase/functions/digest-unsubscribe/`
  (`handler.js`, `index.ts`), `src/lib/digestUnsubscribe.test.js`, `supabase/config.toml`
- `supabase/functions/digest-run/handler.js`, `index.ts`; tests appended to
  `src/lib/digestRunHandler.test.js`
- `src/lib/digestSchedule.js`, `src/components/DigestSchedule.jsx`
- `scripts/founder-recapture-email.mjs`
- `supabase/tests/run_spending_tests.sh` (applies the new migration before the SQL tests)
- Engagement (2026-10-26): `supabase/migrations/20261026150000_digest_engagement.sql`,
  `20261026151000_beta_email_engagement_metrics.sql`, `supabase/tests/email_engagement.sql`
  (via `run_beta_admin_tests.sh`); `_shared/digestClick.js`, `supabase/functions/digest-click/`,
  `supabase/functions/digest-resume/`, `src/lib/digestClick.test.js`; dashboard in
  `src/lib/betaAdmin.js` and `src/components/AdminDashboard.jsx`

The function bundle is unchanged: no file under `src/` that the bundle manifest names was
edited, so `npm run bundle:functions` is not needed for this release.

## Release

Order matters only in that the handler reads two columns the migration adds.

1. `npm test`, `npm run lint`, and `supabase/tests/run_spending_tests.sh` against a local
   server, from the commit being released.
2. **Resend is already set up.** The domain is verified, the account is on the Pro plan,
   and the credentials are the `SMTP_*` function secrets. Nothing to create. Digests go
   out as "Marissa at Verastar" from the SMTP_FROM address, with replies to
   statupfordocs@gmail.com (both in `_shared/digestEmail.js`).
3. **Secrets** on the project's Edge Functions: `DIGEST_UNSUBSCRIBE_SECRET` (a long random
   string, `openssl rand -hex 32`) is the one new secret. Overrides, none needed:
   `DIGEST_EMAIL_FROM`, `DIGEST_EMAIL_REPLY_TO`, `RESEND_API_KEY`, `APP_URL`.
4. **Apply the two migrations** in file order (each one transaction; the first is
   additive, the second redefines the monitor's due model and re-activates monitoring).
5. **Deploy** `digest-run` and `digest-unsubscribe` from the released commit, as in
   `SPONSORED_ACCESS_DEPLOY.md` § 4b. Do 4 and 5 back to back: the new handler selects
   the new columns and fails closed (no runs) until the migration is in, and the old
   handler would not run the unfrozen accounts the new monitor expects.
   Deploying in the US evening is fine: accounts more than twelve hours past their hour
   wait for the morning; the few whose morning is close (Asia, Australia) run on time. Open an unsubscribe link with a wrong token and
   confirm the 400 page; then test a real one on the founder account and turn the email
   back on in Settings.
6. **Smoke test** with the founder account: turn the schedule on, open the current digest,
   wait for the next tick after the hour, or press "run now" (which is not emailed, by
   design) and then check `events` for `digest_emailed` after the next scheduled run.
   Confirm the email renders in Gmail on a phone.
7. **Unfreeze happens by itself.** Every account that was frozen on an unopened digest has
   `unopened_streak = 0`; on the first tick after its next hour, the streak becomes 1 and a
   fresh digest is built and emailed. The scheduler runs one account per five-minute tick,
   so 40 accounts with the same hour finish over roughly three to four hours; the monitor
   allows two hours past the hour before calling an account overdue, so expect a transient
   "schedule: overdue" on the first morning for the accounts at the back of the queue, and
   none after that. Spreading hours, or a faster tick, is a separate change.

Rollback: set `DIGEST_EMAIL_FROM` to an empty value is not enough (the fallback is
`SMTP_FROM`); turn every account's `email_digest` off in SQL, or redeploy the previous
`digest-run`, which also restores the freeze rule. The columns may stay.

## Release: engagement (2026-10-26)

Not deployed. Do this before 2026-11-03, the first morning a reader who has only read the
email could be paused under the old rule. No new secrets: both new functions use
`DIGEST_UNSUBSCRIBE_SECRET`, already set. The function bundle is unchanged.

1. `npm test` and `supabase/tests/run_beta_admin_tests.sh` against a local server.
2. **Apply** `20261026150000_digest_engagement.sql`, then
   `20261026151000_beta_email_engagement_metrics.sql` (each one transaction, additive; the
   second redefines `beta_release_stats`).
3. **Deploy** `digest-click` and `digest-resume` (both `verify_jwt = false`, in
   `supabase/config.toml`), then `digest-run`. In that order: digest-run selects
   `engaged_at` and starts printing links to the two new functions.
4. **Smoke test** on the founder account: open a tracked link from the next digest email
   and check `events` for `digest_link_clicked` and `digest_schedules.engaged_at`; edit a
   tracked link's `to=` and confirm the 400 page; open a resume link
   (`resumeUrl` in `_shared/unsubscribe.js`) and confirm the page and
   `digest_resume_clicked`.

Rollback: redeploy the previous `digest-run` (emails go back to plain links; the old streak
rule returns). The two functions can stay; the column and trigger are harmless; re-apply
`20261015233845_share_click_metrics.sql` to restore the dashboard RPC.

## Scheduler capacity (decide before release)

The scheduler serves one account per cron tick, and the tick is every five minutes. A
digest takes two ticks (rank, then done), so the cohort as it stands (17 accounts at
6 am Eastern, 10 at 6 am Central, and so on) takes about six hours to get through once
nothing is frozen. The freeze hid this: on 2026-10-21 the 24 runs that did happen
finished between 06:10 and 09:51 Eastern. After the release every account runs every
morning, so the queue is real, the Central and Mountain readers get their "morning"
digest in the afternoon, and the monitor's two-hour grace is exceeded daily.

With the one-hour build lead the queue is invisible to readers until it exceeds the lead:
about six accounts per shared hour at the five-minute tick, about thirty at the per-minute
tick. The fix is a schedule change on the pg_cron job, not code: ticks every minute give
five times the throughput (about 80 minutes for 40 accounts, so the lead covers most of
it) and the claim and spending
contracts already cover overlapping ticks on different accounts (the handler tests
interleave two). **Done 2026-10-26 00:30Z, on the live project**, with:

```sql
select cron.alter_job((select jobid from cron.job where jobname = 'verastar-digest-run'), schedule := '* * * * *');
```

The monitor and alert-dispatch jobs stay at five minutes. To revert, run the same
statement with `'*/5 * * * *'`. `SPONSORED_ACCESS_DEPLOY.md` § 4b still shows the
original five-minute schedule for a fresh project. Watch the first morning's
`digest_scheduled_run` timestamps and the Anthropic rate-limit headers in the function
logs.

## Recapture

After step 7 has produced fresh digests (the morning after release), send the founder
email once:

```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... DIGEST_UNSUBSCRIBE_SECRET=... \
RESEND_API_KEY=<the SMTP_PASSWORD secret> SMTP_FROM=<the SMTP_FROM secret> \
node scripts/founder-recapture-email.mjs                      # dry run: who gets what, first email of each kind
node scripts/founder-recapture-email.mjs --only you@example.com --send   # one test send
node scripts/founder-recapture-email.mjs --send
```

The copy is in the script, in Marissa's words; edit it there and dry-run again. Segments:
**digest** (onboarded, schedule on, a digest with papers from the last 36 hours) gets the
founder note with today's items; **setup** (not onboarded, or schedule off) gets the one
step that is left; an account that opted out of email, and anyone else, is listed with the
reason and skipped. Every send
is recorded as a `founder_email_sent` event and never repeated. Send Tuesday to Thursday,
in the morning.

## Measuring

Email opens and clicks are in the Resend dashboard. In the project: `digest_emailed`
per account-day, `digest_email_unsubscribed`, `app_opened` after an email (the link carries `?src=digest-email`;
`app_opened` does not yet record the source), `digest_opened`, and day-7 return by
enrollment cohort. The beta dashboard counts `digest_link_clicked` as meaningful use
(72-hour use, returned users, week-1 retention) and shows clicks, unsubscribes, resumes,
and accounts with the email off now (`20261026151000_beta_email_engagement_metrics.sql`).
`digest_emailed` itself is still not on the dashboard.

## Known limits

- A click is the only email signal. Reading an email without clicking leaves no trace (no
  open pixel, by choice), so a reader who reads every morning and never clicks is still
  paused after a week; the pause email asks them to press one button.
- Hospital mail gateways that follow links to scan them (URL defence) use GET and are
  recorded as clicks. That errs toward keeping a digest running, never toward a wrong
  pause; the dashboard caveat says so. HEAD probes are not recorded.

- `app_opened` does not record `?src=`, so attribution of an open to an email is by
  timing only until the client logs it.
- Replacing an unopened digest means a reader who returns on day four sees day four's
  digest, not days one to three. The earlier ones are in their inbox.
- One email per account per local day (`delivered_day`). An hour-0 reader's build starts
  at 0, not the day before, so their email lands when the build finishes.
- Delivery lands within one cron tick of the hour: with the five-minute tick, up to five
  minutes late; with the per-minute tick, within a minute.
