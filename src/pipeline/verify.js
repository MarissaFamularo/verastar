// pipeline/verify.js — THE SACRED CORE.
//
// Deterministic. No LLM runs in this file. The model proposes (value, source_quote,
// location); this layer disposes by re-deriving truth from the fetched source text.
// A wrong `verified` badge is the one failure that invalidates the whole product, so
// the bias is absolute: NEVER false-verify. A correct value that gets flagged is
// annoying; a wrong value that gets a green badge is fatal.
//
// Spec: docs/VERIFICATION_SPEC.md. Eval: docs/EVAL.md.

export const TIERS = {
  REGISTRY: 'verified-registry',
  FULL_TEXT: 'verified-full-text',
  ABSTRACT: 'abstract-only',
  FLAGGED: 'flagged',
}

// --- 1. Normalization ---------------------------------------------------------

const DASH_VARIANTS = /[‐‑‒–—−－]/g // ‐ ‑ ‒ – — − －
// Interpunct / middle-dot decimals used by Lancet, EJVES, etc.: 0·84 -> 0.84.
// Only between two digits, so it never touches a real bullet list.
const INTERPUNCT_DECIMAL = /(\d)[·‧⋅∙•](\d)/g
// Thousands separators in grouped integers: 502,157 -> 502157, 1,234,567 -> 1234567.
// Scoped to STRICT grouping — 1–3 lead digits, then one-or-more comma-delimited groups of
// EXACTLY 3 digits — so a decimal comma ("0,84", "1,5") is never a match and can't be
// mis-read as an integer (that would risk a false-verify). A trailing period decimal is
// preserved: "1,234.56" -> "1234.56" because the group match ends before the dot. Applied
// identically to quote and source, so exact-substring location still lines up.
const THOUSANDS_GROUP = /\b\d{1,3}(?:,\d{3})+\b/g

// Normalize a string for matching: NFKC, unify dashes, middle-dot decimals -> period,
// strip thousands separators, collapse whitespace, lowercase. Applied identically to quote
// and source text so the two are compared on equal footing.
export function normalize(str) {
  if (str == null) return ''
  let s = String(str).normalize('NFKC')
  s = s.replace(DASH_VARIANTS, '-')
  s = s.replace(INTERPUNCT_DECIMAL, '$1.$2')
  s = s.replace(THOUSANDS_GROUP, (m) => m.replace(/,/g, ''))
  s = s.replace(/\s+/g, ' ').trim()
  return s.toLowerCase()
}

// --- 2. Numeric tokenization --------------------------------------------------

// Pull every numeric token out of a (normalized) span as boundary-delimited numbers.
//
// The regex is the crux of decision ① (no substring false-verify). It must:
//   - match whole decimals: 0.84, 11.2, 8.0
//   - match leading-dot decimals: .90  (the EVAL .90 -> verified case; the spec's
//     sketch regex omits this, so we widen it here — documented deviation)
//   - match bare integers: 84, 1984
//   - NEVER match a fragment of a longer number: not 0.02 inside 0.028, not 84 inside
//     1984, not 84 inside 84.5
//   - still match an integer that ends a sentence: the "." in "n=84." is punctuation,
//     not a decimal point, so 84 must match there.
//
// Boundaries: not preceded by a digit or dot; not followed by a digit; not followed by
// a dot-then-digit (which would mean we stopped mid-decimal).
//
// Sign: an optional leading `-` is captured, but only where the match START clears the
// `(?<![\d.])` lookbehind — i.e. the `-` is NOT preceded by a digit. That distinguishes a
// negative sign ("difference, -0.4") from a numeric RANGE dash ("95% CI 1.26-2.90"): in
// the range case the `-` follows a digit, the lookbehind fails there, and the engine
// instead starts at the digit after the dash, yielding a POSITIVE second bound. Effect
// differences in trials are routinely negative, so sign-blind matching false-flagged them.
const NUMBER_RE = /(?<![\d.])-?(?:\d+\.\d+|\.\d+|\d+)(?!\d)(?!\.\d)/g

export function extractNumbers(span) {
  return extractNumbersWithIndex(span).map((t) => t.value)
}

// Tokenize with positions so we can keep only numbers that fall *fully inside* a located
// quote's span in the source. This is what defeats the degenerate-quote false-verify:
// a quote of just "8" exact-matches inside "2008", but the source token "2008" is not
// contained in the 1-char span, so no number is credited and the claim is flagged.
export function extractNumbersWithIndex(text) {
  const out = []
  const re = new RegExp(NUMBER_RE.source, 'g')
  let m
  while ((m = re.exec(text)) !== null) {
    out.push({ value: parseFloat(m[0]), start: m.index, end: m.index + m[0].length })
  }
  return out
}

// Numbers whose token span is entirely within [start, end) of `text`.
function numbersInRange(text, start, end) {
  return extractNumbersWithIndex(text)
    .filter((t) => t.start >= start && t.end <= end)
    .map((t) => t.value)
}

