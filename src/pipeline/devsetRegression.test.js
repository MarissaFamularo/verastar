// devsetRegression.test.js — regression tests for the six fixes from the 2026-10-11
// Development-set evaluation (67 papers). OFFLINE: every model call is mocked, and the
// inputs are the SAVED Development-set evidence (src/pipeline/__fixtures__/devset/*.json:
// the source text and tables the pipeline verified against, every extracted row with its
// recorded verdict, and the recorded triage take). No Held-out rows are included.
//
// What was recorded and what is reconstructed: the run saved the SANITIZED take (finding,
// design caution, relevance, check verdicts), not the raw model JSON. So the writer's raw
// `finding_plain` and the checker's raw verdict list were not recorded. Where a test needs
// one, it is written inline and marked RECONSTRUCTED; everything else is recorded data.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

vi.mock('../lib/anthropic.js', () => ({
  MODELS: { extraction: 'x', triage: 'x', interview: 'x', fast: 'x' },
  extractStructured: vi.fn(),
  getNcbiKey: () => '',
  getNcbiEmail: () => '',
}))

import { extractStructured } from '../lib/anthropic.js'
import { fmtNum, pQualifier, ciLabel } from '../lib/format.js'
import { claimCheckLabel } from '../lib/claimCheck.js'
import { selectEvidenceContext, evidenceForResult, locateQuote, EVIDENCE_CHARS } from './evidenceContext.js'
import { findPrimary, tagResult, describeTags, primaryScopeVerdict, headlinesNonPrimary } from './primaryResult.js'
import { repairNumberFree } from './numberFree.js'
import { triage, sanitizeRanking, dedupeEstimateLabels, allowedNumbers, numbersGrounded } from './triage.js'
import { checkFindings, NO_VERDICT_REASON, SNIPPET_CHARS } from './check.js'
import { citationDoi, fetchCitation, fetchPmcFullText } from './sources.js'

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'devset')
const load = (id) => JSON.parse(fs.readFileSync(path.join(DIR, `${id}.json`), 'utf8'))
const notFlagged = (row) => !row.verdict.flagged
const verifiedOf = (d, isVerified = notFlagged) =>
  d.rows.filter(isVerified).map((r) => ({ name: r.quantity.name, value: fmtNum(r.quantity), quote: r.quantity.source_quote }))
const OLD_WINDOW = 2600 // the window before fix 1: the first 2,600 chars of sourceDoc.text
const DIGIT = /\d/

