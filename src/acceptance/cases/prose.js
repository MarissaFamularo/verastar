// Final-prose checks. The renderer's output is sentences tagged with claim ids; checkProse
// judges each sentence against an Assessment and the claims. These cases hand-write the
// Assessment a correct assessCard produces for the BEST-CLI reference card, so the prose
// checker is tested on its own; the end-to-end test in the suite runs the same sentences
// against the real assessment as well.
import bestcli from './bestcli.js'
import { claim } from './load.js'
import { REASONS as R } from '../schema.js'

const bound = (keys) => Object.fromEntries(keys.map((k) => [k, 'bound']))
// What a correct assessment binds the cohort claims' outcome to: the definition's core
// ("a composite of a major adverse limb event or death from any cause"), its acronyms, its two
// disjuncts, and its components.
const DEF = {
  headTokens: ['composite', 'major', 'adverse', 'limb', 'death', 'mal', 'ale', 'male'],
  acronyms: ['mal', 'ale', 'male'],
  disjuncts: [['composite', 'major', 'adverse', 'limb'], ['death']],
  componentTokens: ['amputation', 'above', 'ankle', 'major', 'limb', 'reintervention', 'new', 'bypass', 'graft', 'revision', 'thrombectomy', 'thrombolysi'],
}

// The conclusions sentence of the abstract carries the cohort-1 conclusion independently of
// the results sentence; a state-A fallback rests on it.
const CONCLUSION_QUOTE = 'Among patients with CLTI who had an adequate great saphenous vein for surgical revascularization (cohort 1), the incidence of a major adverse limb event or death was significantly lower in the surgical group than in the endovascular group.'
export const cohort1Conclusion = claim({
  id: 'cohort1-conclusion', kind: 'effect', role: 'co-primary',
  population: 'cohort 1: CLTI with an adequate great saphenous vein', comparator: { a: 'surgical', b: 'endovascular' },
  outcome: 'major adverse limb event or death', direction: 'favors-a', language: 'causal', attribution: 'authors',
  evidence: { quote: CONCLUSION_QUOTE },
})
export const claims = [...bestcli.fidelity[0].card, cohort1Conclusion]

const resultsFull = [
  { id: 'design', eligibility: 'pass-qualitative', elements: { ...bound(['population']), role: 'bound' }, linkage: 'none', reasons: [], bound: {} },
  { id: 'enrollment', eligibility: 'pass', elements: bound(['value']), linkage: 'none', reasons: [], bound: {} },
  { id: 'primary-def', eligibility: 'pass-qualitative', elements: { ...bound(['outcome']), role: 'bound' }, linkage: 'same-sentence', reasons: [], bound: {} },
  { id: 'cohort1', eligibility: 'pass', elements: { ...bound(['population', 'comparator', 'outcome', 'timepoint', 'direction', 'value', 'interval', 'arms', 'language']), role: 'bound' }, linkage: 'definition-linked', reasons: [], bound: { outcomeDef: DEF } },
  { id: 'cohort2', eligibility: 'pass', elements: { ...bound(['population', 'comparator', 'outcome', 'timepoint', 'direction', 'value', 'interval', 'arms']), role: 'bound' }, linkage: 'definition-linked', reasons: [], bound: { outcomeDef: DEF } },
  { id: 'components-not-separated', eligibility: 'pass-qualitative', elements: { role: 'bound' }, linkage: 'none', reasons: [], bound: {} },
]

/** A correct assessment of the BEST-CLI reference card. */
export const BESTCLI_ASSESSMENT = {
  claims: resultsFull,
  fidelity: { status: 'pass', reasons: [], inventory: { entries: [], primaryBasis: 'labeled', uncertain: false }, omitted: [] },
  personal: [{ id: 'p-ns1', status: 'pass', reasons: [] }, { id: 'p-f1', status: 'pass', reasons: [] }],
  render: {
    state: 'full',
    display: { design: 'shown-qualitative', enrollment: 'shown-with-estimate', 'primary-def': 'shown-qualitative', cohort1: 'shown-with-estimate', cohort2: 'shown-with-estimate', 'components-not-separated': 'shown-qualitative' },
    claimsShown: ['design', 'enrollment', 'primary-def', 'cohort1', 'cohort2', 'components-not-separated'],
    estimatesShown: ['enrollment', 'cohort1', 'cohort2'],
    personalShown: ['p-ns1', 'p-f1'],
    mainResultShown: true,
    fallback: null,
  },
  recommendation: { read: 'full', basis: ['E1'] },
  context: { design: { randomized: true } },
}

