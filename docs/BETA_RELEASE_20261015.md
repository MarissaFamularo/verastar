# Beta release review — 15 October 2026

Four scoped changes, based on remote main `8dc9560e3162deb8e9dfd32205598b4942cd7c23`.
Branch: `codex/beta-release-20261015`. Isolated checkout; existing checkouts untouched.

- Full-width admin (full-screen on mobile), real enrollment / meaningful 72-hour use / return / mature week-1 retention cards. Surveys are separate; definitions and technical diagnostics are collapsed. Existing private admin allowlist and survey grants/RLS remain unchanged.
- Prominent today/month sponsor API usage and blended cost per completed digest. Paid failures/retries and test spending remain included. Outstanding reservations are separate, never added twice. BYOK, provider credit balance, and grant-versus-cash breakdown are unavailable and labeled.
- Deterministic enrollment/digest observations, overdue work check, independent monitor heartbeat, sustained-incident/recovery outbox, redacted SMTP payloads. Delivery defaults off in both database and environment. No model monitoring calls.
- Optional beta code; alternate enrollment requires verified email plus server-owned individual physician NPI/name match. It reuses the existing global enrollment lock, limit, pause, per-account defaults, and spend protections. Existing invite flow is preserved. No identity-verification claim or process was added.

## Independent release review

Review of `d93eaaf` found two blockers, now corrected: multiple accounts could enroll with the same NPI, and monitor ticks could replay an old/abandoned completion timestamp as fresh success. A service-only persistent NPI claim now protects both enrollment paths; existing accounts remain unchanged. Claim seeding locks enrollments through trigger installation. Monitor ticks record heartbeat and overdue failures only; actual new outcomes provide successful evidence. Completion accounting also excludes explicitly lost scheduler claims. Read-only production privilege inspection found that `service_role` cannot directly read `auth.users`; the new enrollment RPC is therefore security-definer with an empty search path and execution restricted to service_role. A test revokes direct auth-table access and verifies that enrollment still works while client calls remain denied.

Targeted regressions cover different-account/same-NPI concurrent requests, both enrollment paths, unchanged invite uses, receipt changes, preserved existing access, abandoned schedules, and stale success. Independent follow-up review confirmed the corrections, including the added migration lock. The production privilege compatibility fix was also independently reviewed.

## Review images (synthetic data, real app)

[Desktop admin](screenshots/beta-release/shell-admin-desktop.png) · [Mobile admin](screenshots/beta-release/shell-admin-mobile.png) · [Mobile join](screenshots/beta-release/join-without-code-mobile.png)

## Verification

- `npm test`: 135 files; 2,584 passed, 3 existing expected failures, 15 existing todo.
- `npm run lint`: no new diagnostics (9 baseline errors, 9 baseline warnings).
- `npm run build`: passed; existing SDK browser-externalization and bundle-size warnings.
- `npm run bundle:functions`: passed; generated pipeline bundle unchanged.
- Deno check: monitor, invite, and NPI endpoints passed. Deno runtime suite: 7 passed, synthetic/local network only.
- Disposable PostgreSQL: existing admin/survey contract and new release contract passed; includes unauthorized access, test exclusions, activity dedupe, cohort maturity, missing/stale health, incident/recovery dedupe, disabled/uncertain mail, enrollment pause/cap/retry, spending separation.
- Parallel enrollment: 12 requests → one enrollment and 11 idempotent replies; competing invite/NPI last-slot requests → one enrollment, one full response; different accounts sharing one NPI → one enrollment, one NPI-conflict response.
- Existing spending contract and all 74 concurrency checks passed.
- Real Chromium app-shell scenarios with fake Supabase, synthetic accounts, external requests blocked: desktop/mobile, optional-code survey handoff, existing invite survey paths, keyboard/focus, non-admin entry denial. Evidence in `screenshots/beta-release/shell-results.txt`.

## Release gates — not executed

