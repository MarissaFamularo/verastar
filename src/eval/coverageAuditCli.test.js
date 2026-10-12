// Runnable CLI + schema tests for the coverage audit. Fully offline: SYNTHETIC paper, SYNTHETIC
// live-shaped extraction report (provider 'live' is a fixture label only; no model produced it),
// fake SDK transport, fake constant API key. Nothing here measures model quality and nothing
// ever touches the network.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { DOMParser } from 'linkedom'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main, parseArgs, authorizationFor } from '../../scripts/eval-coverage-audit.mjs'
import { planCoverageAudit, validateCoverageAudit, extractionReportSha256, coverageRequest } from './coverageAudit.js'
import { planSinglePaper } from './singlePaper.js'

const FAKE_KEY = 'sk-ant-FAKE-CONSTANT-NOT-A-REAL-KEY'
const MODEL = 'claude-sonnet-5-5'

const SYNTH = `<?xml version="1.0"?><pmc-articleset><article><front><article-meta><abstract><sec><title>Methods</title><p>Adults.</p></sec></abstract></article-meta></front><body><sec sec-type="results"><title>Results</title><p>Major bleeding occurred in 1.1% vs. 2.3%, P = 0.03.</p><table-wrap><label>Table 2</label><table><thead><tr><th>Outcome</th><th>Active</th><th>Control</th></tr></thead><tbody><tr><td>Hospitalization for heart failure</td><td>3.1%</td><td>4.4%</td></tr></tbody></table></table-wrap></sec></body></article></pmc-articleset>`

const realParser = globalThis.DOMParser
beforeAll(() => { globalThis.DOMParser = DOMParser })
afterAll(() => { globalThis.DOMParser = realParser })

const buildRows = () => [{ quantity: { name: 'bleeding', quantity_type: 'single', value: 1.1, range_low: null, range_high: null, first_label: null, first_value: null, second_label: null, second_value: null, unit: '%', ci_low: null, ci_high: null, p_value: 0.03, source_quote: 'Major bleeding occurred in 1.1% vs. 2.3%, P = 0.03', location_hint: 'Results' }, tier: 'verified' }]

// Clearly synthetic live-SHAPED report; deep-built per call (no shared object references).
async function fixtures({ provider = 'live', mode = 'live', rows = buildRows() } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'verastar-cov-'))
  const xml = join(dir, 's.xml')
  const rep = join(dir, 'r.json')
  writeFileSync(xml, SYNTH)
  const plan = await planSinglePaper({ caseId: 'CAR-10', pmid: '1', pmcXml: SYNTH })
  const report = { mode, plan: { caseId: 'CAR-10', pmid: '1', sourceSha256: plan.sourceSha256, extractionInputSha256: plan.extractionInputSha256 }, run: { provider, design: 'RCT', rows } }
  writeFileSync(rep, JSON.stringify(report))
  return { dir, xml, rep, report, plan }
}
const baseArgs = (f) => ['--case', 'CAR-10', '--pmid', '1', '--pmc-xml', f.xml, '--extraction-report', f.rep]
const quiet = () => {}
const fresh = (f) => join(f.dir, `out-${Math.random().toString(36).slice(2)}`)

const finding = (over = {}) => ({ category: 'major_harm_safety', outcome: 'Major bleeding', population: 'index study', timepoint: null, source_quote: 'Major bleeding occurred in 1.1% vs. 2.3%, P = 0.03', assessment: 'possibly_missing', extraction_row_indices: [], reason: 'No extracted row names bleeding.', ...over })
const audit = (findings, notes = []) => ({ findings, uncertainty_notes: notes })

async function planFor(f, extra = {}) {
  return planCoverageAudit({ caseId: 'CAR-10', pmid: '1', pmcXml: SYNTH, extractionReport: f.report, ...extra })
}