beforeEach(() => extractStructured.mockReset())
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------------------
// HF-14 (STICH) first: the null ITT primary sat past the window, the writer saw only the
// verified as-treated / per-protocol HRs, and the finding headlined them.
describe('HF-14 — STICH: results context + primary-result handling together', () => {
  const d = load('HF-14')
  const res = { sourceDoc: d.sourceDoc, rows: d.rows }
  const primaryQuote = d.rows[0].quantity.source_quote // ITT HR 0.86, 95% CI 0.72-1.04, P = 0.12

  it('old window held no result; the new evidence context holds the ITT primary quote', () => {
    expect(d.tier).toBe('full_text')
    expect(locateQuote(d.sourceDoc.text.slice(0, OLD_WINDOW), primaryQuote)).toBeNull()
    const ctx = evidenceForResult(res)
    expect(ctx.length).toBeLessThanOrEqual(EVIDENCE_CHARS)
    expect(locateQuote(ctx, primaryQuote)).not.toBeNull()
    for (const row of d.rows) expect(locateQuote(ctx, row.quantity.source_quote)).not.toBeNull()
  })

  it('identifies the ITT primary as unverified and tags the verified rows as non-randomized', () => {
    const primary = findPrimary(d.rows, notFlagged)
    expect(primary).toMatchObject({ verified: false, indexes: [0, 1] })
    expect(primary.name).toMatch(/^Primary outcome: all-cause death/)
    expect(tagResult(d.rows[5].quantity).population).toBe('as-treated')
    expect(tagResult(d.rows[6].quantity).population).toBe('per-protocol')
    expect(describeTags(tagResult(d.rows[5].quantity))).toContain('NOT the randomized intention-to-treat comparison')
  })

  it('the RECORDED finding loses its numbers (Rule A) and is refuted deterministically (Rule B)', () => {
    const verified = verifiedOf(d)
    const primary = findPrimary(d.rows, notFlagged)
    const recorded = d.recordedTake.finding
    expect(headlinesNonPrimary({ finding: recorded, verified, primary })).toBe(true)
    const before = primaryScopeVerdict({ finding: recorded, verified, primary })
    expect(before).toMatchObject({ verdict: 'refuted', deterministic: true })
    expect(before.reason).toMatch(/per-protocol|as-treated/)

    const out = sanitizeRanking({ id: d.pmid, finding: recorded, finding_plain: '' }, verified, { primary })
    expect(out.finding).not.toMatch(DIGIT)
    // Integration retains the stricter local fallback: missing finding_plain means no finding.
    expect(out.finding).toBe('')

  })

  it('end to end through triage() with recorded inputs and mocked models', async () => {
    const primary = findPrimary(d.rows, notFlagged)
    extractStructured
      .mockResolvedValueOnce({
        rankings: [{
          id: d.pmid, score: d.recordedTake.score, tier: d.recordedTake.tier,
          finding: d.recordedTake.finding, // recorded
          // RECONSTRUCTED: the raw finding_plain was not saved.
          finding_plain: 'CABG plus medical therapy was associated with lower risk of the primary outcome in as-treated and per-protocol analyses.',
          design_caution: d.recordedTake.designCaution, relevance: d.recordedTake.relevance,
        }],
      })
      .mockResolvedValueOnce({ verdicts: [{ id: `design-caution:${d.pmid}`, supported: true, reason: 'ok' }] })

    const [take] = await triage({
      candidates: [{ id: d.pmid, title: 'STICH', design: d.design, summary: evidenceForResult(res), verified: verifiedOf(d), primary }],
    })
    const writerPrompt = extractStructured.mock.calls[0][0].content
    expect(writerPrompt).toContain('hazard ratio with CABG, 0.86; 95% confidence interval [CI], 0.72 to 1.04; P = 0.12')
    expect(writerPrompt).toMatch(/Primary result: Primary outcome: all-cause death.*NOT verified/)
    expect(writerPrompt).toContain('[analysis: as-treated, NOT the randomized intention-to-treat comparison]')
    expect(extractStructured.mock.calls[0][0].system).toMatch(/Never present a secondary, subgroup, per-protocol, or as-treated result as the main result/)

    expect(take.finding).not.toMatch(DIGIT)
    expect(take.check.verdict).toBe('refuted') // withheld by the UI
    // the refuted finding never reached the model checker; the caution did
    const checkerPrompt = extractStructured.mock.calls[1][0].content
    expect(checkerPrompt).not.toContain(`[${d.pmid}] CLAIM`)
    expect(checkerPrompt).toContain(`[design-caution:${d.pmid}] CLAIM`)
    expect(take.cautionCheck.verdict).toBe('supported')
  })
})