// State A (simulated): cohort1's estimate withheld; the conclusion is carried by the
// independently checked 'cohort1-conclusion' claim.
export const BESTCLI_STATE_A = {
  ...BESTCLI_ASSESSMENT,
  claims: resultsFull.map((c) => (c.id === 'cohort1' ? { ...c, eligibility: 'withhold', elements: { ...c.elements, direction: 'unbound', value: 'unbound', interval: 'unbound' }, reasons: [R.ESTIMATE_UNCHECKED] } : c))
    .concat([{ id: 'cohort1-conclusion', eligibility: 'pass-qualitative', elements: { ...bound(['population', 'comparator', 'outcome', 'direction', 'language']), role: 'bound' }, linkage: 'same-sentence', reasons: [], bound: { outcomeDef: DEF } }]),
  render: {
    ...BESTCLI_ASSESSMENT.render,
    state: 'reduced-estimate-withheld',
    display: { ...BESTCLI_ASSESSMENT.render.display, cohort1: 'shown-qualitative', 'cohort1-conclusion': 'shown-qualitative' },
    claimsShown: [...BESTCLI_ASSESSMENT.render.claimsShown, 'cohort1-conclusion'],
    estimatesShown: ['enrollment', 'cohort2'],
    fallback: { kind: 'estimate-withheld', conclusionClaims: ['cohort1-conclusion'] },
  },
}

// No declared primary: role words are unbacked.
export const NO_PRIMARY_ASSESSMENT = {
  claims: [{ id: 'vte-reported', eligibility: 'pass', elements: { ...bound(['comparator', 'outcome', 'direction', 'value', 'interval']), role: 'not-asserted' }, linkage: 'same-sentence', reasons: [], bound: {} }],
  fidelity: { status: 'pass', reasons: [R.NO_DECLARED_PRIMARY], inventory: { entries: [], primaryBasis: 'none', uncertain: true }, omitted: [] },
  personal: [],
  render: { state: 'full', display: { 'vte-reported': 'shown-with-estimate' }, claimsShown: ['vte-reported'], estimatesShown: ['vte-reported'], personalShown: [], mainResultShown: true, fallback: null },
  recommendation: { read: 'abstract-enough', basis: [] },
}
export const vteReportedClaim = claim({ id: 'vte-reported', kind: 'effect', role: 'reported', comparator: { a: 'apixaban', b: 'rivaroxaban' }, outcome: 'recurrent VTE', direction: 'favors-a', language: 'associational', estimate: { measure: 'RR', value: 0.85, interval: { low: 0.74, high: 0.98, label: '95% CI' }, p: null, unit: null, sample: null }, evidence: { quote: 'x' } })

const s = (text, claims, extra = {}) => ({ text, claims, ...extra })

// The reference Card 1 as sentences, each tagged with the claims it renders.
export const REFERENCE_RENDERING = { sentences: [
  s('International randomized trial, 1,830 patients with CLTI and infrainguinal disease, two parallel cohorts defined by conduit availability.', ['design', 'enrollment'], { kind: 'header' }),
  s('In patients with a usable single-segment great saphenous vein (cohort 1), an initial surgical strategy led to fewer major adverse limb events or deaths than an initial endovascular strategy over a median 2.7 years (42.6% vs 57.4%; HR 0.68, 95% CI 0.59–0.79).', ['cohort1', 'primary-def']),
  s('In patients without adequate vein (cohort 2), the two strategies did not differ clearly (HR 0.79, 95% CI 0.58–1.06) over a median 1.6 years.', ['cohort2']),
  s('A randomized comparison of initial treatment strategy in CLTI, on your CLTI limb preservation north star and in the population a limb preservation program treats.', ['design'], { personal: ['p-ns1', 'p-f1'], kind: 'for-you' }),
  s('The primary composite counts major reintervention alongside amputation and death, and the abstract does not separate them, so "fewer events" is not "fewer amputations."', ['primary-def', 'components-not-separated'], { kind: 'temper' }),
  s('Yes, in full: this is a landmark trial for the question.', [], { kind: 'read' }),
] }

