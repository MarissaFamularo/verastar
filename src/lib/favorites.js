// lib/favorites.js — one flag, many doorways. A favorite is a property of the SAVED
// paper record (`favorite: true` on the `papers` row), so every surface that shows a
// paper — Library, digest, star map, Connections — reads and flips the same bit. A
// paper must be in the Library to be favorited; the digest's heart saves first, then
// flips, so "favorite" can never point at a record that doesn't exist.

import { store } from './store.js'
import { logEvent } from './events.js'

export async function setPaperFavorite(id, favorite) {
  const p = await store.get('papers', id)
  if (!p) return null
  const next = { ...p, favorite: !!favorite }
  await store.put('papers', id, next)
  // A heart is a deliberate quality signal, like a share — worth a telemetry row.
  logEvent('paper_favorited', { pmid: next.pmid || id, favorite: !!favorite })
  return next
}

export async function togglePaperFavorite(id) {
  const p = await store.get('papers', id)
  if (!p) return null
  return setPaperFavorite(id, !p.favorite)
}
