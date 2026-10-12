# Long triage transport: bounded design (NOT IMPLEMENTED)

**Status:** design prepared 2026-10-09 and corrected 2026-10-10 for the five review findings (§0). Nothing in this document is built into the app. No streaming is enabled, and no paid calibration or paper run was made. Ranking semantics, model defaults and every monetary setting stay as they are. An isolated fake-provider prototype of these semantics exists in the private review package `long-digest-20261010`; it is not app code and is not wired to anything.

## 0. Corrections, 2026-10-10

1. **One absolute deadline (§3.3a).** The earlier text gave triage 330 s and left the prose check its own 140 s. Those do not fit one 400 s worker. There is now one deadline per invocation, measured from when the worker started. A paid attempt is reserved only if its worst case plus a fixed settlement-and-save allowance fits before that deadline; otherwise nothing is reserved and the run stops at a saved checkpoint. The rank phase saves its rankings before the prose check starts, so the check can run in a later invocation without re-ranking. A new request is not treated as a fresh worker lifetime.
2. **One final-usage rule (§3.1).** Every `message_delta` must carry `usage.output_tokens`. The total is the value on the last one, and the stream must end with `message_stop`. There is no fallback to an earlier count. Anything else is ambiguous.
3. **Delivery is separate from the attempt (§3.2, §3.3).** The provider leg and its accounting do not depend on the caller staying connected. The early 200 with a whitespace body, and `EdgeRuntime.waitUntil`, are untested hypotheses about the hosted gateway and worker, not properties this design relies on for correct accounting.
4. **Migration footprint (§3.4, §4).** The ledger, its RPCs, reservation size and caps are unchanged. One additive configuration column, `sponsor_config.long_transport_enabled`, default false, is a separate small migration.
5. **Plan.** The project's organization is on Pro (confirmed read-only on 2026-10-10). That makes the 400 s worker ceiling the relevant one. It proves nothing about runtime behavior.

## 1. The problem, exactly

Triage asks for `max_tokens = triageMaxTokens(n) = min(32000, max(8192, 1024 + 700n))`. With the explicit client timeouts from the R2 round, the SDK now sends large non-streaming requests. Every sponsored path, however, has a short window to finish in:

| Path | What waits | Hard limit today |
|---|---|---|
| Browser → `model` proxy → provider | The browser's sponsored SDK call: one non-streaming HTTP response | Supabase **request idle timeout, 150 s**: "If an Edge Function doesn't send a response before the timeout, 504." The boundary gives up on the provider at 140 s (`PROVIDER_TIMEOUT_MS`). |
| pg_cron or "Run now" → `digest-run` → provider (in-worker) | The provider call inside the worker; also `digest-run`'s own HTTP response to its caller | The worker **wall clock**: 150 s on the free plan, 400 s on paid plans. The same 140 s provider timeout. The 150 s idle timeout applies to `digest-run`'s response. |

A non-streaming provider response sends nothing until generation finishes. A triage that generates for longer than about 140 s therefore ends as an **ambiguous** attempt: the full reservation is kept and probably billed, and no ranking is produced. Before the R2 round, the SDK refused that request before sending, at no cost.

Source for the limits: Supabase Edge Functions limits, read through the Supabase docs on 2026-10-09:
- maximum duration (wall clock) is 150 s free, 400 s paid;
- request idle timeout is 150 s;
- 2 s CPU time per request, excluding async I/O;
- `EdgeRuntime.waitUntil` keeps the isolate alive while a response stream is being piped.

**Which plan is the project on?** Pro, confirmed read-only on 2026-10-10. The limits page (re-read that day) calls the 400 s figure the time "an Edge Function worker will stay active" and says a worker "can serve multiple requests" in that time. It is a ceiling on a worker, not a promise of 400 s to each request. The idle rule is unchanged: 150 s, "if an Edge Function doesn't send a response before the timeout". The background-tasks page says a task marked with `waitUntil` is still "capped based on the wall-clock, CPU, and memory limits". Neither page says what happens to a function when its caller disconnects.

## 2. Requirements carried over (non-negotiable)

1. **Same request, same semantics.**
   - The caller's body is unchanged: same prompt, schema, model, `max_tokens` and thinking setting.
   - Callers still cannot request streaming; the policy keeps refusing `stream`.
   - The candidate set is never truncated.
2. **One reservation per attempt** at the existing full-context bound, and **one settlement**, from authoritative provider usage.
3. **Incomplete means ambiguous.** Any stream that does not end in `message_stop` with priceable final usage leaves the attempt ambiguous, with full liability kept. That includes a mid-stream `error` event, a dropped connection, an idle gap, the time cap, or a lost claim. No release, and no partial settlement.
4. **No automatic retry stacking.** Every failure the caller sees carries `x-should-retry: false`.
5. **Lifetimes nest.** In order, shortest first: inter-event idle cap, then stream cap, then worker wall clock, with the claim lease renewed through the whole attempt.

