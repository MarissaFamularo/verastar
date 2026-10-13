// Card 4 — Cochrane cilostazol (PMID 34192807), abstract only. Reference §Card 4.
// The walking-distance mean difference is part of the INTENDED output: the verifier must check
// treatment/comparator, outcome, units, estimate, interval and contributing sample.
import { devsetSource, claim, ci } from './load.js'
import { PROFILE, REASONS as R } from '../schema.js'

const source = () => devsetSource('PAD-05')

const Q = {
  included: 'We included 16 double-blind, RCTs (3972 participants) comparing cilostazol with placebo, of which five studies also compared cilostazol with pentoxifylline. Treatment duration ranged from six to 26 weeks.',
  primaries: 'Primary outcomes were initial claudication distance (ICD) and quality of life (QoL).',
  icd: 'Participants taking cilostazol had a higher ICD compared with those taking placebo (MD 26.49 metres; 95% CI 18.93 to 34.05; 1722 participants; six studies; low-certainty evidence).',
  qol: 'We reported QoL measures descriptively due to insufficient statistical detail within the studies to combine the results; there was a possible indication in improvement of QoL in the cilostazol treatment groups (low-certainty evidence).',
  acd: 'Participants taking cilostazol had a higher ACD compared with those taking placebo (39.57 metres; 95% CI 21.80 to 57.33; 2360 participants; eight studies; very-low certainty evidence).',
  headache: 'Participants taking cilostazol had an increased odds of experiencing headache compared to participants taking placebo (OR 2.83; 95% CI 2.26 to 3.55; 2584 participants; eight studies; moderate-certainty evidence).',
  serious: 'Very few studies reported on other outcomes so conclusions on revascularisation, amputation, or cardiovascular events could not be made.',
  pentox: 'There was no difference detected between cilostazol and pentoxifylline for improving walking distance, both in terms of ICD (MD 20.0 metres, 95% CI -2.57 to 42.57; 417 participants; one study; low-certainty evidence); and ACD (MD 13.4 metres, 95% CI -43.50 to 70.36; 866 participants; two studies; very low-certainty evidence).',
  pubbias: 'The certainty of the evidence was downgraded by one level for all studies because publication bias was strongly suspected.',
}

const included = claim({ id: 'included', kind: 'design', role: 'design', population: 'stable intermittent claudication; 16 double-blind RCTs, 3,972 participants, 6–26 weeks', evidence: { quote: Q.included } })
const primaries = claim({ id: 'primaries', kind: 'outcome-definition', role: 'primary', outcome: 'initial claudication distance; quality of life', evidence: { quote: Q.primaries } })
const icd = claim({
  id: 'icd', kind: 'effect', role: 'primary',
  population: 'intermittent claudication (pooled RCTs)', comparator: { a: 'cilostazol', b: 'placebo' },
  outcome: 'initial claudication distance', timepoint: null, direction: 'favors-a', language: 'causal',
  estimate: { measure: 'MD', value: 26.49, interval: ci(18.93, 34.05), p: null, unit: 'metres', sample: { studies: 6, participants: 1722 } },
  evidence: { quote: Q.icd }, text: 'low-certainty evidence',
})
const qol = claim({ id: 'qol', kind: 'absence', role: 'primary', outcome: 'quality of life', text: 'could not be pooled', evidence: { quote: Q.qol } })
const headache = claim({
  id: 'headache', kind: 'effect', role: 'safety', population: 'pooled RCTs', comparator: { a: 'cilostazol', b: 'placebo' },
  outcome: 'headache', direction: 'favors-b', language: 'causal',
  estimate: { measure: 'OR', value: 2.83, interval: ci(2.26, 3.55), p: null, unit: null, sample: { studies: 8, participants: 2584 } },
  evidence: { quote: Q.headache }, text: 'moderate certainty',
})
const serious = claim({ id: 'serious', kind: 'absence', role: 'secondary', outcome: 'revascularisation, amputation, cardiovascular events', evidence: { quote: Q.serious } })
const pentox = claim({ id: 'pentox', kind: 'no-clear-difference', role: 'secondary', comparator: { a: 'cilostazol', b: 'pentoxifylline' }, outcome: 'walking distance (ICD, ACD)', direction: 'no-clear-difference', estimate: null, evidence: { quote: Q.pentox }, text: 'one study (ICD) and two (ACD)' })
const pubbias = claim({ id: 'pubbias', kind: 'certainty', role: 'design', evidence: { quote: Q.pubbias } })
const acdWithContext = claim({
  id: 'acd-ctx', kind: 'effect', role: 'secondary', population: 'pooled RCTs', comparator: { a: 'cilostazol', b: 'placebo' },
  outcome: 'absolute claudication distance', direction: 'favors-a', language: 'causal',
  estimate: { measure: 'MD', value: 39.57, interval: ci(21.8, 57.33), p: null, unit: 'metres', sample: { studies: 8, participants: 2360 } },
  evidence: { quote: Q.acd }, text: 'very-low certainty; secondary to the 26 m initial-distance primary',
})

