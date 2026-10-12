// A P printed after the CI's own bracket — estimates-v7 (2026-10-06 candidate, repaired 2026-10-09).
//
// Ann Vasc Surg 2026 (PMID 42833578) printed every adjusted HR as
// "(aHR = 0.78 [95% CI: 0.70-0.86]; P < 0.001)". The tuple grammar stopped at "]", so an
// extraction that correctly included the P stayed unresolved while one that omitted it
// verified. Two Results sentences are quoted below as the corpus. The estimate tier still
// proves only the printed tuple — never the endpoint or comparator — so the mislabel cases
// assert that limitation explicitly rather than pretend it is caught.
import { describe, it, expect } from 'vitest'
import { verify, TIERS } from './verify.js'

const SRC = 'RESULTS: At one year, AC bypass (aHR = 1.30 [95% CI: 1.20-1.41]; P < 0.001) and ET (aHR = 1.18 [95% CI: 1.10-1.28]; P < 0.001) were associated with higher hazards of major amputation/death compared to SSGSV bypass in octogenarians. ET had lower hazards of major amputation compared to SSGSV bypass (aHR = 0.78 [95% CI: 0.70-0.86]; P < 0.001) and AC bypass (aHR = 0.64 [95% CI: 0.57-0.70]; P < 0.001), as well as lower hazards of major amputation/death compared to AC bypass (aHR = 0.91 [95% CI: 0.85-0.97]; P = 0.004).'
const OPTS = { sourceTier: 'abstract_only' }
const base = { quantity_type: 'single', range_low: null, range_high: null, first_label: null, first_value: null, second_label: null, second_value: null, unit: 'aHR', location_hint: 'Abstract, Results' }
const q = (fields) => ({ ...base, ...fields })

// The three single-tuple quotes exactly as extracted in production (screenshots, 2026-10-06).
const ampEtSsgsv = q({ name: 'One-year major amputation, ET vs SSGSV bypass in octogenarians (adjusted HR)', value: 0.78, ci_low: 0.70, ci_high: 0.86, p_value: 0.001, source_quote: 'ET had lower hazards of major amputation compared to SSGSV bypass (aHR = 0.78 [95% CI: 0.70-0.86]; P < 0.001)' })
const ampEtAc = q({ name: 'One-year major amputation, ET vs AC bypass in octogenarians (adjusted HR)', value: 0.64, ci_low: 0.57, ci_high: 0.70, p_value: 0.001, source_quote: 'and AC bypass (aHR = 0.64 [95% CI: 0.57-0.70]; P < 0.001)' })
const deathEtAc = q({ name: 'One-year major amputation/death, ET vs AC bypass in octogenarians (adjusted HR)', value: 0.91, ci_low: 0.85, ci_high: 0.97, p_value: 0.004, source_quote: 'as well as lower hazards of major amputation/death compared to AC bypass (aHR = 0.91 [95% CI: 0.85-0.97]; P = 0.004)' })
// Both production quotes for the AC/ET vs SSGSV pair carried the whole two-tuple sentence.
const TWO_TUPLE = 'At one year, AC bypass (aHR = 1.30 [95% CI: 1.20-1.41]; P < 0.001) and ET (aHR = 1.18 [95% CI: 1.10-1.28]; P < 0.001) were associated with higher hazards of major amputation/death compared to SSGSV bypass in octogenarians.'

const withheld = (quantity, source = SRC) => {
  const v = verify(quantity, source, OPTS)
  expect(v.tier).not.toBe(TIERS.ESTIMATE)
  expect(v.relationshipValidated).toBe(false)
  return v
}

