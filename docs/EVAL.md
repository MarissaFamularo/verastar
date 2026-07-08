# Eval — proving the verifier never lies

*Authored 2026-07-07. The evidence that the sacred core works, and the source of the
demo's trust number. All ground truth is generated **during the event** (rules-clean —
no pre-existing spreadsheet is reused).*

## The metric — precision-first, not accuracy

The thesis is that the model does **not** have to be perfect, because the verifier
catches it. So the target is **not** extraction accuracy. It is:

> **Verifier precision = 100%. Never a green `verified` badge on a wrong value.**

Two error types, wildly asymmetric:
- **False verify** (badge a wrong value as proven) — **fatal.** Invalidates the whole
  product. Drive to **zero.**
- **False flag** (flag a value that is actually correct) — annoying, tolerable. Keep the
  rate reasonable so the digest isn't all grey.

Optimize the code and the extraction prompt to kill false-verifies first, then reduce
false-flags second. Never trade a lower false-flag rate for a single false-verify.

**Demo payoff:** *"We ran N papers. The model made M extraction errors. The verifier
caught 100% of them — zero false `verified` badges."* That number feeds Claude Use (25%)
and Depth & Execution (20%).

## Ground-truth sources (in ROI order)

### 1. Synthetic adversarial triples → `verify.js` unit suite (spine-day essential)
No external document needed. Hand-author ~30 cases of the form
`(claimed_number, source_quote, source_text) → expected_verdict`, then run the loop:
write tests → run → fix code → rerun until green. This is how we *know* the core works
before anything hangs off it. Cases must include:

- interpunct decimal: quote `0·84`, claim `0.84` → **verified** (normalization).
- number-inside-a-number: claim `0.02`, quote says `0.028` → **flagged** (no false verify).
- leading-zero variants: claim `0.9`, quote `.90` → **verified**.
- trailing-zero: claim `8`, quote `8.0` → **verified** (float-equal).
- unicode dash in CI: quote `0.61–1.16` with en-dash → parses, **verified**.
- integer collision: claim `84` (an N), quote contains `1984` only → **flagged**.
- faithful quote, corrupted value: real sentence, JSON value off by a digit → **flagged**.
- quote not in text at all (hallucinated) → **flagged**.
- table-cell value: `location_hint` names a table; value only in a `<table-wrap>` cell → **verified**.
- p-value forms: claim `0.001`, quote `P<0·001` → handled per rule (document the decision).

### 2. ClinicalTrials.gov as an independent answer key
For papers backed by a registered trial with `hasResults=true`, CT.gov posts the
structured outcome value — ground truth from **neither the paper text nor the model**.
Pull ~10 such trials → a labeled set for the registered subset, and the same data powers
the `verified-registry` tier. (Seed: NCT04881110 / STARDUST → 11.2 mmHg, 95% CI 8.0–14.5.)

### 3. ~15 open-access PMC papers, Claude-extracted + human spot-check
For the unregistered majority: during the event, Claude reads full text and extracts
headline quantities **with source sentences**; Marissa eyeballs a sample. The source
sentence makes each row self-auditing. Small N, high quality, built fresh.

## The loop (agentic, human-in-the-loop)
1. Assemble cases (source #1 first, then #2/#3).
2. Run pipeline → record verdict per case.
3. Any **false verify** → stop, fix `verify.js` or tighten the extraction schema, rerun.
4. Repeat until false-verifies = 0 and false-flags are acceptable.
5. Freeze the suite; the final counts become the demo number.

Keep it human-reviewed — no unattended overnight runs deciding correctness. The suite is
a means to a trustworthy core and one honest number, not an end in itself.

## Scope discipline
- Source #1 is **required, on spine day** — it is not polish; it is how the badge earns
  trust.
- Sources #2–3 are a **polish-phase asset** whose payoff is the video's trust number.
- Do not let the eval eat the week. ~30 synthetic cases + ~25 real rows is enough.
