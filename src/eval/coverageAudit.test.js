// Coverage-audit harness, fully offline. SYNTHETIC paper and fake provider only; nothing
// here measures model accuracy.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { DOMParser } from 'linkedom'
import { planCoverageAudit, coverageSummary, runCoverageAudit, validateCoverageAudit, normalizeForQuote, extractionReportSha256, COVERAGE_SCHEMA, MAX_FINDINGS } from './coverageAudit.js'
import { planSinglePaper, runSinglePaper } from './singlePaper.js'

const SYNTH = `<?xml version="1.0"?><pmc-articleset><article><front><article-meta>
<abstract><sec><title>Methods</title><p>Adults were randomized.</p></sec></abstract>
</article-meta></front><body>
<sec sec-type="results"><title>Results</title><p>The primary end point occurred in 7.2% and 6.8% (hazard ratio, 1.11; 95% CI, 0.81 to 1.51; P = 0.51). Major bleeding occurred in 1.1% vs. 2.3%, P = 0.03. Stroke alone occurred in 0.4% vs 0.9%.</p></sec>
</body></article></pmc-articleset>`

const EXTRACTION = {
  study_id: '1', design: 'RCT',
  quantities: [{ name: 'primary composite (HR)', quantity_type: 'single', value: 1.11, range_low: null, range_high: null, first_label: null, first_value: null, second_label: null, second_value: null, unit: 'HR', ci_low: 0.81, ci_high: 1.51, p_value: 0.51, source_quote: 'hazard ratio, 1.11; 95% CI, 0.81 to 1.51; P = 0.51', location_hint: 'Results' }],
}

const realParser = globalThis.DOMParser
beforeAll(() => { globalThis.DOMParser = DOMParser })
afterAll(() => { globalThis.DOMParser = realParser })

async function liveReport(over = {}) {
  const plan = await planSinglePaper({ caseId: 'CAR-10', pmid: '1', pmcXml: SYNTH })
  const run = await runSinglePaper(plan, async () => structuredClone(EXTRACTION), { label: 'fake' })
  return { mode: 'live', plan: { caseId: plan.caseId, pmid: plan.pmid, sourceSha256: plan.sourceSha256, extractionInputSha256: plan.extractionInputSha256 }, run: { ...run, provider: 'live', note: 'Synthetic live-shaped fixture; no live model was called.' }, ...over }
}
const args = (report, extra = {}) => ({ caseId: 'CAR-10', pmid: '1', pmcXml: SYNTH, extractionReport: report, ...extra })
const finding = (over = {}) => ({ category: 'major_harm_safety', outcome: 'Major bleeding', population: 'index study', timepoint: null, source_quote: 'Major bleeding occurred in 1.1% vs. 2.3%, P = 0.03', assessment: 'possibly_missing', extraction_row_indices: [], reason: 'No extracted row names bleeding.', ...over })
const ctx = async () => { const p = await planCoverageAudit(args(await liveReport())); return { corpusText: p.corpusText, rowCount: p.extractionRowCount } }