1. Approve release, then apply forward migrations `20261015180000_beta_release.sql`, `20261015181000_beta_monitor.sql`, `20261015182000_beta_release_review.sql`, and `20261015183000_beta_expected_work.sql` after the existing dashboard migration. Deploy `match-npi`, `redeem-invite`, `digest-run`, `beta-monitor`, and the frontend. Old dashboard RPC remains available during rollout.
2. Approve setting `sponsor_config.npi_enrollment_enabled=true`. It defaults false. Leave the existing enrollment pause/limit and every budget unchanged; no live values were assumed or modified. New NPI accounts inherit existing default daily/monthly caps and are limited by the same global/beta ceilings.
3. Confirm an alert recipient and approve reusing the existing Resend SMTP provider before enabling delivery. Read-only Auth configuration inspection verified `smtp.resend.com`, port 465, with SMTP user/password and sender fields populated; the custom send-email hook is disabled. These credentials are configured for Supabase Auth only, not currently exposed to app Edge Functions. No credential value or sender address was printed. Provider credential scope and approved app reuse remain unverified; no new provider is required by this implementation. Read-only inspection of live Edge secret **names** found no SMTP or beta-alert settings; schema inspection found no notification-recipient configuration. One allowlisted admin has a confirmed email, but no recipient is designated. The adapter expects `SMTP_HOST`, `SMTP_PORT` (465/587), `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, and `BETA_ALERT_RECIPIENT`. These are proposed configuration names, not settings already present. No secret values were exposed, credentials created, or live emails sent. Only after approval/configuration and a controlled delivery check, set both `BETA_ALERTS_ENABLED=true` and `private.beta_alert_config.enabled=true`.
4. Approve an independent monitor invocation every five minutes using the service role. No job was installed and the digest scheduling policy was not changed. `beta-monitor` accepts POST and requires the service-role bearer token in addition to the gateway check.

## Exact operational limits

Meaningful use is digest-open/view or paper interaction, never generation, app launch, or access permission. Retention denominator includes every real enrollment since the migration's observation start that is at least 14 days old; numerator used on days 7–13. Earlier historical events remain observational; a full new cohort needs 14 days. Empty eligible denominator is “Not ready.” Counts can understate activity when client telemetry is missing/deleted.

The exact known smoke cohort is excluded from adoption; its earlier survey is excluded without editing the row. Additional exclusions must use reviewed `private.beta_test_exclusions` time intervals so historical real use is preserved. Test spending is never filtered. No known smoke profile, enrollment, or schedule row was altered.

The blended average uses current-month sponsor ledger usage (all features/failures/retries/test work) divided by recorded completed scheduled user-days plus non-append browser digest completions for sponsored accounts. This is not precise per-job attribution, not a provider invoice, and not a claim that grant usage is cash charged. Released unpriced attempts remain disclosed separately.

Green now means **Monitor active · schedule on track**: heartbeat and expected-work checks succeeded within 15 minutes, no sustained incident remains open, and no unresolved mail failure exists. Signup/digest outcomes remain separately labeled last-observed evidence (with timestamps), or untested; normal inactivity does not expire them or prove signup capability. Sustained failures stay red until recovery, even if monitoring later stops.

Expected work uses the existing local daily hour/timezone, active access, and unopened-digest gate. The actual scheduler has no weekly cadence or next-due column; no weekly policy was invented. An unopened completed digest may wait more than a week without overdue status. A newly opened old digest receives a fresh two-hour grace period. A single expected slot overdue by two hours opens one schedule incident immediately, without needing repeated digest attempts; repeated ticks deduplicate it and resolved expected work produces one recovery. Invalid timezones cannot produce a passing check. Enrollment/digest outcome incidents still require three failures spanning five minutes within 30 minutes. No scheduling policy, ranking, verifier, or summary behavior changed. An absent monitor cannot email about its own outage; the dashboard marks its heartbeat stale.

Independent follow-up review also corrected completion-before-hour, activation-after-hour, and opening-before-hour cases. A stable monitor activation timestamp prevents failed retries from postponing the first expected digest; existing schedules receive a rollout grace period.

Follow-up verification: 20 focused UI/monitor tests passed, full disposable admin/release SQL contracts passed (quiet daily, future due, single stuck digest, incident/recovery dedupe, week-long unopened wait, newly opened grace, invalid timezone, stale heartbeat), full suite 2,584 passed (3 existing expected failures, 15 todo), all browser shell scenarios passed with refreshed desktop/mobile images, build passed, lint has no new diagnostics.

Outbox claims are serialized and at most once. SMTP acceptance is not inbox delivery; uncertain/failed sends are marked visibly and held for operator review rather than automatically resent. Verify provider delivery before manually retrying a claimed message. These deliberate limits prevent duplicate incident email after an uncertain send.

Read-only live inspection was limited to secret names and configuration/admin-email-confirmation metadata. No merge, push, deploy, live migration, live account change, model call, or live email occurred.
