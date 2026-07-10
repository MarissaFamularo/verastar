// corrupt.test.js — the corrupted-value oracle helper. corruptAndReverify must produce a
// value the deterministic gate FLAGS, every time: the demo moment is "watch it catch the
// corruption", so a corrupted value that happens to equal another real number in the quote
// (classically a CI bound: 0.7 + 0.1 = 0.8 inside "0.7 (95% CI 0.5-0.8)") would re-verify
// green and break the whole point. Pure — fake paperResult rows, no network.

import { describe, it, expect } from 'vitest'
import { corruptAndReverify } from './pipeline.js'
import { normalize, extractNumbers, numbersEqual } from './verify.js'

// Mirror the shapes runPaper builds: rows of { quantity, verdict } plus source.tier,
// and the sourceDoc { text, tables } that SpineCheck passes back in for re-verification.
const paperResult = (quantity) => ({
  rows: [{ quantity, verdict: { flagged: false } }],
  source: { tier: 'full_text' },
})
const sourceDoc = (text) => ({ text, tables: '' })

describe('corruptAndReverify', () => {
  it('never lands on another real number in the quote (the CI-bound collision)', () => {
    const quantity = {
      value: 0.7,
      ci_low: 0.5,
      ci_high: 0.8,
      source_quote: 'difference 0.7 (95% CI 0.5-0.8)',
    }
    const text = 'The between-group difference 0.7 (95% CI 0.5-0.8) favored revascularization.'
    const out = corruptAndReverify(paperResult(quantity), sourceDoc(text))

    expect(out).not.toBeNull()
    expect(out.original).toBe(0.7)
    // 0.7 + 0.1 = 0.8 is a legitimate number in the quote — must have been skipped.
    const quoteNums = extractNumbers(normalize(quantity.source_quote))
    expect(quoteNums).toContain(0.8)
    expect(quoteNums.some((n) => numbersEqual(n, out.quantity.value))).toBe(false)
    expect(out.verdict.flagged).toBe(true)
  })

  it('flags the simple corruption (0.84 -> 0.94) when +0.1 is safe', () => {
    const quantity = { value: 0.84, source_quote: 'hazard ratio was 0.84' }
    const text = 'In the primary analysis the hazard ratio was 0.84 for the endpoint.'
    const out = corruptAndReverify(paperResult(quantity), sourceDoc(text))

    expect(out).not.toBeNull()
    expect(out.quantity.value).toBe(0.94)
    expect(out.original).toBe(0.84)
    expect(out.verdict.flagged).toBe(true)
  })

  it('returns null when there is no clean verified row to corrupt', () => {
    const res = {
      rows: [{ quantity: { value: 0.84, source_quote: 'hr 0.84' }, verdict: { flagged: true } }],
      source: { tier: 'full_text' },
    }
    expect(corruptAndReverify(res, sourceDoc('hr 0.84'))).toBeNull()
    expect(corruptAndReverify({ rows: [], source: { tier: 'full_text' } }, sourceDoc(''))).toBeNull()
  })
})
