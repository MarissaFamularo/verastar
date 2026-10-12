// lib/format.js — the ONE quantity formatter for the fact channel.
//
// Every surface that renders a verified quantity (digest rows, triage input, the on-disk
// vault notes) formats it here, so they can never disagree. Two-channel rule
// (docs/VERIFICATION_SPEC.md): a verified number is an app-owned fact and must never be
// misstated — including its p-value operator. The verifier accepts a magnitude-only
// p-value match (claim 0.001 verifies against "P<0·001"), so the operator is NOT part of
// the verified tuple; it is re-derived here from the verified quote, deterministically,
// never model-asserted, and never invented when the quote doesn't state one.

import { normalize, extractNumbersWithIndex, numbersEqual, unlabelledIntervalWrap } from '../pipeline/verify.js'

// Post-NFKC operator characters the quote may state before a p-value. ⩽/⩾ (slanted
// variants) are distinct code points NFKC does not fold, so they map here.
const P_OPERATORS = { '=': '=', '<': '<', '>': '>', '≤': '≤', '≥': '≥', '⩽': '≤', '⩾': '≥' }
// Older papers print the operator in words ("P less than 0.001"); same meaning, same symbol.
const P_WORD_OPERATORS = {
  'less than or equal to': '≤',
  'less than': '<',
  'greater than or equal to': '≥',
  'greater than': '>',
  'more than': '>',
}
const P_LOOKBEHIND = 40
const P_LEAD_RE = /\bp(?:\s*[- ]?value)?\s*(?:(?:was|is|of)\s*)?(<=|>=|[=<>≤≥⩽⩾]|less\s+than\s+or\s+equal\s+to|less\s+than|greater\s+than\s+or\s+equal\s+to|greater\s+than|more\s+than)?\s*$/i

// Numeric JSON deliberately loses spelling (1.00 -> 1, .02 -> 0.02). Display values
// come back from the verbatim receipt instead. This tokenizer retains the exact source
// token while parsing a numeric twin solely for matching.
const PRINTED_NUMBER_RE = /(?<![\d.·‧⋅∙•])[+\-‐‑‒–—−－]?(?:\d{1,3}(?:,\d{3})+(?:[.·‧⋅∙•]\d+)?|\d+[.·‧⋅∙•]\d+|[.·‧⋅∙•]\d+|\d+)(?!\d)(?![.·‧⋅∙•]\d)/g

function printedTokens(quote) {
  const out = []
  const text = String(quote || '').normalize('NFKC')
  const re = new RegExp(PRINTED_NUMBER_RE.source, 'g')
  let match
  while ((match = re.exec(text)) !== null) {
    const normalized = normalize(match[0])
    const value = Number(normalized)
    if (Number.isFinite(value)) out.push({ raw: match[0], value, start: match.index, end: re.lastIndex })
  }
  return { text, tokens: out }
}

function printedValue(quantity, field) {
  const target = quantity?.[field]
  if (target == null) return ''
  const { text, tokens } = printedTokens(quantity.source_quote)
  if (!tokens.length) return String(target)

  if (field === 'p_value') {
    const semantic = tokens.find((token) => {
      if (!numbersEqual(token.value, target)) return false
      const before = text.slice(Math.max(0, token.start - P_LOOKBEHIND), token.start)
      return P_LEAD_RE.test(before)
    })
    return (semantic || tokens.find((t) => numbersEqual(t.value, target)))?.raw || String(target)
  }

  if (field === 'ci_low' || field === 'ci_high') {
    const marker = text.search(/\b(?:ci|confidence\s+interval)\b/i)
    const ciTokens = marker < 0 ? tokens : tokens.filter((t) => t.start > marker)
    const lowIndex = ciTokens.findIndex((t) => numbersEqual(t.value, quantity.ci_low))
    if (field === 'ci_low') return ciTokens[lowIndex]?.raw || String(target)
    const high = ciTokens.slice(Math.max(0, lowIndex + 1)).find((t) => numbersEqual(t.value, target))
    return high?.raw || String(target)
  }

  const token = tokens.find((t) => numbersEqual(t.value, target))
  if (!token) return String(target)
  // A comparator printed directly before the value is part of the value (">0.999" is not
  // "0.999"). Symbols only, glued or space-separated; never inferred.
  // A P-labelled token is the P value's operator, rendered separately by pOperator.
  const lead = text.slice(Math.max(0, token.start - 3), token.start).match(/([<>≤≥⩽⩾])\s*$/)
  const isP = P_LEAD_RE.test(text.slice(Math.max(0, token.start - P_LOOKBEHIND), token.start))
  return lead && !isP ? `${P_OPERATORS[lead[1]] || lead[1]}${token.raw}` : token.raw
}

