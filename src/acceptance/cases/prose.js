// Final-prose checks. The renderer's output is sentences tagged with claim ids; checkProse
// judges each sentence against an Assessment. These cases hand-write the Assessment a correct
// assessCard would produce for the BEST-CLI reference card, so the prose checker is tested on
// its own, independent of assessCard.
import { REASONS as R } from '../schema.js'

const bound = (keys) => Object.fromEntries(keys.map((k) => [k, 'bound']))

/** A correct assessment of the BEST-CLI reference card (claims as in cases/bestcli.js). */
export const BESTCLI_ASSESSMENT = {
  claims: [
    { id: 'design', eligibility: 'pass-qualitative', elements: bound(['population']), linkage: 'same-sentence', reasons: [] },
    { id: 'primary-def', eligibility: 'pass-qualitative', elements: bound(['outcome']), linkage: 'same-sentence', reasons: [] },
    { id: 'cohort1', eligibility: 'pass', elements: { ...bound(['population', 'comparator', 'outcome', 'timepoint', 'direction', 'value', 'interval']), role: 'bound' }, linkage: 'definition-linked', reasons: [] },
    { id: 'cohort2', eligibility: 'pass', elements: { ...bound(['population', 'comparator', 'outcome', 'timepoint', 'direction', 'value', 'interval']), role: 'bound' }, linkage: 'definition-linked', reasons: [] },
    { id: 'components-not-separated', eligibility: 'pass-qualitative', elements: {}, linkage: 'none', reasons: [] },
  ],
  fidelity: { status: 'pass', reasons: [], inventory: { entries: [], primaryBasis: 'labeled', uncertain: false }, omitted: [] },
  personal: [{ id: 'p-ns1', status: 'pass', reasons: [] }, { id: 'p-f1', status: 'pass', reasons: [] }],
  render: {
    state: 'full',
    display: { design: 'shown-qualitative', 'primary-def': 'shown-qualitative', cohort1: 'shown-with-estimate', cohort2: 'shown-with-estimate', 'components-not-separated': 'shown-qualitative' },
    claimsShown: ['design', 'primary-def', 'cohort1', 'cohort2', 'components-not-separated'],
    estimatesShown: ['cohort1', 'cohort2'],
    personalShown: ['p-ns1', 'p-f1'],
    mainResultShown: true,
    fallback: null,
  },
  recommendation: { read: 'full', basis: ['E1'] },
}

// The same assessment under state A (simulated): cohort1's estimate withheld; the conclusion
// is carried by a separate checked claim 'cohort1-conclusion'.
export const BESTCLI_STATE_A = {
  ...BESTCLI_ASSESSMENT,
  claims: BESTCLI_ASSESSMENT.claims.map((c) => (c.id === 'cohort1' ? { ...c, eligibility: 'withhold', elements: { ...c.elements, direction: 'unbound', value: 'unbound' }, reasons: [R.ESTIMATE_UNCHECKED] } : c))
    .concat([{ id: 'cohort1-conclusion', eligibility: 'pass-qualitative', elements: bound(['population', 'comparator', 'outcome', 'direction']), linkage: 'same-sentence', reasons: [] }]),
  render: {
    ...BESTCLI_ASSESSMENT.render,
    state: 'reduced-estimate-withheld',
    display: { ...BESTCLI_ASSESSMENT.render.display, cohort1: 'shown-qualitative', 'cohort1-conclusion': 'shown-qualitative' },
    claimsShown: [...BESTCLI_ASSESSMENT.render.claimsShown, 'cohort1-conclusion'],
    estimatesShown: ['cohort2'],
    fallback: { kind: 'estimate-withheld', conclusionClaims: ['cohort1-conclusion'] },
  },
}

// A positional-role assessment (no declared primary): role words are unbacked.
export const NO_PRIMARY_ASSESSMENT = {
  claims: [{ id: 'vte-reported', eligibility: 'pass', elements: { ...bound(['comparator', 'outcome', 'direction', 'value', 'interval']), role: 'not-asserted' }, linkage: 'same-sentence', reasons: [] }],
  fidelity: { status: 'pass', reasons: [R.NO_DECLARED_PRIMARY], inventory: { entries: [], primaryBasis: 'none', uncertain: true }, omitted: [] },
  personal: [],
  render: { state: 'full', display: { 'vte-reported': 'shown-with-estimate' }, claimsShown: ['vte-reported'], estimatesShown: ['vte-reported'], personalShown: [], mainResultShown: true, fallback: null },
  recommendation: { read: 'abstract-enough', basis: [] },
}

const s = (text, claims, extra = {}) => ({ text, claims, ...extra })