export default {
  id: 'C4-CILOSTAZOL',
  title: 'Review: Cochrane cilostazol for intermittent claudication',
  source,
  profile: PROFILE,

  supported: [
    { claim: included, expect: 'pass-qualitative' },
    { claim: primaries, expect: 'pass-qualitative' },
    { claim: icd, expect: 'pass', bound: ['comparator', 'outcome', 'direction', 'value', 'interval', 'unit', 'sample'] },
    { claim: qol, expect: 'pass-qualitative' },
    { claim: headache, expect: 'pass', bound: ['comparator', 'outcome', 'direction', 'value', 'interval', 'sample'] },
    { claim: serious, expect: 'pass-qualitative' },
    { claim: pentox, expect: 'pass-qualitative' },
    { claim: pubbias, expect: 'pass-qualitative' },
    { claim: acdWithContext, expect: 'pass', bound: ['comparator', 'outcome', 'value', 'interval', 'unit', 'sample'] },
  ],

  misleading: [
    {
      name: 'sample over-attributed: 26 m from "16 trials, 3,972"',
      check: 'claim-support',
      claim: claim({ ...icd, id: 'm-sample', estimate: { ...icd.estimate, sample: { studies: 16, participants: 3972 } } }),
      expect: 'fail', reasons: [R.SAMPLE_MISMATCH],
    },
    {
      name: '"improves walking distance and quality of life"',
      check: 'claim-support',
      claim: claim({ ...icd, id: 'm1', outcome: 'quality of life', estimate: null, evidence: { quote: Q.qol } }),
      expect: 'fail', reasons: [R.DIRECTION_UNSUPPORTED],
    },
    {
      name: 'pentoxifylline "no difference" generalized beyond walking distance',
      check: 'claim-support',
      claim: claim({ ...pentox, id: 'm-pentox', outcome: 'efficacy and safety' }),
      expect: 'fail', reasons: [R.OUTCOME_UNBOUND],
    },
    {
      name: '"safe and effective"',
      check: 'claim-support',
      claim: claim({ id: 'm3', kind: 'author-statement', role: 'secondary', outcome: 'serious events (safety)', text: 'safe', evidence: { quote: Q.serious } }),
      expect: 'fail', reasons: [R.DIRECTION_UNSUPPORTED],
    },
  ],

  fidelity: [
    { name: 'primary walking distance first; QoL gap stated; headache labeled safety', card: [included, primaries, icd, qol, headache, serious, pentox, pubbias], expect: 'pass' },
    { name: 'secondary ACD stated with outcome, certainty and relation to primary', card: [included, primaries, icd, acdWithContext, qol, headache, pubbias], expect: 'pass' },
    {
      name: 'ACD as the walking-distance result without context',
      card: [included, primaries, claim({ ...acdWithContext, id: 'acd-bare', outcome: 'walking distance', text: undefined }), headache, pubbias],
      expect: 'fail', reasons: [R.SECONDARY_WITHOUT_CONTEXT, R.PRIMARY_MISSING],
    },
    { name: 'headache-led card (legacy failure), primary absent', card: [included, headache, pubbias], expect: 'fail', reasons: [R.PRIMARY_MISSING] },
  ],

  personal: [
    { personal: { id: 'p-upstream', items: ['NS1'], connection: 'topic', text: 'claudication sits upstream of CLTI limb preservation' }, expect: 'fail', reasons: [R.NO_SUPPORTING_ITEM] },
  ],

  // No personal line is the expected output; the card must still render and must not be marked down for it.
  noPersonalLine: { expectShown: true },
}
