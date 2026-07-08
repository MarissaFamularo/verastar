// lib/domains.js — the clinician's DOMAIN taxonomy: the broad research fields her knowledge graph
// colors nodes by (lifted from her real KG so Verastar reads as hers). Concepts are classified into
// ONE domain (drives the star's color); "Projects" is a separate node KIND (yellow), not a paper
// domain. North stars are NOT graph nodes — they steer the digest/rubric, not the map.
//
// These 6 are her defaults; a later build can let a user edit the set. Colors echo her palette.

export const DOMAINS = [
  { key: 'vascular', label: 'Vascular Surgery & Limb Preservation', color: '#e0605a' },
  { key: 'datascience', label: 'Health Data Science & Biostatistics', color: '#5b93d6' },
  { key: 'education', label: 'Surgical Education', color: '#a06cd5' },
  { key: 'methodology', label: 'Research Methodology', color: '#45ac6d' },
  { key: 'ai', label: 'AI & Technology in Medicine', color: '#29bccd' },
  { key: 'leadership', label: 'Program Building & Leadership', color: '#e6912e' },
]

export const PROJECT_COLOR = '#eec13a' // her "Projects" yellow — Verastar project nodes on the map
export const DEFAULT_PAPER_COLOR = '#6fa8ff' // a concept with no domain yet

const BY_KEY = new Map(DOMAINS.map((d) => [d.key, d]))

export function domainColor(key) {
  return BY_KEY.get(key)?.color || DEFAULT_PAPER_COLOR
}

export function domainLabel(key) {
  return BY_KEY.get(key)?.label || 'Unclassified'
}

export const DOMAIN_KEYS = DOMAINS.map((d) => d.key)
