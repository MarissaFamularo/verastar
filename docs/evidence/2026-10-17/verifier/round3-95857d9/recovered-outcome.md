# Round 3 recovered evaluation — pending independent review

Final candidate: `95857d9171aa1a8c4998170c2df919af4319538f` on `codex/complete-evidence-passages`. No merge, deployment, migration, or production paper write.

## Outcome

- Development regressions: twelve selected papers, twelve unique returned identities, twelve nonblank displayed findings.
- Frozen fresh set: three selected papers, three unique returned identities, two nonblank displayed findings. PMID 42693683 (TEVAR landing-zone meta-analysis) remains blank after one bounded rewrite and has a null score with an explicit numeric/primary-scope failure reason.
- The other fresh cases are PMID 42704575 (cilostazol/rosuvastatin) and PMID 42733468 (CRP/MESA).
- All fifteen saved originals were reread and compared unchanged. Final holdouts remain untouched.
- No additional round was started; infrastructure and repair-scope recovery stayed within round three.

The independent reviewer should judge exact displayed findings and cautions, including the missing TEVAR finding. Raw/intermediate good text is not a substitute for a displayed result. Several previous semantic problems remain visible in development outputs: PARADE's weighting qualification appears only in the caution, aspirin withdrawal timing is still omitted from the main finding, the balloon finding uses confident benefit language despite differing certainty grades, and the carotid finding says 'as safe' after nonsignificant comparisons. These are implementation observations, not a replacement for independent source review. Do not release pending review.

## Recovery and provenance

1. `8758a69` added per-ID keyed output, deterministic identity validation, bounded blank-summary repair, explicit unscored failures, diagnostic traces, and source-bound delta labels. The twelve-paper keyed schema was rejected by the provider as too complex. No output was returned.
2. `4a82f0a1a07814389ca4b48d8fd32dce3cb0050a` restored the previously supported reusable array-row schema and limited writer/checker groups to three papers. Client validation rejects duplicate, missing, or unexpected IDs before maps. The twelve development outputs were generated at this commit, with no repair requests needed.
3. The first fresh attempt's main response had exactly three IDs. Its repair needed one ID but returned all three because the repair prompt still referred to schema IDs after changing to an array schema. Validation rejected that response; no findings from that attempt were displayed. The entire failed trace is retained in the fresh packet.
4. `95857d9171aa1a8c4998170c2df919af4319538f` explicitly names repair IDs and passes only their evidence. Only the fresh summary/checker stage was rerun; source retrieval and extraction were reused. The resulting repair returned exactly its requested two IDs. One finding recovered, while TEVAR remained unusable. No further repair loop occurred.

The final change affects repair scoping only; the development outputs' non-repair path did not change. Packet headers preserve their actual generating commit rather than claiming all outputs were produced at the final commit.

## Deliverables

- `Verastar-round3-development-review.md`: exact displayed outcomes, twelve full sources, candidate inputs, raw writer output/fallbacks, sanitization and final checks.
- `Verastar-round3-fresh-review.md`: equivalent packet for the three frozen fresh papers, including both the failed attempt and final recovery trace.
- `Verastar-round3-recovered-code.diff`: candidate changes from the preserved context-only checkpoint `575504a0bba8d6ae31d015666f06c6ff2daf6e6e`.

Remaining blocker: independent scientific review and the demonstrated fresh-summary coverage failure. No migration required.