// ---------------------------------------------------------------------------------------
describe('fix 1 — results-context selection on saved sources', () => {
  // Full-text papers: the body's first 2,600 chars are background/methods.
  it.each(['CAR-06', 'CAR-07', 'CAR-10', 'CAD-01', 'PAD-02'])('%s (full text): every extracted quote is in the context, none was in the old window', (id) => {
    const d = load(id)
    const ctx = evidenceForResult({ sourceDoc: d.sourceDoc, rows: d.rows })
    const located = d.rows.filter((r) => locateQuote(d.sourceDoc.text, r.quantity.source_quote))
    expect(located.length).toBeGreaterThan(0)
    for (const r of located) {
      expect(locateQuote(d.sourceDoc.text.slice(0, OLD_WINDOW), r.quantity.source_quote)).toBeNull()
      expect(locateQuote(ctx, r.quantity.source_quote)).not.toBeNull()
    }
    expect(ctx.length).toBeLessThanOrEqual(EVIDENCE_CHARS)
    expect(ctx).toContain('RESULT EXCERPTS (verbatim from the source text)')
  })

  // Long abstracts: the results/conclusions sat past char 2,600 and were cut off.
  it.each(['HF-09', 'PAD-05', 'PAD-12', 'PAD-15'])('%s (long abstract): the whole abstract now fits', (id) => {
    const d = load(id)
    expect(d.sourceDoc.text.length).toBeGreaterThan(OLD_WINDOW)
    expect(d.sourceDoc.text.length).toBeLessThanOrEqual(EVIDENCE_CHARS)
    const ctx = evidenceForResult({ sourceDoc: d.sourceDoc, rows: d.rows })
    expect(ctx).toBe(d.sourceDoc.text)
    for (const r of d.rows) expect(locateQuote(ctx, r.quantity.source_quote)).not.toBeNull()
  })

  it('the checker window equals the writer window (same text judged as written)', () => {
    expect(SNIPPET_CHARS).toBeGreaterThanOrEqual(EVIDENCE_CHARS)
  })

  it('a PMC abstract leads the context when the fetch supplies one (SYNTHETIC text; abstracts were not saved)', () => {
    const body = `${'Background prose. '.repeat(400)}The hazard ratio was 0.86 (95% CI, 0.72 to 1.04). ${'Discussion prose. '.repeat(100)}`
    const ctx = selectEvidenceContext({ text: body, abstract: 'ABSTRACT: Results were null.', quotes: ['The hazard ratio was 0.86 (95% CI, 0.72 to 1.04)'] })
    expect(ctx.startsWith('ABSTRACT: Results were null.')).toBe(true)
    expect(ctx).toContain('The hazard ratio was 0.86 (95% CI, 0.72 to 1.04).')
    expect(ctx.length).toBeLessThanOrEqual(EVIDENCE_CHARS)
  })

  it('fetchPmcFullText returns the front-matter abstract, skipping graphical abstracts (SYNTHETIC XML)', async () => {
    const { DOMParser } = await import('linkedom')
    vi.stubGlobal('DOMParser', DOMParser)
    const xml = '<article><front><article-meta><abstract abstract-type="graphical"><p>Graphic.</p></abstract><abstract><sec><title>Results</title><p>HR 0.86; P = 0.12.</p></sec></abstract></article-meta></front><body><sec><p>Body text.</p></sec></body></article>'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => xml }))
    const out = await fetchPmcFullText('PMC1')
    expect(out).toMatchObject({ hasBody: true, tier: 'full_text', text: 'Body text.', abstract: 'Results HR 0.86; P = 0.12.' })
  })
})

