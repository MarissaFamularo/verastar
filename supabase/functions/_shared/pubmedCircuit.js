// Service-owned, durable admission for scheduled discovery. One search at a time,
// including manual scheduled runs. A stopped process leaves only an expiring lease.
const waiting = () => Object.assign(new Error('PubMed search is waiting for its next retry.'), { code: 'PUBMED_WAITING' })
export function guardedPubmedSearch(admin) {
  return async (work) => {
    const { data: token, error } = await Promise.resolve(admin.rpc('pubmed_search_claim')).catch(() => ({ error: true }))
    if (error) throw waiting() // fail closed: no upstream traffic when admission is unknown
    if (!token) throw waiting()
    let outcome = 'cancelled'
    let retryAfter = 0
    let result, failure
    try {
      result = await work()
      // A partial result must never retire today's work or close the circuit.
      if (result.failed?.length) throw Object.assign(new Error('PubMed discovery was incomplete.'), { code: 'PUBMED_UNAVAILABLE' })
      outcome = result.counts?.length ? 'ok' : 'cancelled'
    } catch (err) {
      if (err?.code === 'PUBMED_UNAVAILABLE') {
        outcome = 'unavailable'
        retryAfter = Math.min(86400, Math.max(0, Math.ceil(Number(err.retryAfterSeconds) || 0)))
      }
      failure = err
    }
    const { data, error: finishError } = await Promise.resolve(admin.rpc('pubmed_search_finish', { p_token: token, p_outcome: outcome, p_retry_after_seconds: retryAfter })).catch(() => ({ error: true }))
    if (finishError || data !== true) throw waiting() // stale owners cannot publish success
    if (failure) throw failure
    return result
  }
}
