// lib/findingGate.test.js — a refuted finding never leaves the paper record (2026-10-04
// review: concept synthesis, weekend synthesis and filing were reading paper.finding raw).

import { describe, it, expect } from 'vitest'
import { usableFinding } from './findingGate.js'
import { buildWeekendContent } from '../pipeline/weekend.js'

const refuted = { title: 'A', finding: 'Drug X halved mortality.', check: { verdict: 'refuted', reason: 'not in source' } }
const supported = { title: 'B', finding: 'Drug Y reduced bleeding.', check: { verdict: 'supported', reason: '' } }
const unchecked = { title: 'C', finding: 'Drug Z was well tolerated.', check: { verdict: 'unchecked', reason: '' } }

describe('usableFinding', () => {
  it('withholds a refuted finding', () => {
    expect(usableFinding(refuted)).toBe('')
  })
  it('passes supported, unchecked and legacy (no check) findings through', () => {
    expect(usableFinding(supported)).toBe('Drug Y reduced bleeding.')
    expect(usableFinding(unchecked)).toBe('Drug Z was well tolerated.')
    expect(usableFinding({ finding: 'Legacy.' })).toBe('Legacy.')
  })
  it('tolerates junk', () => {
    expect(usableFinding(null)).toBe('')
    expect(usableFinding({})).toBe('')
  })
})

describe('weekend synthesis input', () => {
  it('never carries a refuted finding, in the focus set or the library shelf', () => {
    const content = buildWeekendContent({ papers: [refuted, supported], libraryPapers: [{ ...refuted, pmid: '9' }] })
    expect(content).not.toContain('halved mortality')
    expect(content).toContain('Drug Y reduced bleeding.')
    expect(content).toContain('(no verified finding)')
  })
})
