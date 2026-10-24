# Bot protection on the email-code request

*Authored 2026-10-24. Owner runbook for CAPTCHA on sign-in and the Auth rate limits.*

## What happened

The shared Supabase project "Paper Trellis + Verastar" (`lahahztitoqjumrxjcim`) is
being used to send sign-in emails to strangers' addresses ("subscription bombing").
Read-only counts on 2026-10-24:

| Measure | Value |
|---|---|
| `auth.users` total | 218 |
| Unconfirmed (`email_confirmed_at is null`) | 73 |
| Unconfirmed that ever signed in | 0 |
| First / latest unconfirmed created | 2026-09-18 / 2026-10-22 |
| Unconfirmed created in the last 3 days | 2 |

The abuse is still happening. It is not limited to the Oct 9–15 burst.

**Which app was used is not established.** `auth.audit_log_entries` is empty, and both
apps create accounts in the same `auth.users` table. Verastar's `signInWithOtp` creates
an account on first send (`shouldCreateUser` defaults to true). A Paper Trellis
`signUp` or OTP form would leave the same unconfirmed rows. The Auth logs (Dashboard →
Logs → Auth, filtered on `path` `/otp` vs `/signup`) can attribute any new events. The
fix below covers both endpoints, but only once **both** apps send a token.

## What the code does now

- `src/lib/captcha.js` gets a Cloudflare Turnstile token for every send and resend.
  The widget is `interaction-only`: most people never see it. When Cloudflare wants a
  click, the widget shows in a fixed panel at the bottom of the screen. This works in
  iPhone Safari and in the installed home-screen app, because it is an in-page iframe
  and not a popup.
- `useEmailCodeSignIn` (`src/lib/emailCode.js`) fetches the token while the Gmail alias
  lookup runs. The token does not count against the 8 s delivery timeout; the check has
  its own 45 s limit. If the widget fails, the send goes out without a token and
  Supabase Auth decides: refused (with a readable message) once CAPTCHA is on, sent
  while it is off. A wrong key or hostname therefore cannot lock anyone out by itself.
- Typed-address route: `sendMagicLink(email, token)` passes `options.captchaToken` to
  `signInWithOtp`. Supabase Auth verifies the token.
- Gmail canonical route: the browser posts `captchaToken` to `gmail-canonical-otp`. The
  function checks the token's shape before it uses the ticket, then passes the token to
  its own anon-key `signInWithOtp`, and Auth verifies it there. The function must
  **not** call `siteverify` itself: a Turnstile token works only once, so a check in
  the function would use it up and Auth would then refuse the send. CAPTCHA protection
  covers the whole project, so Auth refuses this anon-key call without a valid token,
  just as it refuses the browser's call. An Auth CAPTCHA refusal comes back as
  `400 {status: 'captcha'}`.
- CSP (`public/_headers`): `https://challenges.cloudflare.com` is added to
  `script-src` and `frame-src`. Nothing else changed. `scripts/check-netlify-headers.mjs`
  checks both.
- With no `VITE_TURNSTILE_SITE_KEY`, nothing changes. No token is requested and the
  request bodies match the previous ones exactly.

## Owner steps, in this order

The order matters. If CAPTCHA protection is turned on before the deployed bundles
send tokens, **every sign-in on both apps fails**.

1. **Cloudflare → Turnstile → Add widget.**
   - Hostnames: `verastar.papertrellis.com`, `verastar.netlify.app`, `localhost`, plus
     the Paper Trellis hostname(s) if Paper Trellis will share the widget.
   - Widget mode: **Managed**. Pre-clearance: off.
   - Copy the **Site key** and the **Secret key**.
2. **Netlify → Verastar site → Environment variables:** set
   `VITE_TURNSTILE_SITE_KEY=<site key>`. The key is public and lives in the bundle.
   Trigger a deploy.
3. **Deploy the edge function:**
   `supabase functions deploy gmail-canonical-otp --project-ref lahahztitoqjumrxjcim`
   (keeps `verify_jwt = true` from `supabase/config.toml`).
4. **Paper Trellis: blocker.** Its auth calls on this project (`signUp`,
   `signInWithPassword`, `signInWithOtp`, `resetPasswordForEmail`) must also pass
   `options.captchaToken` and be deployed. Supabase CAPTCHA has no per-app setting: it
   gates `/signup`, `/otp`, `/recover` and password `/token` for every client that uses
   the anon key. Token refresh and `/verify` (typing the code) are not gated.
5. Check that the live Verastar bundle sends a token: DevTools → Network → the
   `/auth/v1/otp` request body should contain `gotrue_meta_security.captcha_token`.
6. **Supabase → Authentication → Attack Protection (Bot and Abuse Protection) →
   Enable CAPTCHA protection:** provider **Turnstile**, paste the **Secret key**, Save.
7. Run the hosted checks below right away. To roll back, turn the toggle off; nothing
   else needs undoing.

## Auth rate limits

The current values cannot be read from this session (the Supabase connector does not
expose the Auth config). Read them first:

