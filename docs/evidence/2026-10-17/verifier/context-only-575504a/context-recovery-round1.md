# Round 1 context recovery checkpoint

Scope: fix defects introduced by the complete-passage change. No prose prompt, numerical verifier, model selection, UI, database, or production changes.

- Legacy full-text resumes use the entire saved verification corpus plus tables with an explicit provenance header; clipped windows are never reused. A missing corpus stops before generation. An unusually large legacy corpus requests re-reading to recover structured abstract/Results context.
- Fresh abstract and Results passages remain complete. LIFE-BTK's real 12,327-character window now fits with every abstract part and Results passage retained.
- Admission uses conservative token accounting: serialized UTF-8 bytes (including JSON escapes, system/user messages and schema), multiplied by 1.25, plus 1,024 overhead tokens and requested output tokens, against the smaller configured prose-model context. This is a local overestimate, not a provider token count. The source-only guard derives from that context with 32,768 tokens reserved for prompt overhead and 8,192 output tokens; final admission checks the entire request. Truly oversized single sources remain explicitly blocked.
- Writer batches split deterministically at paper boundaries until each request fits. Checker batches split at source boundaries, keeping finding/caution pairs together. Every paper remains represented; no evidence text is dropped. Scores remain the existing per-paper rubric scores, although model output can vary with batch composition. Extra batches can incur additional calls; existing spending controls still apply.
- Scheduler bundle regenerated from the same modules.

Validation: 138 test files passed, 2,612 tests passed, three expected failures, 15 todo. Production build passed; lint reports zero new diagnostics. New tests cover old clipped-window resume, missing evidence rejection, complete >12k passages, 20-paper writer batches, standalone checker batches with paired claims, UTF-8 and JSON-escape accounting, schema/output overhead, and pre-dispatch refusal. Offline replay retained the complete LIFE-BTK window and the complete saved 32,126-character PARADE corpus.

[Historical spending paragraph omitted.]

PARADE is not an unqualified prose pass. Unweighted Kaplan–Meier and conventional multivariable Cox analyses associated combined therapy with worse survival; inverse-probability-weighted analysis did not establish that survival difference (confidence interval crossed the null; robust test nonsignificant). Patency association persisted after weighting. The fresh finding leads with worse survival while placing weighting uncertainty in a separate caution, so readers of the finding alone could overinterpret it. This prose issue remains separate from context recovery.

Minimal next prose work, now authorized for the bounded hill-climb: enforce the reported analysis and uncertainty in the finding itself, distinguish not reported from demonstrated absent, preserve change-versus-level labels such as ΔC, and match certainty language to the source's evidence grade. Add focused regression cases; independent source review must measure useful-summary coverage as well as correctness. Do not tune to sealed final holdouts.
