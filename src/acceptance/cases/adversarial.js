// Adversarial binding cases: every number below is PRINTED in the source. Each claim attaches
// it to the wrong arm, outcome, population, timepoint, comparator, p-value or sample. All must
// be ineligible. These are the cases a token-level verifier passes and a claim-level checker
// must refuse. Sources: the saved development fixtures.
import { devsetSource, liveSource, claim, ci, bracket } from './load.js'
import { REASONS as R } from '../schema.js'

const est = (measure, value, interval = null, extra = {}) => ({ measure, value, interval, p: null, unit: null, sample: null, ...extra })

const BESTCLI = {
  cohort1: 'In cohort 1, after a median follow-up of 2.7 years, a primary-outcome event occurred in 302 of 709 patients (42.6%) in the surgical group and in 408 of 711 patients (57.4%) in the endovascular group (hazard ratio, 0.68; 95% confidence interval [CI], 0.59 to 0.79; P<0.001).',
  cohort2: 'In cohort 2, a primary-outcome event occurred in 83 of 194 patients (42.8%) in the surgical group and in 95 of 199 patients (47.7%) in the endovascular group (hazard ratio, 0.79; 95% CI, 0.58 to 1.06; P = 0.12) after a median follow-up of 1.6 years.',
}
const CREST = {
  stent: 'In the stenting trial, the 4-year rate of the composite primary outcome was 6.0% (95% confidence interval [CI], 3.8 to 8.3) in the medical therapy group and 2.8% (95% CI, 1.5 to 4.3) in the stenting group. The absolute risk difference was 3.2 percentage points (95% CI, 0.6 to 5.9; P=0.02)',
  cea: 'In the endarterectomy trial, the 4-year rate of the primary outcome was 5.3% (95% CI, 3.3 to 7.4) in the medical-therapy group and 3.7% (95% CI, 2.1 to 5.5) in the endarterectomy group. The absolute risk difference was 1.6 percentage points (95% CI, −1.1 to 4.3; P=0.24)',
  ceaRR: 'the relative risk in the medical-therapy group as compared with the endarterectomy group was 1.43 (95% CI, 0.78 to 2.72)',
  stentPost: 'in the stenting group, 7 ipsilateral ischemic strokes occurred among 582 patients followed for 1714 person-years, for an annual event rate of 0.4% (95% CI, 0.2 to 0.9)',
}
const CILO = {
  icd: 'Participants taking cilostazol had a higher ICD compared with those taking placebo (MD 26.49 metres; 95% CI 18.93 to 34.05; 1722 participants; six studies; low-certainty evidence).',
  acd: 'Participants taking cilostazol had a higher ACD compared with those taking placebo (39.57 metres; 95% CI 21.80 to 57.33; 2360 participants; eight studies; very-low certainty evidence).',
  headache: 'Participants taking cilostazol had an increased odds of experiencing headache compared to participants taking placebo (OR 2.83; 95% CI 2.26 to 3.55; 2584 participants; eight studies; moderate-certainty evidence).',
  pentoxHeadache: 'Cilostazol participants had an increased odds of experiencing headache compared with participants taking pentoxifylline at 24 weeks (OR 2.20, 95% CI 1.16 to 4.17; 982 participants; two studies; low-certainty evidence).',
}
const RAO = {
  rao: 'At 1 year, CAS was associated with higher risks of RAO (0.421% vs 0.257%; OR 1.64; 95% CI, 1.12-2.41)',
  stroke: 'CAS also conferred higher odds of stroke (6.20% vs 4.43%; OR 1.42; 1.25-1.62)',
}
const PCB = {
  peroneal: 'After adjustment, peroneal runoff was independently associated with higher risk of major amputation (HR 1.81 [1.04-3.13]) and MALE (HR 1.52 [1.03-2.25]) compared with AT/PT runoff.',
  endo: 'These associations persisted in the endovascular cohort (major amputation: HR 2.09 [1.06-4.13]; MALE: HR 1.59 [1.08-2.35])',
  grade3: 'patients without any robust branch (PCB Grade 3) had significantly higher risk of major amputation (HR 3.21 [1.76-4.84]) and MALE (HR 2.41 [1.53-3.79])',
}
const BASIL = {
  primary: 'Major amputation or death occurred in 108 (63%) of 172 patients in the vein bypass group and 92 (53%) of 173 patients in the best endovascular treatment group (adjusted hazard ratio [HR] 1·35 [95% CI 1·02-1·80]; p=0·037).',
  death: '91 (53%) of 172 patients in the vein bypass group and 77 (45%) of 173 patients in the best endovascular treatment group died (adjusted HR 1·37 [95% CI 1·00-1·87]).',
}

