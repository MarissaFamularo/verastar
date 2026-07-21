// lib/drain.js — pure computation for the vault drain: which records still need
// to reach the flat-file folder.
//
// There is no outbox queue. Every record a vault writer handles carries a
// `vaultWrittenAt` stamp, set when its note actually lands on disk. A record with
// no stamp (saved on the phone, or saved while the folder was disconnected) or a
// stamp older than its own save time needs a (re)write. Stamps are always >= the
// record's own timestamp — even against a fast phone clock — so a second drain
// finds nothing: idempotent, and a crashed drain just resumes where it stopped.
//
// Timestamps are ISO-8601 UTC strings throughout (`new Date().toISOString()`),
// so lexicographic comparison IS chronological comparison — no Date.parse, no NaN.

// The record's own "last saved" moment: papers stamp savedAt, weekend reads createdAt.
export function recordBasis(record) {
  return record?.savedAt || record?.createdAt || null
}

// Does this record's note still need to be written (or re-written) to the vault?
export function needsVaultWrite(record) {
  if (!record) return false
  if (!record.vaultWrittenAt) return true
  const basis = recordBasis(record)
  return !!basis && record.vaultWrittenAt < basis
}

// Stamp a record as written. The stamp is max(now, record's own basis) so a
// record saved under a fast clock can never look stale again a moment later.
export function stampVaultWritten(record, nowIso) {
  const basis = recordBasis(record)
  return { ...record, vaultWrittenAt: basis && basis > nowIso ? basis : nowIso }
}

// The store key a weekend-read record lives under (same-day regens overwrite it).
export function weekendKey(record) {
  return `weekend:${(record?.createdAt || '').slice(0, 10)}`
}

// Given the whole store's contents, what must the drain write?
//   papers     — stale paper records (source notes)
//   weekends   — stale weekend reads (connections.md entries), oldest first so
//                prepending lands them newest-on-top
//   conceptIds — concepts touched by the stale papers (their notes list members)
// Daily-digest records (kind 'daily') are UI state, never vault notes — ignored.
export function computeDrain({ papers, digests } = {}) {
  const stalePapers = (papers || []).filter(needsVaultWrite)
  const weekends = (digests || [])
    .filter((d) => d?.type === 'weekend' && needsVaultWrite(d))
    .sort((a, b) => ((a.createdAt || '') < (b.createdAt || '') ? -1 : 1))
  const conceptIds = new Set(stalePapers.map((p) => p.conceptId).filter(Boolean))
  return { papers: stalePapers, weekends, conceptIds }
}
