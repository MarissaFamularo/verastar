// betaAudit.prose.test.js — pre-beta adversarial probes of the two-channel rule.
// Every test asserts the SAFE outcome. A failing test is a real finding, not a bug in the
// test: it documents an input the gate lets through (or a render rule that can show an
// unverified number as fact). Synthetic fixtures only. Pure functions + mocked model calls.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/anthropic.js', () => ({
  MODELS: { extraction: 'x', triage: 'x', interview: 'x', fast: 'x' },
  extractStructured: vi.fn(),
}))

import { extractStructured } from '../lib/anthropic.js'
import { sanitizeRanking, numbersGrounded, triage } from './triage.js'
import { repairNumberFree } from './numberFree.js'
import { checkFindings, reasonAdmitsMissingEvidence } from './check.js'
import { linkFindingNumbers, claimCheckLabel } from '../lib/claimCheck.js'
import { usableFinding } from '../lib/findingGate.js'
import { badgeWord } from '../lib/badgeWord.js'
import { evidenceVerdict, isRelationshipValidated, VERIFICATION_VERSION } from '../lib/evidenceVersion.js'
import { regateTriaged } from '../lib/digestStore.js'

beforeEach(() => extractStructured.mockReset())

const base = { id: 'p1', score: 70, tier: 1, finding: 'Unbacked 99 claim.', design_caution: '', relevance: 'Relevant.' }
const V = [{ name: 'hazard ratio', value: '0.84 (CI 0.61–1.16)', quote: 'hazard ratio 0.84 (95% CI 0.61-1.16) at 12 months' }]
// finding_plain is the fallback the app renders when `finding` fails; the field the model
// is told to keep digit-free. The safe outcome for a leaking fallback is '' (withheld).
const plainOut = (finding_plain) => sanitizeRanking({ ...base, finding_plain }, V).finding
const relOut = (relevance) => sanitizeRanking({ ...base, finding_plain: 'Fine.', relevance }, V).relevance
const free = (s) => numbersGrounded(s, [])

describe('1a. digits in every disguise are caught by the guard', () => {
  it.each([
    ['plain', 'Mortality fell by 12 percent.'],
    ['percent sign', 'Mortality fell 12%.'],
    ['markdown bold', 'Mortality fell by **12**%.'],
    ['markdown link', 'Mortality fell by [12](http://x).'],
    ['parenthetical', 'Mortality fell (12).'],
    ['after colon', 'Result: 12 deaths.'],
    ['n=', 'Enrolled (n=412).'],
    ['p-value', 'Significant (p<0.05).'],
    ['leading-dot p', 'Significant (p<.05).'],
    ['approx', 'About ~30 patients.'],
    ['negative', 'Change of -3 points.'],
    ['year', 'Published in 2019.'],
    ['decade', 'Cohort from the 1990s.'],
    ['thousands', 'Among 1,200 patients.'],
    ['interpunct decimal', 'Ratio 0·84.'],
    ['hyphenated timepoint', 'The 5-year outcome improved.'],
    ['stage', 'Stage 3 disease improved.'],
    ['dose', 'Dosed at 75 mg daily.'],
    ['ci level', 'The 95% CI excluded the null.'],
    ['full-width digits', 'Mortality fell by １２ percent.'],
    ['circled digit', 'Mortality fell by ⑫ percent.'],
    ['vulgar fraction', 'Mortality fell by ½.'],
    ['superscript exponent', 'Counts of 10⁶ cells.'],
    ['zero-width split', 'Mortality fell by 1​2 percent.'],
  ])('%s -> finding withheld', (_n, text) => {
    expect(plainOut(text)).toBe('')
  })
  it('Arabic-Indic digits are not treated as digits (JS \\d is ASCII; NFKC leaves them)', () => {
    expect(free('Mortality fell by ١٢ percent.')).toBe(false)
  })
})

