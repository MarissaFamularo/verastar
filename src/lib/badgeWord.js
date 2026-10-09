// lib/badgeWord.js — the provenance badge's one word, kept out of the component file so
// ProvenanceBadge.jsx exports only a component (fast refresh).

// The badge is ONE word (2026-10-04: multi-part labels read as noise). What exactly was
// matched — and what was not, e.g. "endpoint unchecked" — moves to the tap-to-explain panel; the
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

// What the app checked, and what it did not, for the tap-to-explain panel under a badge.
// Phones have no hover, so the qualification ("endpoint unchecked", "groups unchecked")
// must be reachable by tap and keyboard. Plain sentences; no claim beyond what the
// verifier's tier means.
const WHERE = {
  full_text: 'the full text',
  abstract_only: 'the abstract (full text was not available)',
  user_text: 'the file you supplied, not the publisher copy',
}
const ALWAYS = 'Before relying on it, read the quote for the treatment arm, population, outcome and timepoint.'

export function badgeExplanation(tier, sourceTier) {
  const where = WHERE[sourceTier] || 'the source'
  switch (tier) {
    case 'verified-registry':
      return { checked: ['The value matches a result posted for this trial on ClinicalTrials.gov.'], unchecked: ['How the result applies to your patients.', ALWAYS] }
    case 'verified-full-text':
      return { checked: ['The number and what it measures were matched in one sentence of the full text.'], unchecked: ['The paper’s broader interpretation.', ALWAYS] }
    case 'abstract-only':
      return { checked: ['The number and what it measures were matched in one sentence of the abstract.'], unchecked: ['Anything only the full text reports; it was not available.', ALWAYS] }
    case 'verified-user-text':
      return { checked: ['The number and what it measures were matched in the file you supplied.'], unchecked: ['Whether that file matches the published version.', ALWAYS] }
    case 'verified-estimate':
      return { checked: [`The estimate and its interval appear exactly as printed in ${where}.`], unchecked: ['Endpoint: which outcome and comparison the estimate belongs to.', ALWAYS] }
    case 'verified-comparison':
      return { checked: [`The values appear exactly as printed in ${where}.`], unchecked: ['Groups and endpoint: which arm or cohort each value belongs to, and which outcome.', ALWAYS] }
    case 'verified-proportion':
      return { checked: [`The percentage was recomputed from its count in ${where}.`], unchecked: ['Endpoint: which outcome the count measures.', ALWAYS] }
    case 'verified-heterogeneity':
      return { checked: [`The I² value appears exactly as printed in ${where}.`], unchecked: ['Analysis: which pooled comparison it describes.', ALWAYS] }
    case 'source-located':
      return { checked: ['The quote was found in the source.'], unchecked: ['Whether the number belongs to what the label says. Read the source before using it.'] }
    case 'legacy-unchecked':
      return { checked: ['Checked under earlier, looser rules that matched numbers only.'], unchecked: ['What each number measures, under the current rules. Refresh the paper or read the source.'] }
    default:
      return { checked: [], unchecked: ['The app could not match this value to the source. It is withheld; read the source.'] }
  }
}