export default {
  id: 'PROSE',
  title: 'Final prose checked against the assessment',

  accepted: [
    {
      name: 'the BEST-CLI reference card as rendered',
      assessment: BESTCLI_ASSESSMENT,
      rendered: { sentences: [
        s('International randomized trial, 1,830 patients with CLTI and infrainguinal disease, two parallel cohorts defined by conduit availability.', ['design'], { kind: 'header' }),
        s('In patients with a usable single-segment great saphenous vein (cohort 1), an initial surgical strategy led to fewer major adverse limb events or deaths than an initial endovascular strategy over a median 2.7 years (42.6% vs 57.4%; HR 0.68, 95% CI 0.59–0.79).', ['cohort1', 'primary-def']),
        s('In patients without adequate vein (cohort 2), the two strategies did not differ clearly (HR 0.79, 95% CI 0.58–1.06) over a median 1.6 years.', ['cohort2']),
        s('A randomized comparison of initial treatment strategy in CLTI, on your CLTI limb preservation north star and in the population a limb preservation program treats.', ['design'], { personal: ['p-ns1', 'p-f1'], kind: 'for-you' }),
        s('The primary composite counts major reintervention alongside amputation and death, and the abstract does not separate them, so "fewer events" is not "fewer amputations."', ['primary-def', 'components-not-separated'], { kind: 'temper' }),
        s('Yes, in full: this is a landmark trial for the question.', [], { kind: 'read' }),
      ] },
    },
    {
      name: 'state A: conclusion sentence without the number, from the checked conclusion claim',
      assessment: BESTCLI_STATE_A,
      rendered: { sentences: [
        s('In cohort 1 an initial surgical strategy led to fewer major adverse limb events or deaths than an initial endovascular strategy; the size of the difference could not be confirmed by the app, so no estimate is shown.', ['cohort1-conclusion', 'cohort1']),
        s('In cohort 2 the two strategies did not differ clearly (HR 0.79, 95% CI 0.58–1.06).', ['cohort2']),
      ] },
    },
  ],

  rejected: [
    { name: 'number from a claim the sentence does not cite', assessment: BESTCLI_ASSESSMENT, sentence: s('In cohort 2 the hazard ratio was 0.68.', ['cohort2']), reasons: [R.UNBACKED_NUMBER] },
    { name: 'superlative with no claim', assessment: BESTCLI_ASSESSMENT, sentence: s('The largest randomized trial of CLTI revascularization to date.', ['design']), reasons: [R.UNBACKED_COMPARATIVE] },
    { name: 'factual sentence with no claim ids', assessment: BESTCLI_ASSESSMENT, sentence: s('Bypass reduced major amputation by a third.', []), reasons: [R.UNTAGGED_ASSERTION] },
    { name: 'direction word contradicts the cited claim', assessment: BESTCLI_ASSESSMENT, sentence: s('In cohort 2, surgery reduced events (HR 0.79).', ['cohort2']), reasons: [R.DIRECTION_WORD_CONTRADICTS_CLAIM] },
    { name: 'withheld estimate printed anyway', assessment: BESTCLI_STATE_A, sentence: s('In cohort 1 surgery led to fewer events (HR 0.68, 95% CI 0.59–0.79).', ['cohort1', 'cohort1-conclusion']), reasons: [R.NUMBER_FROM_WITHHELD_ESTIMATE] },
    { name: 'withheld estimate printed under a badge', assessment: BESTCLI_STATE_A, sentence: s('In cohort 1 surgery led to fewer events (HR 0.68, unverified).', ['cohort1', 'cohort1-conclusion']), reasons: [R.NUMBER_FROM_WITHHELD_ESTIMATE] },
    { name: 'state A direction stated from the withheld claim alone (no conclusion claim cited)', assessment: BESTCLI_STATE_A, sentence: s('In cohort 1 surgery led to fewer events.', ['cohort1']), reasons: [R.DIRECTION_WORD_CONTRADICTS_CLAIM] },
    { name: 'citing a claim the render plan does not show', assessment: { ...BESTCLI_ASSESSMENT, render: { ...BESTCLI_ASSESSMENT.render, display: { ...BESTCLI_ASSESSMENT.render.display, cohort2: 'not-shown' }, claimsShown: ['design', 'primary-def', 'cohort1', 'components-not-separated'], estimatesShown: ['cohort1'] } }, sentence: s('In cohort 2 the two strategies did not differ clearly.', ['cohort2']), reasons: [R.CLAIM_NOT_SHOWN_CITED] },
    { name: 'role word resting on no declared primary', assessment: NO_PRIMARY_ASSESSMENT, sentence: s('The primary outcome, recurrent VTE, favored apixaban (RR 0.85, 95% CI 0.74–0.98).', ['vte-reported']), reasons: [R.ROLE_WORD_UNBACKED] },
    { name: 'personal sentence without item tags', assessment: BESTCLI_ASSESSMENT, sentence: s('Directly relevant to your limb preservation program.', ['design'], { kind: 'for-you' }), reasons: [R.PERSONAL_UNTAGGED] },
  ],

  // Printed bracket rendered as a CI: needs an assessment whose claim carries a 'printed-bracket' interval.
  bracket: {
    assessment: {
      claims: [{ id: 'peroneal', eligibility: 'pass', elements: { comparator: 'bound', outcome: 'bound', direction: 'bound', value: 'bound', interval: 'bound' }, linkage: 'same-sentence', reasons: [] }],
      fidelity: { status: 'pass', reasons: [], inventory: { entries: [], primaryBasis: 'labeled', uncertain: false }, omitted: [] },
      personal: [],
      render: { state: 'full', display: { peroneal: 'shown-with-estimate' }, claimsShown: ['peroneal'], estimatesShown: ['peroneal'], personalShown: [], mainResultShown: true, fallback: null },
      recommendation: { read: 'abstract-enough', basis: [] },
    },
    claimIntervalLabel: 'printed-bracket',
    accepted: s('Peroneal-only runoff was associated with higher adjusted risk of major amputation (HR 1.81 [1.04–3.13]).', ['peroneal']),
    rejected: { sentence: s('Peroneal-only runoff was associated with higher adjusted risk of major amputation (HR 1.81, 95% CI 1.04–3.13).', ['peroneal']), reasons: [R.PROSE_INTERVAL_LABEL_INVENTED] },
  },
}
