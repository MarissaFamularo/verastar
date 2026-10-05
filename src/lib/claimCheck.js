// lib/claimCheck.js — what the digest is allowed to SAY about a prose sentence.
//
// Two different things back a digest sentence, and the UI must never blur them:
//   - its NUMBERS: each one matched to a printed source quote by verify.js (deterministic,
//     proof). linkFindingNumbers ties every number in the sentence to its OWN quote.
//   - its CLAIM: the direction, comparison, population around those numbers. Only a model
//     judged that (pipeline/check.js) — a judgment, not proof.
//     claimCheckLabel words it that way.
// Before 2026-10-04 one "grounded in source" link sat after the whole sentence and opened
// only the paper's first verified number, which read as if the entire sentence were proven.

import { normalize, extractNumbers, extractNumbersWithIndex, numbersEqual } from '../pipeline/verify.js'
import { fmtNum } from './format.js'

// The label after a finding or design caution. null = say nothing (unchecked, as before
// the gate existed). Refuted claims are withheld upstream and never reach this.
export function claimCheckLabel(check) {
  if (check?.verdict !== 'supported') return null
  return {
    text: '✓ claim checked by a model',
    title: 'A second model read the source text and judged this sentence supported — direction of effect, comparison, population. That is a judgment, not proof: only the underlined numbers are matched to the source by the app.',
  }
}

// Length-preserving normalization for tokenizing the rendered sentence, so token offsets
// map straight back onto the text the reader sees: unify dashes and middle-dot decimals,
// nothing else. (Grouped thousands stay split and so stay unlinked — never mislinked.)
const DASHES = /[‐‑‒–—−－]/g
const lightNormalize = (s) => s.replace(DASHES, '-').replace(/(\d)[·‧⋅∙•](\d)/g, '$1.$2')

// Split `finding` into segments, each { text } or { text, row }: every number in the
// sentence becomes its own link to the verified row whose printed value contains it.
// When several rows carry the same number, a number keeps the row its neighbour just
// used (so "OR 0.30, CI 0.11–0.88" stays one row) — otherwise the first row in order.
// Nomenclature (TcPO2, COVID-19) is skipped, exactly as the number guard skips it.
// A number no row carries stays plain text: it is never linked to the wrong quote.
export function linkFindingNumbers(finding, rows) {
  const text = String(finding || '')
  const rowNums = (rows || []).map((row) => extractNumbers(normalize(fmtNum(row.quantity || {}))))
  const tokens = extractNumbersWithIndex(lightNormalize(text)).filter(
    (t) => !/[a-z]/i.test(text[t.start - 1] || '')
  )
  const segments = []
  let cursor = 0
  let lastRow = -1
  for (const t of tokens) {
    const candidates = rowNums.flatMap((nums, i) => (nums.some((n) => numbersEqual(n, t.value)) ? [i] : []))
    if (!candidates.length) continue
    const pick = candidates.includes(lastRow) ? lastRow : candidates[0]
    // A CI dash stays plain text ("0.11–0.88" links 0.11 and 0.88): the tokenizer starts
    // a range's second bound after the dash, and only a true minus sign joins its number.
    if (t.start > cursor) segments.push({ text: text.slice(cursor, t.start) })
    segments.push({ text: text.slice(t.start, t.end), row: rows[pick] })
    cursor = t.end
    lastRow = pick
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) })
  return segments
}
