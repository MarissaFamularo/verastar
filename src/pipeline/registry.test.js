// Registry-parser suite — proves parseRegistryOutcomes() reads the STARDUST posted outcome
// off the LIVE CT.gov v2 shape, and never throws on malformed input.
//
// The fixture (__fixtures__/nct04881110.json) is the real
//   clinicaltrials.gov/api/v2/studies/NCT04881110?fields=hasResults,resultsSection.outcomeMeasuresModule
// response, captured to disk so tests NEVER hit the network. Refresh it by re-running that
// curl if CT.gov ever restructures.

import { describe, it, expect } from 'vitest'
import { parseRegistryOutcomes } from './sources.js'
import fixture from './__fixtures__/nct04881110.json'

const outcomeMeasures = fixture.resultsSection.outcomeMeasuresModule.outcomeMeasures

describe('parseRegistryOutcomes — live CT.gov shape (NCT04881110 fixture)', () => {
  it('extracts the STARDUST TcPO2 posted outcome: value 11.2, CI 8.0/14.5, with a measure title', () => {
    const rows = parseRegistryOutcomes(outcomeMeasures)
    const hero = rows.find(
      (r) => numEq(r.value, 11.2) && numEq(r.ci_low, 8) && numEq(r.ci_high, 14.5),
    )
    expect(hero).toBeTruthy()
    expect(hero.measure).toBe('Peripheral Transcutaneous Oxygen Pressure')
  })

  it('fans out one row per analysis (a measure can post several)', () => {
    const rows = parseRegistryOutcomes(outcomeMeasures)
    // The TcPO2 measure posts both a mean difference (11.2) and a risk ratio (1.91).
    expect(rows.some((r) => numEq(r.value, 1.91) && numEq(r.ci_low, 1.26) && numEq(r.ci_high, 2.9))).toBe(true)
  })

  it('every parsed row has a numeric value', () => {
    const rows = parseRegistryOutcomes(outcomeMeasures)
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(typeof r.value).toBe('number')
  })

  it('malformed / empty input -> [] (never throws)', () => {
    expect(parseRegistryOutcomes(null)).toEqual([])
    expect(parseRegistryOutcomes(undefined)).toEqual([])
    expect(parseRegistryOutcomes('nope')).toEqual([])
    expect(parseRegistryOutcomes({})).toEqual([])
    expect(parseRegistryOutcomes([])).toEqual([])
    expect(parseRegistryOutcomes([null, 42, { title: 'x' }])).toEqual([]) // no analyses
    // A non-numeric paramValue is skipped, not crashed on.
    expect(
      parseRegistryOutcomes([{ title: 'x', analyses: [{ paramValue: 'not-a-number' }] }]),
    ).toEqual([])
  })

  it('skips a non-numeric estimate but keeps a numeric sibling', () => {
    const rows = parseRegistryOutcomes([
      {
        title: 'Mixed',
        analyses: [{ paramValue: '<0.001' }, { paramValue: '3.5', ciLowerLimit: '1.0', ciUpperLimit: '6.0' }],
      },
    ])
    expect(rows).toEqual([{ measure: 'Mixed', value: 3.5, ci_low: 1, ci_high: 6 }])
  })
})

// Local representation-equality so the assertions don't couple to verify.js.
function numEq(a, b) {
  return typeof a === 'number' && Math.abs(a - b) < 1e-9
}
