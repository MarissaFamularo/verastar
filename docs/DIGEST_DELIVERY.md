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
| finished, with papers, opened | 0 |
| finished, with papers, unopened | +1 |
| empty (no papers) | unchanged |
| scheduler run still mid-flight | unchanged |
| none, or not a daily record | unchanged |
| any, when the reader pressed "run now" | 0 |

If the next streak would reach 7 and the tick is not manual, the account is paused:
`paused_at` is stamped once, a `digest_paused` event is recorded, and one pause email is
sent. Otherwise the unopened digest is replaced like any other, and the new streak is
stamped at claim time (fenced on the claim token), which also clears `paused_at`.

Resuming needs no new action: the app stamps `openedAt` when a digest is shown, the next
tick computes streak 0, and the run proceeds at the usual hour. "Run now" resumes too.

`digestGate` and `schedulerMayRun` are unchanged; the handler now passes `mayRun: true`.
The gate's `last digest unopened` reason is no longer produced by the scheduler.

**Cost bound.** An account can now spend up to seven digest-days without a single open,
about $1.60 at the observed average, inside the $3.00 daily and $25 monthly caps.

### Email on every finished scheduled digest

After a cron run finishes `done` with papers and still owns its claim, the handler reads
the stored digest back and sends it (`../_shared/digestEmail.js`):

- Subject: the top paper's title.
- Body: up to five items in digest order; title, authors, journal, year; the triage
  finding, labelled **"Checked against the source text."** only when the triage check
  verdict is `supported`, otherwise **"Not checked against the source text; read the
  abstract."**; the relevance line; the PubMed link; the open-access link when one exists.
  A finding the number guard withheld is omitted.
- Footer: why the reader gets it (their hour and timezone), how to stop it (Settings,
  "Run automatically"), and a reply line when a reply-to address is configured.

Nothing is generated at send time. No model call, no new numbers, no new citations: the
email shows exactly what the app would show. Manual runs are not emailed (the reader is in
the app). A run that lost its claim sends nothing.

Outcomes are events on the account: `digest_emailed` (`papers`, `provider_id`),
`digest_email_failed` (`error`), `digest_paused` (`streak`), `digest_pause_emailed`,
`digest_pause_email_failed`. A send failure never fails the run.

The runtime (`digest-run/index.ts`) builds the sender only when `RESEND_API_KEY` and
`DIGEST_EMAIL_FROM` are both set. Without them the scheduler behaves exactly as before,
minus the freeze.

### Settings

The morning-digest block says digests are emailed and explains the pause; a paused row
shows "Paused since" with how to resume. `digestRefusalMessage` knows the new reason.

## Files

- `supabase/migrations/20261025120000_digest_unopened_pause.sql`
- `supabase/functions/_shared/digestEmail.js`, `src/lib/digestEmail.test.js`
- `supabase/functions/digest-run/handler.js`, `index.ts`; tests appended to
  `src/lib/digestRunHandler.test.js`
- `src/lib/digestSchedule.js`, `src/components/DigestSchedule.jsx`
- `scripts/founder-recapture-email.mjs`
- `supabase/tests/run_spending_tests.sh` (applies the new migration before the SQL tests)

The function bundle is unchanged: no file under `src/` that the bundle manifest names was
edited, so `npm run bundle:functions` is not needed for this release.

## Release

Order matters only in that the handler reads two columns the migration adds.

1. `npm test`, `npm run lint`, and `supabase/tests/run_spending_tests.sh` against a local
   server, from the commit being released.
2. **Resend.** Create an account, add the sending domain (`verastar.papertrellis.com` or a
   subdomain such as `mail.verastar.papertrellis.com`), and add the DNS records it asks for
   (SPF, DKIM, and the return-path CNAME) at the DNS host for `papertrellis.com`. Wait for
   Resend to show the domain verified. Create an API key with send permission only.
3. **Secrets** on the project's Edge Functions:
   `RESEND_API_KEY`, `DIGEST_EMAIL_FROM` (for example
   `Marissa at Verastar <digest@verastar.papertrellis.com>`),
   `DIGEST_EMAIL_REPLY_TO` (a mailbox Marissa reads), and optionally `APP_URL`.
4. **Apply the migration** (one transaction, additive, no function changes).
5. **Deploy** `digest-run` from the released commit, as in
   `SPONSORED_ACCESS_DEPLOY.md` § 4b.
6. **Smoke test** with the founder account: turn the schedule on, open the current digest,
   wait for the next tick after the hour, or press "run now" (which is not emailed, by
   design) and then check `events` for `digest_emailed` after the next scheduled run.
   Confirm the email renders in Gmail on a phone.
7. **Unfreeze happens by itself.** Every account that was frozen on an unopened digest has
   `unopened_streak = 0`; on the first tick after its hour, the streak becomes 1 and a fresh
   digest is built and emailed.

Rollback: unset `RESEND_API_KEY` to stop email without redeploying; redeploy the previous
`digest-run` to restore the freeze rule. The columns may stay.

## Recapture

After step 7 has produced fresh digests (the morning after release), send the founder
email once:

```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... RESEND_API_KEY=... \
DIGEST_EMAIL_FROM="Marissa at Verastar <digest@verastar.papertrellis.com>" \
DIGEST_EMAIL_REPLY_TO="..." \
node scripts/founder-recapture-email.mjs                      # dry run: who gets what, first email of each kind
node scripts/founder-recapture-email.mjs --only you@example.com --send   # one test send
node scripts/founder-recapture-email.mjs --send
```

Segments: **digest** (onboarded, schedule on, a digest with papers from the last 36 hours)
gets the founder note with today's items; **setup** (not onboarded, or schedule off) gets
the one step that is left; anyone else is listed with the reason and skipped. Every send
is recorded as a `founder_email_sent` event and never repeated. Send Tuesday to Thursday,
in the morning.

## Measuring

Email opens and clicks are in the Resend dashboard. In the project: `digest_emailed`
per account-day, `app_opened` after an email (the link carries `?src=digest-email`;
`app_opened` does not yet record the source), `digest_opened`, and day-7 return by
enrollment cohort. The beta dashboard RPC does not count the new events; adding
`digest_emailed` to it is a separate change.

## Known limits

- `app_opened` does not record `?src=`, so attribution of an open to an email is by
  timing only until the client logs it.
- Replacing an unopened digest means a reader who returns on day four sees day four's
  digest, not days one to three. The earlier ones are in their inbox.
- One email per account per day at most (the `ranToday` gate), but a day with an error
  after `done` cannot happen, and a `done` with zero papers sends nothing.
- `List-Unsubscribe` headers are not set; the footer names the Settings switch.
