// pipeline/quoteLocate.js — ONE quote locator for every context, qualification, obligation
// and excerpt span the summary path uses.
//
// Matching runs on the production verifier's own normalization (verify.js normalize: NFKC,
// dash variants, interpunct decimals, thousands separators, collapsed whitespace, lower
// case), so a quote that differs from the saved source only in line wrapping, dash glyphs
// or a middle-dot decimal still locates (2026-10-16 final evaluation: 39 of 39 balloon
// spans and 50 of 53 NPT spans were "whitespace-only mismatches" under raw indexOf and
// were rejected). The locator ALSO returns positions in the original source, because an
// excerpt fallback must quote the source as printed and a context span must be anchored
// to the passage it came from.
//
// A located quote proves LOCATION only. It never proves that the label a model attached
// to the quote is correct; the checker judges that against the complete source.
//
// Repeated text: a quote printed more than once is disambiguated by surrounding context
// when the caller supplies an anchor (the normalized position of the result's own
// source_quote, or of another located field of the same record): the nearest occurrence
// is taken and the choice is reported. Without an anchor the quote stays 'ambiguous'. The
// numeric validators in verify.js keep their own refusal of repeated sentences; nothing
// here changes them.

import { normalize } from './verify.js'

const DASH_VARIANTS = /[‐‑‒–—−－]/
const INTERPUNCT = /[·‧⋅∙•]/
const isDigit = (c) => c >= '0' && c <= '9'
const isSpace = (c) => /\s/.test(c)

// Normalize `str` the way verify.normalize does, keeping for every output character the
// index of the original character it came from. `exact` is true when the mapped text is
// byte-identical to verify.normalize(str); the per-character construction differs from a
// whole-string NFKC only for exotic combining sequences, and the result then says so.
export function normalizeWithMap(str) {
  const src = str == null ? '' : String(str)
  // 1. NFKC per character, dashes and (later) interpuncts.
  let entries = []
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    const folded = ch.normalize('NFKC')
    for (const c of folded) entries.push({ c: DASH_VARIANTS.test(c) ? '-' : c, i })
  }
  // 2. Interpunct between two digits -> period.
  for (let k = 0; k < entries.length; k++) {
    if (INTERPUNCT.test(entries[k].c) && k > 0 && k + 1 < entries.length && isDigit(entries[k - 1].c) && isDigit(entries[k + 1].c)) entries[k] = { c: '.', i: entries[k].i }
  }
  // 3. Thousands separators: strict 1–3 digits then comma-delimited groups of exactly 3,
  //    not led by a lone 0 (a European decimal). Same regex family as verify.js.
  let joined = entries.map((e) => e.c).join('')
  const drop = new Set()
  for (const m of joined.matchAll(/\b\d{1,3}(?:,\d{3})+\b/g)) {
    if (/^0/.test(m[0])) continue
    for (let k = m.index; k < m.index + m[0].length; k++) if (joined[k] === ',') drop.add(k)
  }
  if (drop.size) entries = entries.filter((_, k) => !drop.has(k))
  // 4. Whitespace: collapse runs to one space, trim the ends.
  const collapsed = []
  let pendingSpace = false
  for (const e of entries) {
    if (isSpace(e.c)) {
      if (collapsed.length) pendingSpace = true
      continue
    }
    if (pendingSpace) {
      collapsed.push({ c: ' ', i: e.i })
      pendingSpace = false
    }
    collapsed.push(e)
  }
  // 5. Lower case per character (an expansion keeps the same origin).
  const out = []
  for (const e of collapsed) {
    const lower = e.c.toLowerCase()
    for (const c of lower) out.push({ c, i: e.i })
  }
  const text = out.map((e) => e.c).join('')
  const map = out.map((e) => e.i)
  return { text, map, exact: text === normalize(src) }
}

// Per-source memo: one normalization per source string, shared by every span located in
// it. Keyed by string identity, bounded so a long session cannot grow it without limit.
const MEMO = new Map()
const MEMO_LIMIT = 16
export function normalizedSource(text) {
  const key = text == null ? '' : String(text)
  let hit = MEMO.get(key)
  if (!hit) {
    hit = normalizeWithMap(key)
    if (MEMO.size >= MEMO_LIMIT) MEMO.delete(MEMO.keys().next().value)
    MEMO.set(key, hit)
  }
  return hit
}