describe('P after the CI bracket — the production example', () => {
  it('verifies each single-tuple quote WITH its P, endpoint still unchecked', () => {
    for (const quantity of [ampEtSsgsv, ampEtAc, deathEtAc]) {
      const v = verify(quantity, SRC, OPTS)
      expect(v.tier).toBe(TIERS.ESTIMATE)
      expect(v.endpointValidated).toBe(false)
      expect(v.reason).toMatch(/not checked/)
    }
  })
  it('still verifies when the extraction omits the P (unchanged)', () => {
    expect(verify({ ...ampEtSsgsv, p_value: null }, SRC, OPTS).tier).toBe(TIERS.ESTIMATE)
  })
  it('a quote holding two tuples stays unresolved for either value (missing isolation)', () => {
    withheld(q({ name: 'amp/death AC vs SSGSV', value: 1.30, ci_low: 1.20, ci_high: 1.41, p_value: 0.001, source_quote: TWO_TUPLE }))
    withheld(q({ name: 'amp/death ET vs SSGSV', value: 1.18, ci_low: 1.10, ci_high: 1.28, p_value: 0.001, source_quote: TWO_TUPLE }))
  })
  it('the same value verifies once the quote isolates its own tuple', () => {
    const v = verify(q({ name: 'amp/death AC vs SSGSV', value: 1.30, ci_low: 1.20, ci_high: 1.41, p_value: 0.001, source_quote: 'AC bypass (aHR = 1.30 [95% CI: 1.20-1.41]; P < 0.001)' }), SRC, OPTS)
    expect(v.tier).toBe(TIERS.ESTIMATE)
  })
  it('the "18.9%" of limbs stays unresolved — no "n of N" and 25,547/134,808 is 18.95', () => {
    const src = 'Data from a total of 134,808 limbs and 91,938 patients were analyzed (Octogenarian=25,547, 18.9%).'
    withheld(q({ name: 'Proportion of octogenarians among all patients analyzed', unit: '%', value: 18.9, ci_low: null, ci_high: null, p_value: null, source_quote: src }), src)
  })
})

describe('P after the CI bracket — [false-verify guards]', () => {
  it('amputation value under the amputation/death quote (endpoint swap by number)', () => {
    withheld({ ...deathEtAc, value: 0.78, ci_low: 0.70, ci_high: 0.86, p_value: 0.001 })
  })
  it('ET-vs-AC value under the ET-vs-SSGSV quote (comparator swap by number)', () => {
    withheld({ ...ampEtSsgsv, value: 0.64, ci_low: 0.57, ci_high: 0.70 })
  })
  it('reversed direction (AC vs ET reciprocal, 1/0.64)', () => withheld({ ...ampEtAc, value: 1.56, ci_low: 1.43, ci_high: 1.75 }))
  it('wrong P', () => withheld({ ...deathEtAc, p_value: 0.04 }))
  it('P placed as a CI bound', () => withheld({ ...deathEtAc, ci_high: 0.004 }))
  it('value and CI bound swapped', () => withheld({ ...ampEtSsgsv, value: 0.70, ci_low: 0.78 }))
  it('quote truncated before the P, P still claimed (missing context)', () => {
    withheld({ ...ampEtSsgsv, source_quote: 'compared to SSGSV bypass (aHR = 0.78 [95% CI: 0.70-0.86]' })
  })
  it('a quote the source does not contain (unsupported claim)', () => {
    const v = withheld({ ...ampEtSsgsv, source_quote: 'ET had lower hazards of death compared to SSGSV bypass (aHR = 0.78 [95% CI: 0.70-0.86]; P < 0.001)' })
    expect(v.tier).toBe(TIERS.FLAGGED)
  })
  it('mismatched brackets do not bind the P', () => {
    const src = 'Death fell (HR 0.78 [95% CI 0.70-0.86); P = 0.02.'
    withheld(q({ name: 'death', value: 0.78, ci_low: 0.70, ci_high: 0.86, p_value: 0.02, unit: 'HR', source_quote: src }), src)
  })
  it('a P qualified after the bracket ("for interaction") is a different test', () => {
    const src = 'Death fell (HR 0.78 [95% CI 0.70-0.86]; P = 0.02 for interaction).'
    withheld(q({ name: 'death', value: 0.78, ci_low: 0.70, ci_high: 0.86, p_value: 0.02, unit: 'HR', source_quote: src }), src)
    // …but the tuple itself, without that P, is still printed as claimed.
    expect(verify(q({ name: 'death', value: 0.78, ci_low: 0.70, ci_high: 0.86, p_value: null, unit: 'HR', source_quote: src }), src, OPTS).tier).toBe(TIERS.ESTIMATE)
  })
  it('a bracket closing the whole estimate leaves the trailing P unbound', () => {
    const src = 'Death fell (HR 0.78, 95% CI 0.70-0.86), P = 0.02 overall.'
    withheld(q({ name: 'death', value: 0.78, ci_low: 0.70, ci_high: 0.86, p_value: 0.02, unit: 'HR', source_quote: src }), src)
  })
  it('known limit: a correct tuple under a wrong NAME still verifies, endpoint unchecked', () => {
    // The estimate tier never binds the name; the badge says "endpoint unchecked". This
    // pins that the verdict says so rather than claiming the endpoint.
    const v = verify({ ...ampEtSsgsv, name: 'One-year major amputation/death, AC vs ET' }, SRC, OPTS)
    expect(v.tier).toBe(TIERS.ESTIMATE)
    expect(v.endpointValidated).toBe(false)
  })
})

