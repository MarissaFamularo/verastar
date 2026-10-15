// CMS NPPES v2.1: https://npiregistry.cms.hhs.gov/api-page
// A public registry match is signup friction, not identity or license verification.
export const NPI_MATCH_VERSION = 1
export function normalizeName(value) {
  return String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}]/gu, '')
}
export function validNpi(value) {
  if (typeof value !== 'string' || !/^[12]\d{9}$/.test(value)) return false
  const digits = `80840${value}`.split('').reverse().map(Number)
  return digits.reduce((sum, n, i) => sum + (i % 2 ? (n * 2 > 9 ? n * 2 - 9 : n * 2) : n), 0) % 10 === 0
}
export function validNpiInput(input) {
  return Boolean(input && validNpi(input.npi) && ['firstName', 'lastName'].every((key) =>
    typeof input[key] === 'string' && input[key].trim().length <= 100 && /^[\p{L}\p{M} .’'-]+$/u.test(input[key]) && normalizeName(input[key]).length > 0))
}
export function hasNpiMatch(user) {
  const receipt = user?.app_metadata?.npi_match
  return Boolean(receipt?.version === NPI_MATCH_VERSION && validNpi(receipt.npi) &&
    normalizeName(receipt.firstName) && normalizeName(receipt.lastName) && Number.isFinite(Date.parse(receipt.matchedAt)))
}
export async function lookupNpi(input, fetcher = fetch) {
  if (!validNpiInput(input)) return { status: 'invalid' }
  try {
    const response = await fetcher(`https://npiregistry.cms.hhs.gov/api/?version=2.1&number=${input.npi}`, {
      signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json' },
    })
    if (!response.ok) return { status: 'unavailable' }
    const body = await response.json()
    if (body?.Errors || !Number.isInteger(body?.result_count) || !Array.isArray(body?.results)) return { status: 'unavailable' }
    const record = body.results.find((entry) => String(entry.number) === input.npi)
    if (!record || record.enumeration_type !== 'NPI-1' || record.basic?.status !== 'A') return { status: 'not_found' }
    if (normalizeName(record.basic.first_name) !== normalizeName(input.firstName) ||
        normalizeName(record.basic.last_name) !== normalizeName(input.lastName)) return { status: 'mismatch' }
    return { status: 'matched', match: { version: NPI_MATCH_VERSION, npi: input.npi,
      physician: Array.isArray(record.taxonomies) && record.taxonomies.some(t => /^20[0-9A-Z]{8}$/.test(t.code || '')),
      firstName: record.basic.first_name, lastName: record.basic.last_name, matchedAt: new Date().toISOString() } }
  } catch { return { status: 'unavailable' } }
}
