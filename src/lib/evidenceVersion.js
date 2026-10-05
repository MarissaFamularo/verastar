import { verify, VERIFICATION_VERSION, COMPATIBLE_VERIFICATION_VERSIONS } from '../pipeline/verify.js'
export { VERIFICATION_VERSION }

// Read-time policy only: old persisted source, annotations and provenance remain intact.
// Missing/older verdict stamps never inherit the new relationship guarantee.
export function evidenceVerdict(verdict) {
  if (verdict?.verificationVersion === VERIFICATION_VERSION || COMPATIBLE_VERIFICATION_VERSIONS.includes(verdict?.verificationVersion)) return verdict
  return {
    ...verdict,
    originalTier: verdict?.originalTier || verdict?.tier || null,
    verificationVersion: verdict?.verificationVersion || null,
    tier: 'legacy-unchecked',
    flagged: true,
    relationshipValidated: false,
    relationshipStatus: 'unchecked',
    reason: 'Earlier verification checked source tokens only. Claim relationships have not been checked under the current rules; inspect the saved source before use.',
    warnings: (verdict?.warnings || []).map((warning) => ({ ...warning, status: 'unverified', message: String(warning?.message || '').replace(/^Verified as printed, but/, 'Unverified extraction; additionally,') })),
  }
}

// A saved paper's evidence under the CURRENT verifier. Library papers keep the verdict
// stamped when they were saved; a stale stamp is re-derived from the source text saved
// with the paper — the same corpus it was first verified against — exactly as the digest
// store does (lib/digestStore.js), so a verifier fix reaches the Library without a paid
// re-run. Read-time only: nothing is written back. The saved bookkeeping fields (tier,
// verdict) are stripped first, since verify refuses fields it does not know. Without saved
// source text the read-time version policy (evidenceVerdict) applies as before.
export function currentPaperQuantities(paper) {
  const quantities = Array.isArray(paper?.quantities) ? paper.quantities : []
  const text = paper?.fullText || ''
  const tables = paper?.tables || ''
  if (!text && !tables) return quantities
  return quantities.map((saved) => {
    if (saved?.verdict?.verificationVersion === VERIFICATION_VERSION) return saved
    const { tier, verdict, ...quantity } = saved || {}
    if (!quantity.source_quote) return saved
    const fresh = verify(quantity, { text, tables }, { sourceTier: verdict?.sourceTier || 'abstract_only' })
    return { ...quantity, tier: fresh.tier, verdict: fresh }
  })
}

export function isRelationshipValidated(verdict) {
  return evidenceVerdict(verdict).relationshipValidated === true && evidenceVerdict(verdict).flagged === false
}

// The library rail counts papers with at least one currently validated claim,
// never a relevance tier, PubMed citation flag, or legacy paper-level boolean.
export function hasValidatedPaperEvidence(paper) {
  return Array.isArray(paper?.quantities) && paper.quantities.some((quantity) => isRelationshipValidated(quantity?.verdict))
}

// App-owned provenance for the extraction that created a paper's structured evidence.
// Bump this whenever the extraction model, prompt, or schema changes in a way that could
// alter saved quantities. A missing stamp is intentionally legacy, never assumed current.
export const CURRENT_EXTRACTION_VERSION = '2026-10-04.sonnet-5-5-v2'

export function extractionVersionStatus(record) {
  const version = String(record?.extractionVersion || '').trim()
  if (!version) return 'legacy'
  return version === CURRENT_EXTRACTION_VERSION ? 'current' : 'outdated'
}

export function extractionUpdateAvailable(record) {
  return extractionVersionStatus(record) !== 'current'
}