function occurrencesOf(haystack, needle) {
  const out = []
  if (!needle) return out
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) break
    out.push(at)
    from = at + 1
    if (out.length > 200) break
  }
  return out
}

function spanFrom(norm, normStart, normEnd, extra = {}) {
  const start = norm.map[normStart]
  const end = norm.map[normEnd - 1] + 1
  return { status: 'located', start, end, normStart, normEnd, positionsExact: norm.exact, ...extra }
}

// Locate `quote` in `source`.
//   { status: 'located', start, end, normStart, normEnd, raw, whitespaceOnly, disambiguated, occurrences }
//   { status: 'ambiguous', occurrences: [normStart...] }
//   { status: 'missing' } | { status: 'empty' }
// `raw` is true when the quote is a verbatim substring of the source as saved; when it is
// false the quote located only under normalization (`whitespaceOnly` says the difference
// was whitespace alone). `near` is a normalized position used to disambiguate repeats.
export function locateQuote(source, quote, { near = null } = {}) {
  const src = source == null ? '' : String(source)
  const q = quote == null ? '' : String(quote).trim()
  if (!q || !src) return { status: 'empty' }
  const norm = normalizedSource(src)
  const nq = normalize(q)
  if (!nq) return { status: 'empty' }
  const occurrences = occurrencesOf(norm.text, nq)
  if (!occurrences.length) return { status: 'missing' }
  const rawIndex = src.indexOf(q)
  const raw = rawIndex >= 0
  const whitespaceOnly = !raw && src.replace(/\s+/g, ' ').includes(q.replace(/\s+/g, ' '))
  if (occurrences.length === 1) return spanFrom(norm, occurrences[0], occurrences[0] + nq.length, { raw, whitespaceOnly, disambiguated: false, occurrences })
  if (!(Number.isFinite(near) && near >= 0)) return { status: 'ambiguous', occurrences, raw, whitespaceOnly }
  let best = occurrences[0]
  for (const at of occurrences) if (Math.abs(at - near) < Math.abs(best - near)) best = at
  return spanFrom(norm, best, best + nq.length, { raw, whitespaceOnly, disambiguated: true, occurrences })
}

// Locate a contract span ({ text, quote, corpus }) in a source document { text, tables }.
export function locateSpan(sourceDoc, span, { near = null } = {}) {
  if (!span || typeof span !== 'object') return { status: 'malformed' }
  const corpus = span.corpus === 'tables' ? 'tables' : span.corpus === 'text' ? 'text' : null
  if (!corpus || typeof span.quote !== 'string' || typeof span.text !== 'string') return { status: 'malformed' }
  const located = locateQuote(sourceDoc?.[corpus] || '', span.quote, { near })
  return { ...located, corpus, text: span.text, quote: span.quote }
}

// The span's own label text, checked against ITS quote under the same normalization: a
// label the quote does not print is reported (never silently accepted, never a reason to
// drop the record). Location only; meaning is the checker's.
export function labelInQuote(span) {
  if (!span || typeof span.text !== 'string' || typeof span.quote !== 'string') return false
  return normalize(span.quote).includes(normalize(span.text))
}

// Audit counts for a list of locate results, in the shape the final-evaluation reports used.
export function locateAudit(results) {
  const out = { spans: 0, located: 0, raw: 0, whitespaceOnly: 0, normalizedOnly: 0, ambiguous: 0, missing: 0 }
  for (const r of results || []) {
    out.spans += 1
    if (r?.status === 'located') {
      out.located += 1
      if (r.raw) out.raw += 1
      else if (r.whitespaceOnly) out.whitespaceOnly += 1
      else out.normalizedOnly += 1
    } else if (r?.status === 'ambiguous') out.ambiguous += 1
    else out.missing += 1
  }
  return out
}

// Sentence boundaries around [start, end) in the ORIGINAL source, for excerpts: widen to
// the enclosing sentence so a verbatim excerpt never starts or ends mid-clause.
export function sentenceBounds(source, start, end) {
  const src = String(source || '')
  let s = start
  while (s > 0 && !/[.!?]\s$/.test(src.slice(Math.max(0, s - 2), s)) && src[s - 1] !== '\n') s -= 1
  let e = end
  while (e < src.length && !/[.!?]/.test(src[e - 1] || '') && src[e] !== '\n') e += 1
  return { start: s, end: e }
}