describe('1b. nomenclature is allowed (deliberate): names carry digits', () => {
  it.each(['COVID-19', 'CREST-2', 'PD-1', 'TcPO2', 'SF-36', 'P2Y12', 'CD34', 'HbA1c', 'Class IIa'])('%s survives', (name) => {
    expect(plainOut(`Outcomes in ${name} patients were similar.`)).toBe(`Outcomes in ${name} patients were similar.`)
  })
  it('a name-like glue must not smuggle a statistic: HR0.84 / HR-0.84 / x2 / OR0.5', () => {
    for (const t of ['The HR0.84 favoured treatment.', 'The HR-0.84 favoured treatment.', 'A x2 higher risk.', 'The OR0.5 favoured treatment.', 'Risk RR1.4 in smokers.']) {
      expect(plainOut(t), t).toBe('')
    }
  })
  it('over-gating (conservative, safe): "type 2 diabetes" is withheld in the fallback', () => {
    expect(plainOut('Benefit in type 2 diabetes.')).toBe('')
  })
})

describe('1c. spelled-out and implied numbers (no digit for the guard to see)', () => {
  // [policy] The prompt deliberately asks finding_plain for "roughly halved the risk"; the guard is
  // digit-based by design. Whether spelled magnitudes ("twelve percent", "halved", "a third")
  // may appear unbadged in finding_plain / relevance / design_caution is the product owner's
  // call (2026-10-14 beta audit, prose finding A). Probes kept as todos until decided.
  it.todo('[policy] "Mortality fell by twelve percent." / "halved" / "doubled" / "one in five" / "seven patients" in finding_plain, relevance, design_caution')
  it.todo('[policy] a grounded finding can carry an unverified spelled number beside a verified digit')
})

describe('1d. the repair path (relevance / design_caution) re-checks with a weaker tokenizer', () => {
  it.each([
    ['full-width digits', 'Cuts risk by ２５ percent in your cohort.'],
    ['circled digit', 'Cuts risk by ㉕ percent in your cohort.'],
    ['fraction', 'Cuts risk by ½ in your cohort.'],
  ])('relevance with %s must not render', (_n, t) => {
    const out = relOut(t)
    expect(out).not.toMatch(/[２５㉕½]/)
  })
  it('repairNumberFree itself returns text that contains a number the guard would reject', () => {
    const out = repairNumberFree('Cuts risk by ２５ percent.')
    expect(free(out) || out === '').toBe(true)
  })
  it('ASCII digits are repaired cleanly or dropped', () => {
    const out = relOut('Cuts mortality by 25 percent in your cohort, a key north star.')
    expect(free(out)).toBe(true)
  })
})

describe('1e. verified-number laundering inside a grounded finding', () => {
  it('a timepoint printed as months cannot be reused as days/weeks', () => {
    for (const unit of ['days', 'weeks', 'years']) {
      const out = sanitizeRanking({ ...base, finding: `No clear difference at 12 ${unit}.`, finding_plain: 'No statistically clear difference.' }, V)
      expect(out.finding, unit).toBe('No statistically clear difference.')
    }
  })
  it('a verified timepoint (12 months) is accepted in its own unit', () => {
    const out = sanitizeRanking({ ...base, finding: 'No clear difference at 12 months.', finding_plain: 'x' }, V)
    expect(out.finding).toBe('No clear difference at 12 months.')
  })
  it.todo('[policy] allowedNumbers is unit-blind (0.84 as a percent); only the model claim gate catches it today')
  it('a verified 0.84 cannot launder 0.8 or 84', () => {
    for (const f of ['HR 0.8 favoured treatment.', 'HR 84 favoured treatment.']) {
      expect(sanitizeRanking({ ...base, finding: f, finding_plain: 'Lower hazard.' }, V).finding).toBe('Lower hazard.')
    }
  })
  it('an unverified-primary paper drops cited numbers (02f9468), with explicit null and unknown', () => {
    for (const primary of [{ state: 'unknown', name: null, verified: false }, { state: 'identified', name: 'x', verified: false }]) {
      const out = sanitizeRanking({ ...base, finding: 'HR 0.84 for the endpoint.', finding_plain: 'Lower hazard.' }, V, { primary })
      expect(out.finding).toBe('Lower hazard.')
    }
  })
})

