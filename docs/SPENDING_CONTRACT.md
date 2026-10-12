# Sponsored spending, scheduler ownership, and cache trust — contract

**Status: PROPOSED, revised 2026-10-12.** Reservations are sized to the request. The daily
cap is unchanged. This is implemented and
tested locally against disposable PostgreSQL databases, fake providers, and plain Deno. It
has not been applied to any linked project, deployed, or validated on a Supabase edge
runtime or PostgREST. No amount in this document is a proposal: every dollar figure in the
tests is a fixture.

**Code:**
- `supabase/functions/_shared/{pricing,requestPolicy,spending,tokenReserve,timeouts}.js`
- `supabase/functions/model/handler.js`
- `supabase/functions/digest-run/handler.js`
- `src/lib/serverScope.js`
- `src/pipeline/evidenceCache.js`
- migrations `supabase/migrations/20261009120000_beta_spending_safeguards.sql`,
  `20261010130000_scheduler_hold.sql`, `20261012180000_spend_release.sql`

**Tests:**
- vitest: `src/lib/{pricing,requestPolicy,spending,modelProxy,digestRunHandler,spendingContractCheck}.test.js`,
  `src/pipeline/{digestCapStop,evidenceCache}.test.js`
- SQL and real-connection concurrency: `supabase/tests/run_spending_tests.sh`
- Deno, against the generated bundle: `supabase/functions/tests/scope_isolation_test.ts` and
  `scheduled_rank_test.ts` (`deno test --no-lock --allow-env --allow-net=127.0.0.1`).
  The latter is a real scheduled rank tick through the handler and the bundled runner,
  with synthetic data and a fake provider.
- local Supabase stack: `scripts/local-stack-spending-test.mjs` (**written, not yet
  executed**: it needs a container runtime and exits with "PREREQUISITE MISSING" without
  starting anything otherwise)

## 1. One paid-call boundary

Every sponsor-funded provider attempt runs `guardedProviderCall` in
`_shared/spending.js`. That includes the browser's proxied calls (`functions/model`) and
every call inside a scheduled digest (`functions/digest-run`).

1. **Check** the request against the policy (§3). Nothing unchecked is forwarded.
2. **Count** this request's input with Anthropic's token-counting API
   (`POST /v1/messages/count_tokens`). Counting is free and is not a reservation. The
   count is an estimate. A failure, a timeout, a non-2xx, or a count that is not a
   positive integer falls back to a local estimate (one token per two UTF-8 bytes of the
   forwarded body, at least one). The fallback is never zero.
3. **Reserve** with `spend_reserve`. The hold is the counted (or estimated) input plus a
   safety margin, plus `max_tokens` at the output price, clamped to the context-window
   ceiling and at least one micro-dollar (§3). This is one transaction under a global
   advisory lock. It checks:
   - the account, configuration, pause, and overrun review;
   - per-person day and month caps;
   - the global monthly ceiling and the total beta budget;
   - the request-id binding;
   - for scheduler attempts, **the run's claim token** (§6).

   Any RPC error means **no dispatch**. Parallel reservations take the same lock, so they
   cannot jointly pass a cap.
4. **Dispatch once.** The boundary never retries. Only `_shared/spending.js` addresses
   the provider; the drift check enforces this. The counting request is a separate fetch
   to the count URL derived from the messages URL, so a local-stack override never counts
   against the real provider.
5. **Record the outcome.** Settlement and release are each retried once, and the outcome
   RPCs are idempotent.

