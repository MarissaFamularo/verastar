// lib/domains.js — the user's DOMAIN taxonomy: the broad research fields the knowledge
// graph colors nodes by. Concepts are classified into ONE domain (drives the star's color);
// "Projects" is a separate node KIND (yellow), not a paper domain. North stars are NOT
// graph nodes — they steer the digest/rubric, not the map.
//
// Domains are PER-USER DATA, not a constant: the store holds { key, label, color } records.
// The set grows automatically — when a paper doesn't fit an existing domain, the classifier
// proposes a new field-level name and ensureDomain() mints it with the next palette color.
// Users edit the set (rename/add/remove) in Settings.
//
// Lookups (domainColor/domainLabel/listDomains) are SYNC against an in-memory cache so render
// paths and the pure markdown formatter stay simple; App hydrates the cache via loadDomains()
// before any view mounts. Legacy keys fall back to the original six labels/colors so existing
// libraries (and their disk exports) stay correct even unhydrated.

import { store } from './store.js'

// Distinct-on-dark hues; the first six match the original palette. New domains take the
// first color not already in use, then cycle.
export const PALETTE = [
  '#e0605a', '#5b93d6', '#a06cd5', '#45ac6d', '#29bccd', '#e6912e',
  '#d6789c', '#8fbde6', '#b8c26a', '#7fbf9a', '#c98f5b', '#9a86e8',
]

// The original hardcoded set — now only a migration seed for libraries that already
// reference these keys, and a label/color fallback for unhydrated lookups.
export const LEGACY_DOMAINS = [
  { key: 'vascular', label: 'Vascular Surgery & Limb Preservation', color: '#e0605a' },
  { key: 'datascience', label: 'Health Data Science & Biostatistics', color: '#5b93d6' },
  { key: 'education', label: 'Surgical Education', color: '#a06cd5' },
  { key: 'methodology', label: 'Research Methodology', color: '#45ac6d' },
  { key: 'ai', label: 'AI & Technology in Medicine', color: '#29bccd' },
  { key: 'leadership', label: 'Program Building & Leadership', color: '#e6912e' },
]
const LEGACY_BY_KEY = new Map(LEGACY_DOMAINS.map((d) => [d.key, d]))

export const PROJECT_COLOR = '#eec13a' // "Projects" yellow — project nodes on the map
export const DEFAULT_PAPER_COLOR = '#6fa8ff' // a concept with no (or a removed) domain

let _cache = null // Array<{key,label,color}> once hydrated

export function slugifyDomain(label) {
  return (label || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'domain'
}

export function nextColor(existing) {
  const used = new Set(existing.map((d) => d.color))
  return PALETTE.find((c) => !used.has(c)) || PALETTE[existing.length % PALETTE.length]
}

// Hydrate the cache from the store. One-time migration: a library whose papers/concepts
// already reference the legacy keys (built before domains were per-user) gets the legacy
// set seeded so nothing loses its name or color. Fresh users start EMPTY — domains appear
// as the classifier files papers.
export async function loadDomains() {
  let rows = (await store.all('domains')) || []
  if (rows.length === 0) {
    const [papers, nodes] = await Promise.all([store.all('papers'), store.all('graphNodes')])
    const referenced = new Set(
      [...(papers || []), ...(nodes || [])].map((r) => r?.domain).filter(Boolean),
    )
    const seed = LEGACY_DOMAINS.filter((d) => referenced.has(d.key))
    for (const d of seed) await store.put('domains', d.key, d)
    rows = seed
  }
  _cache = rows
  return rows
}

export function listDomains() {
  return _cache || []
}

function find(key) {
  return (_cache || []).find((d) => d.key === key) || LEGACY_BY_KEY.get(key)
}

export function domainColor(key) {
  return find(key)?.color || DEFAULT_PAPER_COLOR
}

export function domainLabel(key) {
  return find(key)?.label || 'Unclassified'
}

// Resolve a classifier answer (an existing key OR a proposed new label) to a real key,
// minting the domain — with the next palette color — when it's new.
export async function ensureDomain(keyOrLabel) {
  const raw = (keyOrLabel || '').trim()
  if (!raw) return ''
  if (_cache === null) await loadDomains()
  const slug = slugifyDomain(raw)
  const hit = _cache.find(
    (d) => d.key === raw || d.key === slug || d.label.toLowerCase() === raw.toLowerCase(),
  )
  if (hit) return hit.key
  const domain = { key: slug, label: raw, color: nextColor(_cache) }
  await store.put('domains', domain.key, domain)
  _cache = [..._cache, domain]
  return domain.key
}

// --- Settings editing (rename keeps the key, so filed papers follow the new label) ---

export async function addDomain(label) {
  return ensureDomain(label)
}

export async function renameDomain(key, label) {
  const next = (label || '').trim()
  if (!next) return
  const hit = (_cache || []).find((d) => d.key === key)
  if (!hit) return
  const updated = { ...hit, label: next }
  await store.put('domains', key, updated)
  _cache = _cache.map((d) => (d.key === key ? updated : d))
}

// Removing a domain orphans any concepts still filed under it (they render as
// "Unclassified" in the default blue) — callers should warn when the domain is in use.
export async function removeDomain(key) {
  await store.delete('domains', key)
  _cache = (_cache || []).filter((d) => d.key !== key)
}