## 3. Design

### 3.1 Provider leg (shared, inside `_shared/spending.js`)

**When it applies.** Only to requests with `max_tokens > LONG_OUTPUT_THRESHOLD`. The proposed threshold is 16,384, the extraction retry ceiling, so extraction and the prose check never take this path. Triage takes it from 22 candidates upward (`1024 + 700 × 22 = 16,424`).

**How the attempt runs.**
- **Request.** The boundary sends the already-checked body with `stream: true` added on the provider leg only. The fingerprint, the reservation and the policy check all use the non-streaming checked body, so request-ID binding is unchanged.
- **Accumulation.** An SSE accumulator builds the final `Message`:
  - `message_start` supplies id, model and the input-side usage (`input_tokens`, `cache_*`);
  - `content_block_*` events build the text blocks;
  - `message_delta` supplies `stop_reason` and the **cumulative** usage.

  **The final-usage rule (one rule, corrected 2026-10-10).** The streaming docs (re-read 2026-10-10) say a stream has "one or more `message_delta` events" and that "the token counts shown in the `usage` field of the `message_delta` event are *cumulative*". One of their examples also shows a `message_delta` with no usage at all. SDK 0.110 (`lib/MessageStream.mjs`) sets `output_tokens` from every `message_delta` and overwrites input and cache fields when the event carries them; it throws on a `message_delta` without usage. The boundary follows the same accumulation and is strict where the SDK throws:
  - usage starts as `message_start.message.usage`;
  - each `message_delta` overwrites the fields it carries;
  - **every** `message_delta` must carry `usage.output_tokens` as a non-negative integer that does not decrease, and the stream must end with `message_stop` after at least one `message_delta`;
  - the total is the value after the last `message_delta`.

  If any `message_delta` lacks usage, the count goes down, or `message_stop` never arrives, the final count is unknown and the attempt is **ambiguous** at the full reservation. An earlier count is never used as the total. The boundary needs its own accumulator for this, since the SDK helper throws instead of reporting.
- **Settlement.** The existing `priceUsage` and `responseModelMatches` apply to the merged result, exactly as for non-streaming calls. A server-side fallback that changes the serving model fails `responseModelMatches`, so the attempt stays ambiguous.

**Caps.**
- `STREAM_IDLE_MS = 45 s`: no SSE event at all, `ping` included, for that long means abort, then ambiguous.
- `STREAM_MAX_MS = 300 s`: the longest one streamed attempt may run. Reaching it means abort, then ambiguous. It is not a promise that the attempt gets 300 s: admission (§3.3a) decides whether an attempt may start at all.
- **Caller cancellation and claim loss** abort the provider request. After dispatch the attempt is ambiguous; before reservation nothing is recorded.
- **Mid-stream errors.** An `event: error`, for example `overloaded_error`, is ambiguous. The docs map it to a 529, and nothing establishes that it is zero-charge.

### 3.2 Browser path (`model` proxy)

The browser SDK call stays **non-streaming**, so `extractStructured`, `parseStructuredResponse` and the ranking code do not change. For a long request, the proxy:

1. Reserves.
2. Returns `200`, `content-type: application/json`, with a streamed body, **immediately**. Hypothesis, untested on the hosted platform: a response that has begun satisfies the 150 s idle rule. The piping promise would be passed to `EdgeRuntime.waitUntil`; that does not lift the wall-clock limit, and the docs do not say it keeps a function alive after its caller leaves.
3. While the provider stream runs, writes a single space (`0x20`) to the body every 15 s. Leading whitespace is valid JSON, and the SDK parses the body with `JSON.parse` after reading it in full.
4. At the end, writes either the accumulated `Message` JSON, or an error envelope carrying the status the caller would have seen: `{"type":"error","error":{...},"verastar_status":504|529|...}`.

Because the status line is already committed as 200, failures must be carried in the body. The browser's sponsored `fetch` wrapper in `src/lib/anthropic.js` already intercepts every proxied request. It would buffer long responses and, if the parsed body has `type: 'error'`, return a re-materialized `Response` with `verastar_status` and `x-should-retry: false`. The SDK then raises the same typed `APIError` as today, and a 402 still becomes `CapReachedError`.

A body that ends without valid JSON (the connection was cut) is mapped by the same wrapper to a 504 with `x-should-retry: false`. The browser then knows only that it has no result; the attempt's outcome is whatever the server recorded.

**The attempt does not depend on delivery.** Reservation, the provider stream, and settlement run to their own end whether or not the browser is still connected. A browser that hangs up gets nothing, and the attempt still settles or stays ambiguous on the server. Whether the hosted function is allowed to keep running after the caller disconnects is unproven; if it is killed, the reservation stays `reserved`, which is counted in full.