describe('planning', () => {
  it('binds the whole report by hash and makes no model call; summary omits source and extraction', async () => {
    const report = await liveReport()
    const plan = await planCoverageAudit(args(report, { model: 'claude-sonnet-5-5', maxUsd: 5 }))
    expect(plan.extractionReportSha256).toBe(await extractionReportSha256(report))
    expect(plan.requestSettings.requestSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(plan.withinBound).toBe(true)
    const text = JSON.stringify(coverageSummary(plan))
    expect(text).not.toContain('Major bleeding')
    expect(text).not.toContain('primary composite')
    expect(coverageSummary(plan).request.contentChars).toBeGreaterThan(0)
    expect(plan.request.content).toContain('untrusted')
  })
  it('changing any part of the report changes its hash', async () => {
    const a = await liveReport()
    const b = await liveReport()
    b.run.rows[0].quantity.value = 9
    expect(await extractionReportSha256(a)).not.toBe(await extractionReportSha256(b))
  })
  it('rejects wrong case, pmid, source, input hash, mode, and malformed rows', async () => {
    const r = await liveReport()
    await expect(planCoverageAudit(args({ ...r, plan: { ...r.plan, caseId: 'CAR-11' } }))).rejects.toThrow(/caseId/)
    await expect(planCoverageAudit(args({ ...r, plan: { ...r.plan, pmid: '2' } }))).rejects.toThrow(/pmid/)
    await expect(planCoverageAudit(args({ ...r, plan: { ...r.plan, sourceSha256: 'x' } }))).rejects.toThrow(/sourceSha256/)
    await expect(planCoverageAudit(args({ ...r, plan: { ...r.plan, extractionInputSha256: 'x' } }))).rejects.toThrow(/extractionInputSha256/)
    await expect(planCoverageAudit(args({ ...r, mode: 'fake' }))).rejects.toThrow(/live run/)
    await expect(planCoverageAudit(args({ ...r, run: { provider: 'live', rows: 'no' } }))).rejects.toThrow(/run\.rows/)
    await expect(planCoverageAudit(args(null))).rejects.toThrow(/report object/)
  })
  it('the schema has no complete/pass/fail/score field', () => {
    expect(JSON.stringify(COVERAGE_SCHEMA)).not.toMatch(/complete|pass|fail|score/)
  })
})

describe('validation', () => {
  it('a dropped safety component stays a review flag; represented is not proof', async () => {
    const c = await ctx()
    const v = validateCoverageAudit({ findings: [finding(), finding({ outcome: 'Primary', category: 'primary_endpoint', source_quote: 'hazard ratio, 1.11; 95% CI, 0.81 to 1.51', assessment: 'represented', extraction_row_indices: [0] })], uncertainty_notes: [] }, c)
    expect(v.accepted).toHaveLength(2)
    expect(v.accepted.every((f) => f.review === 'needs_clinical_review')).toBe(true)
    expect(v.status).toBe('findings-pending-review')
    expect(v.clinicalScore).toBeNull()
    expect(JSON.stringify(v)).not.toMatch(/"complete"|no omissions|"pass"/)
  })
  it('empty, malformed or failed output is coverage-undetermined, never no-omissions', async () => {
    const c = await ctx()
    for (const raw of [{ findings: [], uncertainty_notes: [] }, null, 'x', {}, { findings: 'no' }, { findings: [finding({ source_quote: 'invented text' })] }]) {
      const v = validateCoverageAudit(raw, c)
      expect(v.status).toBe('coverage-undetermined')
      expect(v.accepted).toEqual([])
      expect(v.raw).toEqual(raw)
    }
  })
  it('rejects an invented quote and fuzzy numerical proximity', async () => {
    const c = await ctx()
    const v = validateCoverageAudit({ findings: [finding({ source_quote: 'Major bleeding occurred in 1.2% vs. 2.3%' }), finding({ source_quote: 'bleeding was more common with treatment' })], uncertainty_notes: [] }, c)
    expect(v.accepted).toHaveLength(0)
    expect(v.rejected.every((r) => r.reasons.some((x) => /not found/.test(x)))).toBe(true)
  })
  it('normalization is source-only: case, spacing, dashes and curly quotes fold; nothing fuzzy', () => {
    expect(normalizeForQuote('  A\u2013B   \u201Cx\u201D ')).toBe('a-b "x"')
    expect(normalizeForQuote('P = 0.03')).not.toBe(normalizeForQuote('P = 0.3'))
  })
  it('refuses out-of-range, string, non-integer and duplicate indices and invalid status/index pairings', async () => {
    const c = await ctx()
    const rep = (over) => finding({ assessment: 'uncertain_match', ...over })
    const cases = [
      [rep({ extraction_row_indices: [5] }), /out of range/],
      [rep({ extraction_row_indices: [-1] }), /out of range/],
      [rep({ extraction_row_indices: ['0'] }), /not an integer/],
      [rep({ extraction_row_indices: [1.5] }), /not an integer/],
      [rep({ extraction_row_indices: [0, 0] }), /duplicate/],
      [finding({ extraction_row_indices: [0] }), /possibly_missing must have no row indices/],
      [finding({ assessment: 'represented', extraction_row_indices: [] }), /represented requires/],
    ]
    for (const [f, re] of cases) {
      const v = validateCoverageAudit({ findings: [f], uncertainty_notes: [] }, c)
      expect(v.accepted).toHaveLength(0)
      expect(v.rejected[0].reasons.join(' ')).toMatch(re)
    }
  })
  it('refuses unsupported status/category, extra fields, missing fields', async () => {
    const c = await ctx()
    const bad = [finding({ assessment: 'complete' }), finding({ category: 'whatever' }), { ...finding(), score: 1 }, (({ reason, ...r }) => r)(finding())]
    const v = validateCoverageAudit({ findings: bad, uncertainty_notes: [] }, c)
    expect(v.accepted).toHaveLength(0)
    expect(v.rejected).toHaveLength(4)
    expect(validateCoverageAudit({ findings: [], extra: 1 }, c).schemaErrors.join(' ')).toMatch(/unknown top-level/)
  })
  it('more than the finding limit is refused whole, not truncated', async () => {
    const c = await ctx()
    const v = validateCoverageAudit({ findings: Array.from({ length: MAX_FINDINGS + 1 }, () => finding()), uncertainty_notes: [] }, c)
    expect(v.accepted).toEqual([])
    expect(v.schemaErrors.join(' ')).toMatch(/no silent truncation/)
    expect(validateCoverageAudit({ findings: Array.from({ length: MAX_FINDINGS }, () => finding()), uncertainty_notes: [] }, c).accepted).toHaveLength(MAX_FINDINGS)
  })
})

describe('runCoverageAudit', () => {
  it('makes exactly one call, preserves the report byte-for-byte, labels fake', async () => {
    const report = await liveReport()
    const before = JSON.stringify(report)
    const plan = await planCoverageAudit(args(report))
    const planBefore = JSON.stringify(coverageSummary(plan))
    let calls = 0
    const out = await runCoverageAudit(plan, async () => { calls++; return { findings: [finding()], uncertainty_notes: ['x'] } }, { label: 'fake' })
    expect(calls).toBe(1)
    expect(JSON.stringify(report)).toBe(before)
    expect(JSON.stringify(coverageSummary(plan))).toBe(planBefore)
    expect(out.note).toMatch(/FAKE PROVIDER/)
    expect(out.extractionReportSha256).toBe(plan.extractionReportSha256)
    expect(out.audit.raw.findings).toHaveLength(1)
    expect(out.limitations.join(' ')).toMatch(/clinical review/)
  })
  it('propagates provider errors without retry and requires a provider and label', async () => {
    const plan = await planCoverageAudit(args(await liveReport()))
    let calls = 0
    await expect(runCoverageAudit(plan, async () => { calls++; throw new Error('boom') }, { label: 'fake' })).rejects.toThrow(/boom/)
    expect(calls).toBe(1)
    await expect(runCoverageAudit(plan, null, { label: 'fake' })).rejects.toThrow(/provider/)
    await expect(runCoverageAudit(plan, async () => ({}), { label: 'x' })).rejects.toThrow(/Label/)
  })
})