// ---------------------------------------------------------------------------------------
describe('fix 2 — primary-result handling on saved rows', () => {
  it.each([
    ['AS-04', /transfemoral-access cohort/],
    ['HF-02', /reduced cardiovascular death versus enalapril/],
    ['PAD-12', /higher all-cause death/],
    ['AS-01', /reduced the composite of death or repeat hospitalization/],
  ])('%s: recorded finding cites only non-primary verified numbers while the primary is unverified → number-free', (id, gist) => {
    const d = load(id)
    const verified = verifiedOf(d)
    const primary = findPrimary(d.rows, notFlagged)
    expect(primary.verified).toBe(false)
    expect(d.recordedTake.finding).toMatch(gist)
    expect(d.recordedTake.finding).toMatch(DIGIT)
    expect(headlinesNonPrimary({ finding: d.recordedTake.finding, verified, primary })).toBe(true)
    const out = sanitizeRanking({ finding: d.recordedTake.finding, finding_plain: '' }, verified, { primary })
    // no statistic left (names such as LCZ696 / BASIL-2 are nomenclature, exempt as before)
    expect(numbersGrounded(out.finding, [])).toBe(true)
    expect(out.finding).not.toMatch(/\d+\.\d+|\d·\d/)
  })

  it('AS-04: the transfemoral row is tagged subgroup; the overall NI row is not', () => {
    const d = load('AS-04')
    expect(tagResult(d.rows[3].quantity).subgroup).toBe(true)
    expect(tagResult(d.rows[2].quantity)).toMatchObject({ subgroup: false, hypothesis: 'noninferiority' })
  })

  it.each(['CAD-01', 'HF-04', 'HF-08', 'HF-13', 'PAD-07', 'CAR-07'])('%s: primary verified → a number-led finding is left alone', (id) => {
    const d = load(id)
    const verified = verifiedOf(d)
    const primary = findPrimary(d.rows, notFlagged)
    expect(primary.verified).toBe(true)
    const out = sanitizeRanking({ finding: d.recordedTake.finding, finding_plain: '' }, verified, { primary })
    expect(out.finding).toMatch(DIGIT)
    expect(primaryScopeVerdict({ finding: out.finding, verified, primary })).toBeNull()
  })

  it('PAD-15, PAD-05, CAR-10: primary state (the model-side fix needs a paid rerun to confirm)', () => {
    expect(findPrimary(load('PAD-15').rows).name).toMatch(/VascuQoL-6.*primary endpoint/)
    // REV2: no PAD-05 row is labelled primary (name or location) → unknown, not row 0
    expect(findPrimary(load('PAD-05').rows)).toMatchObject({ state: 'unknown', name: null, verified: false })
    // REV2: CAR-10's only verified "primary" rows were the symptomatic/asymptomatic subgroups
    expect(findPrimary(load('CAR-10').rows)).toMatchObject({ state: 'identified', verified: false, indexes: [0, 1, 2] })
  })

  it('per-protocol noninferiority is NOT treated as a non-randomized headline', () => {
    const t = tagResult({ name: 'Primary end point, per-protocol noninferiority analysis', source_quote: 'P<0.001 for noninferiority' })
    expect(describeTags(t)).not.toMatch(/NOT the randomized/)
    expect(primaryScopeVerdict({
      finding: 'TAVR was noninferior in the per-protocol analysis.',
      verified: [], primary: { name: 'x', verified: false },
    })).toBeNull()
  })

  it('the writer prompt marks a verified primary and passes tags (mocked call)', async () => {
    const d = load('AS-06')
    const primary = findPrimary(d.rows, notFlagged)
    extractStructured.mockResolvedValueOnce({ rankings: [] })
    await triage({ candidates: [{ id: d.pmid, title: 't', summary: d.sourceDoc.text, verified: verifiedOf(d), primary }] })
    const prompt = extractStructured.mock.calls[0][0].content
    expect(prompt).toMatch(/Primary result: .*\(verified; listed below\)/)
    // AS-06 rows 0 and 2 verified; row 2's quote says "P = 0.001 for superiority"
    expect(prompt).toMatch(/1-year primary composite end point \(death, stroke, or rehospitalization\), TAVR vs surgery: .*\[PRIMARY\]/)
    expect(prompt).toContain('[superiority test]')
  })
})

