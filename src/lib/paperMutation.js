// A read snapshot survives object spread but never JSON serialization. This lets
// all paper writers use one field-level compare-and-set contract.
export const PAPER_BASE = Symbol('paper read baseline')
const plain = (value) => JSON.parse(JSON.stringify(value))
export function trackPaper(value, userId, key) {
  if (!value || typeof value !== 'object') return value
  Object.defineProperty(value, PAPER_BASE, {
    value: { userId, key: String(key), value: plain(value) }, enumerable: true, configurable: true,
  })
  return value
}
export function paperMutation(value, userId, key) {
  const base = value?.[PAPER_BASE]
  if (!base) return { p_action: 'create', p_value: plain(value) }
  if (base.userId !== userId || base.key !== String(key)) throw new Error('Library account changed. Reload before saving.')
  const next = plain(value)
  const fields = [...new Set([...Object.keys(base.value), ...Object.keys(next)])]
    .filter((field) => JSON.stringify(base.value[field]) !== JSON.stringify(next[field]))
  return {
    p_action: 'patch', p_value: Object.fromEntries(fields.filter((f) => f in next).map((f) => [f, next[f]])),
    p_expected: { ...Object.fromEntries(fields.filter((f) => f in base.value).map((f) => [f, base.value[f]])), ...(base.value._libraryEpoch ? { _libraryEpoch: base.value._libraryEpoch } : {}) },
    p_fields: fields,
  }
}
export async function mutateCloudPaper(client, userId, key, mutation) {
  const { data, error } = await client.rpc('mutate_library_paper', { p_user_id: userId, p_key: String(key), ...mutation })
  if (error) throw new Error(`Library save failed: ${error.message || error}`)
  if (data?.status === 'conflict') throw new Error('This paper changed in another tab. Reload and reapply your edit; your edit was not saved.')
  if (data?.status === 'deleted') throw new Error('This paper was removed from the Library. The pending change was not saved.')
  return data
}
