// Card 5 — peroneal communicating-branch grade (PMID 42855019), abstract only. Development example.
// Reference §Card 5. This paper does NOT fill the diagnostic-validation category.
import { liveSource, claim, bracket } from './load.js'
import { PROFILE, REASONS as R } from '../schema.js'

const source = () => liveSource('42855019')

const Q = {
  design: 'All patients undergoing first-time revascularization for CLTI were retrospectively reviewed (2005-2022) and stratified by sole runoff vessel (AT, peroneal, PT).',
  primaries: 'Primary outcomes were wound healing, major amputation, major adverse limb events (MALE), and amputation/death',
  n: 'Overall, 732 patients had single-vessel below-knee runoff: 225 AT, 315 peroneal, and 192 PT. Groups differed significantly in age, sex, and diabetes prevalence.',
  peroneal: 'After adjustment, peroneal runoff was independently associated with higher risk of major amputation (HR 1.81 [1.04-3.13]) and MALE (HR 1.52 [1.03-2.25]) compared with AT/PT runoff.',
  grade: 'a three-tiered, Peroneal Communicating Branch (PCB) Grade: Both branches present with at least one robust (PCB Grade 1), a single robust branch (PCB Grade 2), or no robust branch (PCB Grade 3)',
  grade3: 'patients without any robust branch (PCB Grade 3) had significantly higher risk of major amputation (HR 3.21 [1.76-4.84]) and MALE (HR 2.41 [1.53-3.79])',
  bypass: 'but did not reach significance in the bypass cohort, which was limited by low event rates',
}

const design = claim({ id: 'design', kind: 'design', role: 'design', population: 'first-time CLTI revascularization, single-vessel runoff, 732 patients', evidence: { quote: Q.design } })
const primaries = claim({ id: 'primaries', kind: 'outcome-definition', role: 'primary', outcome: 'wound healing; major amputation; MALE; amputation/death', evidence: { quote: Q.primaries } })
const differed = claim({ id: 'differed', kind: 'limitation', role: 'design', evidence: { quote: Q.n }, text: 'groups differed in age, sex and diabetes' })
const peroneal = claim({
  id: 'peroneal', kind: 'effect', role: 'primary',
  population: 'single-vessel peroneal runoff', comparator: { a: 'peroneal runoff', b: 'AT/PT runoff' },
  outcome: 'major amputation', direction: 'favors-b', language: 'associational',
  estimate: { measure: 'HR', value: 1.81, interval: bracket(1.04, 3.13), p: null, unit: null, sample: null },
  evidence: { quote: Q.peroneal }, text: 'adjusted',
})
const gradeDef = claim({ id: 'grade-def', kind: 'design', role: 'design', text: 'three-tier PCB grade, defined and evaluated in this cohort', evidence: { quote: Q.grade } })
const grade3 = claim({
  id: 'grade3', kind: 'effect', role: 'subgroup',
  population: 'peroneal runoff with no robust communicating branch (PCB grade 3)', comparator: { a: 'PCB grade 3', b: 'AT/PT runoff' },
  outcome: 'major amputation', direction: 'favors-b', language: 'associational',
  estimate: { measure: 'HR', value: 3.21, interval: bracket(1.76, 4.84), p: null, unit: null, sample: null },
  evidence: { quote: Q.grade3 },
})
const noValidation = claim({ id: 'no-validation', kind: 'absence', role: 'design', basis: 'design', text: 'no separate validation is reported in the abstract' })

export default {
  id: 'C5-PCB',
  title: 'Observational paper proposing a classification (development example; not diagnostic-validation coverage)',
  source,
  profile: PROFILE,

  supported: [
    { claim: design, expect: 'pass-qualitative' },
    { claim: primaries, expect: 'pass-qualitative' },
    { claim: differed, expect: 'pass-qualitative' },
    { claim: peroneal, expect: 'pass', bound: ['comparator', 'outcome', 'direction', 'value', 'interval', 'language'] },
    { claim: gradeDef, expect: 'pass-qualitative' },
    { claim: grade3, expect: 'pass', bound: ['population', 'comparator', 'outcome', 'value', 'interval'] },
    { claim: noValidation, expect: 'pass-qualitative' },
  ],

  misleading: [
    {
      name: 'printed bracket shown as a 95% CI',
      check: 'claim-support',
      claim: claim({ ...peroneal, id: 'm-ci', estimate: { ...peroneal.estimate, interval: { low: 1.04, high: 3.13, label: '95% CI' } } }),
      expect: 'fail', reasons: [R.INTERVAL_LABEL_INVENTED],
    },
    {
      name: '"a validated grading system"',
      check: 'claim-support',
      claim: claim({ id: 'm1', kind: 'author-statement', role: 'design', text: 'validated grading system', evidence: { quote: Q.grade } }),
      expect: 'fail', reasons: [R.VALIDATION_NOT_REPORTED],
    },
    {
      name: '"nothing was validated" (absence over-scoped)',
      check: 'claim-support',
      claim: claim({ ...noValidation, id: 'm-abs', text: 'nothing was validated' }),
      expect: 'fail', reasons: [R.ABSENCE_OVERSCOPED],
    },
    {
      name: 'subgroup HR attributed to peroneal overall: "peroneal runoff triples amputation risk"',
      check: 'claim-support',
      claim: claim({ ...grade3, id: 'm2', population: 'single-vessel peroneal runoff', comparator: { a: 'peroneal runoff', b: 'AT/PT runoff' } }),
      expect: 'fail', reasons: [R.SUBGROUP_AS_WHOLE, R.POPULATION_OVERGENERALIZED],
    },
    {
      name: 'treatment recommendation from no treatment comparison',
      check: 'claim-support',
      claim: claim({ id: 'm3', kind: 'effect', role: 'secondary', population: 'single-vessel peroneal runoff', comparator: { a: 'bypass', b: 'endovascular' }, outcome: 'major amputation', direction: 'favors-a', language: 'causal', evidence: { quote: Q.bypass } }),
      expect: 'fail', reasons: [R.COMPARATOR_UNBOUND, R.DIRECTION_UNSUPPORTED],
    },
  ],

  fidelity: [
    { name: 'main association first, subgroup labeled, absence scoped', card: [design, primaries, differed, peroneal, gradeDef, grade3, noValidation], expect: 'pass' },
    { name: 'grade-3 subgroup as the headline, overall association absent', card: [design, gradeDef, grade3, noValidation], expect: 'fail', reasons: [R.PRIMARY_MISSING] },
  ],

  personal: [
    { personal: { id: 'p-ns1', items: ['NS1'], connection: 'topic', text: 'on your CLTI limb preservation north star' }, expect: 'pass' },
    { personal: { id: 'p-p5-candidate', items: ['P5'], connection: 'method', text: 'a candidate anatomic variable for limb-loss prediction if it holds up elsewhere' }, expect: 'pass' },
    { personal: { id: 'p-p5-direct', items: ['P5'], connection: 'project-aim', text: 'directly relevant to your limb-loss prediction model' }, expect: 'fail', reasons: [R.PROJECT_AIM_ASSERTED] },
  ],
}
