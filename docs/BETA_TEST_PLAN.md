# Beta release test plan

*Authored 2026-10-14 for the physician beta. This is the checklist a release candidate
must clear, and the record of the run against the candidate. Re-run the automated gates on
every candidate; re-run the hosted checks on the deployed bundle, never on a local build.*

The promise under test, in order of how badly a miss would hurt:

1. **Zero false verifies.** No value wears a verified badge unless the deterministic
   verifier located the quote in the fetched source and every claimed number is in the
   matched span (docs/VERIFICATION_SPEC.md, docs/EVIDENCE_RELATIONSHIP_CONTRACT.md).
2. **Two-channel rule.** Model prose is number-free and restates only app-verified
   findings; numbers are the separate badged channel. A flagged or legacy value never
   reads as fact.
3. **Sponsored spending is bounded.** Every sponsor-paid call reserves before dispatch;
   caps, pause, and budget fail closed (docs/SPENDING_CONTRACT.md).
4. **A fresh physician can get in and read.** Email code → invitation code → NPI match →
   interview → Starter shelf → digest → source → save → report, on desktop and phone,
   with no API key and nothing stranded after a reload.
5. **Signed-out demo is untouched.** IndexedDB behaviour is byte-for-byte what it was.

## A. Automated gates (every candidate, locally, before any push)

| Gate | Command | Expected |
|---|---|---|
| Unit + regression suite | `npm test` | all files green; the floor only goes up |
| Lint ratchet | `npm run lint` | "New diagnostics: 0" |
| Production build | `npm run build` | succeeds; chunk-size warnings are known |
| Scheduler bundle freshness | `npm run bundle:functions && git status --short supabase/functions/digest-run` | no diff (bundle on disk equals a fresh build) |
| Spending / scheduler contract | `node scripts/check-spending-contract.mjs` | all checks pass |
| Scheduler Deno tests | `cd supabase/functions && deno test --no-lock --allow-env --allow-net=127.0.0.1 tests/` | pass |

The adversarial audit files added for this release live beside the modules they probe and
run with the suite: `src/pipeline/betaAudit.verify.test.js`,
`src/pipeline/betaAudit.prose.test.js`, `src/lib/betaAudit.flows.test.js`,
`src/lib/betaAudit.server.test.js`. Each case asserts the *safe* outcome, so a failure is a
finding, not a flake.

## B. Verifier (the sacred core)

Probe classes, each with a control that must verify and guards that must flag:

- Token traps: `0.02` inside `0.028`, `1.2` inside `11.2`, the `95` of "95% CI" as a value,
  years, reference and figure numbers, page ranges.
- Normalization: dash and minus variants, middle-dot decimals, NFKC (superscripts,
  fractions, full-width digits), thousands separators, scientific notation.
- Shape rules: exactly one declared estimate shape; CI bounds swapped; P bound from a
  neighbouring clause or after a cross-reference; `p<0.001` vs `p=0.001`; "A vs B" with a
  label that belongs to a different comparison; "and" pairs without a comparison cue;
  `n of N` with `n > N` or a non-rounding percentage; I² vs any other percentage.
- Robustness: null or non-string quote, regex metacharacters, very long quotes, empty
  source. Nothing may throw; everything degrades to flagged.
- Registry tier: the value must equal the CT.gov posted outcome, not merely have an NCT.
- Legacy stamps: verdicts stamped under a looser version are re-derived from saved source
  text or shown as legacy-unchecked, never as verified.

Oracle cases (docs/VERIFICATION_SPEC.md): BASIL-3 HR 0.84 → verified-full-text;
STARDUST 11.2 mmHg → verified-registry; an injected HR 0.94 → flagged.

## C. Prose gate and render path

- Enumerate numeric leaks: digits, spelled-out quantities and multiples, Roman numerals,
  percent words, ratios ("one in five"), unicode digits, numbers inside names
  (CREST-2, COVID-19, PD-1) which are legitimate and must not be over-blocked.
- Every quantity render in SpineCheck, ClaimCheckMark, ProvenanceBadge: tier `flagged`,
  `null`, unknown, or legacy renders grey and unasserted; never inside prose.
- When the gate's own model call fails (error, timeout, bad JSON) the prose is withheld,
  not shown ungated.
- Relevance and finding sentences restate only verified findings; a withheld primary
  endpoint produces a number-free summary (commit 02f9468).

## D. Client flows and storage

- Email code sign-in: retry, supersede, expired code, Gmail dot/plus aliases, a late code
  after navigating away. No path shows success before the server confirms.
- Invitation redemption: invalid, revoked, expired, exhausted, enrollment paused; NPI
  required only for beta codes; NPI mismatch, registry timeout (retryable), rate limit.
