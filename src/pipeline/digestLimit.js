// Pilot ceiling: all read attempts in a digest share one allowance, including additions.
export const PILOT_DIGEST_LIMIT = 20
export const DIGEST_LIMIT_NOTE = 'The pilot allows up to 20 papers per digest. Remaining candidates are available for a later digest.'
export const LEGACY_DIGEST_LIMIT_NOTE = 'This saved digest exceeds the pilot limit of 20 papers. Start a new digest; your saved papers are unchanged.'
export function digestCount(value, fallback = 5) {
  const n = Math.round(Number(value))
  return Math.min(PILOT_DIGEST_LIMIT, Number.isFinite(n) && n > 0 ? n : fallback)
}
export function fitDigestPapers(papers, processed = []) {
  const seen = new Set(processed.map((r) => String(r.paper.id)))
  let room = Math.max(0, PILOT_DIGEST_LIMIT - seen.size)
  return papers.filter((p) => {
    const id = String(p.id)
    if (seen.has(id) || room === 0) return false
    seen.add(id)
    room -= 1
    return true
  })
}