const bypassVsEndo = { a: 'vein bypass first', b: 'best endovascular treatment first' }
const surgVsEndo = { a: 'surgical', b: 'endovascular' }

export default {
  id: 'ADV-BINDING',
  title: 'Adversarial: correct numbers, wrong arm / outcome / population / timepoint',
  groups: [
    {
      source: () => devsetSource('PAD-10'), paper: 'BEST-CLI',
      cases: [
        { name: 'HR 0.68 attached to cohort 2', claim: claim({ id: 'a1', kind: 'effect', role: 'co-primary', population: 'cohort 2: CLTI needing an alternative conduit', comparator: surgVsEndo, outcome: 'primary composite', direction: 'favors-a', estimate: est('HR', 0.68, ci(0.59, 0.79)), evidence: { quote: BESTCLI.cohort2 } }), reasons: [R.VALUE_MISMATCH, R.POPULATION_UNBOUND] },
        { name: '57.4% assigned to the surgical arm (arms swapped)', claim: claim({ id: 'a2', kind: 'rate', role: 'co-primary', population: 'cohort 1, surgical group', outcome: 'primary composite', timepoint: 'median 2.7 years', estimate: est('percent', 57.4, null, { unit: '%' }), evidence: { quote: BESTCLI.cohort1 } }), reasons: [R.ARM_VALUE_MISMATCH] },
        { name: 'HR 0.68 with direction flipped (favors endovascular)', claim: claim({ id: 'a3', kind: 'effect', role: 'co-primary', population: 'cohort 1', comparator: { a: 'endovascular', b: 'surgical' }, outcome: 'primary composite', direction: 'favors-a', estimate: est('HR', 0.68, ci(0.59, 0.79)), evidence: { quote: BESTCLI.cohort1 } }), reasons: [R.DIRECTION_UNSUPPORTED, R.ARM_VALUE_MISMATCH] },
        { name: '42.6% attached to major amputation', claim: claim({ id: 'a4', kind: 'rate', role: 'co-primary', population: 'cohort 1, surgical group', outcome: 'major amputation', timepoint: 'median 2.7 years', estimate: est('percent', 42.6, null, { unit: '%' }), evidence: { quote: BESTCLI.cohort1 } }), reasons: [R.OUTCOME_SUBSTITUTED] },
        { name: 'HR 0.68 at the cohort-2 timepoint (median 1.6 years)', claim: claim({ id: 'a5', kind: 'effect', role: 'co-primary', population: 'cohort 1', comparator: surgVsEndo, outcome: 'primary composite', timepoint: 'median 1.6 years', direction: 'favors-a', estimate: est('HR', 0.68, ci(0.59, 0.79)), evidence: { quote: BESTCLI.cohort1 } }), reasons: [R.TIMEPOINT_MISMATCH, R.TIMEPOINT_UNBOUND] },
        { name: 'cohort-2 interval attached to the cohort-1 HR', claim: claim({ id: 'a6', kind: 'effect', role: 'co-primary', population: 'cohort 1', comparator: surgVsEndo, outcome: 'primary composite', direction: 'favors-a', estimate: est('HR', 0.68, ci(0.58, 1.06)), evidence: { quote: BESTCLI.cohort1 } }), reasons: [R.INTERVAL_MISMATCH] },
        // timepoint: same number, changed unit / changed meaning
        { name: 'median 2.7 MONTHS (unit changed)', claim: claim({ id: 'a7', kind: 'effect', role: 'co-primary', population: 'cohort 1', comparator: surgVsEndo, outcome: 'primary composite', timepoint: 'median 2.7 months', direction: 'favors-a', estimate: est('HR', 0.68, ci(0.59, 0.79)), evidence: { quote: BESTCLI.cohort1 } }), reasons: [R.TIMEPOINT_UNIT_MISMATCH] },
        { name: 'AT 2.7 years (fixed horizon claimed for a median follow-up)', claim: claim({ id: 'a8', kind: 'effect', role: 'co-primary', population: 'cohort 1', comparator: surgVsEndo, outcome: 'primary composite', timepoint: 'at 2.7 years', direction: 'favors-a', estimate: est('HR', 0.68, ci(0.59, 0.79)), evidence: { quote: BESTCLI.cohort1 } }), reasons: [R.TIMEPOINT_MEANING_MISMATCH] },
        // interval: same bounds, changed confidence level
        { name: '97.5% CI claimed for a 95% CI', claim: claim({ id: 'a9', kind: 'effect', role: 'co-primary', population: 'cohort 1', comparator: surgVsEndo, outcome: 'primary composite', direction: 'favors-a', estimate: est('HR', 0.68, { low: 0.59, high: 0.79, label: '97.5% CI' }), evidence: { quote: BESTCLI.cohort1 } }), reasons: [R.INTERVAL_LEVEL_MISMATCH] },
        { name: 'interval level left unstated for a labeled 95% CI', claim: claim({ id: 'a10', kind: 'effect', role: 'co-primary', population: 'cohort 1', comparator: surgVsEndo, outcome: 'primary composite', direction: 'favors-a', estimate: est('HR', 0.68, { low: 0.59, high: 0.79, label: null }), evidence: { quote: BESTCLI.cohort1 } }), reasons: [R.INTERVAL_LEVEL_MISMATCH] },
        // outcome: wrong endpoint sharing words with the right one
        { name: '"major limb reintervention" (a component sharing "major"/"limb")', claim: claim({ id: 'a11', kind: 'effect', role: 'co-primary', population: 'cohort 1', comparator: surgVsEndo, outcome: 'major limb reintervention', direction: 'favors-a', estimate: est('HR', 0.68, ci(0.59, 0.79)), evidence: { quote: BESTCLI.cohort1 } }), reasons: [R.OUTCOME_SUBSTITUTED] },
        { name: '"major adverse cardiac events" (shares "major adverse … events")', claim: claim({ id: 'a12', kind: 'effect', role: 'co-primary', population: 'cohort 1', comparator: surgVsEndo, outcome: 'major adverse cardiac events', direction: 'favors-a', estimate: est('HR', 0.68, ci(0.59, 0.79)), evidence: { quote: BESTCLI.cohort1 } }), reasons: [R.OUTCOME_UNBOUND, R.OUTCOME_SUBSTITUTED] },
        { name: '"death from any cause" alone for the composite', claim: claim({ id: 'a13', kind: 'effect', role: 'co-primary', population: 'cohort 1', comparator: surgVsEndo, outcome: 'death from any cause', direction: 'favors-a', estimate: est('HR', 0.68, ci(0.59, 0.79)), evidence: { quote: BESTCLI.cohort1 } }), reasons: [R.OUTCOME_SUBSTITUTED] },
      ],
    },
    {
      source: () => devsetSource('CAR-07'), paper: 'CREST-2',
      cases: [
        { name: '2.8% assigned to the medical-therapy group', claim: claim({ id: 'c1', kind: 'rate', role: 'primary', population: 'stenting trial, medical-therapy group', outcome: 'primary composite', timepoint: '4 years', estimate: est('percent', 2.8, ci(1.5, 4.3), { unit: '%' }), evidence: { quote: CREST.stent } }), reasons: [R.ARM_VALUE_MISMATCH] },
        { name: 'RD 3.2 attached to the endarterectomy trial', claim: claim({ id: 'c2', kind: 'effect', role: 'primary', population: 'endarterectomy trial', comparator: { a: 'endarterectomy + IMM', b: 'IMM alone' }, outcome: 'primary composite', timepoint: '4 years', direction: 'favors-a', estimate: est('RD', 3.2, ci(0.6, 5.9), { unit: 'percentage points' }), evidence: { quote: CREST.cea } }), reasons: [R.VALUE_MISMATCH, R.POPULATION_UNBOUND] },
        { name: 'annual postprocedural 0.4% presented as the 4-year primary rate', claim: claim({ id: 'c3', kind: 'rate', role: 'primary', population: 'stenting group', outcome: 'primary composite', timepoint: '4 years', estimate: est('percent', 0.4, ci(0.2, 0.9), { unit: '%' }), evidence: { quote: CREST.stentPost } }), reasons: [R.OUTCOME_SUBSTITUTED, R.TIMEPOINT_MISMATCH] },
        { name: 'RR 1.43 read as endarterectomy lowering risk (CI includes 1)', claim: claim({ id: 'c4', kind: 'effect', role: 'primary', population: 'endarterectomy trial', comparator: { a: 'endarterectomy + IMM', b: 'IMM alone' }, outcome: 'primary composite', timepoint: '4 years', direction: 'favors-a', estimate: est('RR', 1.43, ci(0.78, 2.72)), evidence: { quote: CREST.ceaRR } }), reasons: [R.DIRECTION_UNSUPPORTED] },
        { name: 'P=0.02 attached to the endarterectomy risk difference', claim: claim({ id: 'c5', kind: 'no-clear-difference', role: 'primary', population: 'endarterectomy trial', comparator: { a: 'endarterectomy + IMM', b: 'IMM alone' }, outcome: 'primary composite', timepoint: '4 years', direction: 'no-clear-difference', estimate: est('RD', 1.6, ci(-1.1, 4.3), { p: 0.02, unit: 'percentage points' }), evidence: { quote: CREST.cea } }), reasons: [R.P_MISMATCH] },
      ],
    },
    {
      source: () => devsetSource('PAD-05'), paper: 'Cochrane cilostazol',
      cases: [
        { name: 'MD 26.49 attached to absolute claudication distance', claim: claim({ id: 'd1', kind: 'effect', role: 'secondary', comparator: { a: 'cilostazol', b: 'placebo' }, outcome: 'absolute claudication distance', direction: 'favors-a', estimate: est('MD', 26.49, ci(18.93, 34.05), { unit: 'metres' }), evidence: { quote: CILO.acd } }), reasons: [R.VALUE_MISMATCH, R.OUTCOME_SUBSTITUTED] },
        { name: 'MD 39.57 attached to initial claudication distance (the primary)', claim: claim({ id: 'd2', kind: 'effect', role: 'primary', comparator: { a: 'cilostazol', b: 'placebo' }, outcome: 'initial claudication distance', direction: 'favors-a', estimate: est('MD', 39.57, ci(21.8, 57.33), { unit: 'metres' }), evidence: { quote: CILO.icd } }), reasons: [R.VALUE_MISMATCH, R.OUTCOME_SUBSTITUTED] },
        { name: 'OR 2.83 attached to the pentoxifylline comparison', claim: claim({ id: 'd3', kind: 'effect', role: 'safety', comparator: { a: 'cilostazol', b: 'pentoxifylline' }, outcome: 'headache', direction: 'favors-b', estimate: est('OR', 2.83, ci(2.26, 3.55)), evidence: { quote: CILO.pentoxHeadache } }), reasons: [R.VALUE_MISMATCH, R.COMPARATOR_UNBOUND] },
        { name: '1,722 participants attached to the headache OR', claim: claim({ id: 'd4', kind: 'effect', role: 'safety', comparator: { a: 'cilostazol', b: 'placebo' }, outcome: 'headache', direction: 'favors-b', estimate: est('OR', 2.83, ci(2.26, 3.55), { sample: { studies: 8, participants: 1722 } }), evidence: { quote: CILO.headache } }), reasons: [R.SAMPLE_MISMATCH] },
        { name: 'eight studies attached to the ICD mean difference', claim: claim({ id: 'd5', kind: 'effect', role: 'primary', comparator: { a: 'cilostazol', b: 'placebo' }, outcome: 'initial claudication distance', direction: 'favors-a', estimate: est('MD', 26.49, ci(18.93, 34.05), { unit: 'metres', sample: { studies: 8, participants: 1722 } }), evidence: { quote: CILO.icd } }), reasons: [R.SAMPLE_MISMATCH] },
      ],
    },
    {
      source: () => liveSource('42854197'), paper: 'RAO after CEA vs CAS',
      cases: [
        { name: '0.421% assigned to CEA', claim: claim({ id: 'r1', kind: 'rate', role: 'primary', population: 'CEA cohort', outcome: 'RAO', timepoint: '1 year', estimate: est('percent', 0.421, null, { unit: '%' }), evidence: { quote: RAO.rao } }), reasons: [R.ARM_VALUE_MISMATCH] },
        { name: 'OR 1.64 attached to stroke', claim: claim({ id: 'r2', kind: 'effect', role: 'secondary', comparator: { a: 'CAS', b: 'CEA' }, outcome: 'stroke', timepoint: '1 year', direction: 'favors-b', language: 'associational', estimate: est('OR', 1.64, ci(1.12, 2.41)), evidence: { quote: RAO.stroke } }), reasons: [R.VALUE_MISMATCH, R.OUTCOME_SUBSTITUTED] },
        { name: '1-year OR reported at 90 days', claim: claim({ id: 'r3', kind: 'effect', role: 'primary', comparator: { a: 'CAS', b: 'CEA' }, outcome: 'RAO', timepoint: '90 days', direction: 'favors-b', language: 'associational', estimate: est('OR', 1.64, ci(1.12, 2.41)), evidence: { quote: RAO.rao } }), reasons: [R.TIMEPOINT_MISMATCH] },
      ],
    },
    {
      source: () => liveSource('42855019'), paper: 'PCB grade',
      cases: [
        { name: 'MALE HR 1.52 labeled major amputation', claim: claim({ id: 'p1', kind: 'effect', role: 'primary', comparator: { a: 'peroneal runoff', b: 'AT/PT runoff' }, outcome: 'major amputation', direction: 'favors-b', language: 'associational', estimate: est('HR', 1.52, bracket(1.03, 2.25)), evidence: { quote: PCB.peroneal } }), reasons: [R.OUTCOME_SUBSTITUTED, R.VALUE_MISMATCH] },
        { name: 'endovascular-cohort HR 2.09 presented as the overall association', claim: claim({ id: 'p2', kind: 'effect', role: 'primary', population: 'single-vessel peroneal runoff', comparator: { a: 'peroneal runoff', b: 'AT/PT runoff' }, outcome: 'major amputation', direction: 'favors-b', language: 'associational', estimate: est('HR', 2.09, bracket(1.06, 4.13)), evidence: { quote: PCB.endo } }), reasons: [R.POPULATION_OVERGENERALIZED, R.SUBGROUP_AS_WHOLE] },
        { name: 'HR 1.81 attached to PCB grade 1', claim: claim({ id: 'p3', kind: 'effect', role: 'subgroup', population: 'PCB grade 1', comparator: { a: 'PCB grade 1', b: 'AT/PT runoff' }, outcome: 'major amputation', direction: 'favors-b', language: 'associational', estimate: est('HR', 1.81, bracket(1.04, 3.13)), evidence: { quote: PCB.peroneal } }), reasons: [R.POPULATION_UNBOUND, R.COMPARATOR_UNBOUND] },
      ],
    },
    {
      source: () => devsetSource('PAD-12'), paper: 'BASIL-2',
      cases: [
        { name: '63% assigned to the endovascular-first group', claim: claim({ id: 'b1', kind: 'rate', role: 'primary', population: 'best endovascular treatment group', outcome: 'major amputation or death', estimate: est('percent', 63, null, { unit: '%' }), evidence: { quote: BASIL.primary } }), reasons: [R.ARM_VALUE_MISMATCH] },
        { name: 'death HR 1.37 attached to amputation-free survival', claim: claim({ id: 'b2', kind: 'effect', role: 'primary', comparator: bypassVsEndo, outcome: 'amputation-free survival (major amputation or death)', direction: 'favors-b', estimate: est('aHR', 1.37, ci(1.0, 1.87)), evidence: { quote: BASIL.death } }), reasons: [R.OUTCOME_SUBSTITUTED, R.VALUE_MISMATCH] },
        { name: 'primary HR 1.35 attached to all-cause death', claim: claim({ id: 'b3', kind: 'effect', role: 'component', comparator: bypassVsEndo, outcome: 'all-cause death', direction: 'favors-b', estimate: est('aHR', 1.35, ci(1.02, 1.8)), evidence: { quote: BASIL.primary } }), reasons: [R.OUTCOME_SUBSTITUTED, R.VALUE_MISMATCH] },
        { name: 'p=0·037 attached to the death HR', claim: claim({ id: 'b4', kind: 'effect', role: 'component', comparator: bypassVsEndo, outcome: 'all-cause death', direction: 'favors-b', estimate: est('aHR', 1.37, ci(1.0, 1.87), { p: 0.037 }), evidence: { quote: BASIL.death } }), reasons: [R.P_MISMATCH] },
        { name: '"major amputation" alone for the amputation-free-survival primary', claim: claim({ id: 'b6', kind: 'effect', role: 'primary', comparator: bypassVsEndo, outcome: 'major amputation', direction: 'favors-b', estimate: est('aHR', 1.35, ci(1.02, 1.8)), evidence: { quote: BASIL.primary } }), reasons: [R.OUTCOME_SUBSTITUTED] },
        { name: '"amputation-free survival" attached to the death HR', claim: claim({ id: 'b7', kind: 'effect', role: 'primary', comparator: bypassVsEndo, outcome: 'amputation-free survival (major amputation or death)', direction: 'no-clear-difference', estimate: est('aHR', 1.37, ci(1.0, 1.87)), evidence: { quote: BASIL.death } }), reasons: [R.OUTCOME_UNBOUND, R.OUTCOME_SUBSTITUTED, R.VALUE_MISMATCH] },
        { name: 'minimum 2 years claimed as median follow-up of 2 years', claim: claim({ id: 'b8', kind: 'design', role: 'design', timepoint: 'median 2 years', evidence: { quote: 'Participants were followed up for a minimum of 2 years.' } }), reasons: [R.TIMEPOINT_MEANING_MISMATCH] },
        { name: 'death HR with CI touching 1·00 stated as a clear difference', claim: claim({ id: 'b5', kind: 'effect', role: 'component', comparator: bypassVsEndo, outcome: 'all-cause death', direction: 'favors-b', language: 'causal', text: 'clearly increased', estimate: est('aHR', 1.37, ci(1.0, 1.87)), evidence: { quote: BASIL.death } }), reasons: [R.DIRECTION_UNSUPPORTED] },
      ],
    },
  ],
}
