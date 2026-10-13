// Card 6 — BASIL-2 (PMID 37116524), abstract only. Reference §Card 6.
// Three conditions on one paper:
//   normal  — full abstract, working verifier: the primary HR prints.
//   state A — explicit verification failure: qualitative conclusion passes, estimate does not.
//             Exercised two ways: (A1) a genuine value mismatch; (A2) the harness option
//             simulateEstimateFailure, with the source untouched.
//   state B — evidence-availability failure: genuinely restricted input (text before FINDINGS).
import { devsetSource, methodsOnly, claim, ci } from './load.js'
import { PROFILE, REASONS as R } from '../schema.js'

const full = () => devsetSource('PAD-12')
const restricted = () => methodsOnly(devsetSource('PAD-12'))

const Q = {
  design: 'Bypass versus Angioplasty for Severe Ischaemia of the Leg (BASIL)-2 was an open-label, pragmatic, multicentre, phase 3, randomised trial done at 41 vascular surgery units in the UK (n=39), Sweden (n=1), and Denmark (n=1).',
  followup: 'Participants were followed up for a minimum of 2 years.',
  population: 'patients with chronic limb threatening ischaemia who required an infra-popliteal, with or without an additional more proximal infra-inguinal, revascularisation procedure to restore limb perfusion',
  primaryDef: 'The primary outcome was amputation-free survival defined as time to first major (above the ankle) amputation or death from any cause measured in the intention-to-treat population.',
  enrolled: '345 participants (65 [19%] women and 280 [81%] men; median age 72·5 years [62·7-79·3]) with chronic limb-threatening ischaemia were enrolled in the trial and randomly assigned',
  primary: 'Major amputation or death occurred in 108 (63%) of 172 patients in the vein bypass group and 92 (53%) of 173 patients in the best endovascular treatment group (adjusted hazard ratio [HR] 1·35 [95% CI 1·02-1·80]; p=0·037).',
  death: '91 (53%) of 172 patients in the vein bypass group and 77 (45%) of 173 patients in the best endovascular treatment group died (adjusted HR 1·37 [95% CI 1·00-1·87]).',
  interpretation: 'a best endovascular treatment first revascularisation strategy was associated with a better amputation-free survival, which was largely driven by fewer deaths in the best endovascular treatment group.',
}

const design = claim({ id: 'design', kind: 'design', role: 'design', population: 'CLTI requiring infra-popliteal revascularisation', evidence: { quote: Q.design } })
const followup = claim({ id: 'followup', kind: 'design', role: 'design', timepoint: 'minimum 2 years', evidence: { quote: Q.followup } })
const population = claim({ id: 'population', kind: 'population', role: 'design', population: 'CLTI requiring infra-popliteal (± more proximal infra-inguinal) revascularisation', evidence: { quote: Q.population } })
const primaryDef = claim({ id: 'primary-def', kind: 'outcome-definition', role: 'primary', outcome: 'amputation-free survival (major amputation or death), intention-to-treat', evidence: { quote: Q.primaryDef } })
const enrolled = claim({ id: 'enrolled', kind: 'count', role: 'design', estimate: { measure: 'count', value: 345, interval: null, p: null, unit: 'participants', sample: null }, evidence: { quote: Q.enrolled } })
const primary = claim({
  id: 'primary', kind: 'effect', role: 'primary',
  population: 'CLTI requiring infra-popliteal revascularisation', comparator: { a: 'vein bypass first', b: 'best endovascular treatment first' },
  outcome: 'amputation-free survival (major amputation or death)', timepoint: null, direction: 'favors-b', language: 'causal',
  estimate: { measure: 'aHR', value: 1.35, interval: ci(1.02, 1.8), p: 0.037, unit: null, sample: null },
  evidence: { quote: Q.primary },
})
const primaryQualitative = claim({ ...primary, id: 'primary-qual', estimate: null, attribution: 'authors', evidence: { quote: Q.interpretation }, text: 'authors attribute the difference largely to fewer deaths' })
const death = claim({
  id: 'death', kind: 'effect', role: 'component',
  population: 'CLTI requiring infra-popliteal revascularisation', comparator: { a: 'vein bypass first', b: 'best endovascular treatment first' },
  outcome: 'all-cause death', direction: 'favors-b', language: 'associational',
  estimate: { measure: 'aHR', value: 1.37, interval: ci(1.0, 1.87), p: null, unit: null, sample: null },
  evidence: { quote: Q.death },
})
const openLabel = claim({ id: 'open-label', kind: 'limitation', role: 'design', evidence: { quote: Q.design }, text: 'open-label' })

const fullCard = [design, followup, population, primaryDef, enrolled, primary, death, openLabel]