// Codex review P1 (2026-10-09): the first v7 candidate accepted punctuation after the P as
// proof that nothing qualified it, so ", for interaction" bound an interaction P to the
// estimate. The same hole was older than v7: with the CI and P in one bracket (estimates
// v1–v6) and in the "A vs B, P" comparison grammar, a trailing qualifier was never read
// at all. A P now binds only when it ends its clause in the FULL source. Synthetic
// grammar fixtures, not quotes from a paper.
describe('a qualified P never binds — [false-verify guards, Codex P1]', () => {
  const hr = (src, quote = src, p = 0.02) => q({ name: 'death', unit: 'HR', value: 0.78, ci_low: 0.70, ci_high: 0.86, p_value: p, source_quote: quote })
  const qualified = [
    'Death fell (HR 0.78 [95% CI 0.70-0.86]; P = 0.02, for interaction).',
    'Death fell (HR 0.78 [95% CI 0.70-0.86]; P = 0.02; interaction test).',
    'Death fell (HR 0.78 [95% CI 0.70-0.86]; P = 0.02 for interaction).',
    'Death fell (HR 0.78 [95% CI 0.70-0.86]; P = 0.02 (interaction test)).',
    'Death fell (HR 0.78 [95% CI 0.70-0.86]; P = 0.02) (interaction test).',
    // Pre-v7 grammar: CI and P in the estimate's one bracket.
    'Death fell (HR 0.78; 95% CI 0.70-0.86; P = 0.02 for interaction).',
    'Death fell (HR 0.78; 95% CI 0.70-0.86; P = 0.02, for interaction).',
    'Death fell (HR 0.78, 95% CI 0.70-0.86, P = 0.02 for trend).',
    'Death fell, HR 0.78, 95% CI 0.70-0.86, P = 0.02 for heterogeneity.',
  ]
  for (const src of qualified) {
    it(`withholds the P in "${src}"`, () => {
      withheld(hr(src), src)
      // The tuple itself, without that P, is still printed as claimed.
      expect(verify(hr(src, src, null), src, OPTS).tier).toBe(TIERS.ESTIMATE)
    })
  }
  it('a quote truncated before the qualifier cannot hide it (bracketed CI)', () => {
    const src = 'Death fell (HR 0.78 [95% CI 0.70-0.86]; P = 0.02, for interaction).'
    withheld(hr(src, 'Death fell (HR 0.78 [95% CI 0.70-0.86]; P = 0.02'), src)
    withheld(hr(src, 'HR 0.78 [95% CI 0.70-0.86]; P = 0.02,'), src)
  })
  it('a quote truncated before the qualifier cannot hide it (one bracket, v1–v6 grammar)', () => {
    const src = 'Death fell (HR 0.78; 95% CI 0.70-0.86; P = 0.02 for interaction).'
    withheld(hr(src, 'Death fell (HR 0.78; 95% CI 0.70-0.86; P = 0.02'), src)
  })
  it('a quote truncated before the qualifier cannot hide it (unpunctuated, bracketed CI)', () => {
    const src = 'Death fell (HR 0.78 [95% CI 0.70-0.86]; P = 0.02 for interaction).'
    withheld(hr(src, 'Death fell (HR 0.78 [95% CI 0.70-0.86]; P = 0.02'), src)
  })
  it('a comparison P followed by a qualifier does not bind either', () => {
    const cmp = (src, quote = src) => ({ name: 'mortality', quantity_type: 'comparison', value: null, range_low: null, range_high: null, first_label: null, second_label: null, first_value: 36, second_value: 26, unit: '%', ci_low: null, ci_high: null, p_value: 0.03, source_quote: quote, location_hint: null })
    for (const src of ['Mortality was 36% vs. 26%, P = 0.03 for trend.', 'Mortality was 36% vs. 26%, P = 0.03, for interaction.']) {
      const v = verify(cmp(src), src, OPTS)
      expect(v.tier).not.toBe(TIERS.COMPARISON)
      expect(v.relationshipValidated).toBe(false)
    }
    const trunc = 'Mortality was 36% vs. 26%, P = 0.03 for trend.'
    expect(verify(cmp(trunc, 'Mortality was 36% vs. 26%, P = 0.03'), trunc, OPTS).relationshipValidated).toBe(false)
    // Control: an unqualified comparison P still binds.
    const ok = 'Mortality was 36% vs. 26%, P = 0.03.'
    expect(verify(cmp(ok), ok, OPTS).tier).toBe(TIERS.COMPARISON)
  })
})

