// Card 3 — RAO after CEA vs CAS (PMID 42854197), abstract only. Development example. Reference §Card 3.
import { liveSource, claim, ci } from './load.js'
import { PROFILE, REASONS as R } from '../schema.js'

const source = () => liveSource('42854197')

const Q = {
  design: 'Retrospective multicenter cohort study using the TriNetX Research Network (January 1, 2004-March 15, 2026).',
  matched: 'yielded 17,851 patients per cohort. The primary outcome was the incidence of RAO at 90 days and 1 year after the index procedure.',
  rao: 'At 1 year, CAS was associated with higher risks of RAO (0.421% vs 0.257%; OR 1.64; 95% CI, 1.12-2.41)',
  secondary: 'CAS also conferred higher odds of stroke (6.20% vs 4.43%; OR 1.42; 1.25-1.62) and mortality (6.41% vs 3.87%; OR 1.70; 1.54-1.88).',
  timing: 'Most events occurred within 72 hours post-procedure.',
  hedge: 'In this retrospective propensity-matched analysis, CAS was associated with greater risk of retinal and neurologic ischemic complications than CEA, although absolute event rates were low.',
}

const design = claim({ id: 'design', kind: 'design', role: 'design', population: 'adults undergoing CEA or CAS, propensity-matched, 17,851 per group', evidence: { quote: Q.design } })
const primaryDef = claim({ id: 'primary-def', kind: 'outcome-definition', role: 'primary', outcome: 'incidence of RAO', timepoint: '90 days and 1 year', evidence: { quote: Q.matched } })
const rao = claim({
  id: 'rao', kind: 'effect', role: 'primary',
  population: 'matched CEA and CAS cohorts', comparator: { a: 'CAS', b: 'CEA' },
  outcome: 'retinal artery occlusion', timepoint: '1 year', direction: 'favors-b', language: 'associational',
  estimate: { measure: 'OR', value: 1.64, interval: ci(1.12, 2.41), p: null, unit: null, sample: null },
  evidence: { quote: Q.rao },
})
const secondary = claim({ id: 'secondary', kind: 'effect', role: 'secondary', population: 'matched CEA and CAS cohorts', comparator: { a: 'CAS', b: 'CEA' }, outcome: 'stroke; mortality', timepoint: '1 year', direction: 'favors-b', language: 'associational', estimate: null, evidence: { quote: Q.secondary } })
const timing = claim({ id: 'timing', kind: 'author-statement', role: 'design', evidence: { quote: Q.timing } })
const confounding = claim({ id: 'confounding', kind: 'limitation', role: 'design', basis: 'design', text: 'procedure choice was not random; residual confounding remains possible despite matching' })

export default {
  id: 'C3-RAO',
  title: 'Observational study: RAO after CEA vs CAS (development example)',
  source,
  profile: PROFILE,

  supported: [
    { claim: design, expect: 'pass-qualitative' },
    { claim: primaryDef, expect: 'pass-qualitative' },
    { claim: rao, expect: 'pass', bound: ['population', 'comparator', 'outcome', 'timepoint', 'direction', 'value', 'interval', 'language'] },
    { claim: secondary, expect: 'pass-qualitative' },
    { claim: timing, expect: 'pass-qualitative' },
    { claim: confounding, expect: 'pass-qualitative' },
  ],

  misleading: [
    {
      name: 'causal verb on a matched cohort: "stenting causes RAO"',
      check: 'claim-support',
      claim: claim({ ...rao, id: 'm1', language: 'causal', estimate: null }),
      expect: 'fail', reasons: [R.CAUSAL_LANGUAGE_NONRANDOMIZED],
    },
    {
      name: 'OR reported as relative risk: "70% higher mortality"',
      check: 'claim-support',
      claim: claim({ ...secondary, id: 'm2', outcome: 'mortality', estimate: { measure: 'RR', value: 1.70, interval: ci(1.54, 1.88), p: null, unit: null, sample: null } }),
      expect: 'fail', reasons: [R.MEASURE_MISMATCH],
    },
    {
      name: '"RAO is a common complication" (magnitude)',
      check: 'claim-support',
      claim: claim({ id: 'm3', kind: 'rate', role: 'primary', population: 'CAS cohort', outcome: 'RAO', timepoint: '1 year', text: 'common', estimate: { measure: 'percent', value: 4.21, interval: null, p: null, unit: '%', sample: null }, evidence: { quote: Q.rao } }),
      expect: 'fail', reasons: [R.VALUE_MISMATCH],
    },
  ],

  fidelity: [
    { name: 'primary first, secondaries labeled, limitation present', card: [design, primaryDef, rao, timing, secondary, confounding], expect: 'pass' },
    { name: 'mortality headlined, RAO primary absent', card: [design, secondary, confounding], expect: 'fail', reasons: [R.PRIMARY_MISSING] },
  ],

  personal: [
    { personal: { id: 'p-ns3', items: ['NS3'], connection: 'topic', text: 'carotid stenosis management is a north star' }, expect: 'pass' },
    { personal: { id: 'p-p4', items: ['P4'], connection: 'topic', text: 'feeds your stroke-prediction project' }, expect: 'fail', reasons: [R.CONNECTION_TYPE_UNSUPPORTED], note: 'the stroke result is secondary and confounded; the reference card deliberately does not cite P4' },
  ],
}
