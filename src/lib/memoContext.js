// lib/memoContext.js — the small, pure mutations behind Memos' context actions.
// Keeping these separate from the UI makes the pilot change easy to test and keeps every
// write additive: the memo remains intact while its text feeds the selected context record.

const clean = (value) => String(value || '').trim()

export function memoLabel(memo) {
  return clean(memo?.text).split(/\r?\n/).find(Boolean)?.trim() || ''
}

export function addMemoLabel(profile, field, label) {
  if (field !== 'projects' && field !== 'northStars') return { profile: profile || {}, added: false }
  const value = clean(label)
  const current = Array.isArray(profile?.[field]) ? profile[field] : []
  if (!value || current.some((item) => clean(item).toLocaleLowerCase() === value.toLocaleLowerCase())) {
    return { profile: profile || {}, added: false }
  }
  return { profile: { ...(profile || {}), [field]: [...current, value] }, added: true }
}

export function attachMemoToPaper(paper, memo) {
  const text = clean(memo?.text)
  if (!paper || !text) return { paper, added: false }

  const memoIds = Array.isArray(paper.memoIds) ? paper.memoIds : []
  if (memo?.id && memoIds.includes(memo.id)) return { paper, added: false }

  const date = clean(memo?.createdAt).slice(0, 10)
  const heading = date ? `Memo — ${date}` : 'Memo'
  const block = `${heading}\n${text}`
  const notes = clean(paper.notes)

  return {
    paper: {
      ...paper,
      notes: notes ? `${notes}\n\n${block}` : block,
      memoIds: memo?.id ? [...memoIds, memo.id] : memoIds,
    },
    added: true,
  }
}