| After dispatch | Ledger action | Reservation state | Counted as |
|---|---|---|---|
| 2xx, JSON, requested model, priceable usage | `spend_settle` | `settled` | actual cost (one ledger row); unused hold drops out |
| 2xx with actual cost above the reservation | `spend_settle` records the full amount and opens an overrun | `settled` + a `spend_overruns` row | actual cost; **all new reservations denied** until acknowledged |
| non-2xx status (400–599, including 408, 429, 529), timeout, network loss | `spend_release` | `released` | nothing; no ledger row. The hold is dropped |
| 2xx that is non-JSON, missing or malformed usage, an unexpected model, or server-tool / priority / geography usage | `spend_mark_ambiguous` | `ambiguous` | full reservation until reconciled |
| an outcome RPC fails (including a release that cannot be recorded), or the worker dies | none | stays `reserved` | full reservation until reconciled |

`spend_release` (`20261012180000_spend_release.sql`) accepts only a `reserved` row. It
sets `actual_micro` to 0, writes a `spend_audit` row with action `release`, and writes
no `model_spend` row. A second release is `already_released`. Settling or reconciling a
released row is a no-op. An `ambiguous` row is not released: the provider returned a
message and may have billed it. A request refused **before** dispatch (by the policy,
auth, account check, a denial, or a duplicate) never creates a reservation.

**Request IDs.** The browser sends `x-verastar-request-id`, one UUID per HTTP attempt. The
scheduler generates one per attempt. IDs are unique per account and bound to the SHA-256
of `purpose + canonical forwarded body`:

- The same ID with the same body is a `duplicate`.
- The same ID with a different body is a `mismatch`.
- Neither dispatches; both return HTTP 409 with `x-should-retry: false`.

The reservation ID identifies the provider attempt. The provider's `request-id` header
and message ID are stored on it.

**SDK retries (audited).** `@anthropic-ai/sdk` 0.110 retries connection errors, 408, 409,
429 and 5xx unless the response says `x-should-retry: false`. Every refusal, every
released error, and every ambiguous post-dispatch response carries that header. As a
result, the SDK never stacks automatic retries on an unresolved liability. The
scheduler's guarded fetch never throws, so it produces no SDK connection-error retries.

In the browser, a connection lost between the browser and the proxy can still trigger an
SDK retry. That retry is a new request ID and a new reservation. If the proxy already
released or settled the earlier attempt, only the new hold counts. If the worker died
before recording an outcome, the earlier attempt remains `reserved`.

**Scheduler halts.** A scheduler run halts when any of these happens:
- an accounting step fails, including a release that could not be recorded;
- an overrun is recorded;
- an outcome is ambiguous;
- the claim is lost.

A released error does not halt the run and does not hold the account.

After a halt, later attempts are refused locally with HTTP 402 and are neither reserved
nor dispatched. The digest stops as `capped`, with its progress kept.

## 2. Caps, windows, money, and account deletion

- **UTC windows:** the day starts at 00:00 UTC and the month on the 1st at 00:00 UTC.
- **Which window a row counts in:** each ledger row counts in the window of its
  timestamp. Settlement and reconciliation stamp the row with the reservation's creation
  time.
- **Outstanding reservations (`reserved`, `ambiguous`) count in every window until
  resolved.** A rollover cannot hide them.
- **The admission rule:** deny if `spent_in_window + outstanding + new_reservation > cap`.
  This applies to the per-person day, the per-person month, the global month, and the
  total beta budget. The budget counts ledger spend at or after `beta_budget_starts_at`,
  plus everything outstanding.
- **Aggregation** is a single SQL `sum()` (one snapshot), never a client-side sum. The
  tests sum more than 5,000 rows exactly.
- **Money is integer micro-dollars.** Each cost is computed with one ceiling, so totals
  never round down.
- **Liability outlives the account.** The original `model_spend → auth.users` foreign key
  cascaded on deletion. That erased a deleted account's spend from every cap, the global
  ceiling, and the budget. The migration drops that foreign key. Historical rows,
  settled spend, unresolved reservations, and reconciliations made after deletion all
  keep counting, without double counting. Real SQL tests cover each case, and the review
  reproduction now fails as intended. Rows removed by earlier cascades cannot be
  recovered.
- **Checked on every reservation:** revocation, an account `ends_at` in the past, and
  the spending pause.