- Onboarding hashes: Back/Forward stay in the flow; a reload restores the typed code and
  NPI draft; auth callback hashes are left alone.
- Starter seeding: zero model calls, create-only writes, resumable after a cache miss or
  fetch failure, never marks an empty shelf complete.
- Digest: cap reached degrades (cached and listed candidates still work) and shows no
  dollar figure to a sponsored account; a held scheduler run is visible, not silent.
- Report and feedback: "Reported" only after the stored row id returns; failure keeps the
  text and offers Retry.
- Store seam: signed-out IndexedDB writes unchanged; device-local keys (API key, vault
  handle) never reach `kv`; the one-time local→cloud migration is idempotent.

## E. Server and data

- `model`, `digest-run`, `redeem-invite`, `match-npi`, `gmail-canonical-otp`: who can call
  each, what a non-sponsored or anonymous caller gets, rate limits, CORS.
- Email-code bot protection (docs/AUTH_BOT_PROTECTION.md): with CAPTCHA on, `/auth/v1/otp`
  without a token returns `captcha_failed`; both send routes (typed address and
  `gmail-canonical-otp`) succeed with one; iPhone Safari and the installed app can send.
- `gmail_alias_hint` / `gmail_alias_prepare` are anon-callable SECURITY DEFINER: confirm
  they cannot enumerate accounts or exceed their private rate-limit tables.
- Reservation lifecycle: settle, release only on a definitive non-charge, ambiguous holds,
  overrun blocks new reservations, claim token on every scheduler attempt, stale claims.
- RLS: `kv` and `events` own-rows only; `model_spend` and `spend_*` service-role only;
  `evidence_cache_trusted` read-only to clients; `sponsor_invites` never readable.
- Security advisor run after every migration.

## F. Hosted acceptance (deployed bundle, real accounts)

Read-only checks anyone can do:

- [x] Live bundle hash equals the local build of `main` (grep the served `index-*.js`).
- [x] Live bundle contains the Supabase URL and the current version stamps.
- [x] All repo migrations listed as applied; functions ACTIVE at the expected versions.
- [x] `sponsor_config` has caps, budget, enrollment limit; `spending_paused` is false only
      when the beta is open.
- [x] Cron `verastar-digest-run` active; reservations all `settled`; no `ambiguous` rows.
- [x] Signed-out landing, sample digest, checked numbers, badge explainer, click-to-source
      highlight, Settings, all without console errors, at desktop and 375 px.

Checks that need a real invitation and a real inbox (Marissa or a QA account):

- [ ] Fresh email → code → account created → beta code → NPI matched → interview →
      review → Today shows the Starter shelf, with zero rows in `model_spend` for that
      user until the first digest.
- [ ] Run a digest (bounded, one account); every badge click opens the source; save a
      paper; it appears in Library after a hard reload and on the phone.
- [ ] Submit a badge report and a beta feedback note; both rows exist in `events`.
- [ ] Exhausted / revoked code shows its own message and never asks for NPI.
- [ ] Cap reached (set a tiny per-account cap on the QA account): the digest degrades,
      the message talks about reading, no dollar figure appears.
- [ ] Scheduled morning run for the QA account completes or is visibly held.
- [ ] PaperTrellis still opens and reads the same auth session (cross-app smoke).

## G. Day-one watch (read-only SQL, no dashboard needed)

```sql
-- spend by day and purpose
select ts::date d, purpose, round(sum(usd)::numeric, 3) usd, count(*) n
from model_spend where ts > now() - interval '3 days' group by 1, 2 order by 1, 2;
-- reservations not settled
select state, count(*) from spend_reservations group by state;
-- overruns block everything until acknowledged
select * from spend_overruns order by 1 desc limit 5;
-- held or failed scheduled runs
select user_id, last_run_at, left(last_result::text, 160) from digest_schedules
where last_result::text not ilike '%done%' order by last_run_at desc;
-- badge reports and feedback
select type, count(*) from events
where type in ('badge_reported', 'beta_feedback', 'cap_reached') and ts > now() - interval '1 day'
group by 1;
```

## H. Results — candidate `main` @ 02f9468 + this commit, 2026-10-14

Baseline before the run: 124 files / 2299 tests green, lint ratchet clean, build clean,
spending contract 30/30, Deno scheduler tests 6/6, live bundle hash equal to the local
build, all migrations applied, functions ACTIVE, cron active, no ambiguous reservations.

Four parallel adversarial audits (verifier, prose gate, client flows, server) wrote 4 probe
files (about 230 cases) and reproduced the defects below; all were then fixed and the probe
cases kept as guards. After the fixes: **129 files / 2508 tests green, 15 todo (policy
questions), 3 expected-fail (open items), lint ratchet clean, build clean, contract 30/30,
scheduler bundle regenerated and matching.**