describe('2. render-path building blocks', () => {
  const current = { verificationVersion: VERIFICATION_VERSION, relationshipValidated: true, flagged: false }
  it('missing / null / empty verdicts are legacy-unchecked and never validated', () => {
    for (const v of [undefined, null, {}, { flagged: false, tier: 'verified-full-text' }]) {
      expect(evidenceVerdict(v).tier).toBe('legacy-unchecked')
      expect(evidenceVerdict(v).flagged).toBe(true)
      expect(isRelationshipValidated(v)).toBe(false)
    }
  })
  it('flagged / null / unknown tiers render the Flagged word, never Verified', () => {
    for (const t of ['flagged', null, undefined, '', 'bogus', 'VERIFIED-FULL-TEXT']) expect(badgeWord(t)).toBe('Flagged')
  })
  it('legacy-unchecked is worded as outdated, source-located as unresolved', () => {
    expect(badgeWord('legacy-unchecked')).toBe('Outdated')
    expect(badgeWord('source-located')).toBe('Unresolved')
  })
  it('a current verdict with a non-verified tier is never counted as a validated claim', () => {
    for (const tier of ['flagged', 'source-located', 'bogus', null, undefined]) {
      expect(isRelationshipValidated({ ...current, tier }), String(tier)).toBe(false)
    }
  })
  it('a validated verdict whose badge would read Flagged/Unresolved is not "Verified"', () => {
    const tier = 'source-located'
    expect(isRelationshipValidated({ ...current, tier })).toBe(false)
    expect(badgeWord(tier)).not.toBe('Verified')
  })
  it.todo('[policy] abstract-only / user-text badges read the same one word as full text; qualification is in the tap panel')
})

describe('2b. a saved finding is re-gated when the verifier later demotes its number', () => {
  // reviveDigest re-derives row verdicts AND re-runs the number guard on the saved finding
  // against the rows that are validated NOW (lib/digestStore.js regateTriaged, 2026-10-14).
  const validatedRow = { quantity: { name: 'hazard ratio', quantity_type: 'single', value: 0.84, ci_low: 0.61, ci_high: 1.16, source_quote: 'HR 0.84 (95% CI 0.61-1.16)' }, verdict: { verificationVersion: VERIFICATION_VERSION, tier: 'verified-estimate', flagged: false, relationshipValidated: true } }
  const demotedRow = { ...validatedRow, verdict: { verificationVersion: VERIFICATION_VERSION, tier: 'flagged', flagged: true, relationshipValidated: false } }
  const take = { finding: 'Reduced the primary composite (HR 0.84, CI 0.61–1.16).', check: { verdict: 'supported', reason: '' } }
  it('a finding whose numbers no validated row carries is withheld on restore', () => {
    const out = regateTriaged({ p1: take }, [{ paper: { id: 'p1' }, rows: [demotedRow] }])
    expect(out.p1.finding).toBe('')
    expect(out.p1.findingWithheld).toBe('stale-numbers')
  })
  it('a finding still backed by a validated row is kept as saved', () => {
    const out = regateTriaged({ p1: take }, [{ paper: { id: 'p1' }, rows: [validatedRow] }])
    expect(out.p1).toBe(take)
  })
  it('a finding with a number from no row at all is withheld; a number-free finding passes', () => {
    const stray = { finding: 'HR 0.84 versus 0.91 in the sensitivity analysis.' }
    expect(regateTriaged({ p1: stray }, [{ paper: { id: 'p1' }, rows: [validatedRow] }]).p1.finding).toBe('')
    const plain = { finding: 'Lower hazard with treatment.' }
    expect(regateTriaged({ p1: plain }, [{ paper: { id: 'p1' }, rows: [] }]).p1).toBe(plain)
  })
  it('nomenclature is never linked to a verified row', () => {
    const rows = [{ quantity: { name: 'x', quantity_type: 'single', value: 19 } }, { quantity: { name: 'y', quantity_type: 'single', value: 2 } }]
    expect(linkFindingNumbers('COVID-19 and CREST-2 patients.', rows).some((s) => s.row)).toBe(false)
  })
})

describe('2c. claim label and withheld findings', () => {
  it('refuted and unknown verdicts carry no positive label', () => {
    for (const c of [{ verdict: 'refuted' }, { verdict: 'SUPPORTED' }, { verdict: 'bogus' }, null, undefined]) {
      const l = claimCheckLabel(c)
      expect(l === null || l.tone === 'muted').toBe(true)
    }
  })
  it('an unchecked finding with NO reason renders silently (no "claim not checked" marker)', () => {
    expect(claimCheckLabel({ verdict: 'unchecked', reason: '' })).not.toBe(null)
    expect(claimCheckLabel(undefined)).not.toBe(null)
  })
  it('usableFinding withholds a refuted finding', () => {
    expect(usableFinding({ finding: 'x', check: { verdict: 'refuted' } })).toBe('')
  })
})

