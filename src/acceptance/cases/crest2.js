// Card 2 — CREST-2 (PMID 41269206), full text. Reference §Card 2. Two trials in one paper.
import { devsetSource, claim, ci } from './load.js'
import { PROFILE, REASONS as R } from '../schema.js'

const source = () => devsetSource('CAR-07')

const Q = {
  design: 'We conducted CREST-2, which comprised two parallel, observer-blinded trials: a stenting trial, in which patients were randomly assigned to receive either intensive medical management alone (medical-therapy group) or carotid-artery stenting plus intensive medical management (stenting group); and an endarterectomy trial, in which patients were randomly assigned to receive either intensive medical management alone (medical-therapy group) or endarterectomy plus intensive medical management (endarterectomy group).',
  primaryDef: 'The primary outcome was a 4-year composite of any stroke (ischemic or hemorrhagic) or death, assessed from randomization to 44 days (periprocedural period), or ipsilateral ischemic stroke, assessed during the remaining follow-up period up to 4 years (postprocedural period).',
  stent: 'In the stenting trial, the 4-year rate of the composite primary outcome was 6.0% (95% confidence interval [CI], 3.8 to 8.3) in the medical therapy group and 2.8% (95% CI, 1.5 to 4.3) in the stenting group. The absolute risk difference was 3.2 percentage points (95% CI, 0.6 to 5.9; P=0.02)',
  cea: 'In the endarterectomy trial, the 4-year rate of the primary outcome was 5.3% (95% CI, 3.3 to 7.4) in the medical-therapy group and 3.7% (95% CI, 2.1 to 5.5) in the endarterectomy group. The absolute risk difference was 1.6 percentage points (95% CI, −1.1 to 4.3; P=0.24)',
  ceaPost: 'in the endarterectomy group, 10 ischemic strokes occurred among 596 patients followed for 1823 person-years, for an annual event rate of 0.5% (95% CI, 0.3 to 1.0), with a relative risk of 2.38 (95% CI, 1.13 to 5.00)',
  similar: 'The event rate among patients who had been assigned to a revascularization group appeared to be similar in the two trials',
  limits: 'First, although stroke adjudicators were unaware of the treatment assignments, patients and treating physicians were not. Second, various changes in medical-therapy practices occurred during the trials that could lower stroke rates',
  tipping: 'A tipping-point analysis in the endarterectomy trial suggested that significance would have been achieved if seven or more events were removed from the endarterectomy group or if six or more events were added to the medical-therapy group.',
}

const design = claim({ id: 'design', kind: 'design', role: 'design', population: 'asymptomatic high-grade (≥70%) carotid stenosis', evidence: { quote: Q.design } })
const primaryDef = claim({ id: 'primary-def', kind: 'outcome-definition', role: 'primary', outcome: 'stroke or death through day 44, then ipsilateral ischemic stroke to 4 years', timepoint: '4 years', evidence: { quote: Q.primaryDef } })
const stent = claim({
  id: 'stent-primary', kind: 'effect', role: 'primary',
  population: 'stenting trial', comparator: { a: 'stenting + IMM', b: 'IMM alone' },
  outcome: 'primary composite', timepoint: '4 years', direction: 'favors-a', language: 'causal',
  estimate: { measure: 'RD', value: 3.2, interval: ci(0.6, 5.9), p: 0.02, unit: 'percentage points', sample: null },
  evidence: { quote: Q.stent },
})
const cea = claim({
  id: 'cea-primary', kind: 'no-clear-difference', role: 'primary',
  population: 'endarterectomy trial', comparator: { a: 'endarterectomy + IMM', b: 'IMM alone' },
  outcome: 'primary composite', timepoint: '4 years', direction: 'no-clear-difference', language: 'none',
  estimate: { measure: 'RD', value: 1.6, interval: ci(-1.1, 4.3), p: 0.24, unit: 'percentage points', sample: null },
  evidence: { quote: Q.cea },
})
const ceaPost = claim({
  id: 'cea-postprocedural', kind: 'effect', role: 'component',
  population: 'endarterectomy trial', comparator: { a: 'endarterectomy + IMM', b: 'IMM alone' },
  outcome: 'ipsilateral ischemic stroke beyond day 44', timepoint: 'to 4 years', direction: 'favors-a', language: 'associational',
  estimate: null, evidence: { quote: Q.ceaPost },
})
const notHeadToHead = claim({ id: 'not-head-to-head', kind: 'author-statement', role: 'design', basis: 'source', text: 'event rates in the revascularization groups appeared similar across the two trials; no head-to-head comparison', evidence: { quote: Q.similar } })
const limits = claim({ id: 'limits', kind: 'limitation', role: 'design', evidence: { quote: Q.limits }, text: 'unblinded patients and physicians; medical therapy changed during the trial' })
const imprecise = claim({ id: 'imprecise', kind: 'limitation', role: 'design', basis: 'design', text: 'the endarterectomy CI runs from a small harm to a benefit about the size of the stenting trial\'s' })

