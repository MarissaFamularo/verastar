import { describe, expect, it } from 'vitest'
import { evidenceHeading } from './evidenceHeading.js'

describe('evidenceHeading', () => {
  it('names withheld rows instead of calling the whole list verified', () => {
    expect(evidenceHeading({ verifiedCount: 5, withheldCount: 3 })).toBe('EVIDENCE · 5 verified · 3 withheld')
    expect(evidenceHeading({ verifiedCount: 0, withheldCount: 1 })).toBe('EVIDENCE · 0 verified · 1 withheld')
  })

  it('keeps a fully checked list to the verified count', () => {
    expect(evidenceHeading({ verifiedCount: 2, withheldCount: 0 })).toBe('EVIDENCE · 2 verified')
  })

  it('keeps the summary count and still names withheld rows outside it', () => {
    expect(evidenceHeading({ verifiedCount: 3, withheldCount: 2, focused: true, summaryCount: 1 })).toBe('EVIDENCE · 1 NUMBER IN THE SUMMARY, VERIFIED · 2 withheld')
    expect(evidenceHeading({ verifiedCount: 1, withheldCount: 0, focused: true, summaryCount: 1 })).toBe('EVIDENCE · 1 NUMBER IN THE SUMMARY, VERIFIED')
  })
})