## 3. Request bounds and what is reserved

**Payload limits (not billing proof):**
- Body: at most 1,000,000 bytes, refused before or while reading.
- Messages: 1–16.
- Schema: at most 64,000 bytes.
- `max_tokens`: an integer from 1 to 32,000, and within the model's limit.

**Admitted request shape:**
- Top-level fields: only `model`, `max_tokens`, `messages`, `system`, `thinking`, and
  `output_config`.
- Content: text blocks only.
- `thinking`: `{type}` only, and only the type each model accepts.
- `output_config`: `{format:{type:'json_schema', schema}}` only.

**Refused:** `stream`, tools, metadata, service tier, inference geography, speed,
sampling parameters, `cache_control` anywhere, and beta headers.

**Models:** exact IDs only (`claude-sonnet-5-5`, `claude-haiku-4-5-20251001`).

**The ceiling is the model's documented context window plus `max_tokens`.** A reservation
is never above that ceiling. The ceiling is not what is reserved.

| Model | Input ceiling | Input price | Output | Largest ceiling (`max_tokens` 32,000) |
|---|---|---|---|---|
| `claude-sonnet-5-5` | 1,000,000 tokens | $2/MTok → $2.00 | $10/MTok | **$2.32** |
| `claude-haiku-4-5-20251001` | 200,000 tokens | $1/MTok → $0.20 | $5/MTok | **$0.36** |