describe('an unqualified P still binds — controls', () => {
  const hr = (src, quote = src) => q({ name: 'death', unit: 'HR', value: 0.78, ci_low: 0.70, ci_high: 0.86, p_value: 0.02, source_quote: quote })
  for (const src of [
    'Death fell (HR 0.78 [95% CI 0.70-0.86]; P = 0.02).',
    'Death fell (HR 0.78 [95% CI 0.70-0.86]; P = 0.02) and stroke did not.',
    'Death fell (HR 0.78; 95% CI 0.70-0.86; P = 0.02).',
    'Death fell, HR 0.78, 95% CI 0.70-0.86, P = 0.02. Stroke did not.',
    'Death fell, HR 0.78, 95% CI 0.70-0.86, P = 0.02',
  ]) {
    it(`binds the P in "${src}"`, () => expect(verify(hr(src), src, OPTS).tier).toBe(TIERS.ESTIMATE))
  }
  it('binds when the quote stops at the P and the source closes the clause right after it', () => {
    const src = 'Death fell (HR 0.78 [95% CI 0.70-0.86]; P = 0.02).'
    expect(verify(hr(src, 'Death fell (HR 0.78 [95% CI 0.70-0.86]; P = 0.02'), src, OPTS).tier).toBe(TIERS.ESTIMATE)
  })
  it('a population qualifier after the closing bracket still binds (endpoint stays unchecked)', () => {
    // The legitimate form: "(95% CI: 1.34-4.98, p = 0.004) for eGFR 30-< 45".
    const src = 'Death fell (HR 0.78 [95% CI 0.70-0.86]; P = 0.02) for patients with diabetes.'
    const v = verify(hr(src), src, OPTS)
    expect(v.tier).toBe(TIERS.ESTIMATE)
    expect(v.endpointValidated).toBe(false)
  })
})

describe('the estimate reason names only what was checked', () => {
  it('mentions the P only when one was claimed and bound', () => {
    const src = 'Death fell (HR 0.78 [95% CI 0.70-0.86]; P = 0.02).'
    const mk = (p) => q({ name: 'death', unit: 'HR', value: 0.78, ci_low: 0.70, ci_high: 0.86, p_value: p, source_quote: src })
    expect(verify(mk(0.02), src, OPTS).reason).toMatch(/confidence interval and P value verified/)
    expect(verify(mk(null), src, OPTS).reason).not.toMatch(/P value/)
  })
})