const C1 = ['cohort1', 'primary-def']
export default {
  id: 'PROSE',
  title: 'Final prose checked against the assessment',
  claims,

  accepted: [
    { name: 'the BEST-CLI reference card as rendered', assessment: BESTCLI_ASSESSMENT, rendered: REFERENCE_RENDERING },
    {
      name: 'state A: conclusion sentence without the number, from the checked conclusion claim',
      assessment: BESTCLI_STATE_A,
      rendered: { sentences: [
        s('In cohort 1 an initial surgical strategy led to fewer major adverse limb events or deaths than an initial endovascular strategy; the size of the difference could not be confirmed by the app, so no estimate is shown.', ['cohort1-conclusion', 'cohort1']),
        s('In cohort 2 the two strategies did not differ clearly in major adverse limb events or death (HR 0.79, 95% CI 0.58–1.06).', ['cohort2']),
      ] },
    },
  ],

  // Valid claim ids, printed numbers — and a wrong card. Each must fail for the stated reason.
  renderedAdversarial: [
    { name: 'arms swapped', sentence: s('In patients with a usable single-segment great saphenous vein (cohort 1), an initial endovascular strategy led to fewer major adverse limb events or deaths than an initial surgical strategy over a median 2.7 years (57.4% vs 42.6%; HR 0.68, 95% CI 0.59–0.79).', C1), reasons: [R.PROSE_ARM_SWAPPED] },
    { name: 'arm values swapped, arm order kept', sentence: s('In patients with a usable single-segment great saphenous vein (cohort 1), an initial surgical strategy led to fewer major adverse limb events or deaths than an initial endovascular strategy over a median 2.7 years (57.4% vs 42.6%; HR 0.68, 95% CI 0.59–0.79).', C1), reasons: [R.PROSE_ARM_SWAPPED] },
    { name: 'amputation substituted for the composite', sentence: s('In patients with a usable single-segment great saphenous vein (cohort 1), an initial surgical strategy led to fewer major amputations than an initial endovascular strategy over a median 2.7 years (42.6% vs 57.4%; HR 0.68, 95% CI 0.59–0.79).', C1), reasons: [R.PROSE_OUTCOME_SUBSTITUTED] },
    { name: 'conduit restriction removed', sentence: s('In patients with CLTI, an initial surgical strategy led to fewer major adverse limb events or deaths than an initial endovascular strategy over a median 2.7 years (42.6% vs 57.4%; HR 0.68, 95% CI 0.59–0.79).', C1), reasons: [R.PROSE_POPULATION_DROPPED] },
    { name: 'timepoint unit changed (2.7 months)', sentence: s('In patients with a usable single-segment great saphenous vein (cohort 1), an initial surgical strategy led to fewer major adverse limb events or deaths than an initial endovascular strategy over a median 2.7 months (42.6% vs 57.4%; HR 0.68, 95% CI 0.59–0.79).', C1), reasons: [R.PROSE_TIMEPOINT_CHANGED] },
    { name: 'timepoint meaning changed (at 2.7 years)', sentence: s('In patients with a usable single-segment great saphenous vein (cohort 1), an initial surgical strategy led to fewer major adverse limb events or deaths than an initial endovascular strategy at 2.7 years (42.6% vs 57.4%; HR 0.68, 95% CI 0.59–0.79).', C1), reasons: [R.PROSE_TIMEPOINT_CHANGED] },
    { name: 'confidence level changed (97.5% CI)', sentence: s('In patients with a usable single-segment great saphenous vein (cohort 1), an initial surgical strategy led to fewer major adverse limb events or deaths than an initial endovascular strategy over a median 2.7 years (42.6% vs 57.4%; HR 0.68, 97.5% CI 0.59–0.79).', C1), reasons: [R.PROSE_INTERVAL_LEVEL_CHANGED] },
    { name: 'wrong outcome sharing words (major limb reinterventions)', sentence: s('In patients with a usable single-segment great saphenous vein (cohort 1), an initial surgical strategy led to fewer major limb reinterventions than an initial endovascular strategy over a median 2.7 years (42.6% vs 57.4%; HR 0.68, 95% CI 0.59–0.79).', C1), reasons: [R.PROSE_OUTCOME_SUBSTITUTED] },
    { name: 'timepoint changed to the other cohort\'s', sentence: s('In patients with a usable single-segment great saphenous vein (cohort 1), an initial surgical strategy led to fewer major adverse limb events or deaths than an initial endovascular strategy over a median 1.6 years (42.6% vs 57.4%; HR 0.68, 95% CI 0.59–0.79).', C1), reasons: [R.PROSE_TIMEPOINT_CHANGED] },
  ],

  rejected: [
    { name: 'number from a claim the sentence does not cite', assessment: BESTCLI_ASSESSMENT, sentence: s('In cohort 2 the hazard ratio for the primary composite was 0.68.', ['cohort2']), reasons: [R.UNBACKED_NUMBER] },
    { name: 'superlative with no claim', assessment: BESTCLI_ASSESSMENT, sentence: s('The largest randomized trial of CLTI revascularization to date.', ['design']), reasons: [R.UNBACKED_COMPARATIVE] },
    { name: 'factual sentence with no claim ids', assessment: BESTCLI_ASSESSMENT, sentence: s('Bypass reduced major amputation by a third.', []), reasons: [R.UNTAGGED_ASSERTION] },
    { name: 'direction word contradicts the cited claim', assessment: BESTCLI_ASSESSMENT, sentence: s('In cohort 2, surgery reduced primary composite events (HR 0.79).', ['cohort2']), reasons: [R.DIRECTION_WORD_CONTRADICTS_CLAIM] },
    { name: 'withheld estimate printed anyway', assessment: BESTCLI_STATE_A, sentence: s('In cohort 1 surgical led to fewer major adverse limb events or deaths than endovascular (HR 0.68, 95% CI 0.59–0.79).', ['cohort1', 'cohort1-conclusion']), reasons: [R.NUMBER_FROM_WITHHELD_ESTIMATE] },
    { name: 'withheld estimate printed under a badge', assessment: BESTCLI_STATE_A, sentence: s('In cohort 1 surgical led to fewer major adverse limb events or deaths than endovascular (HR 0.68, unverified).', ['cohort1', 'cohort1-conclusion']), reasons: [R.NUMBER_FROM_WITHHELD_ESTIMATE] },
    { name: 'state A direction stated from the withheld claim alone (no conclusion claim cited)', assessment: BESTCLI_STATE_A, sentence: s('In cohort 1 surgical led to fewer major adverse limb events or deaths than endovascular.', ['cohort1']), reasons: [R.DIRECTION_WORD_CONTRADICTS_CLAIM] },
    { name: 'citing a claim the render plan does not show', assessment: { ...BESTCLI_ASSESSMENT, render: { ...BESTCLI_ASSESSMENT.render, display: { ...BESTCLI_ASSESSMENT.render.display, cohort2: 'not-shown' }, claimsShown: ['design', 'enrollment', 'primary-def', 'cohort1', 'components-not-separated'], estimatesShown: ['enrollment', 'cohort1'] } }, sentence: s('In cohort 2 the two strategies did not differ clearly in primary composite events.', ['cohort2']), reasons: [R.CLAIM_NOT_SHOWN_CITED] },
    { name: 'role word resting on no declared primary', assessment: NO_PRIMARY_ASSESSMENT, claims: [vteReportedClaim], sentence: s('The primary outcome, recurrent VTE, favored apixaban (RR 0.85, 95% CI 0.74–0.98).', ['vte-reported']), reasons: [R.ROLE_WORD_UNBACKED] },
    { name: 'personal sentence without item tags', assessment: BESTCLI_ASSESSMENT, sentence: s('Directly relevant to your limb preservation program.', ['design'], { kind: 'for-you' }), reasons: [R.PERSONAL_UNTAGGED] },
  ],

  // Printed bracket rendered as a CI.
  bracket: {
    assessment: {
      claims: [{ id: 'peroneal', eligibility: 'pass', elements: { comparator: 'bound', outcome: 'bound', direction: 'bound', value: 'bound', interval: 'bound' }, linkage: 'same-sentence', reasons: [], bound: {} }],
      fidelity: { status: 'pass', reasons: [], inventory: { entries: [], primaryBasis: 'labeled', uncertain: false }, omitted: [] },
      personal: [],
      render: { state: 'full', display: { peroneal: 'shown-with-estimate' }, claimsShown: ['peroneal'], estimatesShown: ['peroneal'], personalShown: [], mainResultShown: true, fallback: null },
      recommendation: { read: 'abstract-enough', basis: [] },
    },
    claimIntervalLabel: 'printed-bracket',
    accepted: s('Peroneal runoff was associated with higher adjusted risk of major amputation than AT/PT runoff (HR 1.81 [1.04–3.13]).', ['peroneal']),
    rejected: { sentence: s('Peroneal runoff was associated with higher adjusted risk of major amputation than AT/PT runoff (HR 1.81, 95% CI 1.04–3.13).', ['peroneal']), reasons: [R.PROSE_INTERVAL_LABEL_INVENTED] },
  },
}
