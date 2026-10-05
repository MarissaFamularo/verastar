// claimCheck.test.js — the digest must keep the two kinds of backing apart: numbers are
// matched to source quotes (proof), the claim around them is judged by models (not proof).

import { describe, it, expect } from 'vitest'
import { claimCheckLabel, linkFindingNumbers } from './claimCheck.js'

const OR_PATENCY = { quantity: { name: 'odds ratio, primary patency', quantity_type: 'single', value: 0.3, ci_low: 0.11, ci_high: 0.88, printed: { value: '0.30' } } }
const OR_TLR = { quantity: { name: 'odds ratio, TLR-free survival', quantity_type: 'single', value: 0.28, ci_low: 0.09, ci_high: 0.86 } }

const linked = (segments) => segments.filter((s) => s.row).map((s) => [s.text, s.row.quantity.name])

describe('linkFindingNumbers — every number links to its own quote', () => {
  it('links each estimate in a two-claim sentence to its own row, not the first row', () => {
    const finding = 'Diabetes reduced the odds of primary patency (OR 0.30, CI 0.11–0.88) and TLR-free survival (OR 0.28, CI 0.09–0.86).'
    const segs = linkFindingNumbers(finding, [OR_PATENCY, OR_TLR])
    expect(segs.map((s) => s.text).join('')).toBe(finding)
    expect(linked(segs)).toEqual([
      ['0.30', 'odds ratio, primary patency'],
      ['0.11', 'odds ratio, primary patency'],
      ['0.88', 'odds ratio, primary patency'],
      ['0.28', 'odds ratio, TLR-free survival'],
      ['0.09', 'odds ratio, TLR-free survival'],
      ['0.86', 'odds ratio, TLR-free survival'],
    ])
  })
  it('a shared number stays with the row its neighbour used', () => {
    const a = { quantity: { name: 'A', quantity_type: 'single', value: 0.5, ci_low: 0.2, ci_high: 0.9 } }
    const b = { quantity: { name: 'B', quantity_type: 'single', value: 0.7, ci_low: 0.5, ci_high: 0.95 } }
    expect(linked(linkFindingNumbers('HR 0.7 (CI 0.5–0.95)', [a, b]))).toEqual([['0.7', 'B'], ['0.5', 'B'], ['0.95', 'B']])
  })
  it('never links a number no verified row carries, nor nomenclature', () => {
    const segs = linkFindingNumbers('In type 2 diabetes after COVID-19, OR 0.30.', [OR_PATENCY])
    expect(linked(segs)).toEqual([['0.30', 'odds ratio, primary patency']])
  })
  it('a number-free sentence is one plain segment', () => {
    expect(linkFindingNumbers('No statistically clear benefit.', [OR_PATENCY])).toEqual([{ text: 'No statistically clear benefit.' }])
  })
})

describe('claimCheckLabel — says what was checked, and by what', () => {
  it('says nothing for an unchecked claim', () => {
    expect(claimCheckLabel({ verdict: 'unchecked', reason: '' })).toBeNull()
    expect(claimCheckLabel(undefined)).toBeNull()
  })
  it('names the model check and says it is not proof', () => {
    const l = claimCheckLabel({ verdict: 'supported', reason: '' })
    expect(l.text).toBe('✓ claim checked by a model')
    expect(l.title).toMatch(/not proof/)
  })
  it('never labels a claim "grounded" or "verified"', () => {
    expect(claimCheckLabel({ verdict: 'supported' }).text).not.toMatch(/grounded|verified|proven/i)
  })
})
