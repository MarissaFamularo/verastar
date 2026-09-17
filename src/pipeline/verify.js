// pipeline/verify.js — THE SACRED CORE.
//
// Deterministic. No LLM runs in this file. The model proposes (value, source_quote,
// location); this layer locates source evidence and validates only explicit supported relationships.
// A wrong `verified` badge is the one failure that invalidates the whole product, so
// the bias is absolute: NEVER false-verify. A correct value that gets flagged is
// annoying; a wrong value that gets a green badge is fatal.
//
// Spec: docs/VERIFICATION_SPEC.md. Eval: docs/EVAL.md.

export const VERIFICATION_VERSION = '2026-09-11.relationships-v1'

export const TIERS = {
  REGISTRY: 'verified-registry',
  FULL_TEXT: 'verified-full-text',
  ABSTRACT: 'abstract-only',
  // The reader supplied the text (a PDF they uploaded). The app proved the quote is in
  // that text; it cannot prove the text is the paper, and the label says so.
  USER_TEXT: 'verified-user-text',
  FLAGGED: 'flagged',
  LOCATED: 'source-located',
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

// --- Statistical plausibility (warning-only) ---------------------------------

// These checks never manufacture or revoke a verification tier. Verification answers
// "does the source print this tuple?"; plausibility answers "does that printed tuple make
// statistical sense?" Keeping those claims separate lets a source typo be honestly shown
// as verified-as-printed while still receiving a conspicuous warning.
const RATIO_MEASURE = /\b(?:hazard|odds|risk|rate|prevalence)\s+ratio\b|\brelative\s+risk\b/i
const DIFFERENCE_MEASURE = /\b(?:mean|risk|rate|absolute|between-group|treatment)?\s*difference\b/i

function statedPValueOperator(quantity) {
  if (quantity?.p_value == null) return null
  const quote = normalize(quantity.source_quote || '')
  for (const token of extractNumbersWithIndex(quote)) {
    if (!numbersEqual(token.value, quantity.p_value)) continue
    const before = quote.slice(Math.max(0, token.start - 18), token.start)
    const match = before.match(/\bp(?:\s*[- ]?value)?\s*(?:of\s*)?(<=|>=|[=<>≤≥⩽⩾])?\s*$/i)
    if (!match) continue
    return ({ '<=': '≤', '>=': '≥', '⩽': '≤', '⩾': '≥' })[match[1]] || match[1] || null
  }
  return null
}

function pDirection(quantity) {
  const p = quantity?.p_value
  if (p == null) return null
  const op = statedPValueOperator(quantity)
  if ((op === '<' || op === '≤') && p <= 0.05) return 'significant'
  if ((op === '>' || op === '≥') && p >= 0.05) return 'not-significant'
  if ((op === '=' || op == null) && p < 0.05) return 'significant'
  if ((op === '=' || op == null) && p > 0.05) return 'not-significant'
  return null // exact boundary p=.05 is too rounding-sensitive to warn on
}

function warning(kind, detail, verifiedAsPrinted) {
  const status = verifiedAsPrinted ? 'verified-as-printed' : 'unverified'
  const prefix = verifiedAsPrinted ? 'Verified as printed, but' : 'Unverified extraction; additionally,'
  return { kind, status, message: `${prefix} ${detail}` }
}

export function plausibilityWarnings(quantity, { verifiedAsPrinted = false } = {}) {
  const out = []
  if (!quantity) return out

  const p = quantity.p_value
  if (p === 0) {
    out.push(warning(
      'zero-p-value',
      'the reported P value is zero; an exact P value cannot be zero and this is likely rounded or affected by numerical underflow.',
      verifiedAsPrinted,
    ))
  } else if (p != null && (!Number.isFinite(p) || p < 0 || p > 1)) {
    out.push(warning('impossible-p-value', `the reported P value (${p}) is outside 0–1.`, verifiedAsPrinted))
  }

  const low = quantity.ci_low
  const high = quantity.ci_high
  const value = quantity.value
  const rangeLow = quantity.range_low
  const rangeHigh = quantity.range_high
  if (Number.isFinite(rangeLow) && Number.isFinite(rangeHigh) && rangeLow > rangeHigh) {
    out.push(warning('reversed-estimate-range', `the reported estimate range runs from ${rangeLow} to ${rangeHigh}.`, verifiedAsPrinted))
  }
  const completeCi = Number.isFinite(low) && Number.isFinite(high)
  if (completeCi && low > high) {
    out.push(warning('reversed-confidence-interval', `the reported CI runs from ${low} to ${high}.`, verifiedAsPrinted))
  } else if (completeCi && Number.isFinite(value) && (value < low || value > high)) {
    out.push(warning(
      'estimate-outside-confidence-interval',
      `the point estimate (${value}) lies outside its reported CI (${low}–${high}).`,
      verifiedAsPrinted,
    ))
  }

  const percentUnit = /^\s*(?:%|percent|percentage)\s*$/i.test(quantity.unit || '')
  if (percentUnit && Number.isFinite(value) && value > 100) {
    out.push(warning('percentage-over-100', `the reported percentage is ${value}%.`, verifiedAsPrinted))
  }

  // A P/CI coherence warning is safe only when the quote explicitly says 95% CI and the
  // measure identifies its conventional null (1 for ratios, 0 for differences). We do
  // not sum percentages across rows: without explicit mutually-exclusive group semantics,
  // a total above 100 can be perfectly valid (multi-select responses, overlapping events).
  const evidence = `${quantity.name || ''} ${quantity.source_quote || ''}`
  const is95Ci = /\b95\s*%\s*(?:ci|confidence\s+interval)\b/i.test(evidence)
  const nullValue = RATIO_MEASURE.test(evidence) ? 1 : DIFFERENCE_MEASURE.test(evidence) ? 0 : null
  const direction = p >= 0 && p <= 1 ? pDirection(quantity) : null
  if (completeCi && low <= high && is95Ci && nullValue != null && direction) {
    const excludesNull = high < nullValue || low > nullValue
    const containsNull = low < nullValue && high > nullValue
    if (excludesNull && direction === 'not-significant') {
      out.push(warning(
        'ci-p-incoherence',
        `the 95% CI excludes the null (${nullValue}) while the reported P value is not significant.`,
        verifiedAsPrinted,
      ))
    } else if (containsNull && direction === 'significant') {
      out.push(warning(
        'ci-p-incoherence',
        `the 95% CI contains the null (${nullValue}) while the reported P value is significant.`,
        verifiedAsPrinted,
      ))
    }
  }
  return out
}

// --- Registry (CT.gov posted outcome) match -----------------------------------

// Numeric coincidence is not endpoint identity. Registry upgrades require explicit
// exact endpoint, unit, timepoint and group identity from the source adapters. Missing
// identity withholds the upgrade; abbreviations are not guessed. Existing adapters
// commonly lack these fields and therefore intentionally cannot earn this tier.
function registryMatch(quantity, rows) {
  if (!Array.isArray(rows) || quantity.value == null) return null
  return rows.find((row) => {
    if (!row || !quantity.name || !row.measure || normalize(row.measure) !== normalize(quantity.name)) return false
    for (const key of ['unit', 'timepoint', 'population']) {
      if (!quantity[key] || !row[key] || normalize(quantity[key]) !== normalize(row[key])) return false
    }
    for (const key of ['value', 'ci_low', 'ci_high', 'p_value']) {
      if (quantity[key] == null && row[key] == null) continue
      if (!Number.isFinite(quantity[key]) || !Number.isFinite(row[key]) || !numbersEqual(quantity[key], row[key])) return false
    }
    return true
  }) || null
}

// A small grammar, not a proximity heuristic or a general clinical truth checker.
// It covers complete, unambiguous standalone sentences with exact endpoint/unit
// identity. Tables, fuzzy/truncated quotes, repeated sentences, statistical tuples,
// and any additional context fields require review. Source evidence remains available.
function validateRelationship(quantity, matched, corpus, declaredType) {
  if (!matched || matched.fuzzy || matched.corpus !== 'prose') return false
  const span = corpus.slice(matched.index, matched.index + matched.length)
  if (corpus.indexOf(span, matched.index + 1) !== -1) return false
  const before = corpus.slice(0, matched.index).trimEnd()
  const after = corpus.slice(matched.index + matched.length).trimStart()
  if (before && !/[.!?]$/.test(before)) return false
  if (after && !/[.!?]$/.test(span) && !/^[.!?](?:\s|$)/.test(after)) return false
  if (quantity.ci_low != null || quantity.ci_high != null || quantity.p_value != null) return false
  // These fields are not currently produced by extraction. Never ignore future
  // semantic qualifiers if a stored or external quantity includes them.
  const supportedFields = new Set(['name', 'quantity_type', 'value', 'range_low', 'range_high', 'first_label', 'first_value', 'second_label', 'second_value', 'unit', 'ci_low', 'ci_high', 'p_value', 'source_quote', 'location_hint', 'timepoint', 'population', 'direction', 'endpoint'])
  if (Object.keys(quantity).some((key) => !supportedFields.has(key))) return false
  const name = normalize(quantity.name)
  const unit = normalize(quantity.unit)
  if (!name || !unit || /[.!?;:=]/.test(name)) return false
  const population = normalize(quantity.population)
  const timepoint = normalize(quantity.timepoint)
  const scopeSuffix = `${population ? ` in ${population}` : ''}${timepoint ? ` at ${timepoint}` : ''}`
  if (scopeSuffix && !name.endsWith(scopeSuffix)) return false
  if (quantity.endpoint != null && normalize(quantity.endpoint) !== name) return false
  if (quantity.direction != null && declaredType !== 'change') return false
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const number = '(-?(?:\\d+\\.\\d+|\\.\\d+|\\d+))'
  const amount = number + '\\s*' + escape(unit)
  let pattern
  let values
  if (declaredType === 'comparison') {
    const first = normalize(quantity.first_label)
    const second = normalize(quantity.second_label)
    if (!first || !second || first === second || /[.!?;:=]/.test(first + second)) return false
    pattern = `${escape(name)} was ${amount} in ${escape(first)} and ${amount} in ${escape(second)}`
    values = [quantity.first_value, quantity.second_value]
  } else if (declaredType === 'single') {
    pattern = `${escape(name)} was ${amount}`
    values = [quantity.value]
  } else if (declaredType === 'range') {
    pattern = `${escape(name)} ranged from ${amount} to ${amount}`
    values = [quantity.range_low, quantity.range_high]
    if (values[0] > values[1]) return false
  } else if (declaredType === 'change') {
    if (quantity.first_label || quantity.second_label) return false
    const direction = normalize(quantity.direction)
    if (quantity.direction != null && !['increased', 'decreased', 'changed'].includes(direction)) return false
    pattern = `${escape(name)} ${direction ? escape(direction) : '(?:increased|decreased|changed)'} from ${amount} to ${amount}`
    values = [quantity.first_value, quantity.second_value]
  } else return false
  const match = span.match(new RegExp(`^${pattern}[.!?]?$`))
  return !!match && values.every((value, index) => Number.isFinite(value) && numbersEqual(value, Number(match[index + 1])))
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
  //
  // The stripped-corpus hit is mapped BACK to real offsets in the normalized corpus, so
  // the numeric check always runs against source tokens, never the model's own quote.
  // (Stripping deletes decimal points — "0.84" and "084" and "8.4"/"84" collapse — so a
  // quote-token fallback here false-verified truncated and re-punctuated values.)
  const q = normQuote.replace(/[^a-z0-9]/g, '')
  if (q.length > 6) {
    // map[i] = offset in normCorpus of the i-th alphanumeric character.
    const map = []
    let stripped = ''
    for (let i = 0; i < normCorpus.length; i++) {
      if (/[a-z0-9]/.test(normCorpus[i])) {
        map.push(i)
        stripped += normCorpus[i]
      }
    }
    const hit = stripped.indexOf(q)
    if (hit !== -1) {
      // Span ends right after the last matched character — NOT widened to token
      // boundaries. A source number only partially covered by the quote (e.g. "0.842"
      // under a quote of "0.84") then correctly fails numbersInRange containment.
      const start = map[hit]
      const end = map[hit + q.length - 1] + 1
      return { found: true, index: start, length: end - start, fuzzy: true }
    }
  }
  return { found: false }
}

// --- The gate -----------------------------------------------------------------

// verify(quantity, source, opts)
//   quantity : { quantity_type?, value?, range_low?, range_high?, first_label?,
//                first_value?, second_label?, second_value?, ci_low?, ci_high?, p_value?,
//                source_quote, location_hint? }
//   source   : string  OR  { text?: string, tables?: string }
//   opts     : { sourceTier?: 'full_text' | 'abstract_only' | 'user_text',  // default 'full_text'
//                registry?: Array<{ measure, value, ci_low, ci_high }> } // CT.gov posted rows
//
// Returns a verdict including `warnings`, a separate statistical-plausibility channel.
export function verify(quantity, source, opts = {}) {
  const sourceTier = opts.sourceTier || 'full_text'

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

  // 3. Numeric consistency. Extract numeric tokens from the MATCHED SOURCE SPAN (never
  // the isolated quote) so source-level boundaries are respected: a quote "8" located
  // inside "2008" credits no number. Both exact and fuzzy matches carry corpus offsets,
  // so the same containment rule applies to both paths.
  let quoteNums = []
  if (matched) {
    const corpusText = matched.corpus === 'tables' ? normTables : normProse
    quoteNums = numbersInRange(corpusText, matched.index, matched.index + matched.length)
  }
  const present = []
  if (quantity.value != null) present.push(['value', quantity.value])
  if (quantity.range_low != null) present.push(['range_low', quantity.range_low])
  if (quantity.range_high != null) present.push(['range_high', quantity.range_high])
  if (quantity.first_value != null) present.push(['first_value', quantity.first_value])
  if (quantity.second_value != null) present.push(['second_value', quantity.second_value])
  if (quantity.ci_low != null) present.push(['ci_low', quantity.ci_low])
  if (quantity.ci_high != null) present.push(['ci_high', quantity.ci_high])
  if (quantity.p_value != null) present.push(['p_value', quantity.p_value])

  const badNums = []
  for (const [, num] of present) {
    if (!someEqual(quoteNums, num)) badNums.push(num)
  }
  // Exactly one semantic estimate shape is valid. Legacy records have no quantity_type;
  // infer only scalar or range so already-saved evidence remains readable. New two-value
  // records must declare whether they are a change or comparison and carry both labels.
  const hasScalar = quantity.value != null
  const hasRangeLow = quantity.range_low != null
  const hasRangeHigh = quantity.range_high != null
  const hasFirst = quantity.first_value != null
  const hasSecond = quantity.second_value != null
  const firstLabel = String(quantity.first_label || '').trim()
  const secondLabel = String(quantity.second_label || '').trim()
  const declaredType = quantity.quantity_type || (hasScalar ? 'single' : (hasRangeLow && hasRangeHigh ? 'range' : ''))
  const labelsInQuote = firstLabel && secondLabel &&
    normQuote.includes(normalize(firstLabel)) && normQuote.includes(normalize(secondLabel))
  const noLabels = !firstLabel && !secondLabel
  const scalarShape = hasScalar && !hasRangeLow && !hasRangeHigh && !hasFirst && !hasSecond && !firstLabel && !secondLabel
  const rangeShape = !hasScalar && hasRangeLow && hasRangeHigh && !hasFirst && !hasSecond && !firstLabel && !secondLabel
  const pairedBase = !hasScalar && !hasRangeLow && !hasRangeHigh && hasFirst && hasSecond
  const validEstimateShape = declaredType === 'single'
    ? scalarShape
    : declaredType === 'range'
      ? rangeShape
      : declaredType === 'change'
        ? pairedBase && (noLabels || !!labelsInQuote)
        : declaredType === 'comparison' && pairedBase && !!labelsInQuote
  const shapeError = validEstimateShape
    ? ''
    : 'Quantity must contain exactly one declared shape: a single value, a true range, a labeled change, or a labeled group comparison.'
  // If the quote wasn't located, consistency is moot — it's flagged regardless.
  const consistent = found && validEstimateShape && badNums.length === 0

  // 4. Assign tier. Registry is the strongest tier and outranks abstract-only, so it is
  // checked first — a registry-matched value posted by CT.gov is proven regardless of which
  // corpus located the quote.
  const matchedCorpus = matched?.corpus === 'tables' ? normTables : normProse
  const relationshipValidated = consistent && validateRelationship(quantity, matched, matchedCorpus, declaredType)
  const regRow = relationshipValidated ? registryMatch(quantity, opts.registry) : null
  let tier
  let reason
  if (!found) {
    tier = TIERS.FLAGGED
    reason = 'Quote not found in source text.'
  } else if (!validEstimateShape) {
    tier = TIERS.FLAGGED
    reason = shapeError
  } else if (!consistent) {
    tier = TIERS.FLAGGED
    reason = `Quote located, but ${badNums.join(', ')} is not present in it — the value does not match the source.`
  } else if (!relationshipValidated) {
    tier = TIERS.LOCATED
    reason = 'Quote and numeric tokens located; endpoint, units, groups, timepoints or statistical relationships remain unresolved. Check the source before using this claim.'
  } else if (regRow) {
    tier = TIERS.REGISTRY
    const label = regRow.measure ? ` ("${regRow.measure}")` : ''
    const hasCi = regRow.ci_low != null || regRow.ci_high != null
    reason = hasCi
      ? `Value and 95% CI match the ClinicalTrials.gov posted outcome${label}.`
      : `Value matches the ClinicalTrials.gov posted outcome${label}.`
  } else if (sourceTier === 'abstract_only') {
    tier = TIERS.ABSTRACT
    reason = 'Explicit quantity relationship validated in an abstract sentence; broader clinical interpretation is unchecked.'
  } else if (sourceTier === 'user_text') {
    tier = TIERS.USER_TEXT
    reason = 'Explicit quantity relationship validated in text you supplied. The app verified the quote against that file, not against the publisher copy.'
  } else {
    tier = TIERS.FULL_TEXT
    reason = 'Explicit quantity relationship validated in a source sentence; broader clinical interpretation is unchecked.'
  }

  const warnings = plausibilityWarnings(quantity, { verifiedAsPrinted: relationshipValidated })

  return {
    tier,
    verificationVersion: VERIFICATION_VERSION,
    flagged: !relationshipValidated,
    sourceLocated: found,
    numericCoverage: consistent,
    relationshipValidated,
    relationshipStatus: relationshipValidated ? 'validated' : 'unresolved',
    sourceTier,
    found,
    consistent,
    matched,
    quoteNums,
    badNums,
    shapeError,
    reason,
    warnings,
  }
}