// Recover both printed endpoints and the source's separator for a reported estimate
// range. The endpoints are matched in order so a duplicated number elsewhere in the quote
// cannot make the display reverse or splice the range. If the source spelling cannot be
// recovered, fall back to the parsed endpoints joined by an en dash; verification still
// controls whether the quantity is allowed to render at all.
function printedRange(quantity) {
  const low = quantity?.range_low
  const high = quantity?.range_high
  if (low == null || high == null) return ''
  const { text, tokens } = printedTokens(quantity.source_quote)
  const lowIndex = tokens.findIndex((t) => numbersEqual(t.value, low))
  const highToken = lowIndex < 0
    ? null
    : tokens.slice(lowIndex + 1).find((t) => numbersEqual(t.value, high))
  const lowToken = tokens[lowIndex]
  if (!lowToken || !highToken) return `${low}–${high}`
  const between = text.slice(lowToken.end, highToken.start)
  const separator = /^\s*(?:[-‐-―−－]|to)\s*$/i.test(between) ? between : '–'
  return `${lowToken.raw}${separator}${highToken.raw}`
}

// Derive the p-value operator from the quantity's verified quote. Tokenize the normalized
// quote (representation may differ: "P = .02" vs claim 0.02, so tokens are matched with
// numbersEqual, never string search), take the FIRST token equal to p_value, and scan
// backwards from the first P-labelled matching token for an explicit operator. Returns '=', '<', '>',
// '≤', '≥', or null when the quote states none (or there is no quote / no p_value).
export function pOperator(quantity) {
  if (quantity == null || quantity.p_value == null) return null
  const quote = normalize(quantity.source_quote || '')
  if (!quote) return null
  const hit = pToken(quote, quantity.p_value)
  return hit ? hit.op : null
}

// The first P-labelled token in the normalized quote equal to p, with its operator.
// Returns { start, end, op } or null.
function pToken(quote, p) {
  for (const token of extractNumbersWithIndex(quote)) {
    if (!numbersEqual(token.value, p)) continue
    const before = quote.slice(Math.max(0, token.start - P_LOOKBEHIND), token.start)
    const match = before.match(P_LEAD_RE)
    if (!match) continue
    const word = (match[1] || '').toLowerCase().replace(/\s+/g, ' ')
    const op = word === '<=' ? '≤' : word === '>=' ? '≥' : P_WORD_OPERATORS[word] || P_OPERATORS[match[1]] || null
    return { start: token.start - before.length + match.index, end: token.end, op }
  }
  return null
}

// A confidence interval describes uncertainty around ONE estimate, so it is rendered only
// beside a single estimate (`value`). A comparison, change or range has no slot for the
// estimate its CI would belong to: when such a row carries ci_low/ci_high, the interval
// belongs to something else in the quote — typically a hazard ratio printed after the two
// rates ("6.7% vs. 5.4%; hazard ratio, 1.26; 95% CI, 0.81 to 1.96"). Rendering it would
// state uncertainty around the percentages that the source never reported. This is a
// shape rule, not a statistical parser: it does not try to work out which estimate the
// interval belongs to, it only refuses to attach it to a pair or range. The row itself is
// left as extracted — verify.js still sees the CI fields and keeps such a row out of the
// verified tiers — and the receipt quote still shows the interval in context.
export function ciBelongsToEstimate(q) {
  if (q == null || q.ci_low == null || q.ci_high == null) return false
  if (q.value == null) return false
  if (q.first_value != null || q.second_value != null || q.range_low != null || q.range_high != null) return false
  return q.quantity_type == null || q.quantity_type === 'single'
}