describe('report validation', () => {
  it('rejects fake provider, fake mode, null rows and malformed row quantities', async () => {
    const f = await fixtures()
    const mk = (over) => ({ ...f.report, run: { ...f.report.run, ...over } })
    await expect(planFor({ report: mk({ provider: 'fake' }) })).rejects.toThrow(/provider must be "live"/)
    await expect(planFor({ report: { ...f.report, mode: 'fake' } })).rejects.toThrow(/live run/)
    await expect(planFor({ report: mk({ rows: [null] }) })).rejects.toThrow(/rows\[0\] is not an object/)
    await expect(planFor({ report: mk({ rows: [{ tier: 'x' }] }) })).rejects.toThrow(/quantity is not an object/)
    await expect(planFor({ report: mk({ rows: [{ quantity: { name: 5 } }] }) })).rejects.toThrow(/name must be a string/)
    await expect(planFor({ report: mk({ rows: [{ quantity: { source_quote: 5 } }] }) })).rejects.toThrow(/source_quote must be a string/)
    await expect(planFor({ report: mk({ rows: [{ quantity: { value: 'x' } }] }) })).rejects.toThrow(/value must be a finite number/)
  })
  it('report hash differs when a deep-cloned fixture row is changed (no shared references)', async () => {
    const a = await fixtures()
    const b = await fixtures()
    b.report.run.rows[0].quantity.value = 9
    expect(await extractionReportSha256(a.report)).not.toBe(await extractionReportSha256(b.report))
    expect(a.report.run.rows[0].quantity.value).toBe(1.1)
  })
})

describe('row summary preserves full quantity shape', () => {
  it('range, change and first/second labels reach the request content', async () => {
    const rows = [{ quantity: { name: 'arm contrast', quantity_type: 'change', value: null, range_low: 0.2, range_high: 0.9, first_label: 'Active arm', first_value: 3.1, second_label: 'Control arm', second_value: 4.4, unit: '%', ci_low: null, ci_high: null, p_value: null, source_quote: 'q', location_hint: 'Table 2' }, tier: 'verified' }]
    const f = await fixtures({ rows })
    const p = await planFor(f, { model: MODEL })
    const c = p.request.content
    expect(c).toContain('"quantity_type": "change"')
    expect(c).toContain('"range_low": 0.2')
    expect(c).toContain('"range_high": 0.9')
    expect(c).toContain('"first_label": "Active arm"')
    expect(c).toContain('"second_label": "Control arm"')
    expect(c).toContain('"location_hint": "Table 2"')
  })
})

describe('quote location keeps prose and tables separate', () => {
  it('accepts a table-only quote with locatedIn tables; prose quote is locatedIn prose', async () => {
    const f = await fixtures()
    const p = await planFor(f)
    expect(p.tablesText).toContain('Hospitalization')
    const ctx = { corpusText: p.corpusText, tablesText: p.tablesText, rowCount: p.extractionRowCount }
    const v = validateCoverageAudit(audit([finding({ outcome: 'HF hospitalization', category: 'major_benefit', source_quote: 'Hospitalization for heart failure' }), finding()]), ctx)
    expect(v.accepted).toHaveLength(2)
    expect(v.accepted[0].locatedIn).toBe('tables')
    expect(v.accepted[1].locatedIn).toBe('prose')
  })
  it('rejects a fabricated quote spanning the prose/table boundary', async () => {
    const f = await fixtures()
    const p = await planFor(f)
    const proseTail = p.corpusText.trim().split(/\s+/).slice(-3).join(' ')
    const tableHead = p.tablesText.trim().split(/\s+/).slice(0, 3).join(' ')
    const v = validateCoverageAudit(audit([finding({ source_quote: `${proseTail} ${tableHead}` })]), { corpusText: p.corpusText, tablesText: p.tablesText, rowCount: 1 })
    expect(v.accepted).toHaveLength(0)
    expect(v.rejected[0].reasons.join(' ')).toMatch(/not found/)
  })
  it('plan summary omits table content as well', async () => {
    const f = await fixtures()
    const { coverageSummary } = await import('./coverageAudit.js')
    const s = JSON.stringify(coverageSummary(await planFor(f)))
    expect(s).not.toContain('Hospitalization')
    expect(s).not.toContain('Major bleeding')
  })
})