### Fixed in this commit

Verifier (`2026-10-14.estimates-v13`, see the contract amendment of the same date):
20 false-verify shapes and 5 crash inputs. The most serious: a quote that cut a source
token at either end earned verified-comparison / verified-estimate ("5% vs 7%" inside
"15% vs 7%"; "0.8-1.5" inside "0.8-1.57"), a bare "or" mid-clause read as an odds ratio,
"10²" verifying 102, "0,847" verifying 847, an "and" pair governed by a cue in another
clause, a heterogeneity P with an exponent. `verify()` now never throws.

Prose gate and render path: "HR0.84"-style glued statistics passed the nomenclature
exemption; full-width and circled digits leaked through the relevance repair path;
Arabic-Indic digits were invisible to the guard; a timepoint ignored its unit (12 months
backing "12 days"); a duplicate checker verdict let a refute be dropped; an unchecked claim
with no reason rendered with no label; a malformed verdict with a flagged tier could count
as validated; a restored digest kept a finding whose numbers the current verifier had
demoted. Checker reasons that paraphrase "not in the snippet" now refute.

Client flows: a sponsored "Run digest" HTTP failure was reported as "being prepared on the
server"; the sample-digest button on a signed-in account wrote a demo profile into the
account and skipped invite, NPI and interview; failed saves and hearts stayed on;
sponsorship was dropped for the session on one transient read error; a cap during pre-read
scoring became "try again"; schedule controls dead-ended after one error; report and
feedback sends had no deadline; onboarding save could fire twice and fail silently; a 503
paused and an auth rate limit were mis-worded; cardiology readers seeded the vascular
shelf. Also: Escape closes the source viewer (it has a dialog role now), and the signed-out
Access panel says to sign in before entering a code instead of showing only the key.

### Decisions reserved for the owner (probes kept as `[policy]` todos)

- Spelled-out magnitudes ("halved", "twelve percent", "one in five") in number-free prose:
  the prompt asks for them; the guard is digit-based. Allow, or ban in finding_plain /
  relevance / design_caution?
- When the prose checker itself fails, the finding renders with a muted "claim not
  checked" label. Withhold instead for the beta?
- `abstract-only` and `verified-user-text` badges read "Verified" like full text; the
  qualification is in the tap panel only.
- The interview does not record `profile.specialty`; Starter seeding guesses from rubric
  prose and a blank rubric falls back to the vascular shelf.
- A verified value can be restated under another unit ("0.84 percent"); only the model
  claim gate can catch it.

### Server findings not fixed here (need a migration or function deploy, so her call)

*Update 2026-10-14, later the same day:* all but the first bullet are now implemented as
local code and migration files (`supabase/migrations/20261014*`, `supabase/config.toml`),
covered by vitest, the Deno tests, `spending_contract.sql`, `gmail_alias_audit.sql` and
`scripts/check-spending-contract.mjs`. Nothing is deployed or applied; the order is in
[SPONSORED_ACCESS_DEPLOY.md](SPONSORED_ACCESS_DEPLOY.md) § 0. The first bullet stays with
PR 22. Not done: `gmail_alias_prepare` still answers an alias query for an existing inbox,
and `spending_health.sql` is still not wired to an alert.

- Invite and NPI rate limits are counted in user-editable `events` rows and are not atomic;
  open PR 22 (invite-attempt ledger) addresses the invite half. Merge it before opening
  enrollment and make sure the beta code is high-entropy.
- `redeem_sponsor_invite` does not compare the invite's `ends_at` to now: a code redeemed
  after its end date enrolls an already-inactive account that is then locked out.
- The scheduler picks the first enabled schedule with no ordering or failure backoff; one
  account that always errors starves the rest, and throughput is one phase per 5-minute
  tick. A held or timed-out run needs an operator (`spending_health.sql` is not wired to
  any alert).
- Gmail OTP tickets have no failed-attempt counter; `gmail_alias_prepare` still answers an
  alias query for an existing inbox.
- `evidence_cache_trusted.created_by` is readable by every signed-in user.
- No `supabase/config.toml` pins `verify_jwt=false`; a plain `functions deploy` would break
  cron and CORS.
- A 402 of any kind (paused, overrun review, held) is worded as the per-user cap message.

### Still open before opening the beta

- Hosted first-use acceptance with a real invitation and inbox (section F, second list),
  on desktop and a physical phone. Not something this session could do.
- Redeploy `digest-run` with the regenerated bundle so the scheduler verifies under v13;
  until then browser and scheduler disagree on the verifier version.
- Re-derive or accept that existing digests and Library verdicts stamped v7–v12 show as
  legacy-unchecked unless saved source text lets them re-derive (digest store and Library do
  this on read).
