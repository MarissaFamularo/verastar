# Verastar summary evaluation — stopped after round 3

**Decision: do not release.** Independent Astra review found scientific quality stalled. No further paid calls, prompt patches, rounds, or sealed-holdout testing are planned. Nothing from this evaluation was merged or deployed.

## Useful engineering changes preserved

- Complete evidence passages and conservative request-budget batching: context-only checkpoint `575504a0bba8d6ae31d015666f06c6ff2daf6e6e`.
- Deterministic rejection of missing, duplicate, or unexpected ranking IDs before downstream maps; provider-compatible schema and three-paper batches.
- Source-bound delta-statistic labels; explicit null scores/reasons for unusable summaries; bounded repairs scoped to their requested IDs and evidence.
- Raw writer/fallback, transformation, repair and final-display traces. Final candidate: `95857d9171aa1a8c4998170c2df919af4319538f`.

These changes improved structure and availability, but do not establish scientific correctness. They remain reviewable checkpoints, not release recommendations. Offline checks passed: 140 files, 2,626 tests; build passed; no new lint diagnostics.

## Unresolved scientific failures

Despite full evidence, the checker approved main sentences while its own explanations recognized qualifications that those sentences omitted or overstated:

- PARADE: weighted survival uncertainty remained in the caution rather than the main finding.
- Aspirin withdrawal: the material one-to-two-month timing remained absent from the main finding.
- Drug-eluting balloons: low-certainty reintervention evidence was presented with confident benefit language.
- Radiation-associated carotid disease: similar perioperative outcomes were described as “as safe,” implying equivalence.

Availability at round 3 was twelve of twelve regression findings and two of three fresh findings. The remaining TEVAR finding was blank after its single bounded repair. Independent review therefore does not support advancing to the final holdout or production.

## TEVAR offline diagnosis only

Using the saved final-round inputs and raw/repair outputs, both main findings failed the numeric gate, while `headlinesNonPrimary` was false. The source-backed thirty-day timepoint was accepted for the main sentence. Separated anatomical labels “zone 2” and “zone 3” were rejected as unverified numeric tokens. Both fallbacks failed the strict number-free check; the repair fallback still contained numeric zone labels and “30 days.” Thus the issue is distinguishable from primary eligibility and from missing source evidence. No gate change or new evaluation was made.

## Safe next recommendation

Keep production unchanged. Review the structural fixes separately for possible future isolation and approval. Treat scientific correctness as a separate design problem: use the existing reviewed cases to specify a source-to-claim audit that preserves decisive analysis distinctions and rejects missing material qualifications. Evaluate any future design against the fixed failure rubric before paid runs. Do not continue general prompt additions or weaken numerical gates to make coverage look better.

