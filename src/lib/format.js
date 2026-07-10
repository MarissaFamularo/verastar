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

// Derive the p-value operator from the quantity's verified quote. Tokenize the normalized
// quote (representation may differ: "P = .02" vs claim 0.02, so tokens are matched with
// numbersEqual, never string search), take the FIRST token equal to p_value, and scan
// backwards over whitespace for an explicit operator character. Returns '=', '<', '>',
// '≤', '≥', or null when the quote states none (or there is no quote / no p_value).
export function pOperator(quantity) {
  if (quantity == null || quantity.p_value == null) return null
  const quote = normalize(quantity.source_quote || '')
  if (!quote) return null
  for (const token of extractNumbersWithIndex(quote)) {
    if (!numbersEqual(token.value, quantity.p_value)) continue
    let i = token.start - 1
    while (i >= 0 && quote[i] === ' ') i--
    if (i < 0) return null
    // ASCII "<=" / ">=" — the "=" is only the tail; the real operator is the char before it,
    // so read through to it ("P<=.05" states ≤, never =). Whitespace between is tolerated.
    if (quote[i] === '=') {
      let j = i - 1
      while (j >= 0 && quote[j] === ' ') j--
      if (j >= 0 && quote[j] === '<') return '≤'
      if (j >= 0 && quote[j] === '>') return '≥'
    }
    // First matching token decides — a later duplicate never overrides.
    return P_OPERATORS[quote[i]] || null
  }
  return null
}

// One verified quantity as a scannable value string: value, unit, CI, and P when present.
// The p-value carries an operator ONLY when the quote states one ("P<0.001", "P=0.02");
// otherwise it renders operator-free ("P 0.02") — an "=" the source never said is a
// misstatement in the fact channel.
export function fmtNum(q) {
  if (q.value == null) return ''
  let s = String(q.value)
  if (q.unit) s += ` ${q.unit}`
  if (q.ci_low != null && q.ci_high != null) s += ` (CI ${q.ci_low}–${q.ci_high})`
  if (q.p_value != null) {
    const op = pOperator(q)
    s += op ? `, P${op}${q.p_value}` : `, P ${q.p_value}`
  }
  return s
}
