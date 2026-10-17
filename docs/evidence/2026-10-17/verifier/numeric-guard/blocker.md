# Narrow gate fix: offline acceptance blocker

No release candidate was produced. Production and the clean production-based branch `codex/verified-summary-values` remain unchanged. No model calls or source/context patch changes were made.

## Work completed after the initial diagnosis

Added and executed six offline acceptance probes against production's actual `sanitizeRanking`, using two verified results with distinct outcomes and confidence intervals. The probes describe the minimum requirements explicitly requested for preserving numbers.

| Acceptance probe | Result |
|---|---|
| Retain matched outcome/comparison/analysis/HR/CI | Pass |
| Reject a new unverified HR | Pass |
| Reject changing bleeding to MACE | **Fail: sentence retained** |
| Reject reversing treatment A versus B | **Fail: sentence retained** |
| Reject changing ITT to per-protocol | **Fail: sentence retained** |
| Reject pairing one HR with the other outcome's CI | **Fail: sentence retained** |

This is a deterministic sanitizer finding, not a claim that the entire pipeline always displays these mutants: the subsequent model checker can reject them. That checker is unchanged, and previous independent review demonstrated false assurance. It cannot supply the deterministic acceptance guarantee requested here.

## Precise blocker

The current prose path reduces verified rows to formatted strings and tests numeric membership across the paper. `citedEntries` links a sentence to a row whenever any numeric token matches. Neither mechanism binds each summary estimate and its CI to a particular outcome, comparator orientation, or analysis. The requested mismatch tests therefore fail even before introducing duration handling or changing primary identification.

The aspirin duration problem and primary declaration parser problem are real, but simply removing those two barriers would expose this existing lack of claim binding. A blanket contextual-number exception, a model-name-based primary fallback, or bypassing `unknown` would not satisfy the user's explicit safeguards.

This is an unresolved implementation/design dependency, not an access denial or an uncertain write. The application fix and paid known/fresh comparison remain pending. No action was denied, and no paid attempt was started.

## Safe next step

Specify and implement a bounded structured claim-to-receipt binding for summary estimates (row identity, outcome, ordered comparison, analysis, estimate and CI together), with source-backed contextual duration kept in a separate typed field. Preserve explicit primary/secondary roles and unresolved declarations rather than inferring them. The six probes should become acceptance tests for that design, followed by duration and multiple-endpoint parser tests. That is a larger change than the requested contextual-duration/primary-parser patch; it should be reviewed as such before paid evaluation.

The current branch has no application edits. Probe source and results are preserved under `comparison-output/summary-gate-acceptance/`; initial exact-sentence and primary-parser replay logs remain in `comparison-output/`. No source snapshots, saved records or checkpoints were deleted.

