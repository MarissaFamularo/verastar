# Result-handoff review: PARADE empty-summary failure

Scope: branch `codex/result-context-handoff` at checkpoint `7d0f5fe`, reconstructed from the
external-review handoff packet (the branch is not on the GitHub remote; the packet embeds the
complete `resultHandoff.js`, `extract.js`, `triage.js`, `check.js`, the schema validator and
the three test files, plus the full PARADE trace). Offline only: no model calls, no live data.

## Diagnosis (verified by replaying the saved trace)

The recorded diagnostics reproduce exactly from the packet's source, normalized extraction and
`buildResultHandoff` (`src/pipeline/__fixtures__/parade/pmid42513277.json`). All 55 quotes are
exact, unique substrings of the corpus. Every rejection came from the label gate, the
number-typing gate, or the comparison contract, never from source evidence.

1. **One verdict for two questions.** `locateField` returned `context-not-located` both when the
   quote was not in the corpus (fabrication) and when the short label was not a verbatim
   substring of its own quote (paraphrase). Seven fields failed the second way, e.g. label
   `bleeding complications not systematically captured`, quote `... were not systematically
   captured`; `competing risk analysis to account for death`; `early graft occlusion` versus
   `Early graft occlusion` (case). The checker already judges label meaning against the complete
   source, so the verbatim rule bought no safety that the quote rule and the checker do not
   already provide, and it cost every record.
2. **One caveat sank the whole result.** Records 0–3 (conventional Cox, weighted patency,
   weighted survival null, competing-risk patency) had every mandatory field located and were
   each rejected for one qualification. Two of those qualifications carried P values and should
   never render as labels; the correct outcome is to withhold the caveat, not the result.
3. **Contextual numbers were typed only in some fields.** `75 mm` (no length unit), `30-day
   MACEs` in `endpointRole`, and `30-day primary patency` in a qualification were rejected as
   unverified estimates because the time-unit strip applied only to six field keys and knew no
   length units.
4. **Descriptive outcomes had no representation.** Five cohort outcomes (overall survival 90.3%,
   primary patency 86.1%, secondary patency 94.7%, early occlusion 2.0%, early MACE 1.1%) were
   rejected for lacking intervention/comparator/effect. They are not comparisons; the contract
   forced an invented one or nothing.
5. **No tuple verified, so no estimate could ever render.** All ten quantities were only
   `source-located` under `estimates-v13`: the estimate grammar accepts `95% CI, 1.04–1.61`,
   `95% CI: ...`, `95% CI = ...` but not MDPI's `95% CI of 1.04–1.61`. With that joiner admitted,
   the multivariable Cox tuple verifies. The three weighted/competing-risk tuples claim a P that
   the verifier deliberately refuses to bind (`log-rank test, p < 0.0001; robust log-rank, p =
   0.03`, or `p = 0.011, C = 0.53`), so they remain qualitative. That is correct behaviour; the
   fix is for extraction to omit an unbindable P, which is a prompt matter, not a verifier one.
6. **The checker's own `applyResultApproval` and binding logic are sound.** Swapped outcomes,
   reversed comparators, borrowed CIs, stale approvals and changed presentations all fail closed
   in the existing tests and continue to.

Not confirmed from the packet: the risk-factor record 7 (`bypasses longer than 75 mm`, HR 1.41)
names no comparator in the source sentence. It stays rejected; inventing `≤ 75 mm` is exactly
what the brief forbids.

## Patch (two commits, `src/pipeline/resultHandoff.js`, `check.js`, `verify.js`)

Handoff gate (`result-handoff-v3`):

- Quote location unchanged: exact, unique corpus substring, else `context-not-located` or
  `ambiguous-context-passage`.
- Label fidelity is a separate verdict. Verbatim is accepted as before. A paraphrase is accepted
  only when every word of it is printed in its own quote (drop or reorder, never add). A
  claim-bearing label (effect, qualification) may not shed a negation its quote prints, verbatim
  or not (`differ significantly` is a substring of `did not differ significantly`). Each span
  records `fidelity: verbatim | paraphrase` for the checker. New reasons: `label-not-in-quote`,
  `label-drops-negation`.
