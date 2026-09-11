import { VERIFICATION_VERSION } from '../pipeline/verify.js'
export { VERIFICATION_VERSION }

// Read-time policy only: old persisted source, annotations and provenance remain intact.
// Missing/older verdict stamps never inherit the new relationship guarantee.
export function evidenceVerdict(verdict) {
  if (verdict?.verificationVersion === VERIFICATION_VERSION) return verdict
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

export function isRelationshipValidated(verdict) {
  return evidenceVerdict(verdict).relationshipValidated === true && evidenceVerdict(verdict).flagged === false
}

// App-owned provenance for the extraction that created a paper's structured evidence.
// Bump this whenever the extraction model, prompt, or schema changes in a way that could
// alter saved quantities. A missing stamp is intentionally legacy, never assumed current.
export const CURRENT_EXTRACTION_VERSION = '2026-09-11.relationships-v1'

export function extractionVersionStatus(record) {
  const version = String(record?.extractionVersion || '').trim()
  if (!version) return 'legacy'
  return version === CURRENT_EXTRACTION_VERSION ? 'current' : 'outdated'
}

export function extractionUpdateAvailable(record) {
  return extractionVersionStatus(record) !== 'current'
}
