// eval/summaryEval.js — the summary-path evaluation harness (library half; the CLI is
// scripts/eval-summary.mjs). Runs the candidate writer → checker → rewrite → fallback path
// on frozen cases, on the checker probes, and on a frozen holdout set, with:
//   - an injected model client (fake for plumbing, live only behind the CLI gate);
//   - a spend LEDGER that prices every response with the shared price table, keeps a
//     running total on disk, and refuses to dispatch a request whose conservative bound
//     would cross the cap (whole request priced as input + max_tokens as output);
//   - complete traces: every request body (hashed and stored), every response, usage,
//     latency, model, the pipeline's own stage events, source and input hashes.
// Nothing here spends on its own: planning and fake runs make no network call.
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { configureServerClient, MODELS } from '../lib/anthropic.js'
import { PRICES, priceUsage, maxChargeMicro, microToUsd } from '../../supabase/functions/_shared/pricing.js'
import { triage } from '../pipeline/triage.js'
import { verify } from '../pipeline/verify.js'
import { findPrimary, verificationCorpus } from '../pipeline/primaryResult.js'
import { isRelationshipValidated } from '../lib/evidenceVersion.js'
import { fmtNum } from '../lib/format.js'
import { evidenceSummary } from '../pipeline/evidenceWindow.js'
import { resultCandidate, normalizeResultContexts, HANDOFF_VERSION } from '../pipeline/resultHandoff.js'
import { checkSummary, evaluateSummaryCheck, SUMMARY_CHECK_VERSION } from '../pipeline/summaryCheck.js'
import { bindFindingNumbers } from '../pipeline/numberBinding.js'
import { extractQuantities, dropUnprovenLabels } from '../pipeline/extract.js'
import { assembleExtractionSource, parsePmcFullText } from '../pipeline/sources.js'
import { extractStructured } from '../lib/anthropic.js'

export const HARNESS_VERSION = '2026-10-17.summary-eval-v1'
export const CHECKER_MODELS = { haiku: MODELS.fast, sonnet: 'claude-sonnet-5-5' }
export const sha256 = (text) => createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')

// The clinician profile every run uses, so writer inputs are reproducible across runs.
export const EVAL_PROFILE = Object.freeze({
  northStars: ['Limb preservation and CLTI outcomes', 'Aortic and carotid intervention evidence', 'Rigorous evidence synthesis and clinical AI'],
  projects: ['Limb Preservation Program outcomes', 'Vascular surgery residency education'],
  rubric: 'Prioritize randomized trials, meta-analyses and large registries in vascular surgery, limb preservation, aortic and carotid disease. Summaries must state the primary result first, name the analysis when results conflict, and never overstate certainty.',
})

// --- spend ledger -------------------------------------------------------------------------

export class CapReached extends Error {
  constructor(message, { total, bound, cap }) { super(message); this.name = 'CapReached'; this.total = total; this.bound = bound; this.cap = cap }
}

// Conservative bound for one request: UTF-8 bytes of the serialized body × 1.25 + 1,024
// as input tokens, max_tokens as output, priced at the model's base rates.
export function requestBoundUsd(body) {
  const model = body?.model
  if (!PRICES[model]) return null
  const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8')
  return microToUsd(maxChargeMicro(model, { maxInputTokens: Math.ceil(bytes * 1.25) + 1024, maxOutputTokens: body.max_tokens }))
}