// What the P value tests, when the quote says so next to it: sidedness printed before the
// P ("1-sided P = .71") and the hypothesis or comparison printed after it ("P = 0.44 for
// noninferiority", "P<0.001 for comparison with the performance goal"). Returned in WORDS
// ("one-sided", "for noninferiority") so the rendered string adds no digits. null when the
// quote states neither. Deterministic and quote-derived, like the operator.
export function pQualifier(quantity) {
  if (quantity == null || quantity.p_value == null) return null
  const quote = normalize(quantity.source_quote || '')
  const hit = quote && pToken(quote, quantity.p_value)
  if (!hit) return null
  const lead = quote.slice(Math.max(0, hit.start - 16), hit.start).match(/\b(one|two|1|2)[- ]sided\s*$/)
  const sided = lead ? (lead[1] === 'one' || lead[1] === '1' ? 'one-sided' : 'two-sided') : null
  const tail = quote.slice(hit.end, hit.end + 70).match(
    /^\s*\)?\s*[,;]?\s*for\s+(?:the\s+)?(non-?inferiority|superiority|equivalence|interaction|trend|heterogeneity|(?:the\s+)?comparison with (?:the\s+)?performance goal)\b/
  )
  const test = tail ? `for ${tail[1].replace(/^non-inferiority$/, 'noninferiority')}` : null
  return sided || test ? { sided, test } : null
}

