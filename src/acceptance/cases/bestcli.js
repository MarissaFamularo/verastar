// Card 1 — BEST-CLI (PMID 36342173), abstract only. Reference: docs/CARD_ACCEPTANCE_REFERENCE.md §Card 1.
import { devsetSource, claim, ci } from './load.js'
import { PROFILE, PROFILE_STORED_ONLY, REASONS as R } from '../schema.js'

const source = () => devsetSource('PAD-10')

const Q = {
  enroll: 'we enrolled 1830 patients with CLTI and infrainguinal peripheral artery disease in two parallel-cohort trials. Patients who had a single segment of great saphenous vein that could be used for surgery were assigned to cohort 1. Patients who needed an alternative bypass conduit were assigned to cohort 2.',
  primaryDef: 'The primary outcome was a composite of a major adverse limb event - which was defined as amputation above the ankle or a major limb reintervention (a new bypass graft or graft revision, thrombectomy, or thrombolysis) - or death from any cause.',
  cohort1: 'In cohort 1, after a median follow-up of 2.7 years, a primary-outcome event occurred in 302 of 709 patients (42.6%) in the surgical group and in 408 of 711 patients (57.4%) in the endovascular group (hazard ratio, 0.68; 95% confidence interval [CI], 0.59 to 0.79; P<0.001).',
  cohort2: 'In cohort 2, a primary-outcome event occurred in 83 of 194 patients (42.8%) in the surgical group and in 95 of 199 patients (47.7%) in the endovascular group (hazard ratio, 0.79; 95% CI, 0.58 to 1.06; P = 0.12) after a median follow-up of 1.6 years.',
}

const enrollment = claim({ id: 'design', kind: 'design', role: 'design', population: 'CLTI with infrainguinal peripheral artery disease', evidence: { quote: Q.enroll }, text: 'International randomized trial, 1,830 patients, two parallel cohorts by conduit availability.' })
const composite = claim({ id: 'primary-def', kind: 'outcome-definition', role: 'primary', outcome: 'MALE (amputation above the ankle or major limb reintervention) or death from any cause', evidence: { quote: Q.primaryDef } })
const cohort1 = claim({
  id: 'cohort1', kind: 'effect', role: 'co-primary',
  population: 'cohort 1: CLTI with a usable single segment of great saphenous vein',
  comparator: { a: 'surgical (initial bypass)', b: 'endovascular' },
  outcome: 'primary composite: MALE or death', timepoint: 'median 2.7 years',
  direction: 'favors-a', language: 'causal',
  estimate: { measure: 'HR', value: 0.68, interval: ci(0.59, 0.79), p: null, unit: null, sample: null },
  evidence: { quote: Q.cohort1 },
})
const cohort2 = claim({
  id: 'cohort2', kind: 'no-clear-difference', role: 'co-primary',
  population: 'cohort 2: CLTI needing an alternative conduit',
  comparator: { a: 'surgical', b: 'endovascular' },
  outcome: 'primary composite: MALE or death', timepoint: 'median 1.6 years',
  direction: 'no-clear-difference', language: 'none',
  estimate: { measure: 'HR', value: 0.79, interval: ci(0.58, 1.06), p: null, unit: null, sample: null },
  evidence: { quote: Q.cohort2 },
})
const notSeparated = claim({ id: 'components-not-separated', kind: 'absence', role: 'design', basis: 'design', outcome: 'component outcomes (amputation, reintervention, death) separately', text: 'The abstract does not separate the composite components.' })

export default {
  id: 'C1-BESTCLI',
  title: 'Positive randomized trial: BEST-CLI',
  source,
  profile: PROFILE,

  supported: [
    { claim: enrollment, expect: 'pass-qualitative' },
    { claim: composite, expect: 'pass-qualitative' },
    { claim: cohort1, expect: 'pass', bound: ['population', 'comparator', 'outcome', 'timepoint', 'direction', 'value', 'interval'] },
    { claim: cohort2, expect: 'pass', bound: ['population', 'comparator', 'outcome', 'timepoint', 'direction', 'value', 'interval'] },
    { claim: notSeparated, expect: 'pass-qualitative' },
  ],

  misleading: [
    {
      name: 'population dropped: "bypass is superior for CLTI"',
      check: 'claim-support',
      claim: claim({ ...cohort1, id: 'm1', population: 'CLTI', timepoint: null, estimate: null, evidence: { quote: Q.cohort1 } }),
      expect: 'fail', reasons: [R.POPULATION_OVERGENERALIZED],
    },
    {
      name: 'outcome substituted: "cut the amputation rate by a third"',
      check: 'claim-support',
      claim: claim({ ...cohort1, id: 'm2', outcome: 'major amputation', estimate: null, evidence: { quote: Q.cohort1 } }),
      expect: 'fail', reasons: [R.OUTCOME_SUBSTITUTED, R.OUTCOME_UNBOUND],
    },
    {
      name: 'null read as equivalence in cohort 2',
      check: 'claim-support',
      claim: claim({ ...cohort2, id: 'm3', direction: 'equivalent', estimate: null }),
      expect: 'fail', reasons: [R.EQUIVALENCE_NOT_TESTED],
    },
  ],

  fidelity: [
    { name: 'both co-primary cohorts present, definition present', card: [enrollment, composite, cohort1, cohort2, notSeparated], expect: 'pass' },
    { name: 'cohort 2 omitted', card: [enrollment, composite, cohort1], expect: 'fail', reasons: [R.PRIMARY_MISSING] },
  ],

  personal: [
    { personal: { id: 'p-ns1', items: ['NS1'], connection: 'topic', text: 'on your CLTI limb preservation north star' }, expect: 'pass' },
    { personal: { id: 'p-f1', items: ['F1', 'NS1'], connection: 'population', text: 'in the population a limb preservation program treats' }, expect: 'pass' },
    { personal: { id: 'p-practice', items: ['NS1'], connection: 'practice', text: 'the first-revascularization choice your program makes' }, profile: PROFILE_STORED_ONLY, expect: 'fail', reasons: [R.PRACTICE_CLAIM_WITHOUT_FACT] },
  ],

  // Omitted factual assertions: every inventory entry with no claim on the card is listed in
  // fidelity.omitted with its role, how the role was established, and whether it blocks.
  omissions: [
    { name: 'cohort 2 omitted → listed as a blocking co-primary omission', card: [enrollment, composite, cohort1], fidelity: 'fail', omitted: { roleIn: ['co-primary', 'primary'], severity: 'blocking' } },
    { name: 'adverse-events sentence omitted → listed, noted, not blocking', card: [enrollment, composite, cohort1, cohort2, notSeparated], fidelity: 'pass', omitted: { describes: 'adverse events', severity: 'noted' } },
    { name: 'declared safety omission is recorded as declared', card: [enrollment, composite, cohort1, cohort2, notSeparated], declared: [{ describes: 'adverse events similar in the two groups in the two cohorts', reason: 'safety-not-shown' }], fidelity: 'pass', omitted: { describes: 'adverse events', severity: 'noted' } },
  ],
  fidelityFallback: { card: [enrollment, composite, cohort1] },

  recommendation: {
    // E1 strengthens the recommendation; without it the abstract carries the headline.
    withEditorial: { profile: PROFILE, expect: 'full' },
    withoutEditorial: { profile: PROFILE_STORED_ONLY, expectNot: 'full-because-landmark' },
  },
}