// ---------------------------------------------------------------------------------------
describe('fix 3 — number-free repair (inputs RECONSTRUCTED from recorded garbled outputs)', () => {
  // Left: the most likely pre-strip sentence, rebuilt from the recorded output and the
  // paper's source. Middle: what was RECORDED (old strip). Right: the repaired output.
  it.each([
    ['AAA-06', 'Endovascular repair cut 30-day operative mortality versus open repair.', 'cut day operative mortality', 'Endovascular repair cut operative mortality versus open repair.'],
    ['AAA-12', 'An endovascular strategy did not significantly reduce 30-day mortality versus open repair.', 'reduce day mortality', 'An endovascular strategy did not significantly reduce mortality versus open repair.'],
    ['AAA-14', 'Doxycycline did not slow aneurysm growth over 2 years.', 'growth over years', 'Doxycycline did not slow aneurysm growth.'],
    ['AAA-04', 'Early surgery did not improve survival, supporting surveillance for aneurysms in the 4.0 to 5.5 cm range.', 'in the to cm range', 'Early surgery did not improve survival, supporting surveillance for aneurysms.'],
    ['AAA-13', 'Endovascular repair lowered the composite of death and severe complications at 30 days.', 'at days.', 'Endovascular repair lowered the composite of death and severe complications.'],
    ['CAR-04', 'Endarterectomy reduced the 5-year risk of ipsilateral stroke.', 'reduced the year risk', 'Endarterectomy reduced the risk of ipsilateral stroke.'],
    ['CAR-04', 'This landmark trial reflects 1980s-1990s medical therapy, so absolute benefits may be smaller today.', 'reflects s-1990s medical therapy', 'This landmark trial reflects earlier-era medical therapy, so absolute benefits may be smaller today.'],
    ['CAR-13', 'This is a 30-day periprocedural analysis, so long-term durability is not addressed.', 'This is a day periprocedural analysis', 'This is a periprocedural analysis, so long-term durability is not addressed.'],
    ['PAD-05', 'Trials were short, ranging from about six to 12 weeks, and the evidence was of low quality.', 'ranging from about six to weeks', 'Trials were short, and the evidence was of low quality.'],
  ])('%s', (_id, input, recordedGarble, repaired) => {
    expect(repairNumberFree(input)).toBe(repaired)
    expect(repaired).not.toContain(recordedGarble)
    expect(repaired).not.toMatch(DIGIT)
  })

  it('the recorded garbled outputs really were recorded (fixture check)', () => {
    expect(load('AAA-06').recordedTake.finding).toContain('cut day operative mortality')
    expect(load('CAR-04').recordedTake.finding).toContain('reduced the year risk')
    expect(load('CAR-13').recordedTake.designCaution).toContain('This is a day periprocedural analysis')
    expect(load('PAD-05').recordedTake.designCaution).toContain('ranging from about six to weeks')
  })

  it('never lets a gated digit through; returns "" when a clean sentence is impossible', () => {
    for (const s of ['1,200 patients were randomized.', 'P<0.001.', 'The 2008 cohort had fewer patients, limiting comparison.']) {
      const out = repairNumberFree(s)
      expect(out).not.toMatch(/(?<![a-z-])\d/i)
    }
    expect(repairNumberFree('P<0.001.')).toBe('')
    expect(repairNumberFree('TcPO2 and SF-36 improved with therapy.')).toBe('TcPO2 and SF-36 improved with therapy.')
  })

  it('sanitizeRanking uses the repair for design caution and relevance', () => {
    const out = sanitizeRanking({ finding: 'x', design_caution: 'This is a 30-day periprocedural analysis, so long-term durability is not addressed.', relevance: 'Validates your 30-day endpoint.' }, [])
    expect(out.designCaution).toBe('This is a periprocedural analysis, so long-term durability is not addressed.')
    expect(out.relevance).toBe('Validates your endpoint.')
  })
})

