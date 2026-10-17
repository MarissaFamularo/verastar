# Review packet: 170a26c92f13b7d2aabc1704b34c931efe0921be

# Integrated handoff checkpoint — offline review before final evaluation

Base: `7d0f5fe9b08be930c41336d7745b25ad9bd95160`, branch `codex/result-context-handoff`.
Reviewed external branch: `claude/wizardly-bell-cd6hq0` at `6bad4aaaf8c96fb49b2aeabcc5d91c9a9c6eeb1e`.
Only the reviewed handoff/checker changes and isolated CI-of parser change were integrated. No reconstructed checkpoint cherry-pick. Existing raw JSON transport, strict validation, save/display/restore wiring remain.

## Changes

- `CI of` joins a printed estimate to its printed confidence interval. Verification v14 preserves v13 guarantees. Borrowed CI and log-rank-P cases remain rejected.
- Labels may drop or reorder source words, with explicit paraphrase status and negation checks. Exact unique quote location remains mandatory. Complete numeric expressions must match their own quote exactly, including signs, operators, units and ranges. These are admission guards, not semantic proof; the independent checker still judges the exact rendered claim against full source.
- Descriptive results require a verified numeric tuple and includeEstimate=true; partial comparisons are rejected. Contextual time/length units are recognized in roles and qualifications too; statistical numbers remain excluded there.
- Invalid qualification labels are withheld from display, but the complete original proposed span (text, quote, corpus), failure reason, and located/ambiguous/missing status reach the checker. Exact raw contexts/source remain bound to approval. The checker must reject a presentation that becomes misleading by omission.
- Trusted cache stores an explicit `{format: 'extraction-wire-v1', value: ...}` envelope. The shared pure contract validates complete schema, identity, indices, cardinality and nonempty spans before normalization or proxy replay. Direct reads return normalized contexts; proxy replay returns validated raw wire contexts. Untagged, mixed, malformed or foreign-paper records are misses. No inferred representation, missing-ID repair, or schema bypass.
- Extraction version is `2026-10-16.result-context-cache-v3`; handoff version is `result-handoff-v4`. Old cache rows remain untouched and miss by version/format. Original library data remains untouched; stale approvals fail closed on read.

## Validation

- Full offline suite: 141 files, 2,746 passing tests, 3 expected failures and 15 todos inherited from baseline.
- Lint: zero new diagnostics; 9 existing errors and 9 existing warnings.
- Production build, digest bundle regeneration, spending-contract bundle integrity checks, and git diff whitespace check pass.
- Frozen PARADE result/extraction fixture copied from the original saved run, with original source bytes, not the external modified fixture.
- End-to-end cache test covers server encoding → direct cache-only pipeline and server encoding → proxy response → actual extraction parser/normalizer. Malformed cache tests fail before rows render; handler trust/no-reservation behavior remains tested.
- Adversarial tests cover sign removal/addition, inequality flip/weakening, reversed/partial ranges, decimal changes and unit swaps, as well as withheld-evidence approval binding and actual checker request inclusion.
- PARADE deterministic replay admits comparative rows 0–3, verifies row 0's conventional Cox tuple, and keeps rows 1–3 numeric-unverified. This does not establish scientific acceptance: no real checker was called. Synthetic approvals in unit tests test plumbing only.

## Review and evaluation boundary

No new paid calls, pushes, merges, deployments, credentials changes, or production/library writes. Independent review is pending before the one authorized final five-paper round. Holdouts remain untouched.


## Deployment implications

No SQL migration or data backfill. A future approved release must ship the client, model proxy plus its new shared contract dependencies, and regenerated digest bundle together so cache representations align. No release is authorized here.