export function makeLedger({ capUsd, dir, label = 'run' }) {
  if (!(Number.isFinite(capUsd) && capUsd > 0)) throw new Error('A finite positive cap is required.')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'ledger.json')
  const lines = join(dir, 'ledger.jsonl')
  const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { harnessVersion: HARNESS_VERSION, label, capUsd, totalUsd: 0, calls: 0, unpricedCalls: 0, byModel: {}, byPurpose: {}, startedAt: new Date().toISOString() }
  state.capUsd = capUsd
  const save = () => writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`)
  save()
  return {
    state,
    file,
    get total() { return state.totalUsd },
    assertRoom(body, purpose) {
      const bound = requestBoundUsd(body)
      if (bound == null) throw new Error(`Model ${body?.model} is not in the shared price table; its cost cannot be bounded.`)
      if (state.totalUsd + bound > capUsd) {
        throw new CapReached(`Spending cap: ${label} total $${state.totalUsd.toFixed(4)} + conservative bound $${bound.toFixed(4)} for the next ${purpose || 'request'} would exceed the $${capUsd} cap. Stopping before dispatch.`, { total: state.totalUsd, bound, cap: capUsd })
      }
      return bound
    },
    record({ model, usage, purpose, requestSha256, requestId, latencyMs, stopReason, boundUsd, caseId }) {
      const priced = priceUsage(model, usage)
      const usd = priced.ok ? microToUsd(priced.micro) : null
      state.calls += 1
      if (usd == null) state.unpricedCalls += 1
      else {
        state.totalUsd = Number((state.totalUsd + usd).toFixed(6))
        state.byModel[model] = Number(((state.byModel[model] || 0) + usd).toFixed(6))
        state.byPurpose[purpose || 'unknown'] = Number(((state.byPurpose[purpose || 'unknown'] || 0) + usd).toFixed(6))
      }
      state.updatedAt = new Date().toISOString()
      const entry = { at: state.updatedAt, caseId: caseId || null, purpose: purpose || null, model, usage, usd, unpricedReason: priced.ok ? null : priced.reason, boundUsd, requestSha256, requestId, latencyMs, stopReason, runningTotalUsd: state.totalUsd }
      appendFileSync(lines, `${JSON.stringify(entry)}\n`)
      save()
      return entry
    },
  }
}

// --- clients ------------------------------------------------------------------------------

// Wraps a real or fake Messages client so every call is bounded, priced, traced and
// attributed to the current case/purpose. `context` is mutable: the harness sets caseId
// and purpose before each stage.
export function wrapClient(inner, { ledger, traceDir, context, now = () => Date.now() }) {
  mkdirSync(join(traceDir, 'calls'), { recursive: true })
  let n = 0
  return {
    messages: {
      async create(body, opts) {
        n += 1
        const purpose = opts?.headers?.['x-verastar-purpose'] || context.purpose || null
        const requestSha256 = sha256(JSON.stringify(body))
        const boundUsd = ledger ? ledger.assertRoom(body, purpose) : null
        const t0 = now()
        const file = join(traceDir, 'calls', `${String(n).padStart(3, '0')}.${context.caseId || 'none'}.${purpose || 'call'}.json`)
        const record = { harnessVersion: HARNESS_VERSION, n, caseId: context.caseId || null, purpose, model: body.model, requestSha256, systemSha256: sha256(body.system || ''), contentSha256: sha256(body.messages?.[0]?.content || ''), request: body, boundUsd, startedAt: new Date(t0).toISOString() }
        let res
        try {
          res = await inner.messages.create(body, opts)
        } catch (err) {
          record.error = { name: err?.name, status: err?.status ?? null, message: String(err?.message || err) }
          record.latencyMs = now() - t0
          writeFileSync(file, `${JSON.stringify(record, null, 1)}\n`)
          throw err
        }
        record.latencyMs = now() - t0
        record.responseModel = res?.model ?? null
        record.stopReason = res?.stop_reason ?? null
        record.usage = res?.usage ?? null
        record.responseText = (res?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
        record.responseSha256 = sha256(record.responseText)
        if (ledger) record.ledger = ledger.record({ model: body.model, usage: res?.usage, purpose, requestSha256, requestId: res?.id ?? null, latencyMs: record.latencyMs, stopReason: res?.stop_reason, boundUsd, caseId: context.caseId })
        writeFileSync(file, `${JSON.stringify(record, null, 1)}\n`)
        return res
      },
    },
  }
}

// A deterministic fake: answers every schema shape so the plumbing runs end to end. Its
// output measures nothing about any model.
export function fakeClient({ findingFor = () => 'The fake writer reports no statistically clear difference for the primary outcome.' } = {}) {
  const message = (text, model) => ({ id: `msg_fake_${Math.random().toString(16).slice(2, 10)}`, type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 200 } })
  return {
    messages: {
      async create(body) {
        const content = body.messages?.[0]?.content || ''
        const schema = body.output_config?.format?.schema
        if (!schema && /SCHEMA:/.test(content)) {
          const studyId = content.match(/study_id: (\S+)/)?.[1] || 'x'
          return message(JSON.stringify({ study_id: studyId, design: 'other', quantities: [], result_contexts: [] }), body.model)
        }
        if (schema?.properties?.rankings) {
          const ids = [...content.matchAll(/^\[([^\]]+)\] /gm)].map((m) => m[1])
          return message(JSON.stringify({ rankings: ids.map((id) => ({ id, score: 60, tier: 2, finding: findingFor(id), finding_plain: findingFor(id), design_caution: 'Fake caution.', relevance: 'Fake relevance.' })) }), body.model)
        }
        if (schema?.properties?.obligations) {
          const obligations = [...content.matchAll(/\[(ob\d+)\]/g)].map((m) => ({ id: m[1], status: 'present', quote: '', reason: 'fake' }))
          const numbers = [...content.matchAll(/\[number ([^\]\s]+)/g)].map((m) => ({ number: m[1], row_id: '0', outcome_ok: true, comparator_ok: true, analysis_ok: true, timepoint_ok: true, direction_ok: true, quote: '', reason: 'fake' }))
          return message(JSON.stringify({ obligations, number_bindings: numbers, equivalence_from_nonsignificant: { failed: false, quote: '', reason: '' }, causal_overclaim: { failed: false, quote: '', reason: '' }, certainty_overclaim: { failed: false, quote: '', reason: '' }, refutation: { refuted: false, quote: '', reason: '' }, caution: { supported: true, quote: '', reason: 'fake' } }), body.model)
        }
        if (schema?.properties?.hard_failures) return message(JSON.stringify({ hard_failures: [], primary_covered: true, numeric_binding_ok: true, readability: 4, notes: 'fake grade' }), body.model)
        throw new Error('fake client: unknown request shape')
      },
    },
  }
}

export async function makeLiveClient({ apiKey, timeoutMs = 300_000 }) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set; live evaluation is blocked.')
  const Anthropic = (await import('@anthropic-ai/sdk')).default
  return new Anthropic({ apiKey, maxRetries: 0, timeout: timeoutMs })
}

// --- cases --------------------------------------------------------------------------------

const REPO = resolve(new URL('../..', import.meta.url).pathname)
export const EVIDENCE_DIR = join(REPO, 'docs', 'evidence', '2026-10-17')
export const RECORDS_DIR = join(EVIDENCE_DIR, 'verifier', 'final-170a26c', 'records')
export const CASES_DIR = join(EVIDENCE_DIR, 'verifier', 'candidate-20261017', 'cases')

// The six frozen development papers. TEVAR (PMID 42693683) is EXCLUDED: its frozen inputs
// (source text, extraction, writer/repair outputs) are not in the archive; only its
// offline diagnosis survived (round3-95857d9/semantic-review.md).
export const FROZEN_CASES = [
  { id: 'PARADE', pmid: '42513277', record: 'final-170a26c', productionRecord: true, expectations: ['weighted survival result stated as not significant', 'original "similar long-term patency across regimens" claim refuted'] },
  { id: 'ASPIRIN', pmid: '42769537', record: 'final-170a26c', productionRecord: true, expectations: ['withdrawal timing (about 1–2 months) stated', 'cites MACE and bleeding primary estimates, not NACE alone'] },
  { id: 'BALLOON', pmid: '42573020', record: 'final-170a26c', productionRecord: true, expectations: ['certainty grade carried for the reintervention outcome', '39 of 39 spans located'] },
  { id: 'CAROTID', pmid: '42637117', record: 'frozen-source', expectations: ['no equivalence or "as safe" assertion, or attributed to the authors'] },
  { id: 'NPT', pmid: '42681580', record: 'final-170a26c', expectations: ['admission recovers from whitespace-only mismatch: 53 of 53 spans located', 'a displayable finding or excerpt'] },
  { id: 'TADV', pmid: '42600759', record: 'final-170a26c', expectations: ['single-arm: a descriptive finding is acceptable'] },
]
export const EXCLUDED_CASES = [{ id: 'TEVAR', pmid: '42693683', reason: 'Frozen inputs (source, extraction, writer and repair outputs) are not in the evidence archive; only the offline diagnosis in round3-95857d9/semantic-review.md survives, so the case cannot be reconstructed without a new fetch and extraction, which would not be the frozen case.' }]

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))

// Re-verify every frozen row with the current verifier (deterministic, free) so verdict
// stamps are current (v14 admits PARADE's "CI of").
function reverifyRows(rows, sourceDoc, tier) {
  return (rows || []).map((row) => {
    const quantity = dropUnprovenLabels(row.quantity)
    return { quantity, verdict: verify(quantity, { text: sourceDoc.text, tables: sourceDoc.tables }, { sourceTier: tier }) }
  })
}

// Load one frozen case into a runPaper()-shaped result. Extraction is reused from the
// archive when it exists; a frozen-source case returns `needsExtraction: true`.
export function loadFrozenCase(c) {
  if (c.record === 'final-170a26c') {
    const rec = readJson(join(RECORDS_DIR, `${c.pmid}.json`))
    const r = rec.result
    const sourceDoc = { text: r.sourceDoc?.text || '', tables: r.sourceDoc?.tables || '' }
    let evidenceSource = null
    if (c.productionRecord) {
      const prod = readJson(join(EVIDENCE_DIR, `${c.pmid}.json`))
      const src = prod.frozenSourceRecord?.source
      if (src?.sections || src?.abstractParts) evidenceSource = { tier: src.tier, abstractParts: src.abstractParts || [], abstract: src.abstract || '', sections: src.sections || [] }
    }
    const result = {
      paper: { id: c.pmid, pmid: c.pmid, title: r.paper?.title || '' }, design: r.design || null,
      source: { tier: r.source?.tier || 'abstract_only', hash: sha256(sourceDoc.tables ? `${sourceDoc.text}\n\nTABLES:\n${sourceDoc.tables}` : sourceDoc.text), hasBody: r.source?.tier === 'full_text' },
      sourceDoc, evidenceSource, rows: reverifyRows(r.rows, sourceDoc, r.source?.tier || 'abstract_only'),
      resultContract: HANDOFF_VERSION, resultContexts: normalizeResultContexts(r.resultContexts || []),
    }
    return { case: c, result, provenance: { record: join('docs/evidence/2026-10-17/verifier/final-170a26c/records', `${c.pmid}.json`), commit: rec.provenance?.commit, extractionReused: true, sourceSha256: result.source.hash, extractionInputSha256: sha256(rec.extractionInput || sourceDoc.text) }, needsExtraction: false }
  }
  if (c.record === 'frozen-source') {
    const frozen = readJson(join(CASES_DIR, `${c.pmid}.frozen-source.json`))
    const assembled = assembleExtractionSource({ text: frozen.source.text, tables: frozen.source.tables || '', abstractParts: [], tier: frozen.source.tier })
    const sourceDoc = { text: assembled.corpusText, tables: assembled.tables }
    const result = {
      paper: { id: c.pmid, pmid: c.pmid, title: frozen.paper.title }, design: null,
      source: { tier: frozen.source.tier, hash: sha256(assembled.modelText), hasBody: false },
      sourceDoc, evidenceSource: null, rows: [], resultContract: HANDOFF_VERSION, resultContexts: [],
    }
    return { case: c, result, provenance: { record: `docs/evidence/2026-10-17/verifier/candidate-20261017/cases/${c.pmid}.frozen-source.json`, extractionReused: false, sourceSha256: result.source.hash, extractionInputSha256: sha256(assembled.modelText) }, needsExtraction: true, modelText: assembled.modelText }
  }
  throw new Error(`Unknown record kind for ${c.id}`)
}

// Run extraction for a case that has none (a paid call on the extraction model).
export async function extractCase(loaded) {
  const extracted = await extractQuantities({ studyId: loaded.result.paper.id, sourceText: loaded.modelText })
  const tier = loaded.result.source.tier
  loaded.result.design = extracted.design
  loaded.result.rows = reverifyRows(extracted.quantities.map((q) => ({ quantity: q })), loaded.result.sourceDoc, tier)
  loaded.result.resultContexts = extracted.result_contexts || []
  loaded.extraction = extracted
  loaded.needsExtraction = false
  return loaded
}

// The candidate exactly as digestRunAndRank.js builds it.
export function candidateFor(result, extra = {}) {
  return {
    id: result.paper.id, title: result.paper.title, design: result.design, topics: [], topicSteering: [],
    summary: evidenceSummary(result),
    ...resultCandidate(result),
    primary: findPrimary(result.rows, (row) => isRelationshipValidated(row.verdict), verificationCorpus(result)),
    verified: result.rows.filter((row) => isRelationshipValidated(row.verdict)).map((row) => ({ name: row.quantity.name, value: fmtNum(row.quantity), quote: row.quantity.source_quote })),
    ...extra,
  }
}

// --- runs ---------------------------------------------------------------------------------

export function installClient(inner, { ledger, traceDir, context }) {
  const client = wrapClient(inner, { ledger, traceDir, context })
  configureServerClient({ client })
  return client
}

// One paper through the summary path. Traces every stage event to traces/<case>/.
export async function runSummary({ loaded, checkerModel, traceDir, context, onEvent }) {
  const caseDir = join(traceDir, 'papers', loaded.case.id)
  mkdirSync(caseDir, { recursive: true })
  context.caseId = loaded.case.id
  const candidate = candidateFor(loaded.result)
  writeFileSync(join(caseDir, 'candidate.json'), `${JSON.stringify({ ...candidate, resultHandoff: { ...candidate.resultHandoff, source: undefined, key: sha256(candidate.resultHandoff.key) }, summary: undefined }, null, 1)}\n`)
  writeFileSync(join(caseDir, 'input.json'), `${JSON.stringify({ case: loaded.case, provenance: loaded.provenance, design: loaded.result.design, source: loaded.result.source, rows: loaded.result.rows, resultContexts: loaded.result.resultContexts, evidenceMeta: candidate.evidenceMeta, audit: candidate.resultHandoff.audit, diagnostics: candidate.resultHandoff.diagnostics, evidenceSha256: sha256(candidate.evidence) }, null, 1)}\n`)
  writeFileSync(join(caseDir, 'evidence.txt'), candidate.evidence)
  const events = []
  let k = 0
  const t0 = Date.now()
  const takes = await triage({
    ...EVAL_PROFILE, candidates: [candidate], checkModel: checkerModel,
    onTrace: (event) => {
      k += 1
      events.push({ stage: event.stage, at: new Date().toISOString() })
      writeFileSync(join(caseDir, `${String(k).padStart(2, '0')}.${event.stage}.json`), `${JSON.stringify(event, null, 1)}\n`)
      onEvent?.(event)
    },
  })
  const take = takes[0]
  const out = { case: loaded.case, provenance: loaded.provenance, checkerModel, writerModel: MODELS.triage, latencyMs: Date.now() - t0, take, events }
  writeFileSync(join(caseDir, 'take.json'), `${JSON.stringify(out, null, 1)}\n`)
  return out
}

// --- checker probes -----------------------------------------------------------------------

export const PROBE_ROWS = [
  { name: 'Bleeding, treatment A vs treatment B, intention-to-treat hazard ratio', value: '0.44 hazard ratio (CI 0.34–0.55)', quote: 'In the intention-to-treat analysis, treatment A versus treatment B reduced bleeding (HR 0.44, CI 0.34–0.55).' },
  { name: 'MACE, treatment A vs treatment B, intention-to-treat hazard ratio', value: '1.05 hazard ratio (CI 0.83–1.32)', quote: 'In the intention-to-treat analysis, MACE for treatment A versus treatment B had HR 1.05 (CI 0.83–1.32).' },
]
const PROBE_CORRECT = 'In the intention-to-treat analysis, treatment A versus treatment B reduced bleeding (0.44 hazard ratio (CI 0.34–0.55)).'
export const PROBES = [
  { id: 'correct-control', finding: PROBE_CORRECT, expect: 'accept' },
  { id: 'outcome-swap', finding: PROBE_CORRECT.replace('bleeding', 'MACE'), expect: 'refute' },
  { id: 'comparator-reversal', finding: PROBE_CORRECT.replace('treatment A versus treatment B', 'treatment B versus treatment A'), expect: 'refute' },
  { id: 'analysis-substitution', finding: PROBE_CORRECT.replace('intention-to-treat', 'per-protocol'), expect: 'refute' },
  { id: 'borrowed-ci', finding: PROBE_CORRECT.replace('0.34–0.55', '0.83–1.32'), expect: 'refute' },
]
export const PROBE_EVIDENCE = `[Evidence window: the paper's complete abstract]\nMETHODS: A randomized trial compared treatment A with treatment B. The primary outcomes were bleeding and MACE, analysed by intention to treat.\nRESULTS: ${PROBE_ROWS[0].quote} ${PROBE_ROWS[1].quote}\nCONCLUSIONS: Treatment A reduced bleeding without a significant difference in MACE.`

// Runs the structured checker on each probe `repeats` times. The deterministic binding
// verdict is reported beside the model's so the two layers are visible separately.
export async function runProbes({ checkerModel, repeats, traceDir, context, probes = PROBES }) {
  const results = []
  for (const probe of probes) {
    const binding = bindFindingNumbers(probe.finding, PROBE_ROWS)
    for (let i = 1; i <= repeats; i++) {
      context.caseId = `probe-${probe.id}-${i}`
      context.purpose = 'summary-check'
      const bindings = binding.bindings
      const obligations = [{ id: 'ob1', kind: 'endpoint-role', quote: 'The primary outcomes were bleeding and MACE, analysed by intention to treat.', rowIndex: null }]
      const t0 = Date.now()
      let outcome
      try {
        const checked = await checkSummary({ paperId: 'probe', title: 'Probe trial', design: 'RCT', evidence: PROBE_EVIDENCE, finding: probe.finding, designCaution: '', obligations, bindings, verified: PROBE_ROWS, primary: { state: 'identified', names: PROBE_ROWS.map((r) => r.name), verified: true } }, { model: checkerModel })
        const ev = evaluateSummaryCheck(checked.response, { obligations, bindings })
        outcome = { modelVerdict: ev.verdict === 'pass' ? 'accept' : 'refute', failures: ev.blocking.map((f) => `${f.kind}${f.dimensions ? `(${f.dimensions.join('/')})` : ''}`), response: checked.response }
      } catch (err) {
        outcome = { modelVerdict: 'error', error: String(err?.message || err) }
      }
      results.push({ probe: probe.id, repeat: i, expect: probe.expect, deterministic: binding.ok ? 'accept' : 'refute', deterministicViolations: binding.violations.map((v) => v.kind), ...outcome, latencyMs: Date.now() - t0 })
    }
  }
  mkdirSync(traceDir, { recursive: true })
  writeFileSync(join(traceDir, 'probes.json'), `${JSON.stringify({ harnessVersion: HARNESS_VERSION, checkerModel, checkVersion: SUMMARY_CHECK_VERSION, results }, null, 1)}\n`)
  return results
}

export function summarizeProbes(results) {
  const byProbe = {}
  for (const r of results) {
    const b = (byProbe[r.probe] ||= { expect: r.expect, runs: 0, modelCorrect: 0, deterministicCorrect: 0, errors: 0 })
    b.runs += 1
    if (r.modelVerdict === 'error') b.errors += 1
    else if (r.modelVerdict === r.expect) b.modelCorrect += 1
    if (r.deterministic === r.expect) b.deterministicCorrect += 1
  }
  return byProbe
}

// --- holdout grading (provisional model pre-grade; physician grading decides) ----------------

export const GRADE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['hard_failures', 'primary_covered', 'numeric_binding_ok', 'readability', 'notes'],
  properties: {
    hard_failures: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['kind', 'quote', 'reason'], properties: { kind: { type: 'string', enum: ['reversed-direction', 'omitted-decisive-exception', 'causal-overclaim', 'invented-limitation', 'blanket-withholding-despite-adequate-source'] }, quote: { type: 'string' }, reason: { type: 'string' } } } },
    primary_covered: { type: 'boolean' },
    numeric_binding_ok: { type: 'boolean' },
    readability: { type: 'integer' },
    notes: { type: 'string' },
  },
}
const GRADE_SYSTEM = `You are grading ONE displayed summary of a medical paper against the complete source evidence, using the round-3 rubric. Hard failures: reversed direction of effect; an omitted decisive exception (a conflicting analysis, a null primary result, a certainty grade or timing that changes the reading); a causal overclaim for a non-randomized or secondary comparison; an invented limitation the source does not state; blanket withholding (summary unavailable or an excerpt-only fallback) although the source has an adequate, summarizable result. Also say whether the primary result is covered, whether every number is attached to the right outcome, comparator, analysis, timepoint and direction, and rate readability 1 (unreadable) to 5 (a colleague would repeat it). Quote the source for every failure. This grade is PROVISIONAL; a physician grades the same outputs independently.`
export async function gradeTake({ take, candidate, model = 'claude-sonnet-5-5' }) {
  const content = `PAPER: ${candidate.title}\nDESIGN: ${candidate.design || 'unknown'}\n\nEVIDENCE:\n${candidate.evidence}\n\nDISPLAY CATEGORY: ${take.summaryKind}\nDISPLAYED SUMMARY: ${take.finding || '(summary unavailable)'}\nDESIGN CAUTION: ${take.designCaution || '(none)'}\nPIPELINE REASON: ${take.summaryReason || take.check?.reason || ''}`
  const response = await extractStructured({ model, system: GRADE_SYSTEM, content, schema: GRADE_SCHEMA, maxTokens: 2048, thinking: { type: 'disabled' }, purpose: 'holdout-grade' })
  return { model, response }
}

// A holdout paper from a saved PMC XML record: parse, extract (paid), verify, summarize.
export function holdoutResultFromXml({ pmid, xml, title }) {
  const source = parsePmcFullText(xml)
  if (!source.hasBody) throw new Error(`PMC record for ${pmid} has no body.`)
  const assembled = assembleExtractionSource(source)
  return {
    result: {
      paper: { id: String(pmid), pmid: String(pmid), title: title || '' }, design: null,
      source: { tier: source.tier, hash: sha256(assembled.modelText), hasBody: true, pmcid: source.pmcid || null },
      sourceDoc: { text: assembled.corpusText, tables: assembled.tables },
      evidenceSource: { tier: source.tier, abstractParts: source.abstractParts || [], abstract: source.abstract || '', sections: source.sections || [] },
      rows: [], resultContract: HANDOFF_VERSION, resultContexts: [],
    },
    modelText: assembled.modelText,
    sourceSha256: sha256(xml),
  }
}

export function reportCounts(outcomes) {
  const kinds = { validated: 0, excerpt: 0, unavailable: 0 }
  for (const o of outcomes) kinds[o.take?.summaryKind || 'unavailable'] = (kinds[o.take?.summaryKind || 'unavailable'] || 0) + 1
  return kinds
}