**Timeouts.** The sponsored client timeout for long requests rises to `STREAM_MAX_MS + 60 s`. Short requests keep 150 s.

**What this buys:** up to 300 s of generation, against about 140 s today, on a worker young enough to admit it (§3.3a). With the flag off (the default) the proxy refuses a long request before reserving, with a 402 `long_request_unavailable`.

### 3.3 Scheduler path (`digest-run`)

- **Same accumulator.** The provider call inside the worker uses the same streaming accumulator. No HTTP idle limit sits between the worker and the provider.
- **Claim heartbeat.** Every 60 s while a long attempt streams, the worker calls `digest_claim_renew(user, token)`, an existing owner-guarded RPC. If it returns `false`, or the RPC fails, the worker aborts the provider stream. The attempt is then ambiguous, already dispatched, and the run **halts** (`claim_lost`). This keeps the 240 s lease valid through a 330 s attempt without lengthening the lease for every run.
- **`digest-run`'s own response.** Today it replies only after the tick ends, so the idle timeout can cut off a long rank tick's HTTP response. Two parts:
  - **Cron.** Existing production already lives with pg_net's client-side timeout: `net.http_post` sets no `timeout_milliseconds`, and pg_net's default is short. The questions to verify on a non-production stack are whether the worker keeps running after its caller disconnects, and whether returning a streamed body changes that. The safe design is to give the **rank phase** the same early-200, whitespace-keepalive, final-JSON body as §3.2, plus `EdgeRuntime.waitUntil` around the tick. Then neither caller type can idle the response out, and the work is tied to an explicitly kept-alive promise.
  - **"Run now"** (`src/lib/digestSchedule.js` → `runScheduledDigestNow`). It already reads `res.json()`, which tolerates leading whitespace, so it needs no change. An error envelope in a 200 body must be mapped the same way as in §3.2: a small change in `runScheduledDigestNow`.
- **Tick budget.** See §3.3a. `RANK_HANDOFF_FRACTION` hands ranking to a later request; a later request is not a fresh worker, so it does not by itself give ranking 400 s.

### 3.3a One absolute deadline (added 2026-10-10)

`deadline = worker start + 400 s - 20 s`. Worker start is taken when the function module loads, so every request served by that worker shares one deadline.

A paid attempt may be reserved only if `deadline - now >= worst case + 30 s`, where the worst case is 300 s for a long streamed attempt and 140 s for a non-streaming one, and the 30 s covers settlement (retried once), the fenced save, finishing the claim and the response. If it does not fit, **nothing is reserved or sent**; the run returns with its phase unchanged and a later request continues.

Consequences, stated plainly:
- A long ranking attempt is admitted only on a worker that is at most 50 s old. On an older worker the tick defers at no cost, and keeps deferring until the platform starts a new worker.
- 300 + 30 for ranking and 140 + 30 for the prose check do not both fit in 380 s. So the rank phase is two saved steps:
  1. `rank`: run the ranking call. Save the sanitized rankings and set the phase to `check` before anything else.
  2. `check`: rebuild the checker's items from the **saved** rankings and the saved evidence windows, run the prose check, save the finished rankings, phase `done`.

  If the check does not fit after ranking, the run stops at `check` with the rankings saved. The ranking call is never repeated to resume the check, so order, scores and wording cannot change. A check that fails leaves findings `unchecked`, as today.
- A ranking attempt that ends ambiguous leaves the phase at `rank` with nothing saved. Whether the next tick may try again is the existing behavior (it does, bounded by the caps); this design does not change it.

### 3.4 What does not change

- The policy: callers still cannot request streaming.
- Pricing, reservation size, the ledger, its RPCs and every cap value. The only schema change is the additive flag column in §4, in its own migration.
- The prompt, schema, `max_tokens` formula and candidate set.
- Extraction and the prose check, which stay below the threshold.
- The verify core.

## 4. Smallest implementation footprint (when approved)

