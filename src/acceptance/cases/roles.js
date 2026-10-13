// Outcome-role and evidence-linkage uncertainty, made explicit.
//
// A: a REAL source that declares no primary outcome (PMID 42855613, apixaban vs rivaroxaban
//    meta-analysis; 2026-10-12 digest fixture; development example). The inventory must say
//    primaryBasis 'none'; a claim asserting role 'primary' is role-unverified; role 'reported'
//    passes; the word "primary" may not appear in prose.
// B: CREST-2 full text — the risk-difference sentence does not name its outcome; the link to
//    the primary rests on the preceding sentence in the same paragraph. The result must record
//    linkage 'adjacent-sentence', and the binding must still succeed only because that
//    adjacency is explicit (same paragraph, no intervening result sentence).
// C: positional classification is never promoted: when the source names no primary, the first
//    reported result must not be labeled primary by position in the inventory.
import { devsetSource, liveSource, claim, ci } from './load.js'
import { REASONS as R } from '../schema.js'

const apix = () => liveSource('42855613')
const Q = {
  outcomes: 'Outcomes, including recurrent VTE, major bleeding, all-cause mortality, and net clinical harm, were pooled using a random-effects model.',
  vte: 'Apixaban was associated with a significantly lower risk of recurrent VTE compared to rivaroxaban (RR 0.85; 95% CI 0.74-0.98), with moderate heterogeneity.',
  bleeding: 'Apixaban was also associated with a significant 28% reduction in major bleeding risk (RR 0.72; 95% CI 0.65-0.81), with low heterogeneity',
  mortality: 'no statistically significant difference was observed in all-cause mortality (RR 0.95; 95% CI 0.80-1.12), with substantial heterogeneity across studies.',
  design: 'Thirteen studies comprising more than 220,000 patients were included.',
  crestRD: 'The absolute risk difference was 3.2 percentage points (95% CI, 0.6 to 5.9; P=0.02)',
}

const vteAsPrimary = claim({ id: 'vte-primary', kind: 'effect', role: 'primary', comparator: { a: 'apixaban', b: 'rivaroxaban' }, outcome: 'recurrent VTE', direction: 'favors-a', language: 'associational', estimate: { measure: 'RR', value: 0.85, interval: ci(0.74, 0.98), p: null, unit: null, sample: null }, evidence: { quote: Q.vte } })
const vteReported = claim({ ...vteAsPrimary, id: 'vte-reported', role: 'reported' })
const bleedingReported = claim({ id: 'bleeding', kind: 'effect', role: 'reported', comparator: { a: 'apixaban', b: 'rivaroxaban' }, outcome: 'major bleeding', direction: 'favors-a', language: 'associational', estimate: { measure: 'RR', value: 0.72, interval: ci(0.65, 0.81), p: null, unit: null, sample: null }, evidence: { quote: Q.bleeding } })
const mortalityReported = claim({ id: 'mortality', kind: 'no-clear-difference', role: 'reported', comparator: { a: 'apixaban', b: 'rivaroxaban' }, outcome: 'all-cause mortality', direction: 'no-clear-difference', estimate: { measure: 'RR', value: 0.95, interval: ci(0.8, 1.12), p: null, unit: null, sample: null }, evidence: { quote: Q.mortality } })
const outcomesListed = claim({ id: 'outcomes', kind: 'outcome-definition', role: 'reported', outcome: 'recurrent VTE; major bleeding; all-cause mortality; net clinical harm', evidence: { quote: Q.outcomes } })
const design = claim({ id: 'design', kind: 'design', role: 'design', population: 'adult VTE patients; 13 studies, >220,000 patients; predominantly observational', evidence: { quote: Q.design } })

export default {
  id: 'ROLES-LINKAGE',
  title: 'Outcome-role and linkage uncertainty',

  noDeclaredPrimary: {
    source: apix,
    claims: {
      asPrimary: { claim: vteAsPrimary, eligibility: 'pass-qualitative', elements: { role: 'positional-only' }, reasons: [R.ROLE_UNVERIFIED], estimateShown: false },
      asReported: { claim: vteReported, eligibility: 'pass', elements: { role: 'not-asserted' } },
    },
    card: [design, outcomesListed, vteReported, bleedingReported, mortalityReported],
    fidelity: { status: 'pass', primaryBasis: 'none', uncertain: true, reasons: [R.NO_DECLARED_PRIMARY] },
    // Positional promotion is forbidden: no inventory entry may carry role 'primary' here.
    inventoryMustNotContainRole: ['primary', 'co-primary'],
    // The whole-card check still applies: a card showing only the favorable results and
    // omitting the null mortality result is a fidelity failure even without a declared primary.
    partialCard: { card: [design, outcomesListed, vteReported, bleedingReported], expect: 'fail', reasons: [R.NULL_PRIMARY_OBSCURED, R.SECONDARY_WITHOUT_CONTEXT], omittedMustInclude: 'all-cause mortality' },
  },

  adjacentLinkage: {
    source: () => devsetSource('CAR-07'),
    claim: claim({ id: 'rd-only', kind: 'effect', role: 'primary', population: 'stenting trial', comparator: { a: 'stenting + IMM', b: 'IMM alone' }, outcome: 'primary composite', timepoint: '4 years', direction: 'favors-a', estimate: { measure: 'RD', value: 3.2, interval: ci(0.6, 5.9), p: 0.02, unit: 'percentage points', sample: null }, evidence: { quote: Q.crestRD } }),
    expect: { eligibility: 'pass', linkage: 'adjacent-sentence', elements: { outcome: 'bound', population: 'bound' } },
  },
}