// Representation-equality: 0.84 == .84 == 0.840, 8 == 8.0. Relative epsilon absorbs
// float representation ONLY — never rounding. 0.84 must NOT satisfy 0.847.
const EPS = 1e-9
export function numbersEqual(a, b) {
  if (a === b) return true
  return Math.abs(a - b) <= EPS * Math.max(1, Math.abs(a), Math.abs(b))
}

function someEqual(nums, target) {
  return nums.some((n) => numbersEqual(n, target))
}

// --- Locate the quote in the source ------------------------------------------

// Returns { found, index, length } into the chosen normalized corpus, or found:false.
function locate(normQuote, normCorpus) {
  if (normQuote.length === 0) return { found: false }

  // 2a. Exact substring first.
  const idx = normCorpus.indexOf(normQuote)
  if (idx !== -1) return { found: true, index: idx, length: normQuote.length }

  // 2b. Fuzzy: strip both to alphanumerics and test containment. Tolerates stray
  // punctuation and line-reflow. Require length > 6 to avoid trivial matches.
  const alnum = (s) => s.replace(/[^a-z0-9]/g, '')
  const q = alnum(normQuote)
  if (q.length > 6 && alnum(normCorpus).includes(q)) {
    // No reliable offset back into the original span; highlight falls back to a text
    // search in the viewer. Verdict correctness does not depend on the offset.
    return { found: true, index: -1, length: normQuote.length, fuzzy: true }
  }
  return { found: false }
}

// --- The gate -----------------------------------------------------------------

// verify(quantity, source, opts)
//   quantity : { value, ci_low?, ci_high?, p_value?, source_quote, location_hint? }
//   source   : string  OR  { text?: string, tables?: string }
//   opts     : { sourceTier?: 'full_text' | 'abstract_only',  // default 'full_text'
//                registryValue?: number | null }              // CT.gov posted outcome
//
// Returns a verdict: { tier, flagged, found, consistent, matched, quoteNums, badNums, reason }
export function verify(quantity, source, opts = {}) {
  const sourceTier = opts.sourceTier || 'full_text'
  const registryValue = opts.registryValue ?? null

  const src = typeof source === 'string' ? { text: source, tables: '' } : (source || {})
  const normProse = normalize(src.text || '')
  const normTables = normalize(src.tables || '')
  const normQuote = normalize(quantity.source_quote || '')

  // Choose corpus order by the location hint. A table-cell value should be matched
  // against flattened cell text, not prose — but fall back to the other corpus so a
  // misfiled hint never causes a false flag.
  const hint = (quantity.location_hint || '').toLowerCase()
  const prefersTable = /table|tbl/.test(hint)
  const corpora = prefersTable
    ? [['tables', normTables], ['prose', normProse]]
    : [['prose', normProse], ['tables', normTables]]

  let matched = null
  for (const [corpusId, corpusText] of corpora) {
    if (!corpusText) continue
    const loc = locate(normQuote, corpusText)
    if (loc.found) {
      matched = { corpus: corpusId, index: loc.index, length: loc.length, fuzzy: !!loc.fuzzy }
      break
    }
  }
  const found = matched !== null

  // 3. Numeric consistency. Extract numeric tokens from the MATCHED SOURCE SPAN (not the
  // isolated quote) so source-level boundaries are respected: a quote "8" located inside
  // "2008" credits no number. For an exact match we have offsets and filter corpus tokens
  // to the span; for a fuzzy match (len>6, no offsets) we fall back to the quote's tokens.
  let quoteNums = []
  if (matched && matched.index >= 0) {
    const corpusText = matched.corpus === 'tables' ? normTables : normProse
    quoteNums = numbersInRange(corpusText, matched.index, matched.index + matched.length)
  } else if (matched) {
    quoteNums = extractNumbers(normQuote)
  }
  const present = []
  if (quantity.value != null) present.push(['value', quantity.value])
  if (quantity.ci_low != null) present.push(['ci_low', quantity.ci_low])
  if (quantity.ci_high != null) present.push(['ci_high', quantity.ci_high])
  if (quantity.p_value != null) present.push(['p_value', quantity.p_value])

  const badNums = []
  for (const [, num] of present) {
    if (!someEqual(quoteNums, num)) badNums.push(num)
  }
  // If the quote wasn't located, consistency is moot — it's flagged regardless.
  const consistent = found && badNums.length === 0

  // 4. Assign tier.
  let tier
  let reason
  if (!found) {
    tier = TIERS.FLAGGED
    reason = 'Quote not found in source text.'
  } else if (!consistent) {
    tier = TIERS.FLAGGED
    reason = `Quote located, but ${badNums.join(', ')} is not present in it — the value does not match the source.`
  } else if (registryValue != null && quantity.value != null && numbersEqual(quantity.value, registryValue)) {
    tier = TIERS.REGISTRY
    reason = 'Value matches the ClinicalTrials.gov posted outcome.'
  } else if (sourceTier === 'abstract_only') {
    tier = TIERS.ABSTRACT
    reason = 'Verified against the abstract; full text not in the OA subset.'
  } else {
    tier = TIERS.FULL_TEXT
    reason = 'Verified against the full source text.'
  }

  return {
    tier,
    flagged: tier === TIERS.FLAGGED,
    found,
    consistent,
    matched,
    quoteNums,
    badNums,
    reason,
  }
}