// The interval's printed level and kind. A 95% confidence interval renders as "CI" (as
// before); any other level or a Bayesian credible interval says so, because "CI" alone reads
// as 95%. The level is rendered from the quote, never assumed.
//
// REV2 (gap 2): the level and kind are BOUND to this quantity's own interval. A quote can
// print several intervals ("HR 0.80 (95% CI, 0.70 to 0.90); difference 1.5 (90% CI, 1.0 to
// 2.0)"), and the first marker in the quote may belong to another result. The interval is
// located by its own printed bounds; the marker must sit directly before it (only words,
// commas, brackets, or "for <effect>" in between — never a ";" or ")" closing another
// result) or directly after it inside the same bracket. No bound marker on an
// unlabelled () or [] interval renders "interval"; "CI" is only the bound label.
const INTERVAL_MARKER = /(?:(\d{2}(?:\.\d+)?)\s*%\s*(?:\(\s*|\[\s*)?)?(bayesian\s+)?(confidence\s+(?:interval|limits?)|credible\s+interval|\bCrI\b|\bCI\b)/gi
const MARKER_GAP_MAX = 45

// A length-preserving cleanup of the quote (dashes and middle-dot decimals only), so token
// offsets index straight back into the text that is searched for markers and effect words.
const lightQuote = (quantity) =>
  String(quantity?.source_quote || '').normalize('NFKC').replace(/[‐‑‒–—−－]/g, '-').replace(/(\d)[·‧⋅∙•](\d)/g, '$1.$2')

// { start, end } of this quantity's interval (its ci_low token followed by its ci_high token).
function intervalSpan(quantity, text) {
  if (quantity?.ci_low == null || quantity?.ci_high == null) return null
  const tokens = extractNumbersWithIndex(text)
  for (let i = 0; i + 1 < tokens.length; i++) {
    const lo = tokens[i]
    const hi = tokens[i + 1]
    if (!numbersEqual(lo.value, quantity.ci_low)) continue
    const join = text.slice(lo.end, hi.start)
    const highOk = numbersEqual(hi.value, quantity.ci_high) ||
      (join === '' && hi.value < 0 && numbersEqual(-hi.value, quantity.ci_high)) // "60-505"
    // join: "-", "to", ",", "and", optionally after a percent sign ("-1.89% to 2.91%")
    if (highOk && /^\s*%?\s*(?:-|to|,|and)?\s*$/i.test(join)) return { start: lo.start, end: hi.end }
  }
  return null
}

function boundMarker(quantity) {
  const text = lightQuote(quantity)
  const span = intervalSpan(quantity, text)
  if (!span) return null
  const markers = [...text.matchAll(INTERVAL_MARKER)].map((m) => ({
    start: m.index, end: m.index + m[0].length, level: m[1] || null,
    credible: /credible|cri/i.test(m[3]) || Boolean(m[2]),
  }))
  // Directly before the interval: the nearest marker, with no other result's closing in between.
  const before = markers.filter((m) => m.end <= span.start).pop()
  if (before) {
    const gap = text.slice(before.end, span.start)
    if (gap.length <= MARKER_GAP_MAX && !/[;)]/.test(gap) && !/\d/.test(gap.replace(/\[\s*CI\s*\]/gi, ''))) return { ...before, span, text }
  }
  // Directly after it, inside the same bracket: "(0.70 to 0.90, 95% CI)".
  const after = markers.find((m) => m.start >= span.end)
  if (after && /^\s*[,;]?\s*$/.test(text.slice(span.end, after.start))) return { ...after, span, text }
  return { level: null, credible: false, span, text, unbound: true }
}

export function ciLabel(quantity) {
  const m = boundMarker(quantity)
  if (m && !m.unbound) {
    if (m.credible) return `${m.level ? `${m.level}% ` : ''}credible interval`
    if (m.level && m.level !== '95') return `${m.level}% CI`
    return 'CI'
  }
  // Same wrap the bracket verifier accepts, including parentheses and internal spaces.
  // "CI" is reserved for a marker bound to these bounds. Bounds the quote does not
  // locate stay "CI" only as the historical fallback for a quote that names none.
  if (m?.unbound && unlabelledIntervalWrap(m.text, m.span.start, m.span.end)) return 'interval'
  return 'CI'
}

// One verified quantity as a scannable value string: value, unit, CI, and P when present.
// The p-value carries an operator ONLY when the quote states one ("P<0.001", "P=0.02");
// otherwise it renders operator-free ("P 0.02") — an "=" the source never said is a
// misstatement in the fact channel.
export function fmtNum(q) {
  const hasPair = q.first_value != null && q.second_value != null
  const hasRange = q.range_low != null && q.range_high != null
  // A P-value-only result ("SF-36 physical component summary (P<0.001)") renders its P
  // rather than nothing; verification still decides whether it is asserted anywhere.
  if (q.value == null && !hasRange && !hasPair) return q.p_value != null ? fmtP(q) : ''
  let s
  // "%" is glued to every value it describes ("67.3% versus 50%"); a word unit is said
  // once, after the values ("144.3 versus 341.8 minutes"). Before 2026-10-04 "%" rendered
  // once with a space — "67.3 versus 50 %" — and the writer copies this string verbatim.
  const pct = q.unit === '%'
  const v = (field) => `${printedValue(q, field)}${pct ? '%' : ''}`
  if (hasPair && q.quantity_type === 'change') {
    const first = v('first_value')
    const second = v('second_value')
    s = q.first_label && q.second_label
      ? `${q.first_label}: ${first} to ${q.second_label}: ${second}`
      : `from ${first} to ${second}`
  } else if (hasPair && q.quantity_type === 'comparison') {
    const first = v('first_value')
    const second = v('second_value')
    // Labels are optional since 2026-09-30 ("36% vs. 26%" with the groups named elsewhere).
    s = q.first_label && q.second_label
      ? `${q.first_label}: ${first} versus ${q.second_label}: ${second}`
      : `${first} versus ${second}`
  } else {
    s = hasRange ? printedRange(q) + (pct ? '%' : '') : v('value')
  }
  if (q.unit && !pct) s += ` ${q.unit}`
  if (ciBelongsToEstimate(q)) {
    s += ` (${ciLabel(q)} ${printedValue(q, 'ci_low')}–${printedValue(q, 'ci_high')})`
  }
  if (q.p_value != null) s += `, ${fmtP(q)}`
  return s
}

// "P<0.001", "one-sided P=.71", "P=0.44 for noninferiority" — operator and qualifiers only
// when the quote prints them.
function fmtP(q) {
  const op = pOperator(q)
  const p = printedValue(q, 'p_value')
  const qual = pQualifier(q)
  const core = op ? `P${op}${p}` : `P ${p}`
  return `${qual?.sided ? `${qual.sided} ` : ''}${core}${qual?.test ? ` ${qual.test}` : ''}`
}
