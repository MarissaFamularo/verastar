# Complete evidence passages review

The prose evidence window previously clipped Results at a character boundary, which could omit an exception while retaining the statement it qualified. Writer and checker also independently sliced evidence. This change preserves the complete normalized abstract and complete outermost Results sections, including nested passages, and sends identical evidence to both prose stages.

Evidence is bounded to 12,000 characters per paper, 100,000 UTF-8 bytes per batch, and 150,000 UTF-8 bytes for the entire prose prompt. Oversized evidence fails explicitly before dispatch rather than silently truncating or falling back to an incomplete abstract. Large batches may need splitting; large individual papers may require direct review. Existing missing-source handling remains unchanged. Extraction, numerical verification, models, and checker instructions are unchanged.

## Verification

- 137 test files passed: 2,606 tests passed, three expected failures, 15 todo.
- Production build passed; lint reported no new diagnostics (existing baseline: nine errors and nine warnings).
- Synthetic regression verifies late qualifying clauses beyond the old 6,000-character downstream cutoff, complete abstract retention, provenance, nested-section deduplication, identical writer/checker evidence, and bounded rejection before model dispatch.
- Read-only replay of three real sources retained every abstract part and all available Results sections: PMID 42619594 (2,672 characters), PMID 42513277/PARADE (9,160), PMID 42769537 (9,405).
- The original PARADE claim incorrectly generalized similar long-term patency across regimens. With the complete context, the unchanged live checker returned **refuted**, explicitly identifying worse primary patency with combined therapy. The earlier truncated-context run had returned supported. This is a checker regression, not proof of a regenerated writer output.

Six total paid calls across the original comparison and this regression settled at $0.166673. The unchanged conservative reservation ledger totals $8.748160 against the authorized $10 cap; another Sonnet writer call cannot fit its maximum reservation and was not attempted. Original saved papers were preserved; the local harness blocks database writes.

## Release scope

Review branch only; do not merge or deploy until approved. No database migration is needed. The checked-in digest-run bundle was regenerated so an eventual release must update both the frontend and digest-run function. The model proxy requires no change. Local comparison data, account state, and the disposable harness are excluded from the commit.