describe('3. the prose gate itself (check.js) under hostile / malformed model output', () => {
  const item = { id: 'p1', finding: 'Reduced events.', snippet: 'RESULTS: events were reduced.' }
  it.each([
    ['verdicts null', { verdicts: null }],
    ['no verdicts key', {}],
    ['supported as string', { verdicts: [{ id: 'p1', supported: 'true', reason: 'ok' }] }],
    ['supported as 1', { verdicts: [{ id: 'p1', supported: 1, reason: 'ok' }] }],
    ['supported missing', { verdicts: [{ id: 'p1', reason: 'ok' }] }],
    ['wrong id', { verdicts: [{ id: 'p9', supported: true, reason: 'ok' }] }],
  ])('%s never yields "supported"', async (_n, payload) => {
    extractStructured.mockResolvedValue(payload)
    const out = await checkFindings({ items: [item] })
    expect(out.get('p1').verdict).not.toBe('supported')
  })
  it('duplicate verdicts for one id: any refute wins (first-verdict-wins would let a later refute be dropped)', async () => {
    extractStructured.mockResolvedValue({ verdicts: [{ id: 'p1', supported: true, reason: 'ok' }, { id: 'p1', supported: false, reason: 'null result' }] })
    expect((await checkFindings({ items: [item] })).get('p1').verdict).toBe('refuted')
  })
  it('a positive boolean with a reason that admits missing evidence is refuted', () => {
    for (const r of [
      'The snippet does not state the timepoint.',
      'Not mentioned in the snippet.',
      'The snippet is silent on blinding.',
      'Cannot be confirmed from the snippet.',
      'No evidence in the abstract for this population.',
      'Timepoint absent from the source text.',
      'Unable to verify against the excerpt.',
    ]) expect(reasonAdmitsMissingEvidence(r), r).toBe(true)
  })
  it('a finding with an empty snippet is not sent to the model and carries a visible reason', async () => {
    const out = await checkFindings({ items: [{ id: 'p1', finding: 'Reduced events.', snippet: '' }] })
    expect(out.get('p1').verdict).toBe('unchecked')
    expect(out.get('p1').reason).not.toBe('')
    expect(extractStructured).not.toHaveBeenCalled()
  })
})

describe('3b. triage() when the gate fails (timeout / network / malformed JSON)', () => {
  const cand = { id: 'p1', title: 'T', summary: 'RESULTS: events were reduced.', design: 'RCT', verified: V, primary: { state: 'identified', name: 'x', verified: true } }
  const ranking = { rankings: [{ id: 'p1', score: 80, tier: 1, finding: 'HR 0.84 for events.', finding_plain: 'Lower hazard.', design_caution: 'Open label.', relevance: 'Matters.' }] }
  it('failure carries a visible reason on both the finding and the caution', async () => {
    extractStructured.mockResolvedValueOnce(ranking).mockRejectedValueOnce(new Error('timeout'))
    const [take] = await triage({ candidates: [cand] })
    expect(take.check.verdict).toBe('unchecked')
    expect(take.check.reason).toMatch(/timeout/)
    expect(take.cautionCheck.reason).toMatch(/timeout/)
  })
  it('malformed (null) gate response is treated as a failure, not as supported', async () => {
    extractStructured.mockResolvedValueOnce(ranking).mockResolvedValueOnce(null)
    const [take] = await triage({ candidates: [cand] })
    expect(take.check.verdict).toBe('unchecked')
    expect(take.check.reason).not.toBe('')
  })
  it.todo('[policy] on gate failure the finding renders with a muted claim-not-checked label; withhold instead?')
  it('the deterministic number guard still runs when the gate fails', async () => {
    extractStructured
      .mockResolvedValueOnce({ rankings: [{ ...ranking.rankings[0], finding: 'Cut risk by 77%.', finding_plain: 'Lower hazard.' }] })
      .mockRejectedValueOnce(new Error('timeout'))
    const [take] = await triage({ candidates: [cand] })
    expect(take.finding).toBe('Lower hazard.')
  })
})