```bash
export SUPABASE_ACCESS_TOKEN=...   # dashboard → Account → Access tokens
curl -s "https://api.supabase.com/v1/projects/lahahztitoqjumrxjcim/config/auth" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  | jq '{rate_limit_otp, rate_limit_email_sent, rate_limit_verify, smtp_max_frequency, mailer_otp_exp, smtp_host}'
```

Recommended values for a closed beta. Both apps share these limits, so size them for
the real combined volume.

| Setting (dashboard / API key) | Default | Recommend | Why |
|---|---|---|---|
| OTP sends per hour, project-wide (`rate_limit_otp`) | 360 | **30** | Caps how much a bot can send even if CAPTCHA is bypassed. Raise it for a planned onboarding session. |
| Emails sent per hour (`rate_limit_email_sent`, custom SMTP only) | 30 | **30** (no higher) | Covers signup/recover/email change. Hold at 30 unless real volume needs more. |
| Interval between OTP requests to one address (`smtp_max_frequency`) | 60 s | **60 s** (keep) | A longer gap stops a stranger from getting repeated emails but also blocks a physician's "Send a new code". 60 s already matches the app's rate message. |
| Email OTP expiry (`mailer_otp_exp`) | 3600 s | **900 s** | Gives a guessed code less time to work. 15 min still covers switching to Mail on an iPhone and back. |
| Token verifications per IP (`rate_limit_verify`) | 360/h | keep | `/verify` is already capped per IP. The Gmail function also locks a ticket after 5 wrong codes. |

```bash
curl -s -X PATCH "https://api.supabase.com/v1/projects/lahahztitoqjumrxjcim/config/auth" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d '{"rate_limit_otp": 30, "mailer_otp_exp": 900}'
```

These limits are project-wide counters, not per IP. They limit total damage, but a
bot can still use up the quota and lock real physicians out until the hour resets.
CAPTCHA is what tells bots apart from people. The limits are the backstop.

## Hosted acceptance (add to docs/BETA_TEST_PLAN.md § F on each candidate)

- [ ] Desktop Chrome, new address: code arrives; no widget is shown.
- [ ] iPhone Safari, new address: code arrives. If Cloudflare shows a check, it
      appears at the bottom of the screen, above the home indicator, and can be tapped.
- [ ] Installed home-screen app on iPhone: send, receive, type code, signed in.
- [ ] Gmail alias (`jane.doe+x@gmail.com` for an existing `janedoe@gmail.com`): code
      goes to the stored account, which shows the edge function's token is accepted.
      **Watch this one.** Auth sends Turnstile the IP of the caller, which here is the
      edge function, not the phone. If Cloudflare rejects that, this route returns
      `{status:'captcha'}` and the screen shows the CAPTCHA message. The fix would be to
      check the token in the function using the browser's IP and send with a
      service-role client. That is a larger change, so make it only if this check fails.
- [ ] Content blocker on (e.g. 1Blocker): the CAPTCHA message appears; no code is sent.
- [ ] `curl -X POST .../auth/v1/otp` with the anon key and no token → 400
      `captcha_failed`.
- [ ] Paper Trellis sign-in still works.
- [ ] A week later: no new unconfirmed accounts (count query below).

## Review query for unconfirmed accounts (read-only)

Postgres (Supabase SQL editor), not SQL Server. It lists accounts that never confirmed
and are older than 7 days, and shows whether any app table holds a row for them. It
**deletes nothing**. Review the list before any deletion, and keep anything with
`has_app_data = true`.

```sql
with candidates as (
  select u.id, u.email, u.created_at, u.confirmation_sent_at, u.last_sign_in_at,
         split_part(lower(u.email), '@', 2) as domain
  from auth.users u
  where u.email_confirmed_at is null
    and u.last_sign_in_at is null
    and u.created_at < now() - interval '7 days'
)
select c.*,
  (   exists (select 1 from public.kv k                    where k.user_id = c.id)
   or exists (select 1 from public.events e                where e.user_id = c.id)
   or exists (select 1 from public.sponsored_accounts s    where s.user_id = c.id)
   or exists (select 1 from public.model_spend m           where m.user_id = c.id)
   or exists (select 1 from public.team_members t          where t.user_id = c.id)
   or exists (select 1 from public.project_collaborators p where p.user_id = c.id)
   or exists (select 1 from public.personal_tasks pt       where pt.owner_id = c.id)
   or exists (select 1 from private.beta_npi_claims n      where n.user_id = c.id)
  ) as has_app_data
from candidates c
order by c.created_at;

-- Summary by domain and day, to see the pattern without reading addresses:
-- select domain, date_trunc('day', created_at)::date as day, count(*) from candidates group by 1, 2 order by 2, 3 desc;
```

No foreign keys point from public tables to `auth.users` (checked 2026-10-24), so a
deletion would not cascade. Rows in other tables would be left orphaned instead. That
is why `has_app_data` is shown. If deletion is approved later, use
`supabase.auth.admin.deleteUser(id)` or Dashboard → Users, one reviewed batch at a time.