// ---------------------------------------------------------------------------------------
describe('fix 4 — statistical qualifiers and labels, rendered from saved rows', () => {
  const row = (id, i) => load(id).rows[i].quantity
  it.each([
    ['CAR-01', 1, '17 percent, P<0.001'], // "(P less than 0.001)" — was "P 0.001"
    ['AS-05', 2, '>0.999'], // posterior probability of noninferiority, >0.999 — was "0.999"
    ['AAA-14', 0, '0.0262 versus -0.0258 normal score, one-sided P=.71'],
    ['AAA-14', 2, '0.0 cm (CI -0.07–0.07), two-sided P=.93'],
    ['AS-06', 1, '-6.6 percentage points (CI -10.8–-2.5), P<0.001 for noninferiority'],
    ['AS-06', 2, '0.54 hazard ratio (CI 0.37–0.79), P=0.001 for superiority'],
    ['CAD-10', 1, '1.16 hazard ratio (CI 1.01–1.33), P=0.44 for noninferiority'],
    ['CAD-15', 0, '-0.09 percentage points (CI -1.39–1.20), P=0.02 for noninferiority'],
    ['CAD-15', 2, '0.46 hazard ratio (CI 0.29–0.75), P=0.002 for superiority'],
    ['PAD-03', 1, 'P<0.001'], // P-only row — was ""
    ['PAD-03', 2, 'P<0.01'],
    ['PAD-01', 0, '282 m (99% CI 60–505)'], // was "(CI 60–505)"
    ['AS-08', 1, '-1.4 percentage points (95% credible interval -4.9–2.1)'],
    ['CAD-01', 2, 'invasive-strategy group: 5.3% versus conservative-strategy group: 3.4%'],
    ['AS-07', 0, 'TAVR group: 22.8% versus surgery group: 27.2%, P=0.07'],
    ['HF-10', 2, '96.6%, P<0.001 for comparison with the performance goal'],
  ])('%s row %i', (id, i, expected) => {
    expect(fmtNum(row(id, i))).toBe(expected)
  })

  it('qualifiers come only from the quote', () => {
    expect(pQualifier({ p_value: 0.05, source_quote: 'P = 0.05' })).toBeNull()
    expect(ciLabel({ source_quote: '95% CI, 0.7 to 0.9' })).toBe('CI')
  })

  it('a CI level is a label, not an allowed number — the guard is not widened', () => {
    const verified = [{ name: 'x', value: fmtNum(row('PAD-01', 0)) }]
    expect(allowedNumbers(verified)).not.toContain(99)
    expect(numbersGrounded('improved by 282 m (99% CI 60–505)', allowedNumbers(verified), [], [99])).toBe(true)
    expect(numbersGrounded('99 patients improved', allowedNumbers(verified), [], [99])).toBe(false)
  })

  it.each(['PAD-07', 'CAD-01', 'HF-04', 'HF-13', 'AS-04', 'HF-08'])('%s: doubled estimate label removed, numbers unchanged', (id) => {
    const recorded = load(id).recordedTake.finding
    const out = dedupeEstimateLabels(recorded)
    expect(out).not.toMatch(/\b(?:HR|hazard ratio) [\d.]+ hazard ratio|rate ratio [\d.]+ rate ratio|odds ratio [\d.]+ odds ratio/)
    expect(out.match(/\d+(?:\.\d+)?/g)).toEqual(recorded.match(/\d+(?:\.\d+)?/g))
  })
})

// ---------------------------------------------------------------------------------------
describe('fix 5 — DOI from esummary articleids (recorded NCBI esummary)', () => {
  const esummary = JSON.parse(fs.readFileSync(path.join(DIR, 'esummary_doi_rows.json'), 'utf8'))
  const rec = (pmid) => esummary.result[pmid]

  it('takes the DOI from articleids when elocationid is empty', () => {
    // CAR-01, CAR-03, AAA-01, AAA-05, AAA-06, CAR-12, CAR-13, AAA-11
    for (const pmid of ['1852179', '15043958', '12443589', '12000813', '15351191', '17050890', '17027729', '15978926']) {
      expect(rec(pmid).elocationid || '').toBe('')
      const doi = citationDoi(rec(pmid))
      expect(doi).toMatch(/^10\.\S+$/)
      expect(doi).toBe(rec(pmid).articleids.find((a) => a.idtype === 'doi').value)
    }
  })

  it('falls back to elocationid, and returns null when PubMed has no DOI', () => {
    expect(citationDoi(rec('24418950'))).toBe('10.1136/bmj.f7661') // AAA-12: both fields agree
    for (const pmid of ['7723155', '9593407', '9853436']) expect(citationDoi(rec(pmid))).toBeNull() // CAR-04, CAR-02, AAA-04: no DOI in PubMed
    expect(citationDoi({ elocationid: 'doi: 10.1136/bmj.f7661', articleids: [] })).toBe('10.1136/bmj.f7661')
  })

  it('fetchCitation surfaces it (fetch mocked with the recorded response)', async () => {
    const empty = { getItem: vi.fn().mockReturnValue(null), setItem: vi.fn(), removeItem: vi.fn() }
    vi.stubGlobal('sessionStorage', empty)
    vi.stubGlobal('localStorage', empty)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ result: { '17050890': rec('17050890') } }) }))
    const c = await fetchCitation('17050890') // CAR-12: elocationid empty — was doi: null
    expect(c.doi).toBe('10.1056/NEJMoa061752')
  })
})

