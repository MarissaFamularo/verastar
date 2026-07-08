// lib/domains.js — categories are DERIVED from the clinician's own steering profile: each
// north star and project IS a category, auto-assigned a color from a fixed palette. (This
// used to be a hardcoded copy of one user's KG domains — wrong for a general app; the
// person's own north stars + projects should organize their knowledge.)
//
// Colors live on the anchor nodes themselves (assigned in graph.syncAnchors, persisted), so
// papers/concepts just store the category's node id and resolve color/label from the anchor
// that owns them. These helpers are pure (node objects in, colors/labels out) — no store, no
// import of graph.js — so there's no cycle.

// A distinct, legible palette that reads on the deep-space map AND on light/dark cards.
// Assigned to categories in profile order (north stars first, then projects), cycling if a
// user has more categories than colors.
export const PALETTE = [
  '#e0605a', // red
  '#5b93d6', // blue
  '#a06cd5', // violet
  '#45ac6d', // green
  '#29bccd', // cyan
  '#e6912e', // orange
  '#d95f9c', // pink
  '#8bbf3f', // lime
  '#5c6bd6', // indigo
  '#d0a93a', // gold
]

export const DEFAULT_COLOR = '#6fa8ff' // uncategorized (no category assigned yet)

export function paletteColor(index) {
  const n = PALETTE.length
  return PALETTE[((index % n) + n) % n]
}

// Is this node a category (i.e. a steering anchor)?
export function isCategory(node) {
  return node?.kind === 'northStar' || node?.kind === 'project'
}

// The category list for chips/legends, in profile order. Reads the anchor nodes (which carry
// their assigned color). Returns [{ key, label, kind, color }] where key is the anchor id.
export function categoryList(nodes) {
  return (nodes || [])
    .filter(isCategory)
    .map((n) => ({ key: n.id, label: n.label, kind: n.kind, color: n.color || DEFAULT_COLOR }))
}

// id -> { label, color, kind } for the categories, so a concept/paper can resolve its parent.
export function categoryMap(nodes) {
  const m = new Map()
  for (const n of nodes || []) if (isCategory(n)) m.set(n.id, { label: n.label, color: n.color || DEFAULT_COLOR, kind: n.kind })
  return m
}

// The display color for any node: an anchor uses its own color; a concept inherits the color
// of its parent category. `catMap` comes from categoryMap(nodes).
export function colorOf(node, catMap) {
  if (!node) return DEFAULT_COLOR
  if (isCategory(node)) return node.color || DEFAULT_COLOR
  return catMap?.get(node.category)?.color || DEFAULT_COLOR
}

// The category label for a node (a concept's parent star, or the anchor's own name).
export function categoryLabelOf(node, catMap) {
  if (!node) return 'Uncategorized'
  if (isCategory(node)) return node.label
  return catMap?.get(node.category)?.label || 'Uncategorized'
}