**Why the ceiling holds.** All of the following come from the
[context windows](https://platform.claude.com/docs/en/build-with-claude/context-windows)
page, accessed 2026-10-09, unless noted:

- **Input is capped by the window.** "If the input alone already exceeds the model's
  context window, the API returns a 400 ... on every model." Input counts
  `input_tokens`, `cache_read_input_tokens` and `cache_creation_input_tokens`.
- **The window sizes.** Sonnet 5.5 has a 1M-token window by default, with no beta header.
  Models not listed as 1M, including Haiku 4.5, have 200k.
- **Input rate.** Input is priced at the base input rate, the highest input rate a
  request can incur here. Caching is enabled only by `cache_control`, which the policy
  refuses, and cache reads are cheaper. Neither model has a prompt-length price tier.
- **System-added tokens.** Per the
  [token counting](https://docs.anthropic.com/en/docs/build-with-claude/token-counting)
  page, tokens Anthropic adds are not billed. The earlier "8,192 tokens for injected
  instructions" reasoning is withdrawn.
- **Output** includes thinking and is capped by `max_tokens`.

**What is reserved.** Anthropic's count is an estimate and can differ by a small amount
from the tokens billed, so the hold is not the raw count:

- counted input, or the local estimate when counting fails;
- plus 25 percent, then 1,024 tokens;
- clamped to the context window, and at least one token;
- plus `max_tokens` at the output price;
- then clamped to the ceiling above, and at least one micro-dollar.

A typical Sonnet call (a few thousand input tokens, triage-sized `max_tokens`) reserves
cents, not the $2.32 ceiling. Settlement (`spend_settle`) replaces the hold with the
actual cost. If the actual cost is above the hold, the full amount is recorded and an
overrun stops new spending.

**Usability.** The per-person daily cap is unchanged. A call is refused when
`spent + outstanding + this hold` exceeds the cap. Outstanding is `reserved` and
`ambiguous` only; a `released` hold does not count. Caps were not raised.

If usage ever reports a charge outside this bound (for example, cache writes that cannot
be requested), settlement records the full amount and the overrun stops all new spending.

## 4. Pricing evidence

Sources, all accessed 2026-10-09 and re-checked by the reviewer the same day:
- <https://platform.claude.com/docs/en/about-claude/pricing>
- <https://platform.claude.com/docs/en/about-claude/models/overview>
- <https://platform.claude.com/docs/en/build-with-claude/context-windows>

The fixture is `src/lib/pricing.fixture.json`.

| Model ID | Input | 5m cache write | 1h cache write | Cache read | Output | Context window |
|---|---|---|---|---|---|---|
| `claude-sonnet-5-5` | 2 | 2.50 | 4 | 0.10 (0.05×) | 10 | 1M |
| `claude-haiku-4-5-20251001` | 1 | 1.25 | 2 | 0.10 (0.1×) | 5 | 200k |

- Usage the table cannot price is ambiguous, never settled at zero or at a fallback price.
- Cache creation without a TTL breakdown is priced at the 1-hour rate.
- The BYOK display uses the same table for these models, so display and settlement agree.

## 5. Configuration and the safe unconfigured state

The migration adds these `sponsor_config` columns:

| Column | Default |
|---|---|
| `spending_paused` | **true** |
| `enrollment_paused` | **true** |
| `beta_budget_usd` | null |
| `beta_budget_starts_at` | null |
| `enrollment_limit` | null |
| `pause_note` | — |

What each state denies:
- **Missing config row:** everything (`config_missing`).
- **Paused:** everything (`spending_paused`).
- **Invalid or unset budget, start, ceiling, or a negative cap:** everything
  (`config_invalid`).
- **An unacknowledged overrun:** everything (`overrun_review`).
- **Enrollment** is denied (`paused`) while `enrollment_paused` is set or the limit is null.

The spending pause and the enrollment pause are independent.

## 6. Scheduler ownership and isolation

- **Claim.** `digest_claim` is one `UPDATE … RETURNING` that issues a fresh `claim_token`.
  It succeeds only when the row is unclaimed or the claim is older than 240 s.
- **Paid attempts are bound to the claim.** `spend_reserve` with `source = 'scheduler'`
  requires the current token. It locks and checks the schedule row and renews `claimed_at`
  in the same transaction. A worker that lost its claim reserves nothing and therefore
  dispatches nothing. Its run halts, and the handler reports `claimLost`.
  - Lock order: the spend advisory lock, then the schedule row.
  - Nothing takes them in the opposite order: fenced writes and claims take only the row,
    and settlement takes only the advisory lock.
- **The lease outlives an admitted attempt.** Admission renews the lease. The attempt
  cannot outlive the provider timeout (140 s) or the client timeout (150 s), both shorter
  than the 240 s lease (`timeouts.js`, tested). So no successor can take the account over
  while an admitted attempt is still running.
  - **Real-connection test:** ten rounds of an attempt racing five takeovers. Each round
    either admits the attempt with zero takeovers, or allows exactly one takeover with
    zero reservations. Both orderings occurred.
  - **Handler tests:** a stale worker's next call makes zero provider requests (the
    review's reproduction, inverted). A takeover during a slow admitted call is refused.
    A retry after a takeover is refused without dispatch. A cron/manual overlap makes
    exactly one paid request.
- **Fenced writes.** Every scheduler storage write goes through `scheduler_kv_write`
  (check the token, write, renew). Finishing is owner-guarded. The handler re-checks the
  gate after claiming.
- **Isolation.** A per-request AsyncLocalStorage scope replaces the old module globals.
  Outside a scope, server code throws. This is proven on the generated bundle under Deno,
  together with a vitest positive control. Across isolates, the database claim and fence
  provide exclusion.
- **Long triage:** `docs/LONG_TRIAGE_TRANSPORT_DESIGN.md` (design only; not implemented).
- **Not excluded (pre-existing, out of scope).** Browser writes to `daily:latest` are not
  fenced: stamping `openedAt`, saving a reaction, or an in-app run while a scheduled run is
  persisting. Nothing here claims that phase markers preserve concurrent reader edits.
  **Acceptance case, to verify end to end before release:**
  1. Open a scheduler-produced digest mid-run on a phone.
  2. Heart a paper.
  3. Let the scheduler persist its next paper.
  4. Reload.
  5. Record whether `openedAt` and the heart survived, and whether the scheduler's paper
     appears.

### Holds: an unresolved scheduler attempt stops the account (PROPOSED, local only)

`supabase/migrations/20261010130000_scheduler_hold.sql`. Applied only to disposable local
databases; not deployed and not released to readers.

- **Rule.** An account with an unresolved scheduler attempt is not runnable by the scheduler.
  Held means a `scheduler` reservation is `reserved` or `ambiguous`, or is `reconciled` and has
  not been released (`spend_reservations.recovered_at` is null). Settled attempts, released
  attempts, and denials never hold. The rule is read from the ledger, so a worker that died
  is covered. A provider error or timeout releases its hold and does not freeze the account.
- **Enforced twice.** `spend_status` (the scheduler's preflight, before the claim) reports
  `unresolved_liability`, so cron and "run mine now" start no phase, search included.
  `spend_reserve` refuses a scheduler attempt for a held account under the claim.
- **Reconciling does not resume.** `spend_reconcile` records the cost. Only
  `scheduler_recover(user, 'resume' | 'abandon' | 'retire', note)` releases the account. It is
  service-role only, refused while anything is unresolved, while a tick holds a live claim, or
  when nothing is held; it writes a `spend_audit` row and dispatches nothing. `abandon` closes
  the unfinished digest as `done` + `abandoned` and keeps what was read.
- **The run stops as held.** A dispatched attempt with no confirmed cost is noted on the run's
  scope; `runDailyDigest` returns phase `held`, does not record the step as done or failed,
  stores `server.held` on the digest, and the day is not marked run. The reader sees a delay
  message with no run control (`src/lib/digestStore.js`); an abandoned digest reads as stopped.
- **Unchanged.** A cap denial, an empty search, a retracted paper and the bounded truncation
  retry behave as before; a capped digest resumes by itself when the cap allows.
- **Scope.** Scheduler attempts only. A browser-proxy attempt (source `proxy`) neither creates
  a hold nor is stopped by one, and the browser lane's own controls (finish, re-scan with no
  live claim) are as they were. A reader can re-enable a schedule an operator retired.
- **Health.** `supabase/ops/spending_health.sql` reports `scheduler_held` per account
  (`unresolved_liability` or `reconciled_awaiting_recovery`). It is not wired into any weekly
  check yet: that waits for this schema and its monitoring to be deployed.
- **Tests.** `supabase/tests/spending_contract.sql` and `spending_concurrency.py` (recovery
  against claims, against reconciliation, and a reconciliation made in an old open session),
  `src/pipeline/digestHeld.test.js`, `src/lib/digestRunHandler.test.js`.

## 7. Cache trust

- **Trusted table only.** Shared cache hits come only from `evidence_cache_trusted`. Rows
  there are written by the scheduled digest under the service role, with **server-owned
  provenance**: `writer: 'digest-run'`, the bundle's compiled source sha256, the manifest
  bundle sha256, the extraction version, and the source tier. Constraints require
  provenance and refuse `user_text`.
- **Proxy and client reads.** The proxy cache read and the client `lookupCachedExtraction`
  read only the trusted table. A row without valid provenance is a miss. The proxy and the
  browser never write.
- **Legacy rows.** Rows in `evidence_cache` are preserved untouched and are no longer
  served or relabeled. A separate table means a trusted write never collides with or
  overwrites a legacy row with the same key. The SQL test covers this collision.
- **Starter shelf.** Starter seeding reads the same trusted lookup. Until trusted rows
  exist, a Starter paper is "not in the shared cache yet" (retryable), not a paid call.
- **What re-verification does and doesn't do.** It catches a proposal whose numbers are
  not in the reader's source. It **does not** establish arm, population, timepoint or the
  surrounding claim, which the evidence review identified as unchecked dimensions. A
  replayed proposal can therefore still surface a wrong badge. That is why cache trust
  matters.

## 8. Invitations

| Status | Condition | Effect |
|---|---|---|
| `invalid` | no such code | none |
| `already` | active, unexpired sponsorship | none; no use consumed; cap, cohort and end unchanged |
| `revoked` | sponsorship inactive or ended | none; never reactivated by a code |
| `inactive` | code revoked | none |
| `expired` | code past `expires_at` | none |
| `exhausted` | no uses left | none |
| `paused` | enrollment paused, or no limit configured | none |
| `full` | active sponsorships at the limit | none |
| `enrolled` | otherwise | created; one use consumed |

- A global enrollment lock serializes every redemption.
- Expiring a code is not revocation.
- `redeem-invite` refuses to redeem as `paused` unless the database reports the new
  contract marker (`spending_contract_version()`, §10).
- The user ID always comes from the verified JWT.

## 9. Privileges

- Every new function is `SECURITY INVOKER`, with EXECUTE revoked from public, anon and
  authenticated and granted only to `service_role`. That includes the contract marker.
- The new tables have RLS and no client grants. The exception is `SELECT` for
  authenticated users on `evidence_cache_trusted`.
- The SQL suite runs every RPC and table write as anon and as authenticated (with a JWT
  subject) under Supabase-like default grants.
- The local-stack test checks the same thing through PostgREST. It is not yet executed.

## 10. Cutover, reconciliation, rollback

**Find outstanding liability.** This is read-only; `supabase/ops/spending_health.sql`
lists all findings.

```sql
select id, user_id, state, state_reason, reserved_micro / 1e6 as usd, provider_request_id, created_at
  from public.spend_reservations where state in ('reserved', 'ambiguous') order by created_at;
```

**Reconcile** each one against the Anthropic Console or usage export. Match by
`provider_request_id` where present, otherwise by time window and model:

```sql
select public.spend_reconcile('<reservation id>', <actual micro-dollars>, '<who checked what, where>');
```

- Zero is allowed only when the provider record shows no charge for that attempt. A 4xx
  status alone is not that evidence.
- The reconciliation writes a ledger row and an audit row.
- An actual cost above the reservation opens an overrun.
- Acknowledge an overrun with `spend_acknowledge_overrun(id, note)`.
- There is no TTL.

**Fail-closed cutover.** Nothing here has been executed; it requires release authorization.

The new functions fail closed against the old schema. Before the migration:
- `model` finds no `spend_reserve` RPC and so dispatches nothing (503, not retryable).
- `digest-run` finds no `spend_status` and refuses before claiming.
- `redeem-invite` finds no contract marker and answers `paused`.

The cutover therefore deploys code first:

1. **Preflight.**
   - Read back the live function versions, the `sponsor_config` row, the pg_cron job, and
     current outstanding app activity.
   - Run the local-stack test (§11) and a `supabase functions deploy` dry run of the
     bundle on a non-production project, if one is authorized.
   - *If either fails: stop; nothing has changed.*
2. **Deploy the new `model`, `digest-run` and `redeem-invite`** (with the generated
   bundle and `--import-map supabase/functions/deno.json`).
   - From here, every sponsored call, scheduled tick and redemption is refused. The app
     is in maintenance: sponsored reading pauses; BYOK and library use are unaffected.
   - *If a deploy fails partway:* any function still on its old version is still
     unprotected.
     - Retry that deploy.
     - If it cannot be deployed, stop the scheduler with
       `select cron.unschedule('verastar-digest-run');`.
     - The emergency stop for an old `model` is rotating the sponsor `ANTHROPIC_API_KEY`
       secret. That is a provider and secret change needing explicit authorization.
3. **Drain.** Old isolates may finish in-flight requests. Wait at least the paid-plan wall
   clock (400 s). Then confirm that no new `model_spend` rows without `reservation_id`
   (and with `cache_hit = false`) have appeared since step 2, which would show an old
   route still spending.
   - *If any appear:* wait and re-check, then investigate; do not migrate over a live
     old route.
4. **Apply the migration.** It runs in a single transaction. Spending and enrollment stay
   paused and the budget unset, so everything is still refused.
   - *If it fails:* it rolls back as a whole. The new functions keep failing closed. Fix
     the migration and re-apply.
5. **Verify** with the live database's contract marker, `has_function_privilege` for anon
   and authenticated on every new function, the health query, and the deployed function
   bundle compared byte for byte with the manifest's `bundleSha256`.
6. **Configure** the values Marissa chose: budget, start, caps and enrollment limit. Read
   them back. Clear `spending_paused`, then `enrollment_paused` when enrollment should
   open.
   - *If any value is wrong:* set `spending_paused = true` again and correct it.
7. **Run the authorized bounded live smoke test.**

**Rollback** must neither reopen an unguarded route nor erase liability.
- **Stop spending:**
  `update public.sponsor_config set spending_paused = true, pause_note = '<why>';`
- **Stop enrollment:** set `enrollment_paused = true`.
- **Stop the scheduler** if needed: `cron.unschedule`.
- **Never** redeploy the previous `model` or `digest-run`.
- **Never** drop the new tables or columns.
- Fix forward.

## 11. Checks and runtime validation

`node scripts/check-spending-contract.mjs` is deterministic and offline. It covers:
- the local bundle import;
- bundle and manifest freshness against a rebuild;
- priced models matching the defaults;
- a single provider route;
- no process-global bindings;
- no proxy cache writes;
- the service-role-only, no-definer migration;
- request-sized reservations (counted input, margin, `max_tokens`), not the context-window ceiling;
- release on error and timeout, and an ambiguous hold for an unpriceable 2xx;
- `spend_release` service-role only, with no daily-cap change in that migration;
- claim-bound scheduler reservations;
- trusted-only cache reads;
- the contract marker matching between the migration and `redeem-invite`;
- a context-window ceiling for each admitted model.

**Bundle identity.**
- The bundler compiles the source-set sha256 into the bundle (`BUNDLE_SOURCE_SHA256`).
- At cold start, `digest-run` checks it against the manifest, along with the versions
  and models. This is **source-set identity**: it does not hash the deployed bytes.
- Byte identity is checked offline (by the drift check) and at release, by downloading
  the deployed function (cutover step 5).

`scripts/local-stack-spending-test.mjs` is the runtime gate that local PostgreSQL and plain
Deno cannot replace. It runs on a local Docker stack with synthetic users and a fake
provider, in two phases:
- **Phase A, the old schema with the new functions:** every function must fail closed.
  - `model` returns 503 (not retryable), with zero provider requests.
  - `digest-run` returns 503, before claiming and with zero requests.
  - `redeem-invite` answers `paused` and enrolls nobody.
- **Phase B, after `supabase migration up --local`:**
  - The migration lands paused, and everything is refused until configured.
  - Grants through PostgREST.
  - The proxy's settle, a 429 that releases the hold (including the browser-exposed
    header), cap and trusted/legacy cache paths. The fake provider answers
    `/v1/messages/count_tokens` and that request is not a paid attempt.
  - The scheduler: a foreign claim blocks the tick, and a wrong-token reservation is
    denied `claim_lost` through PostgREST. Then the bundled runner finishes the synthetic
    rank-phase digest (`supabase/tests/fixtures/scheduledRankFixture.mjs`). That makes
    exactly two paid attempts to the fake provider, both settled at the exact price, with
    linked ledger rows, a persisted digest and a released claim.
  - The `redeem-invite` contract guard.

Readiness is polled rather than slept.

Its guardrails:
- It refuses non-local URLs.
- It runs from a temp workdir with no project link.
- It is the only way to set the functions' provider override, which they refuse outside
  a local stack with a fake key.

**It has not been executed:** no Docker was available.

`supabase/ops/spending_health.sql` is the read-only live companion.