// ---------------------------------------------------------------------------------------
describe('fix 6 — checker results are never silently dropped (CAR-12)', () => {
  const d = load('CAR-12')
  it('the recorded CAR-12 take came back unchecked with no reason', () => {
    expect(d.recordedTake.check).toEqual({ verdict: 'unchecked', reason: '' })
    // Invisible before fix 6; since 2026-10-14 an unchecked claim is labelled even with no reason.
    expect(claimCheckLabel(d.recordedTake.check)).toMatchObject({ text: 'claim not checked', tone: 'muted' })
  })

  it('decorated ids match; unmatched ids are logged; omitted claims carry a reason', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // RECONSTRUCTED checker reply: the raw CAR-12 verdict list was not recorded.
    extractStructured.mockResolvedValueOnce({
      verdicts: [
        { id: `[${d.pmid}]`, supported: true, reason: 'snippet states it' },
        { id: 'design-caution-24418950-typo', supported: true, reason: 'x' },
      ],
    })
    const snippet = d.sourceDoc.text
    const out = await checkFindings({
      items: [
        { id: d.pmid, finding: 'Stenting carried more early stroke or death than endarterectomy.', snippet },
        { id: `design-caution:${d.pmid}`, finding: 'Observational design.', snippet },
      ],
    })
    expect(out.get(d.pmid).verdict).toBe('supported')
    expect(out.get(`design-caution:${d.pmid}`)).toEqual({ verdict: 'unchecked', reason: NO_VERDICT_REASON })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('design-caution-24418950-typo'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`design-caution:${d.pmid}`))
    expect(claimCheckLabel(out.get(`design-caution:${d.pmid}`))).toMatchObject({ text: 'claim not checked', tone: 'muted' })
  })

  it('a checker failure is surfaced per claim, never as a silent empty reason', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    extractStructured
      .mockResolvedValueOnce({ rankings: [{ id: d.pmid, score: 1, tier: 2, finding: 'Endarterectomy was safer early.', finding_plain: '', design_caution: '', relevance: '' }] })
      .mockRejectedValueOnce(new Error('rate limited'))
    const [take] = await triage({ candidates: [{ id: d.pmid, title: 't', summary: d.sourceDoc.text, verified: verifiedOf(d) }] })
    expect(take.check).toEqual({ verdict: 'unchecked', reason: 'Not checked: the source check failed (rate limited).' })
    expect(claimCheckLabel(take.check).text).toBe('claim not checked')
  })
})

// AS-02 is NOT addressed by these fixes: its refute was a checker misread of a snippet that
// did contain the result (the text was within the old window). Recorded here so nobody
// reads a pass of this suite as covering it.
describe('known residual — AS-02 checker misread', () => {
  it('its quotes were already inside the old window (not a truncation case)', () => {
    const d = load('AS-02')
    for (const r of d.rows) expect(locateQuote(d.sourceDoc.text.slice(0, OLD_WINDOW), r.quantity.source_quote)).not.toBeNull()
    expect(d.recordedTake.check.verdict).toBe('refuted')
  })
})
