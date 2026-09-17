# Sponsored access, shared evidence cache, and user-supplied text

*Authored 2026-09-17. Engineering spec only. Budgets, cap values, and pilot design are
not in this repository. Built the same day; the "as built" notes below record where the
implementation refined the plan. Deploy steps: [SPONSORED_ACCESS_DEPLOY.md](SPONSORED_ACCESS_DEPLOY.md).*

Verastar today is bring-your-own-key and browser-direct: every model call leaves the
user's browser with the user's key, and every extraction lands only in that user's
`kv` rows. This spec adds a second lane, sponsored access, without removing the first.
BYOK remains fully supported and is unchanged.

## 1. Model proxy (Supabase edge function)

- One edge function, `model`, fronts every Anthropic call for sponsored accounts. The
  sponsor key lives in Supabase secrets. It is never in env files, the bundle, or `kv`.
- `lib/anthropic.js` stays the single call site. It gains a transport switch: BYOK sends
  browser-direct as today; a sponsored account sends the same request body to the edge
  function, which forwards it and returns the response unchanged, including `usage`.
- The function authenticates the caller with the Supabase JWT, requires an active row in
  `sponsored_accounts`, checks spend against per-day, per-month, and global ceilings, and
  records the call's cost to `model_spend` (model, tokens, cached tokens, USD, purpose,
  cache hit). **As built:** the ledger is its own service-role-only table, not `events`,
  because users hold an update policy on their own `events` rows and could edit a ledger
  there downward. The client never reads or writes `model_spend`.
- Cap values, the global ceiling, and the sponsored allowlist are read from Supabase
  secrets or a config table. They are never committed.
- On a cap: the function returns HTTP 402 with Anthropic's error envelope and type
  `cap_reached`; the SDK does not retry 402 and nothing else returns it, so the client
  maps it to one `CapReachedError`. The client degrades
  rather than blocks. Anything served from the shared cache still works, the digest
  still lists candidates, and new extraction waits until the window resets. The user
  message talks about reading, not money, and shows no numbers. A cap hit is logged
  (`type = 'cap_reached'`).
- Sponsored accounts never see the estimated-USD ledger in settings.

## 2. Shared evidence cache

Extraction is not personalized. It reads source text and emits typed quantities with
verbatim quotes, so its output is the same for every user. It is safe to share. The
relevance prose ("why this matters") is personalized to north stars and stays per user.

