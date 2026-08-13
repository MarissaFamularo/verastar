// App-owned provenance for the extraction that created a paper's structured evidence.
// Bump this whenever the extraction model, prompt, or schema changes in a way that could
// alter saved quantities. A missing stamp is intentionally legacy, never assumed current.
export const CURRENT_EXTRACTION_VERSION = '2026-08-12.quantity-semantics-v2'

export function extractionVersionStatus(record) {
  const version = String(record?.extractionVersion || '').trim()
  if (!version) return 'legacy'
  return version === CURRENT_EXTRACTION_VERSION ? 'current' : 'outdated'
}

export function extractionUpdateAvailable(record) {
  return extractionVersionStatus(record) !== 'current'
}