describe('whole-response schema rejection', () => {
  it('valid finding plus unknown top field, missing notes or malformed notes accepts nothing and keeps raw', async () => {
    const f = await fixtures()
    const p = await planFor(f)
    const ctx = { corpusText: p.corpusText, tablesText: p.tablesText, rowCount: 1 }
    const cases = [
      { findings: [finding()], uncertainty_notes: [], extra: 1 },
      { findings: [finding()] },
      { findings: [finding()], uncertainty_notes: 'nope' },
      { findings: [finding()], uncertainty_notes: [1] },
    ]
    for (const raw of cases) {
      const v = validateCoverageAudit(raw, ctx)
      expect(v.accepted).toEqual([])
      expect(v.status).toBe('coverage-undetermined')
      expect(v.schemaErrors.length).toBeGreaterThan(0)
      expect(v.raw).toBe(raw)
    }
  })
})

describe('CLI gates', () => {
  it('dry-run omits source and extraction content and owns a fresh output', async () => {
    const f = await fixtures()
    const out = fresh(f)
    const report = await main([...baseArgs(f), '--out', out], {}, quiet)
    expect(report.mode).toBe('dry-run')
    expect(readdirSync(out)).toEqual(['CAR-10.coverage.dry-run.json'])
    const text = readFileSync(join(out, 'CAR-10.coverage.dry-run.json'), 'utf8')
    expect(text).not.toContain('Major bleeding')
    expect(text).not.toContain('Hospitalization')
  })
  it('refuses existing output, in-repo output, extra args, directory inputs', async () => {
    const f = await fixtures()
    await expect(main([...baseArgs(f), '--out', f.dir], {}, quiet)).rejects.toThrow(/already exists/)
    await expect(main([...baseArgs(f), '--out', 'tmp-cov'], {}, quiet)).rejects.toThrow(/outside the public app repo/)
    expect(() => parseArgs([...baseArgs(f), 'second.xml'])).toThrow(/one paper/)
    await expect(main(['--case', 'CAR-10', '--pmid', '1', '--pmc-xml', f.dir, '--extraction-report', f.rep], {}, quiet)).rejects.toThrow(/one file/)
  })
  it('refuses an external path whose parent symlink resolves into the public repo', async () => {
    const f = await fixtures()
    const link = join(f.dir, 'repo-link')
    symlinkSync(join(process.cwd()), link)
    await expect(main([...baseArgs(f), '--out', join(link, 'leak-out')], {}, quiet)).rejects.toThrow(/outside the public app repo/)
    expect(existsSync(join(process.cwd(), 'leak-out'))).toBe(false)
  })
  it('refuses live without model, cap, out and the operator guard', async () => {
    const f = await fixtures()
    await expect(main([...baseArgs(f), '--live'], {}, quiet)).rejects.toThrow(/Live run refused[\s\S]*--model is required[\s\S]*VERASTAR_EVAL_AUTHORIZE/)
  })
  it('refuses a fake-provider report at the CLI', async () => {
    const f = await fixtures({ provider: 'fake' })
    await expect(main(baseArgs(f), {}, quiet)).rejects.toThrow(/provider must be "live"/)
  })
})

// ---- fake SDK live transport (never network) ----
function fakeSdk({ response, error } = {}) {
  const calls = []
  class FakeAnthropic {
    constructor(opts) { this.opts = opts; FakeAnthropic.last = opts }
    get messages() {
      return {
        create: (body) => {
          calls.push(body)
          return { withResponse: () => error ? Promise.reject(error) : Promise.resolve({ data: response, request_id: 'req_fake' }) }
        },
      }
    }
  }
  return { Anthropic: FakeAnthropic, calls }
}
const okResponse = (payload) => ({ model: MODEL, stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 200 }, content: [{ type: 'text', text: JSON.stringify(payload) }] })

async function liveSetup() {
  const f = await fixtures()
  const probe = await planFor(f, { model: MODEL, maxUsd: 50 })
  const env = { ANTHROPIC_API_KEY: FAKE_KEY, VERASTAR_EVAL_AUTHORIZE: authorizationFor(probe) }
  const out = fresh(f)
  const argv = [...baseArgs(f), '--model', MODEL, '--max-usd', '50', '--live', '--out', out]
  return { f, probe, env, out, argv }
}