export default {
  id: 'C6-BASIL2',
  title: 'BASIL-2: normal, verification failure (state A), availability failure (state B)',
  source: full,
  profile: PROFILE,

  // Normal: with the full abstract and a working verifier, the primary estimate prints.
  supported: [
    { claim: design, expect: 'pass-qualitative' },
    { claim: population, expect: 'pass-qualitative' },
    { claim: primaryDef, expect: 'pass-qualitative' },
    { claim: enrolled, expect: 'pass', bound: ['value'] },
    { claim: primary, expect: 'pass', bound: ['population', 'comparator', 'outcome', 'direction', 'value', 'interval', 'p'] },
    { claim: primaryQualitative, expect: 'pass-qualitative' },
    { claim: death, expect: 'pass', bound: ['comparator', 'outcome', 'direction', 'value', 'interval'] },
  ],

  misleading: [
    {
      name: 'legacy take: death HR headlined as the finding (claim itself is supported; see fidelity)',
      check: 'claim-support',
      claim: death, expect: 'pass',
    },
    {
      name: '"endovascular-first is safer than bypass in CLTI"',
      check: 'claim-support',
      claim: claim({ ...primary, id: 'm2', population: 'CLTI', outcome: 'safety', estimate: null }),
      expect: 'fail', reasons: [R.POPULATION_OVERGENERALIZED, R.OUTCOME_UNBOUND],
    },
    {
      name: '"bypass increases mortality" (unqualified generalization)',
      check: 'claim-support',
      claim: claim({ ...death, id: 'm3', population: 'CLTI', comparator: { a: 'bypass', b: 'endovascular therapy' }, language: 'causal', estimate: null }),
      expect: 'fail', reasons: [R.POPULATION_OVERGENERALIZED, R.COMPARATOR_UNBOUND],
    },
    {
      name: 'supportable causal form: bypass-first worse AFS, infra-popliteal population, largely through deaths',
      check: 'claim-support',
      claim: claim({ ...primary, id: 'ok-causal', estimate: null, text: 'led to worse amputation-free survival … largely through deaths' }),
      expect: 'pass-qualitative',
    },
  ],

  fidelity: [
    { name: 'normal: primary first with estimate, death labeled component', card: fullCard, expect: 'pass' },
    { name: 'legacy take: death headlined, primary absent', card: [design, primaryDef, death, openLabel], expect: 'fail', reasons: [R.PRIMARY_MISSING, R.COMPONENT_AS_HEADLINE] },
  ],

  personal: [
    { personal: { id: 'p-ns1', items: ['NS1'], connection: 'topic', text: 'CLTI limb preservation; initial treatment strategy for below-knee disease' }, expect: 'pass' },
    { personal: { id: 'p-program', items: ['P1'], connection: 'practice', text: 'the question your program decides most often' }, expect: 'fail', reasons: [R.PRACTICE_CLAIM_WITHOUT_FACT] },
  ],

  // Scenario conditions, judged on the whole card.
  scenarios: {
    normal: {
      source: full, card: fullCard,
      expect: { state: 'full', mainResultShown: true, estimatesShown: ['primary', 'death', 'enrolled'], claimsShown: ['primary'] },
    },
    stateA_genuine: {
      // Value mismatch: the card claims 1.36 where the source prints 1·35.
      source: full,
      card: fullCard.map((c) => (c.id === 'primary' ? { ...c, estimate: { ...c.estimate, value: 1.36 } } : c)),
      expect: {
        state: 'reduced-estimate-withheld', mainResultShown: true,
        claim: { id: 'primary', status: 'withhold', reasons: [R.VALUE_MISMATCH] },
        estimatesNotShown: ['primary'], claimsShown: ['primary'],
      },
    },
    stateA_simulated: {
      source: full, card: fullCard, options: { simulateEstimateFailure: ['primary'] },
      expect: {
        state: 'reduced-estimate-withheld', mainResultShown: true,
        claim: { id: 'primary', status: 'withhold', reasons: [R.ESTIMATE_UNCHECKED] },
        estimatesNotShown: ['primary'], claimsShown: ['primary'],
      },
      // Publication rule: no render state exists in which a withheld estimate is printed under a badge.
      neverPrinted: ['primary'],
    },
    stateB: {
      source: restricted,
      card: [design, followup, population, primaryDef, enrolled, primary, primaryQualitative, death, openLabel],
      expect: {
        state: 'reduced-results-unavailable', mainResultShown: false,
        claims: {
          design: 'pass-qualitative', followup: 'pass-qualitative', population: 'pass-qualitative', 'primary-def': 'pass-qualitative', 'open-label': 'pass-qualitative',
          enrolled: 'excluded', primary: 'excluded', death: 'excluded',
          'primary-qual': 'excluded', // attribution does not substitute for a located sentence
        },
        reasons: { primary: [R.SECTION_UNAVAILABLE], 'primary-qual': [R.ATTRIBUTION_NOT_SUBSTITUTE, R.SECTION_UNAVAILABLE] },
        claimsShown: ['design', 'followup', 'population', 'primary-def', 'open-label'],
        claimsNotShown: ['enrolled', 'primary', 'death', 'primary-qual'],
      },
    },
  },
}