- New table `evidence_cache`, keyed by `(pmid, extraction_version, source_hash)`, where
  `source_hash` is the sha256 of the exact text the model read. Columns: `source_tier`,
  `citation` (jsonb), `extraction` (jsonb: the model's structured output, unmodified),
  `model`, `created_by`, `created_at`. **As built:** the cache stores the model's
  *proposal*, not verdicts. Every reader re-runs the deterministic verifier on the replayed
  proposal against the source text in their own session, so a hit skips the model call and
  never the proof. Hashing the text, not just the PMID, means PMC XML, an abstract, and a
  user-supplied PDF of the same paper are three keys and a proposal is only ever replayed
  against the text it came from.
- Holds only what a citation holds: metadata, quantities, short verbatim source quotes,
  character offsets, verdicts. Never full text.
- Readable by all authenticated users. Writable only by the edge function under the
  service role. Clients cannot insert or update; a client-writable cache would let one
  user poison every other user's badges.
- Read path: `runPaper` hashes the source text, asks the cache directly (any signed-in
  user, BYOK or sponsored), and on a miss sends the key on the extraction call as
  `x-verastar-cache: <pmid>|<version>|<sha256>|<tier>`. The sponsored proxy serves a hit
  from that header without a model call and stores a clean `end_turn` response after a
  miss. A BYOK call goes browser-direct to Anthropic and the header is simply unused.
  A `cacheOnly` mode returns an error instead of calling the model; seeding uses it.
- A version bump of the extraction schema or the relationship contract invalidates by
  key, not by deleting rows. Old rows stay for audit.

## 3. Seed collection on signup

- A curated `reference_papers` table: `(specialty, pmid, rank, note)`. Maintained by
  hand, populated only with papers already in `evidence_cache`. Specialty slugs:
  `vascular-surgery`, `general-surgery`, `cardiology`, `general`. The onboarding drafter
  records `profile.specialty` from the intake answers.
- On the first boot of a signed-in, onboarded account with an empty library, up to 20
  rows (own shelf by rank, then `general`) run through `runPaper` in `cacheOnly` mode and
  save with `saveSource: 'seed'` (the Library shows a "Starter" pill). Source text is
  fetched from PMC or PubMed as for any paper; the cached proposal is verified locally.
  Nothing is spent; a paper not yet in the cache is skipped. `profile.seededAt` makes it
  run once.

## 4. User-supplied text

- `AddPaper` gains an optional "Attach the PDF you have" input next to the identifier
  field. Text extraction runs in the browser (`pipeline/pdfText.js`, pdf.js loaded lazily).
  The client computes a sha256 of the file and stores it with the record
  (`userFileHash`, `userFileName`, `userSupplied`, `sourceTier`, `sourceHash`).
- The full text of a user-supplied PDF is stored only in that user's own `kv` record,
  exactly as OA full text is today. It is never written to `evidence_cache` and never
  reaches another user.
- New source tier: `verified-user-text`, label "verified against user-supplied text."
  It ranks below `verified-full-text`. The badge proves the quote is in the uploaded
  file; the app cannot prove the file is the paper, and the label says so. All other
  verifier rules, including numeric coverage and the relationship contract, apply
  unchanged.
- A proposal extracted from user-supplied text is cached under
  `(pmid, extraction_version, sha256 of the text)` like any other, so a second upload of
  the identical file by any user skips extraction. What is cached is the proposal: typed
  quantities with their short verbatim quotes, nothing more.
- Expect a higher flag rate on PDF input than on PMC XML because of table and column
  mangling. Evaluation stratifies by source tier.

## 5. Events for the study instrument

Append-only `events` rows, per user, RLS as today. Existing types already cover
`app_opened` (session start), `view_opened` (Connections and other tabs), `digest_run`,
`paper_saved`, `paper_noted`, `paper_favorited`, `paper_shared`. Added:

- `digest_item_opened` — a card's evidence panel expanded (`pmid`, `values`). "Surfaced"
  in the study means this, not merely listed.
- `badge_clicked` — a value's click-to-source (`pmid`, `tier`, `flagged`).
- `badge_reported` — "This badge is wrong?" on a validated value (`pmid`, `name`,
  `value`, `tier`, `quote` ≤300 chars). The field channel for false verifies.
- `pdf_uploaded` — (`pmid`, `pages`, `bytes`).
- `cap_reached` — client-side (`surface`, `remaining`) and server-side (`scope`, `purpose`).
- `library_seeded` — (`specialty`, `seeded`, `skipped`).

Payloads carry ids, tiers and a short quote at most, never source text.

## 6. Library-wide synthesis cooldown

Per-paper connection proposals and concept filing stay instant. Library-wide calls
(`consolidateDomains`, `maybeReorganize`) are gated by `pipeline/synthesisCooldown.js`:
they run only when the library fingerprint (count plus newest save) changed since the last
run and at least five days have passed. The stamp lives in the profile collection under
`synthesisRuns`. The explicit "Reorganize" button in the Library is not gated.

## 7. Scheduled morning digests (sponsored only)

A bring-your-own-key user's key never reaches the server, so scheduling is a sponsored
feature. Two pieces:

- `pipeline/dailyDigest.js` is the daily digest as a headless run: the same search →
  score → read → rank → persist → seen-ledger loop SpineCheck drives interactively, writing
  the same `daily:latest` record. It is **resumable** (a `server.phase` marker on the record;
  every paper persisted as it finishes) and **budgeted** (`budgetMs` bounds the reading loop),
  because an edge function's wall clock is shorter than a full run.
- `functions/digest-run` is invoked by pg_cron every five minutes and picks at most one due
  account per tick: schedule enabled, sponsored and active, local hour matches (or a run is
  mid-flight), not already run today in the account's timezone, no fresh claim by another
  tick, today's spend under the daily cap, and **the last digest was opened**. A finished
  digest nobody opened is never replaced by another one nobody will open
  (`schedulerMayRun` in `lib/digestStore.js`). The app stamps `openedAt` the first time it
  shows a digest and logs `digest_opened`.
- The function binds the app's own modules to the account under the service role
  (`configureServerClient`, `configureServerStore`, `configureEvidenceCacheServer`) and
  polyfills `DOMParser` with linkedom for the PMC and PubMed XML parsing in `sources.js`.
  Spend lands in `model_spend` with purpose `scheduled-digest`; cache writes happen inline.
- `digest_schedules` holds enabled, local hour and timezone per account (own-row RLS for
  those columns; claim and result columns are server-owned). Settings shows the block only
  to sponsored accounts, with a "Run now" that calls the same function on the user's JWT.

## Out of scope here

Budget, cap values, pilot cohort size, recruitment, survey instruments, and the
copyright position on user-supplied text are private planning material.