describe('live transport with a fake SDK', () => {
  it('persists the receipt before send, binds the report hash, makes exactly one call, settles the exact charge', async () => {
    const s = await liveSetup()
    const fake = fakeSdk({ response: okResponse(audit([finding()])) })
    let receiptFilesAtSend = null
    const wrapped = class extends fake.Anthropic {
      get messages() {
        const m = super.messages
        return { create: (body) => { receiptFilesAtSend = readdirSync(s.out).filter((n) => n.includes('.attempt-')); return m.create(body) } }
      }
    }
    const logs = []
    const report = await main(s.argv, s.env, (l) => logs.push(l), { Anthropic: wrapped })
    expect(fake.calls).toHaveLength(1)
    expect(receiptFilesAtSend.length).toBe(1)
    expect(wrapped.last.maxRetries).toBe(0)
    expect(wrapped.last.apiKey).toBe(FAKE_KEY)
    expect(report.mode).toBe('live')
    expect(report.run.provider).toBe('live')
    expect(report.run.extractionReportSha256).toBe(await extractionReportSha256(s.f.report))
    expect(report.attempt.extractionReportSha256).toBe(s.probe.extractionReportSha256)
    expect(report.attempt.status).toBe('completed')
    expect(report.attempt.chargeUsd).toBeGreaterThan(0)
    const { evalPriceUsage } = await import('./evalModels.js')
    const { microToUsd } = await import('../../supabase/functions/_shared/pricing.js')
    expect(report.attempt.chargeUsd).toBe(microToUsd(evalPriceUsage(MODEL, { input_tokens: 1000, output_tokens: 200 }).micro))
    const files = readdirSync(s.out)
    expect(files.some((n) => n.includes('.attempt-'))).toBe(true)
    expect(files).toContain('CAR-10.coverage.live.json')
    expect(logs.join('\n')).not.toContain(FAKE_KEY)
    expect(logs.join('\n')).not.toContain('Major bleeding')
  })
  it('provider error: one call, error report persisted, receipt kept, main rejects with a safe generic error', async () => {
    const s = await liveSetup()
    const boom = Object.assign(new Error(`secret ${FAKE_KEY} Major bleeding text`), { status: 529 })
    const fake = fakeSdk({ error: boom })
    const logs = []
    let caught
    await main(s.argv, s.env, (l) => logs.push(l), { Anthropic: fake.Anthropic }).catch((e) => { caught = e })
    expect(caught).toBeDefined()
    expect(caught.message).not.toContain(FAKE_KEY)
    expect(caught.message).not.toContain('Major bleeding')
    expect(fake.calls).toHaveLength(1)
    const files = readdirSync(s.out)
    expect(files.some((n) => n.includes('.attempt-'))).toBe(true)
    const persisted = JSON.parse(readFileSync(join(s.out, 'CAR-10.coverage.live.json'), 'utf8'))
    expect(persisted.error).toBeTruthy()
    expect(JSON.stringify(persisted)).not.toContain(FAKE_KEY)
    expect(files.filter(n => n.includes('.attempt-')).map(n => readFileSync(join(s.out, n), 'utf8')).join('')).not.toContain(FAKE_KEY)
    expect(persisted.attempt.status).toBe('failed')
    expect(persisted.attempt.outcome).toBe('ambiguous')
    expect(logs.join('\n')).not.toContain(FAKE_KEY)
    expect(logs.join('\n')).not.toContain('Major bleeding')
  })
  it('an existing leaf is refused even when created between check and send (fresh-leaf ownership)', async () => {
    const s = await liveSetup()
    const fake = fakeSdk({ response: okResponse(audit([])) })
    writeFileSync(s.out, 'occupied')
    await expect(main(s.argv, s.env, quiet, { Anthropic: fake.Anthropic })).rejects.toThrow(/already exists/)
    expect(fake.calls).toHaveLength(0)
  })
})

describe('request shape', () => {
  it('coverageRequest carries no reference answers and states untrusted data', () => {
    const req = coverageRequest({ studyId: '1', sourceText: 'src', rows: buildRows(), model: MODEL })
    expect(req.content).toContain('untrusted')
    expect(JSON.stringify(req)).not.toMatch(/reference|adjudicat/i)
  })
})
