// lib/badgeWord.js — the provenance badge's one word, kept out of the component file so
// ProvenanceBadge.jsx exports only a component (fast refresh).

// The badge is ONE word (2026-10-04: multi-part labels read as noise). What exactly was
// matched — and what was not, e.g. "endpoint unchecked" — moves to the hover text; the
// verbatim quote still renders directly under every badge, so no evidence hides.
const WORD = {
  'verified-registry': 'Verified',
  'verified-full-text': 'Verified',
  'abstract-only': 'Verified',
  'verified-user-text': 'Verified',
  'verified-estimate': 'Verified',
  'verified-comparison': 'Verified',
  'verified-proportion': 'Verified',
  'verified-heterogeneity': 'Verified',
  'source-located': 'Unresolved',
  'legacy-unchecked': 'Outdated',
  flagged: 'Flagged',
}

export function badgeWord(tier) {
  return WORD[tier] || WORD.flagged
}