export default {
  id: 'C2-CREST2',
  title: 'Inconclusive trial with favorable secondary: CREST-2 endarterectomy trial',
  source,
  profile: PROFILE,

  supported: [
    { claim: design, expect: 'pass-qualitative' },
    { claim: primaryDef, expect: 'pass-qualitative' },
    { claim: stent, expect: 'pass', bound: ['population', 'comparator', 'outcome', 'timepoint', 'direction', 'value', 'interval', 'p', 'unit'] },
    { claim: cea, expect: 'pass', bound: ['population', 'comparator', 'outcome', 'timepoint', 'direction', 'value', 'interval', 'p', 'unit'] },
    { claim: ceaPost, expect: 'pass-qualitative' },
    { claim: notHeadToHead, expect: 'pass-qualitative' },
    { claim: limits, expect: 'pass-qualitative' },
    { claim: imprecise, expect: 'pass-qualitative' },
  ],

  misleading: [
    {
      name: '"endarterectomy does not reduce stroke" (absence from non-significance)',
      check: 'claim-support',
      claim: claim({ ...cea, id: 'm1', kind: 'effect', direction: 'equivalent', estimate: null }),
      expect: 'fail', reasons: [R.EQUIVALENCE_NOT_TESTED, R.DIRECTION_UNSUPPORTED],
    },
    {
      name: '"stenting outperformed endarterectomy" (cross-trial comparison)',
      check: 'claim-support',
      claim: claim({ id: 'm3', kind: 'effect', role: 'primary', population: 'asymptomatic ≥70% stenosis', comparator: { a: 'stenting', b: 'endarterectomy' }, outcome: 'primary composite', timepoint: '4 years', direction: 'favors-a', language: 'causal', evidence: { quote: Q.stent } }),
      expect: 'fail', reasons: [R.COMPARATOR_NOT_RANDOMIZED],
    },
    {
      name: '"6% four-year stroke-or-death risk on medical therapy" (endpoint renamed)',
      check: 'claim-support',
      claim: claim({ id: 'm5', kind: 'rate', role: 'primary', population: 'stenting trial, medical-therapy group', outcome: 'stroke or death', timepoint: '4 years', estimate: { measure: 'percent', value: 6.0, interval: ci(3.8, 8.3), p: null, unit: '%', sample: null }, evidence: { quote: Q.stent } }),
      expect: 'fail', reasons: [R.OUTCOME_SUBSTITUTED],
    },
    {
      name: 'postprocedural RR shown inverted as "endarterectomy RR 2.38"',
      check: 'claim-support',
      claim: claim({ ...ceaPost, id: 'm-inv', estimate: { measure: 'RR', value: 2.38, interval: ci(1.13, 5.0), p: null, unit: null, sample: null }, direction: 'favors-b' }),
      expect: 'fail', reasons: [R.DIRECTION_UNSUPPORTED, R.COMPARATOR_UNBOUND],
    },
  ],

  fidelity: [
    { name: 'both primaries, paper order, component labeled', card: [design, primaryDef, stent, cea, ceaPost, notHeadToHead, limits, imprecise], expect: 'pass' },
    { name: 'component headlined, CEA primary absent', card: [design, primaryDef, stent, ceaPost], expect: 'fail', reasons: [R.PRIMARY_MISSING, R.COMPONENT_AS_HEADLINE] },
    { name: 'CEA primary after its favorable component', card: [design, primaryDef, stent, ceaPost, cea], expect: 'fail', reasons: [R.PRIMARY_AFTER_SECONDARY] },
    {
      name: 'tipping-point sentence as the lead limitation (supported but misleading)',
      card: [design, primaryDef, stent, cea, claim({ id: 'tip', kind: 'author-statement', role: 'design', evidence: { quote: Q.tipping }, text: 'seven fewer events would have made it significant' }), imprecise],
      expect: 'fail', reasons: [R.NULL_PRIMARY_OBSCURED],
    },
  ],

  personal: [
    { personal: { id: 'p-ns3', items: ['NS3'], connection: 'topic', text: 'carotid stenosis management is a north star' }, expect: 'pass' },
    { personal: { id: 'p-p4-risk', items: ['NS3', 'P4'], connection: 'topic', text: 'medical-therapy arms report 4-year primary-composite rates — a reference point for carotid risk stratification' }, expect: 'pass' },
    { personal: { id: 'p-p4-benefit', items: ['P4'], connection: 'project-aim', text: 'names the open question your project is aimed at: which features predict benefit from revascularization' }, expect: 'fail', reasons: [R.PROJECT_AIM_ASSERTED] },
  ],
}