describe('a cross-reference bracket after the P does not unbind it', () => {
  const hr = (src) => q({ name: 'death', unit: 'HR', value: 0.78, ci_low: 0.70, ci_high: 0.86, p_value: 0.02, source_quote: src.slice(0, src.indexOf('0.02') + 4) })
  for (const tail of [') (Table 2).', ') (Table 2, and Fig. 1 in the Supplementary Appendix).', ') [12].', ') (Fig. 2A).', ') (eTable 3).', ') (refs. 4-6).']) {
    const src = `Death fell (HR 0.78 [95% CI 0.70-0.86]; P = 0.02${tail}`
    it(`binds before "${tail}"`, () => expect(verify(hr(src), src, OPTS).tier).toBe(TIERS.ESTIMATE))
  }
  for (const tail of [') (interaction test).', ') (for trend).', ') [interaction].', '), (one-sided).']) {
    const src = `Death fell (HR 0.78 [95% CI 0.70-0.86]; P = 0.02${tail}`
    it(`withholds before "${tail}"`, () => withheld(hr(src), src))
  }
  it('a comparison list closed before a table reference keeps its P (CREST-style, synthetic)', () => {
    const src = 'Rates differed (death, 0.7% vs. 0.3%; P = 0.18; stroke, 4.1% vs. 2.3%; P = 0.01; infarction, 1.1% vs. 2.3%; P = 0.03) (Table 2).'
    const cmp = { name: 'infarction', quantity_type: 'comparison', value: null, range_low: null, range_high: null, first_label: null, second_label: null, first_value: 1.1, second_value: 2.3, unit: '%', ci_low: null, ci_high: null, p_value: 0.03, source_quote: 'infarction, 1.1% vs. 2.3%; P = 0.03', location_hint: null }
    expect(verify(cmp, src, OPTS).tier).toBe(TIERS.COMPARISON)
  })
})

describe('a P followed by the next item of a list still binds', () => {
  // Synthetic, in the shape CREST prints its periprocedural components.
  const SRC = 'The rates differed (death, 0.7% vs. 0.3%; P = 0.18; stroke, 4.1% vs. 2.3%; P = 0.01; myocardial infarction, 1.1% vs. 2.3%; P = 0.03) (Table 2).'
  const cmp = (first, second, p, quote) => ({ name: 'component', quantity_type: 'comparison', value: null, range_low: null, range_high: null, first_label: null, second_label: null, first_value: first, second_value: second, unit: '%', ci_low: null, ci_high: null, p_value: p, source_quote: quote, location_hint: null })
  it('binds each listed component\'s own P', () => {
    expect(verify(cmp(0.7, 0.3, 0.18, 'death, 0.7% vs. 0.3%; P = 0.18'), SRC, OPTS).tier).toBe(TIERS.COMPARISON)
    expect(verify(cmp(4.1, 2.3, 0.01, 'stroke, 4.1% vs. 2.3%; P = 0.01'), SRC, OPTS).tier).toBe(TIERS.COMPARISON)
    expect(verify(cmp(1.1, 2.3, 0.03, 'myocardial infarction, 1.1% vs. 2.3%; P = 0.03'), SRC, OPTS).tier).toBe(TIERS.COMPARISON)
  })
  it('the next segment must be a plain item name, never a P qualifier', () => {
    for (const src of [
      'Rates were 4.1% vs. 2.3%; P = 0.01; for interaction, 0.40.',
      'Rates were 4.1% vs. 2.3%; P = 0.01, interaction p, 0.40.',
      'Rates were 4.1% vs. 2.3%; P = 0.01; trend 3 groups.',
      'Rates were 4.1% vs. 2.3%; P = 0.01, one-sided 0.005.',
    ]) {
      const quote = src.slice(10, src.indexOf('0.01') + 4)
      expect(verify(cmp(4.1, 2.3, 0.01, quote), src, OPTS).relationshipValidated, src).toBe(false)
      // Control: the pair itself, without the P, verifies — only the P binding is refused.
      expect(verify(cmp(4.1, 2.3, null, quote), src, OPTS).tier, src).toBe(TIERS.COMPARISON)
    }
  })
})

