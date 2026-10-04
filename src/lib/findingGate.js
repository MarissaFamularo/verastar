// lib/findingGate.js — the ONE rule for reusing a saved paper's finding sentence.
//
// The prose gate (pipeline/check.js) stamps every finding { verdict }. A 'refuted' finding is
// withheld on the digest screen, the paper card and the vault note — and it must stay withheld
// everywhere else it travels: concept summaries, weekend synthesis, connection proposals and
// any other model prompt or display that reads `paper.finding`. Saved text is not approved
// evidence just because it was saved. 'unchecked' and 'supported' pass through unchanged.
// Pure; no store or model dependency so components and pipeline modules can share it.

export function usableFinding(paper) {
  if (!paper || paper.check?.verdict === 'refuted') return ''
  return String(paper.finding ?? '')
}