| File | Change |
|---|---|
| `supabase/functions/_shared/sse.js` (new) | A pure SSE parser and Message accumulator with usage merge. Unit-tested, with no network. |
| `supabase/functions/_shared/spending.js` | A `dispatch` mode for long requests: add `stream: true` on the provider leg, the idle and max caps, an `onHeartbeat` hook, and settlement from the accumulated result. |
| `supabase/functions/_shared/timeouts.js` | `LONG_OUTPUT_THRESHOLD`, `STREAM_IDLE_MS`, `STREAM_MAX_MS`, `CLAIM_HEARTBEAT_MS`, `LONG_CLIENT_TIMEOUT_MS`, with nesting invariants tested. |
| `supabase/functions/model/handler.js` | For long requests: an early 200 with a whitespace keepalive and the final body or an error envelope, under `waitUntil`. The flag gate. |
| `supabase/functions/digest-run/handler.js` | Heartbeat through `digest_claim_renew`; abort on loss; the rank-phase streamed response. |
| `src/lib/anthropic.js` | Map the in-body error envelope, and set the long-request client timeout. |
| `src/lib/digestSchedule.js` | Map the in-body error envelope in `runScheduledDigestNow`. |
| `supabase/functions/_shared/deadline.js` (new) | The worker-start clock and the admission test of §3.3a. |
| `src/pipeline/dailyDigest.js`, `src/pipeline/triage.js` | The rank phase as two saved steps (`rank`, `check`), with the checker's items rebuilt from saved rankings. No prompt, schema or `max_tokens` change. |
| New additive migration | `sponsor_config.long_transport_enabled boolean not null default false`. Nothing else: no ledger, RPC, reservation or cap change. |

## 5. Fake-provider tests to write first (no paid calls)

Each of these is listed as `it.todo` in `src/lib/longTriageTransport.test.js`, alongside a working fake SSE provider (`src/lib/sseFakeProvider.js`). Its fidelity is already tested against the real SDK's own stream parser.

1. **Accumulator.** It rebuilds the same `Message` the SDK's own `stream().finalMessage()` builds from the same fake stream (text, `stop_reason`, merged usage).
2. **Final usage.** Usage starts at `message_start` and is overwritten by each `message_delta`; the total is the value after the last one. Any `message_delta` without `usage.output_tokens`, a count that decreases, or a missing `message_stop` makes the attempt **ambiguous**. No earlier count is used.
3. **Settlement.** One reservation, one settlement at the exact price for a long triage. The dispatched body equals the checked body plus `stream: true`. The fingerprint is unchanged.
4. **Mid-stream `error` event, dropped connection, idle gap, max cap.** Each is ambiguous, with full liability and `x-should-retry: false`. Fake timers drive the caps.
5. **Proxy delivery.**
   - The real SDK, non-streaming, reads an early-200 body with keepalive spaces and gets the identical parsed ranking.
   - An in-body error envelope becomes a typed `APIError` with the original status, and the SDK makes no retry.
   - A 402 envelope becomes `CapReachedError`.
6. **Browser header filter** (Codex's harness in `modelProxy.test.js`). The long path also dispatches exactly once when only exposed headers are visible.
7. **Scheduler heartbeat.**
   - The lease is renewed during a long fake stream.
   - When the claim is lost mid-stream, the abort reaches the provider fake, the attempt is ambiguous, the run halts, and no further attempts are made.
8. **Ranking semantics.** For 30 and 60 candidates, the ranking applied to the digest is identical whether the fake provider answers non-streaming (short) or streaming (long).
9. **Flag off.** The proxy refuses a long request with 402 `long_request_unavailable` and no reservation. Short requests are unaffected.
10. **Local stack, extending `scripts/local-stack-spending-test.mjs`.** A slow fake SSE provider (for example 170 s with pings) completes through the proxy. A stream cut mid-way leaves one ambiguous reservation. A local stack proves packaging, PostgREST integration and response parsing. It does **not** prove the hosted gateway's idle rule, the hosted worker's lifetime, or what happens when a caller disconnects.
11. **Deadline and checkpoints.** A long attempt is not reserved when it cannot fit; a request on an old worker defers at no cost; ranking saved at `check` is resumed without a second ranking call, and the finished rankings equal the single-pass result for 30 and 60 candidates.
12. **Hosted, non-production, authorized separately.** Only this can settle: whether an early 200 with a trickling body avoids the 504; how long a worker really lives and whether a second request shares it; whether work continues after the caller disconnects; and whether pg_cron's HTTP call tolerates the response shape.

The private prototype package already demonstrates items 1 to 5, 7 to 9 and 11 against isolated prototype code with fake timers. That is evidence for the design, not for an implementation in this repo: the `it.todo` entries stay todo until the app code exists.

## 6. Open questions for the manager

- **Plan:** resolved, Pro.
- **Idle timeout:** whether an early 200 with a trickling body satisfies it. Unproven; only a hosted non-production test can show it (§5 item 12).
- **Caller disconnect:** whether the worker keeps running after pg_net or a browser disconnects. Unproven, and it affects today's design as well.
- **Generation speed:** whether a 32,000-token ranking finishes inside 300 s is unknown. No paid calibration was run. If it does not, the long path ends ambiguous at the full reservation.
- **Threshold:** the proposed `LONG_OUTPUT_THRESHOLD` of 16,384, and whether to keep the long path off for the beta, accepting that sponsored triage stays bounded by about 140 s. A tighter alternative inside today's limits would be a smaller ranking prompt, which is a ranking change and was not proposed.