// Codex R2 review P1 (2026-10-09): an explicit P-test qualifier after a closing delimiter,
// or hidden inside a "reference" bracket, still bound the P. Such a qualifier names a
// different statistical test, not an unchecked endpoint. Synthetic fixtures.
describe('P-test qualifiers through closing delimiters and references — [false-verify guards, Codex R2]', () => {
  const hr = (src, quote = src, p = 0.02) => q({ name: 'death', unit: 'HR', value: 0.78, ci_low: 0.70, ci_high: 0.86, p_value: p, source_quote: quote })
  const cases = [
    'Death fell (HR 0.78 [95% CI 0.70-0.86]; P = 0.02) for interaction.',
    'Death fell (HR 0.78 [95% CI 0.70-0.86]; P = 0.02) for the interaction with age.',
    'Death fell (HR 0.78 [95% CI 0.70-0.86]; P = 0.02), for trend.',
    'Death fell (HR 0.78; 95% CI 0.70-0.86; P = 0.02) for heterogeneity.',
    'Death fell (HR 0.78 [95% CI 0.70-0.86]; P = 0.02) (Table 2; P for interaction).',
    'Death fell (HR 0.78 [95% CI 0.70-0.86]; P = 0.02) (Table 2) for interaction.',
    'Death fell (HR 0.78 [95% CI 0.70-0.86]; P = 0.02) [12] by log-rank test for trend.',
    'Death fell (HR 0.78 [95% CI 0.70-0.86]; P = 0.02) (Fig. 2, interaction).',
    'Death fell (HR 0.78 [95% CI 0.70-0.86]; P = 0.02) one-sided.',
  ]
  for (const src of cases) {
    it(`withholds the P in "${src}"`, () => {
      withheld(hr(src), src)
      // Truncated before the qualifier: the full corpus is still read.
      withheld(hr(src, src.slice(0, src.indexOf('0.02') + 4)), src)
      // Unclaimed P: the tuple still verifies exactly as before.
      expect(verify(hr(src, src, null), src, OPTS).tier).toBe(TIERS.ESTIMATE)
    })
  }
  it('comparison form: a qualifier after the closing bracket withholds the P', () => {
    const cmp = (src, p = 0.03) => ({ name: 'mortality', quantity_type: 'comparison', value: null, range_low: null, range_high: null, first_label: null, second_label: null, first_value: 36, second_value: 26, unit: '%', ci_low: null, ci_high: null, p_value: p, source_quote: src.slice(src.indexOf('36'), src.indexOf('0.03') + 4), location_hint: null })
    for (const src of ['Mortality differed (36% vs. 26%, P = 0.03) for trend.', 'Mortality differed (36% vs. 26%, P = 0.03) (Table 2; P for interaction).']) {
      expect(verify(cmp(src), src, OPTS).relationshipValidated, src).toBe(false)
      expect(verify(cmp(src, null), src, OPTS).tier, src).toBe(TIERS.COMPARISON)
    }
    const ok = 'Mortality differed (36% vs. 26%, P = 0.03) (Table 2).'
    expect(verify(cmp(ok), ok, OPTS).tier).toBe(TIERS.COMPARISON)
  })
  it('real references and population qualifiers are preserved', () => {
    for (const src of [
      'Death fell (HR 0.78 [95% CI 0.70-0.86]; P = 0.02) (Table 2, and Fig. 1 in the Supplementary Appendix).',
      'Death fell (HR 0.78 [95% CI 0.70-0.86]; P = 0.02) (Table 2) for patients over 70.',
      'Death fell (HR 0.78 [95% CI 0.70-0.86]; P = 0.02) [12], as expected.',
    ]) expect(verify(hr(src), src, OPTS).tier, src).toBe(TIERS.ESTIMATE)
  })
})