- Typed contextual numbers (time units, hyphenated forms, `mm`/`cm`, `n-stage`, numbered endpoint
  classes) are admitted in every field; anything else is still `unsupported-context-number`. A
  paraphrase can only carry numbers printed in its own quote.
- A failed field rejects the record (its identity is unsourced). A failed qualification is
  withheld: never rendered, listed as `withheldQualifications` on the record and in diagnostics,
  and the checker prompt says to refute the presentation if it misleads without it.
- `kind: descriptive` when intervention, comparator and effect are all absent; renders as the
  outcome plus analysis/roles/timing and the verified estimate, with no `versus`, and only when
  the tuple is verified. A partial comparison is still rejected with `missing`.

Verifier (`estimates-v14`): `(?:[,:=]|of)?` between the CI label and its bounds. Refuses nothing
v13 accepted, so v13 is fully compatible and stays as stamped. Bundle regenerated with
`npm run bundle:functions`.

## PARADE after the patch (offline, checker verdicts supplied)

Records 0–3 admitted as comparative; 4, 5, 6, 8, 9 admitted as descriptive but excluded from
the plan (no verified tuple); 7 rejected (`missing: comparator`). Withheld: record 1 and 2
P-value caveats, record 3 `residual confounding by indication possible` (adds `possible`).
Rendered summary keeps the conventional Cox result with `Estimate: 1.30 hazard ratio (CI
1.04–1.61)`, the weighted survival null, the weighted and competing-risk patency results with
their analysis labels, the 30-month timepoint, and the bleeding caveat. No P value renders.

## Tests

`src/pipeline/resultHandoffParade.test.js` (saved trace): admission of the four analyses,
paraphrase marking, typed numbers, withheld caveats never rendering, no invented comparator,
descriptive admission and render rule, full-summary render and restore, estimate binding.
Adversarial on the same source: outcome swapped to a phrase elsewhere in the paper, inserted
negation, dropped negation (field and caveat), reordered comparator (admitted by the gate,
refuted by the checker dimension), unprinted timing number, statistics smuggled into labels,
fabricated and ambiguous quotes, borrowed CI, and wire-shaped cache replay.
`resultHandoff.test.js` adds typed-number, withheld-caveat, paraphrase and descriptive cases.
`estimateVerify.test.js` adds the `CI of` positive control and false-verify guards.

## Residual risks and what this does not prove

- A paraphrase made only of quote words can still change meaning (reordering, omission other
  than negation). The gate marks it; the checker must judge it. This was already true of
  verbatim substrings and is not new exposure, but it is model-judged, not deterministic.
- The withheld-caveat disclosure depends on the checker refusing a misleading omission. The
  prompt sentence is new and has not been evaluated on a paid run; one round on the frozen
  five-case set is needed before beta.
- Descriptive results render only with a verified tuple, so for PARADE none render. Plain
  percentages without a count do not verify by design.
- The extraction prompt still says labels are exact substrings. The model did not comply; the
  gate now tolerates faithful paraphrase. Changing the prompt is a separate evaluated iteration.
- Record 7 style risk-factor estimates remain unrepresentable without a stated comparator.

## Release blocker, unchanged by this patch

`runPaper` consumes `cached.extraction` directly on a cache hit. A proxy-written cache can hold
the raw wire shape (`outcome: [span]`), a server-written cache the normalized shape
(`outcome: span`). `buildResultHandoff` on wire-shaped contexts rejects every record with
`malformed-context-field` (test: "rejects every record when a cache hit replays wire-shaped
contexts"), and `normalizeResultContexts` on normalized contexts throws. Smallest fix, not
made here because the branch's `pipeline.js` is not in the packet: on a cache hit, if any
context field is an array, pass `result_contexts` through `normalizeResultContexts` before
use; and bump `CURRENT_EXTRACTION_VERSION` so v2-era cache rows are never replayed under v3.
