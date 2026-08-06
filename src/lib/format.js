// lib/format.js — the ONE quantity formatter for the fact channel.
//
// Every surface that renders a verified quantity (digest rows, triage input, the on-disk
// vault notes) formats it here, so they can never disagree. Two-channel rule
// (docs/VERIFICATION_SPEC.md): a verified number is an app-owned fact and must never be
// misstated — including its p-value operator. The verifier accepts a magnitude-only
// p-value match (claim 0.001 verifies against "P<0·001"), so the operator is NOT part of
// the verified tuple; it is re-derived here from the verified quote, deterministically,
// never model-asserted, and never invented when the quote doesn't state one.

import { normalize, extractNumbersWithIndex, numbersEqual } from '../pipeline/verify.js'

// Post-NFKC operator characters the quote may state before a p-value. ⩽/⩾ (slanted
// variants) are distinct code points NFKC does not fold, so they map here.
const P_OPERATORS = { '=': '=', '<': '<', '>': '>', '≤': '≤', '≥': '≥', '⩽': '≤', '⩾': '≥' }

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
      const before = text.slice(Math.max(0, token.start - 18), token.start)
      return /\bp(?:\s*[- ]?value)?\s*(?:of\s*)?(?:<=|>=|[=<>≤≥⩽⩾])?\s*$/i.test(before)
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

  return tokens.find((t) => numbersEqual(t.value, target))?.raw || String(target)
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
  for (const token of extractNumbersWithIndex(quote)) {
    if (!numbersEqual(token.value, quantity.p_value)) continue
    const before = quote.slice(Math.max(0, token.start - 18), token.start)
    const match = before.match(/\bp(?:\s*[- ]?value)?\s*(?:of\s*)?(<=|>=|[=<>≤≥⩽⩾])?\s*$/i)
    if (!match) continue
    if (match[1] === '<=') return '≤'
    if (match[1] === '>=') return '≥'
    return P_OPERATORS[match[1]] || null
  }
  return null
}

// One verified quantity as a scannable value string: value, unit, CI, and P when present.
// The p-value carries an operator ONLY when the quote states one ("P<0.001", "P=0.02");
// otherwise it renders operator-free ("P 0.02") — an "=" the source never said is a
// misstatement in the fact channel.
export function fmtNum(q) {
  if (q.value == null) return ''
  let s = printedValue(q, 'value')
  if (q.unit) s += ` ${q.unit}`
  if (q.ci_low != null && q.ci_high != null) {
    s += ` (CI ${printedValue(q, 'ci_low')}–${printedValue(q, 'ci_high')})`
  }
  if (q.p_value != null) {
    const op = pOperator(q)
    const p = printedValue(q, 'p_value')
    s += op ? `, P${op}${p}` : `, P ${p}`
  }
  return s
}
