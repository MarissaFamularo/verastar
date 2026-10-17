# Candidate 2026-10-17 — obligation-checked summaries (not deployed)

Branch `codex/evidence-handoff-20261017`, built on evidence commit `4a93051ade0bdb63a8e2e1691a0885642c106612` (production base `22c408a969b267d3c167036b2f1e891584788792`). Nothing here is merged, deployed or written to production data. Commits carry `[skip ci] [skip netlify]`; no pull request exists.

**Status: implementation and offline tests complete; live evaluation BLOCKED — `ANTHROPIC_API_KEY` was absent from the session environment, so no model call was made and no result below is a model result.** The exact commands, the frozen inputs and the operator-guard strings a live run needs are recorded here so the evaluation can run unchanged when a key is present. Spend so far: **$0.00 of the $50 cap** (dev $0 of $20; holdout $0 of $30).

## What changed (summary)

Production path untouched for callers that do not pass a result handoff; every call site now passes one, so the candidate path is what the digest, Add-a-paper, Library refresh and the scheduled run would use on this branch.

- **One quote locator** (`src/pipeline/quoteLocate.js`): matching on the production verifier's own `normalize` (NFKC, dash variants, interpunct decimals, thousands separators, whitespace, case) with positions mapped back to the original source. Repeated text is disambiguated by the result's own quote position when the caller supplies it; otherwise it stays `ambiguous`. The numeric validators in `verify.js` are unchanged, including their refusal of repeated sentences.
- **Result handoff** (`src/pipeline/resultHandoff.js`, from 170a26c without the rejected rules): every proposed span is located and kept with its status; no whole-record drop on one failed field, no label-token fidelity rule, no partial-comparison rejection, no templated renderer. Approval key binds to source hash and text fingerprint, proposals, quantities and contract version; `restoreSummaryApproval` / `currentResultPaper` withhold a stale approval on read (digest snapshot, Library, vault note).
- **Coverage obligations and primary status** (`src/pipeline/obligations.js`): obligations are located endpoint-role, qualification, conflicting-analysis (`analysisRole` + new `conflictingAnalyses` list), intervention-timing spans plus the abstract's conclusion sentence; unlocated model text is reported, never an obligation. A located endpoint-role quote that names the row's outcome as primary establishes primary status; a model label never does; "both roles" or "no role" stays unknown. Unknown no longer forces number-free prose on the candidate path (the primary line tells the writer not to call any result primary and the checker's obligations cover the declaration).
- **Deterministic number binding** (`src/pipeline/numberBinding.js`, wired into `sanitizeRanking`): each number-bearing segment binds to one verified row; outcome swap, comparator reversal, analysis substitution and borrowed interval are refused (the four probes production passed). Rules are high-precision: composites naming their components, segments mentioning both outcomes, and two-analysis contrasts are left to the model checker. Scanned against every saved dev-set finding: zero false rejections.
- **Structured checker** (`src/pipeline/summaryCheck.js`): six separately reported checks against the complete evidence (obligations present / absent-immaterial / absent-material; equivalence from nonsignificance; causal overclaim; certainty overclaim; per-number row/outcome/comparator/analysis/timepoint/direction; direction/comparator refutation) plus the caution; every negative verdict carries a quote (a missing quote is flagged, never excused). Consequences are deterministic (`evaluateSummaryCheck`): unreported obligation or number fails closed; "present" with a reason admitting missing evidence is absent-material.
- **Consequences in `triage.js`** (`triageWithObligations`): one targeted rewrite naming the failures; still failing with a contradiction, overstatement or wrong binding → claim removed (`summaryKind: 'unavailable'`); still failing only by material omission → labelled verbatim excerpt (`'excerpt'`: primary result quote plus the material obligation quotes, whole passages, source order); pass → `'validated'`. Checker error → unavailable, never approval. Categories are reported separately; the UI labels validated summaries, verbatim excerpts and the unavailable notice (`SpineCheck.jsx`, `KnowledgeBase.jsx`, vault note).
- **Reused**: complete evidence passages with the conservative token budget and bounded writer batches of three (575504a, in `evidencePassages.js` as a separate module so the production window and its tests are untouched); verifier v14 "CI of" (`verify.js`, v13 fully compatible); quoted-span contract, wire validation, cache envelope `extraction-wire-v2` and raw-JSON extraction transport (170a26c, `supabase/functions/_shared/extractionContract.js`, `validateExtractionSchema.js`, `extract.js`, `anthropic.js`, `evidenceCache.js`, proxy `logic.js`/`handler.js`); bounded single rewrite and shared fidelity rules (95857d9, `proseGrounding.js`). Extraction version `2026-10-17.result-context-v4` so older cache rows miss. Digest-run bundle regenerated.

## Offline results (actual)

```
npm test      141 files, 2677 passed, 3 expected failures, 15 todo (baseline 136 / 2600)
npm run lint  0 new diagnostics (9 errors, 9 warnings pre-existing)
npm run build passes; node scripts/check-spending-contract.mjs passes
```

| Offline acceptance item | Result | Test |
|---|---|---|
| Six sanitizer probes (outcome swap, comparator reversal, analysis substitution, borrowed CI, unverified magnitude, correct control) | 4 mutants refused by binding, magnitude by the number guard, control retained | `summaryGateContract.test.js` |
| Balloon 42573020 spans | 39 of 39 located (39 whitespace-only) | `quoteLocate.test.js` |
| NPT 42681580 spans | 53 of 53 located (50 whitespace-only, 3 raw) | `quoteLocate.test.js` |
| PARADE 42513277 / aspirin 42769537 / TADV 42600759 spans | 56/56, 64/64, 27/27 located | harness `input.json` audits |
| Stale-cache / stale-approval invalidation (source text, hash, proposal, finding text, contract, missing approval; caution-only change) | withheld / caution dropped | `summaryPath.test.js` |
| Primary status from a located endpoint-role quote; label without quote stays unknown; aspirin MACE + bleeding primary, NACE not | pass | `obligations.test.js` |
| Obligation lists from located quotes only; unlocated reported | pass | `obligations.test.js` |
| Rewrite once, removal vs excerpt vs validated, checker error → unavailable, batches of 3 | pass | `summaryPath.test.js` |
| Ledger cap refused before dispatch; traces complete; fake end-to-end run of a frozen case | pass | `src/eval/summaryEval.test.js` |

A fake-client run of all six frozen cases (`scripts/eval-summary.mjs dev`, no `--live`) completed end to end; its outputs measure nothing about any model and are not kept.

## Live evaluation (blocked) — exact commands

`OUT` must be a directory; traces, `ledger.json` (running total) and `ledger.jsonl` (every priced call) are written there. Every live command refuses to run without `--live`, `--max-usd`, `ANTHROPIC_API_KEY`, and `VERASTAR_EVAL_AUTHORIZE` equal to the manifest digest printed by the same command without `--live` (an operator guard, not authorization). The ledger refuses any request whose conservative bound (whole request as input + `max_tokens` as output, shared price table) would cross the cap, and the run stops there.

```bash
# 1. Development set, six frozen papers, checker = fast model (haiku 4.5), then once with Sonnet 5.5.
VERASTAR_EVAL_AUTHORIZE=dev:bfa900bc620a node scripts/eval-summary.mjs dev --live --max-usd 20 --checker haiku  --out OUT
VERASTAR_EVAL_AUTHORIZE=dev:bfa900bc620a node scripts/eval-summary.mjs dev --live --max-usd 20 --checker sonnet --out OUT
# 2. Checker probes, five repeats each (both checker models); report the five-of-five rule per probe.
VERASTAR_EVAL_AUTHORIZE=probes:a440f3e0fc46 node scripts/eval-summary.mjs probes --live --max-usd 20 --checker haiku  --repeats 5 --out OUT
VERASTAR_EVAL_AUTHORIZE=probes:a440f3e0fc46 node scripts/eval-summary.mjs probes --live --max-usd 20 --checker sonnet --repeats 5 --out OUT
# 3. Choose and freeze the checker model (edit nothing else), then the holdout: 20 frozen papers, $30 cap.
VERASTAR_EVAL_AUTHORIZE=holdout-run:eedb8f954655 node scripts/eval-summary.mjs holdout-run --live --max-usd 30 --checker <chosen> --out OUT
```

Use one `OUT` per cap: `OUT/ledger.json` is the cap's running total (dev + probes share the $20 directory; the holdout gets its own $30 directory). Every run writes its calls, per-paper traces and `report.json` under its own `OUT/runs/<command>-<checker>-<timestamp>/`, so the haiku and Sonnet runs never overwrite each other. The ledger charges a priced response at its usage and charges the conservative bound as a liability for any request that failed ambiguously after dispatch (timeout, connection loss, 408, 5xx), returned unpriceable usage, or named a different model; a 4xx refusal is recorded at $0. `eval/plan.dev.json` is the frozen development manifest (source and extraction-input hashes); `eval/holdout/manifest.json` and `eval/holdout/sources/*.xml` are the frozen holdout set, selected on 2026-10-17 from PubMed/PMC before any model output existed. Rough, non-binding cost expectation: dev ≈ $0.5–1 per checker model, probes ≈ $0.2 (haiku) / $0.6 (sonnet), holdout ≈ $6–10; all well inside the caps.

Development cases: PARADE (42513277, full text, extraction reused), aspirin (42769537, full text, reused), balloon (42573020, abstract, reused), carotid (42637117, abstract frozen from the round-3 snapshot in `cases/42637117.frozen-source.json`; **extraction must be re-run live** because none was archived), NPT (42681580, reused), TADV (42600759, reused; single-arm, descriptive finding acceptable). **TEVAR (42693683) is excluded**: its frozen inputs are not in the archive.

## Acceptance checklist

| Criterion | Status |
|---|---|
| Six frozen papers display a validated finding or a labelled excerpt; validated count reported separately | **Not evaluated** (no key). The harness reports `counts.validated / excerpt / unavailable` separately. |
| Balloon 39/39, NPT 53/53 located | **Met** (offline). |
| PARADE weighted survival stated not significant; original patency claim refuted | Not evaluated. Obligations include the two robust log-rank qualifications and the conclusion sentence. |
| Aspirin: withdrawal timing; MACE and bleeding, not NACE alone; both primary estimates | Not evaluated. Primary status from located quotes marks MACE and bleeding primary and NACE not (tested). |
| Balloon certainty for reintervention; carotid no equivalence/safety or attributed | Not evaluated. The checker has explicit certainty and equivalence checks; the writer rules forbid "as safe" without attribution. |
| Four mutants refuted, control accepted, five of five checker runs | Deterministic layer: met offline. Model layer: not evaluated. |
| Per-paper prose cost ≤ 2× production; batches bounded | Batches ≤ 3 papers per writer call, one checker call per paper, at most one rewrite and one re-check: ≤ 4 prose calls per paper vs production's 2 (writer + checker, shared across papers). Cost not measured. |
| Holdout zero rubric hard failures (model pre-grade); physician grading of ≥ 10 papers | Not evaluated. |

## Remaining risks

- The deterministic binding rules are intentionally high-precision; the model checker carries the semantic cases (composites, contrasts, prose "versus"). Its five-of-five behaviour is unmeasured.
- Obligations inherit the extractor's choice of spans: an endpoint-role span that quotes a non-declaration sentence (PARADE `ob3` "covariates … primary outcomes") becomes an obligation the writer must carry or the checker must judge immaterial; over-obligation could push papers to the excerpt fallback. The excerpt is verbatim source, so the failure mode is readability, not misinformation.
- Excerpt fallback length is capped at 1,400 characters by dropping whole quotes; a paper with many material omissions shows only the primary quote plus the first few.
- The number-free production guard still applies to `finding_plain`; a writer that violates the contract twice yields `unavailable`, which the harness counts.
- The proxy's cache unwrap and the client envelope were changed together; a deployed proxy and client must ship together (not applicable until release).
- Holdout topics were chosen by the harness defaults (vascular, limb preservation, aortic, carotid, dialysis access, VTE, clinical AI); the clinician's own topic list was not available in the repository.

## Not tested

- Any live model behaviour: writer quality, checker verdicts, rewrite effectiveness, excerpt frequency, cost, latency, the carotid extraction.
- The checker model comparison (haiku vs Sonnet 5.5) and the frozen choice.
- The holdout run and its provisional pre-grade; physician grading.
- Browser UI rendering of the new labels beyond the production build compiling.
- The model proxy against a real Supabase cache row in the new envelope (unit-tested only).

## Recommendation

**No-ship.** The design is implemented and every offline acceptance item that can be tested without a model passes, but the acceptance criteria that decide shipping (frozen-case findings, five-of-five checker probes, holdout hard failures, physician grading) are unmeasured because no API key was available. Run the three live commands above under the caps; if the development run fails, one focused correction iteration is allowed by the plan before the holdout, and the candidate is then frozen.
