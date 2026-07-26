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

// Punctuation-insensitive form of a domain name, for matching only. The classifier proposes a
// LABEL; the same field can come back spelled differently from how the user typed it ("AI / ML"
// vs "AI & ML" vs "AI and ML"), which would otherwise mint a duplicate field beside the user's.
export function normalizeDomainName(raw) {
  return (raw || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w && w !== 'and')
    .join('')
}

// Resolve a classifier answer (an existing key OR a proposed label) against a domain list.
// Pure, so the reuse rule is testable: exact key, slug, or case-insensitive label first, then
// the punctuation-insensitive fallback. Returns the matched record, or undefined when it's new.
export function matchDomain(keyOrLabel, domains) {
  const raw = (keyOrLabel || '').trim()
  if (!raw) return undefined
  const list = domains || []
  const slug = slugifyDomain(raw)
  const exact = list.find(
    (d) => d.key === raw || d.key === slug || (d.label || '').toLowerCase() === raw.toLowerCase(),
  )
  if (exact) return exact
  const norm = normalizeDomainName(raw)
  return list.find((d) => normalizeDomainName(d.label) === norm || normalizeDomainName(d.key) === norm)
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

// Hydrate once if nobody has. listDomains() is sync and answers [] before hydration — harmless
// for a render, but a classifier prompt built from [] would be told the taxonomy is empty and
// would mint a broad new field beside the user's. Callers that FILE papers await this first.
export async function ensureDomainsLoaded() {
  if (_cache === null) await loadDomains()
  return _cache
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
  const hit = matchDomain(raw, _cache)
  if (hit) return hit.key
  const domain = { key: slugifyDomain(raw), label: raw, color: nextColor(_cache) }
  await store.put('domains', domain.key, domain)
  _cache = [..._cache, domain]
  return domain.key
}

// --- Settings editing (rename keeps the key, so filed papers follow the new label) ---
//
// A domain the user typed or renamed is marked `source: 'user'`. That mark is the taxonomy's
// steering wheel: the classifier is told to prefer these fields (pipeline/concepts.js), and the
// tidy pass is forbidden from merging them away (deposit.pickMerges). Claude never sets it.

async function markUserOwned(key, patch = {}) {
  const hit = (_cache || []).find((d) => d.key === key)
  if (!hit) return
  const updated = { ...hit, ...patch, source: 'user' }
  await store.put('domains', key, updated)
  _cache = _cache.map((d) => (d.key === key ? updated : d))
}

export async function addDomain(label) {
  const key = await ensureDomain(label)
  // Adding a field Claude already minted doesn't duplicate it — it adopts it.
  if (key) await markUserOwned(key)
  return key
}

export async function renameDomain(key, label) {
  const next = (label || '').trim()
  if (!next) return
  await markUserOwned(key, { label: next })
}

// Keys of the fields the user owns — never merged away, and preferred by the classifier.
export function userDomainKeys() {
  return new Set(listDomains().filter((d) => d.source === 'user').map((d) => d.key))
}

// Removing a domain orphans any concepts still filed under it (they render as
// "Unclassified" in the default blue) — callers should warn when the domain is in use.
export async function removeDomain(key) {
  await store.delete('domains', key)
  _cache = (_cache || []).filter((d) => d.key !== key)
}
