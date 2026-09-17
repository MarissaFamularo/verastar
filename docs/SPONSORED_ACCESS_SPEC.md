# Sponsored access, shared evidence cache, and user-supplied text

*Authored 2026-09-17. Engineering spec only. Budgets, cap values, and pilot design are
not in this repository.*

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
- The function authenticates the caller with the Supabase JWT, checks the account's
  `sponsored` flag, checks spend against per-day, per-month, and global ceilings, and
  records the call's cost to `events` (`type = 'model_call'`, payload: model, tokens,
  cached tokens, estimated USD, purpose).
- Cap values, the global ceiling, and the sponsored allowlist are read from Supabase
  secrets or a config table. They are never committed.
- On a cap: the function returns a typed `cap_reached` response. The client degrades
  rather than blocks. Anything served from the shared cache still works, the digest
  still lists candidates, and new extraction waits until the window resets. The user
  message talks about reading, not money, and shows no numbers. A cap hit is logged
  (`type = 'cap_reached'`).
- Sponsored accounts never see the estimated-USD ledger in settings.

## 2. Shared evidence cache

Extraction is not personalized. It reads source text and emits typed quantities with
verbatim quotes, so its output is the same for every user. It is safe to share. The
relevance prose ("why this matters") is personalized to north stars and stays per user.

- New table `evidence_cache`, keyed by `(pmid, extraction_version)`, with optional
  `source_hash` for user-supplied text. Columns: `citation` (jsonb), `source_tier`,
  `quantities` (jsonb: the extraction schema output with full verdicts, quotes, and
  offsets), `verification_version`, `created_at`.
- Holds only what a citation holds: metadata, quantities, short verbatim source quotes,
  character offsets, verdicts. Never full text.
- Readable by all authenticated users. Writable only by the edge function under the
  service role. Clients cannot insert or update; a client-writable cache would let one
  user poison every other user's badges.
- Read path: before extracting, the pipeline asks the cache for `(pmid, current
  extraction_version)`. A hit skips the model call and runs the deterministic verifier
  locally against whatever source text is available, so the badge is still proven in
  the user's session. A miss extracts, and a sponsored session's edge function writes
  the result back.
- A version bump of the extraction schema or the relationship contract invalidates by
  key, not by deleting rows. Old rows stay for audit.

## 3. Seed collection on signup

- A curated `reference_papers` table: `(specialty, pmid, rank, note)`. Maintained by
  hand, populated only with papers already in `evidence_cache`.
- On first sign-in after onboarding, papers for the user's chosen specialty are copied
  into their library through `mutate_library_paper`, with provenance marking them as
  seeded so they can be filtered or bulk-removed. The user's private record holds no
  full text for seeded papers unless the paper is OA and the pipeline fetched it.

## 4. User-supplied text

- `AddPaper` gains a file input for PDF. Text extraction runs in the browser (pdf.js).
  The client computes a SHA-256 of the file and stores it with the record.
- The full text of a user-supplied PDF is stored only in that user's own `kv` record,
  exactly as OA full text is today. It is never written to `evidence_cache` and never
  reaches another user.
- New source tier: `verified-user-text`, label "verified against user-supplied text."
  It ranks below `verified-full-text`. The badge proves the quote is in the uploaded
  file; the app cannot prove the file is the paper, and the label says so. All other
  verifier rules, including numeric coverage and the relationship contract, apply
  unchanged.
- Quantities extracted from user-supplied text may be cached under
  `(pmid, extraction_version, source_hash)` so a second upload of the identical file
  by any user skips extraction. The quotes cached are the short verbatim receipts the
  verifier already retains, nothing more.
- Expect a higher flag rate on PDF input than on PMC XML because of table and column
  mangling. Evaluation stratifies by source tier.

## 5. Events for the study instrument

Append-only `events` rows, per user, RLS as today. Types: `session_start`,
`digest_opened`, `badge_clicked`, `quote_expanded`, `paper_saved`, `pdf_uploaded`,
`connections_opened`, `model_call`, `cap_reached`. Payloads carry ids and tiers, never
source text.

## 6. Library-wide synthesis cooldown

Per-paper connection proposals stay instant. Library-wide calls (category proposals,
concept synthesis) run only when the library has changed since the last run and not
more often than a configured minimum interval.

## Out of scope here

Budget, cap values, pilot cohort size, recruitment, survey instruments, and the
copyright position on user-supplied text are private planning material.
