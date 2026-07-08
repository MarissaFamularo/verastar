// lib/domains.js — the clinician's OWN domain taxonomy, lifted from her existing knowledge
// graph so Verastar speaks her scheme instead of inventing a parallel one. These 6 are the
// article domains Claude classifies saved papers into (one each, drives the star's color);
// "Projects" in her legend is a node KIND in Verastar (its own yellow), not a paper domain.
// Colors echo her graph's palette so the map reads as hers.

export const DOMAINS = [
  { key: 'vascular', label: 'Vascular Surgery & Limb Preservation', color: '#e0605a' },
  { key: 'datascience', label: 'Health Data Science & Biostatistics', color: '#5b93d6' },
  { key: 'education', label: 'Surgical Education', color: '#a06cd5' },
  { key: 'methodology', label: 'Research Methodology', color: '#45ac6d' },
  { key: 'ai', label: 'AI & Technology in Medicine', color: '#29bccd' },
  { key: 'leadership', label: 'Program Building & Leadership', color: '#e6912e' },
]

export const PROJECT_COLOR = '#eec13a' // her "Projects" domain yellow — Verastar project nodes
export const NORTHSTAR_COLOR = '#ffd36b' // Verastar-only steering anchors: radiant gold
export const DEFAULT_PAPER_COLOR = '#6fa8ff' // un-classified paper (no domain yet)

const BY_KEY = new Map(DOMAINS.map((d) => [d.key, d]))

export function domainColor(key) {
  return BY_KEY.get(key)?.color || DEFAULT_PAPER_COLOR
}

export function domainLabel(key) {
  return BY_KEY.get(key)?.label || 'Unclassified'
}

export const DOMAIN_KEYS = DOMAINS.map((d) => d.key)
