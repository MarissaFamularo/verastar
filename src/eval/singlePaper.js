// eval/singlePaper.js — compare ONE paper's extraction and verification with a private,
// clinician-adjudicated reference. Offline and single-paper by construction:
//   - the source is one saved PMC XML record, parsed by the app's own parser;
//   - no folder or list input, no shared/production evidence cache, no store;
//   - planning makes no model call. A run needs an injected provider; the CLI
//     (scripts/eval-single-paper.mjs) defaults to a dry-run. Its live path is gated on an
//     explicit model, a validated per-run cap that covers the conservative charge bound,
//     and an operator guard — which is NOT proof of human permission; a live run still
//     needs Marissa's separate authorization.
// A fake provider exercises the plumbing only. Its output measures nothing about a model.
// The comparison lists numeric candidates for human review; it never scores a claim.

import { parsePmcFullText, assembleExtractionSource } from '../pipeline/sources.js'
import { EXTRACTION_SCHEMA, EXTRACTION_SYSTEM, EXTRACTION_MAX_TOKENS, dropUnprovenLabels } from '../pipeline/extract.js'
import { verify, numbersEqual } from '../pipeline/verify.js'
import { selectEvidenceWindow } from '../pipeline/evidenceWindow.js'
import { badgeExplanation } from '../lib/badgeWord.js'
import { CURRENT_EXTRACTION_VERSION, VERIFICATION_VERSION } from '../lib/evidenceVersion.js'
import { microToUsd } from '../../supabase/functions/_shared/pricing.js'
import { parseStructuredResponse, thinkingParam } from '../lib/anthropic.js'
import { isEvalPricedModel, isEvalOnlyModel, evalContextWindowTokens, evalMaxChargeMicro, evalChargeBoundBasis, evalPriceUsage, evalThinkingRecord } from './evalModels.js'

// v3 (2026-10-10): eval-only models (evalModels.js), request settings and component hashes
// in the plan and receipt, a response-model identity check, and the parsed extraction kept
// before label post-processing. The request body built for an already supported model is
// byte-identical to v2's.
export const HARNESS_VERSION = '2026-10-10.single-paper-v3'
// Explicit per-attempt timeout for a live request (the SDK default is 10 minutes, and it
// would also retry a timeout). One attempt, no retries — see makeLiveProvider.
export const LIVE_TIMEOUT_MS = 300_000

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

// The request extractQuantities would send for this source — same system prompt, schema,
// content framing and first-attempt token cap. One attempt only: the harness never
// retries, so its spending bound is a single request.
export function extractionRequest({ studyId, sourceText, model }) {
  return {
    model,
    system: EXTRACTION_SYSTEM,
    content: `study_id: ${studyId}\n\nSOURCE TEXT:\n${sourceText}`,
    schema: EXTRACTION_SCHEMA,
    maxTokens: EXTRACTION_MAX_TOKENS,
    thinking: { type: 'disabled' },
  }
}

// The exact Messages API body the live adapter sends for a planned request. Pure, so the
// plan can hash it without a client: the same function builds what is dispatched. The
// shared thinkingParam is used as-is (it maps 'disabled' to 'between_tools' for Sonnet 5.5
// and passes it through for every other model). No effort, cache_control, tools, betas,
// sampling parameters or service tier are sent.
export function liveRequestBody(request) {
  const thinking = thinkingParam(request.model, request.thinking)
  return {
    model: request.model,
    max_tokens: request.maxTokens,
    system: request.system,
    ...(thinking ? { thinking } : {}),
    messages: [{ role: 'user', content: request.content }],
    output_config: { format: { type: 'json_schema', schema: request.schema } },
  }
}

// What makes a run reproducible and comparable across models, without the paper's text:
// the settings actually sent, and hashes of the system prompt, schema and content. Two
// runs with equal system/schema/content hashes used the same prompt on the same input.
export async function requestSettings(request) {
  const body = liveRequestBody(request)
  return {
    endpoint: 'messages.create (non-streaming)',
    maxTokens: body.max_tokens,
    ...evalThinkingRecord(request.model, { thinkingRequested: request.thinking ?? null, thinkingSent: body.thinking ?? null, effortSent: body.output_config.effort ?? null }),
    outputFormat: body.output_config.format.type,
    cacheControl: false,
    tools: false,
    betas: [],
    samplingParameters: false,
    systemSha256: await sha256Hex(body.system),
    schemaSha256: await sha256Hex(JSON.stringify(request.schema)),
    contentSha256: await sha256Hex(request.content),
    requestSha256: await sha256Hex(JSON.stringify(body)),
  }
}

// The enforceable bound on what one request can cost — the same conservative bound the
// sponsored proxy uses (supabase/functions/_shared/requestPolicy.js): the model's whole
// context window as input, max_tokens as output. The API rejects any request whose input
// exceeds the context window, so no request can be billed above this. For a model priced
// by prompt length the whole-context bound is priced at its long-prompt rate. Unpriced
// models have no bound and cannot run live.
export function requestChargeBoundUsd(request) {
  if (!isEvalPricedModel(request.model)) return null
  return microToUsd(evalMaxChargeMicro(request.model, { maxInputTokens: evalContextWindowTokens(request.model), maxOutputTokens: request.maxTokens }))
}

// A planning ESTIMATE, not a bound: UTF-8 bytes of the system prompt, content and schema
// taken as input tokens, plus max_tokens of output. Request framing and provider-side schema
// processing are not modelled, so this may under-count. Never gate spending on it.
export function roughEstimateUsd(request) {
  if (!isEvalPricedModel(request.model)) return null
  const bytes = new TextEncoder().encode(`${request.system}\n${request.content}\n${JSON.stringify(request.schema)}`).length
  return microToUsd(evalMaxChargeMicro(request.model, { maxInputTokens: bytes, maxOutputTokens: request.maxTokens }))
}

// A per-run cap must be a finite, positive number of dollars.
export const validCap = (maxUsd) => typeof maxUsd === 'number' && Number.isFinite(maxUsd) && maxUsd > 0

// Plan a run: parse the one source, hash it, build the window and the exact request. No
// model call, no network, no cache.
export async function planSinglePaper({ caseId, pmid, pmcXml, model = null, maxUsd = null }) {
  if (typeof caseId !== 'string' || !/^[A-Z]+-\d+$/.test(caseId)) throw new Error('One case id, like CAR-10.')
  if (typeof pmcXml !== 'string' || !pmcXml.includes('<')) throw new Error('One PMC XML record as a string.')
  const source = parsePmcFullText(pmcXml)
  if (!source.hasBody) throw new Error('The PMC record has no <body>; this harness evaluates full-text records only.')
  // Same shared assembly production uses (publisher abstract + body + tables).
  const assembled = assembleExtractionSource(source)
  const sourceText = assembled.modelText
  const request = extractionRequest({ studyId: String(pmid), sourceText, model })
  const bound = model ? requestChargeBoundUsd(request) : null
  if (maxUsd != null && !validCap(maxUsd)) throw new Error('--max-usd must be a finite positive number of dollars.')
  const window = selectEvidenceWindow(source)
  return {
    harnessVersion: HARNESS_VERSION,
    caseId,
    pmid: String(pmid),
    sourceTier: source.tier,
    sourceSha256: await sha256Hex(pmcXml),
    extractionInputSha256: await sha256Hex(sourceText),
    extractionInputChars: sourceText.length,
    tablesPresent: !!source.tables,
    // Explicit coverage limits for reviewers: which material the model/verifier could see.
    // Figure-image text (e.g. numbers only in a figure) is never extracted.
    inputCoverage: assembled.coverage,
    evidenceWindow: { kind: window.kind, parts: window.parts, limited: window.limited, reason: window.reason, chars: window.text.length },
    model,
    maxUsd,
    chargeBoundUsd: bound,
    chargeBoundBasis: bound != null ? evalChargeBoundBasis(model, { maxInputTokens: evalContextWindowTokens(model), maxOutputTokens: request.maxTokens }) : null,
    priceTable: model ? (isEvalOnlyModel(model) ? 'eval-only (src/eval/evalModels.js)' : bound != null ? 'shared (supabase/functions/_shared/pricing.js)' : null) : null,
    estimateNotABoundUsd: model ? roughEstimateUsd(request) : null,
    withinBound: bound != null && maxUsd != null ? bound <= maxUsd : null,
    extractionVersion: CURRENT_EXTRACTION_VERSION,
    verificationVersion: VERIFICATION_VERSION,
    requestSettings: model ? await requestSettings(request) : null,
    request,
    source,
    assembled,
  }
}

// A plan WITHOUT the paper's text: drops `source` and `assembled` (the full assembled
// corpus) and reduces `request` to sizes and settings. Everything that summarizes a plan
// for a report or log must go through this so full source never leaks.
export function planSummary(plan) {
  const { source: _source, assembled: _assembled, request, ...summary } = plan
  return {
    ...summary,
    request: {
      model: request.model,
      maxTokens: request.maxTokens,
      systemChars: request.system.length,
      contentChars: request.content.length,
      thinking: request.thinking,
    },
  }
}

// The live adapter. ONE attempt: SDK retries are disabled (the SDK default is 2, which made
// one call three requests — Codex R2), with an explicit timeout. An attempt receipt, bound
// to the source, the model and the exact request body, is handed to `onReceipt` BEFORE
// dispatch and again after, with the provider's request id, usage, priced charge and
// latency when available. An error is classified, never guessed away:
//   'rejected'  — a 4xx other than 408: the provider refused the request;
//   'ambiguous' — timeout, connection failure, 408 or 5xx (incl. 529): the request may or
//                 may not have been processed or billed.
// `fetch` and `Anthropic` are injectable so tests use a fake transport; nothing here runs
// unless the CLI's live gate passed.
export function makeLiveProvider({ apiKey, fetch, Anthropic, timeoutMs = LIVE_TIMEOUT_MS, onReceipt = async () => {}, now = () => Date.now(), context = {} } = {}) {
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) throw new Error('An explicit positive timeout is required.')
  return async (request) => {
    const Client = Anthropic || (await import('@anthropic-ai/sdk')).default
    const client = new Client({ apiKey, maxRetries: 0, timeout: timeoutMs, ...(fetch ? { fetch } : {}) })
    const body = liveRequestBody(request)
    const settings = await requestSettings(request)
    const receipt = {
      harnessVersion: HARNESS_VERSION,
      ...context,
      model: request.model,
      requestSha256: settings.requestSha256,
      requestSettings: settings,
      maxRetries: 0,
      timeoutMs,
      startedAt: new Date(now()).toISOString(),
      status: 'dispatching',
    }
    await onReceipt({ ...receipt })
    const t0 = now()
    let res
    try {
      const out = await client.messages.create(body).withResponse()
      res = out.data
      Object.assign(receipt, { requestId: out.request_id ?? null, responseModel: res?.model ?? null, stopReason: res?.stop_reason ?? null, usage: res?.usage ?? null })
    } catch (err) {
      const status = typeof err?.status === 'number' ? err.status : null
      Object.assign(receipt, {
        latencyMs: now() - t0,
        status: 'failed',
        outcome: status != null && status >= 400 && status < 500 && status !== 408 ? 'rejected' : 'ambiguous',
        error: { name: err?.constructor?.name || 'Error', status, message: String(err?.message || err) },
        requestId: err?.requestID ?? null,
      })
      await onReceipt({ ...receipt })
      throw err
    }
    receipt.latencyMs = now() - t0
    // The response must name the requested model. A different model's usage is not priced
    // as the requested one, and its output is not a valid comparison for it: the receipt
    // keeps the usage as evidence, unpriced, and the run fails.
    receipt.responseModelMatches = res?.model === request.model
    if (!receipt.responseModelMatches) {
      Object.assign(receipt, {
        status: 'response-model-mismatch',
        chargeUsd: null,
        chargeUnpricedReason: 'response_model_mismatch',
        error: { name: 'ResponseModelMismatch', message: `Requested ${request.model}; the response names ${res?.model ?? 'no model'}.` },
      })
      await onReceipt({ ...receipt })
      throw new Error(`${receipt.error.message} Not a valid comparison; usage is recorded unpriced.`)
    }
    const priced = res?.usage ? evalPriceUsage(request.model, res.usage) : { ok: false, reason: 'missing_usage' }
    Object.assign(receipt, priced.ok
      ? { chargeUsd: microToUsd(priced.micro), ...(priced.promptTier ? { chargePromptTier: priced.promptTier, chargePromptTokens: priced.promptTokens } : {}) }
      : { chargeUsd: null, chargeUnpricedReason: priced.reason })
    try {
      const parsed = parseStructuredResponse(res)
      receipt.status = 'completed'
      await onReceipt({ ...receipt })
      return parsed
    } catch (err) {
      Object.assign(receipt, { status: 'response-unusable', error: { name: err?.constructor?.name || 'Error', message: String(err?.message || err) } })
      await onReceipt({ ...receipt })
      throw err
    }
  }
}

// Run the plan through an injected provider `(request) => extraction object`. The
// provider is the only thing that could spend; this function never constructs one.
export async function runSinglePaper(plan, provider, { label }) {
  if (typeof provider !== 'function') throw new Error('A provider function is required; planning alone never calls a model.')
  if (label !== 'fake' && label !== 'live') throw new Error('Label the provider "fake" or "live".')
  const extraction = await provider(plan.request)
  const quantities = Array.isArray(extraction?.quantities) ? extraction.quantities : []
  const rows = quantities.map(dropUnprovenLabels).map((quantity) => ({
    quantity,
    verdict: verify(quantity, { text: plan.assembled.corpusText, tables: plan.assembled.tables }, { sourceTier: plan.sourceTier }),
  }))
  return {
    provider: label,
    note: label === 'fake' ? 'FAKE PROVIDER — plumbing check only; says nothing about model quality.' : 'Live model output; compare against the adjudicated reference only.',
    design: extraction?.design ?? null,
    // The provider's parsed extraction exactly as returned, BEFORE dropUnprovenLabels. A null
    // label in `rows` may be this harness's post-processing; here it is the model's own.
    rawExtraction: extraction ?? null,
    rows: rows.map(({ quantity, verdict }) => ({ quantity, tier: verdict.tier, reason: verdict.reason, explanation: badgeExplanation(verdict.tier, plan.sourceTier) })),
  }
}

const same = (a, b) => a == null || b == null ? a == null && b == null : numbersEqual(Number(a), Number(b))
const close = (a, b) => a != null && b != null && numbersEqual(Number(a), Number(b))

// Numeric candidates for human review — NOT a score. For each reference item it lists every
// extracted row whose printed numbers coincide with the item's, with what the numbers say
// about the P (match / missing / mismatch / not-expected) and whether a pair is reversed.
// A numeric coincidence does not bind a clinical claim: the same value can belong to another
// endpoint, population or timepoint, so every candidate carries empty review fields that
// only a person fills (endpoint, population, timepoint, arms, pBinding). The reference
// being adjudicated does not adjudicate a new model output, so nothing here is "found",
// "scored" or counted as a success.
export function compareToReference(run, reference) {
  const items = Array.isArray(reference?.items) ? reference.items : []
  const matchedRows = new Set()
  const out = items.map((item) => {
    const e = item.expected || {}
    if (item.status !== 'source-supported' || (e.value == null && e.first_value == null)) {
      return { id: item.id, referenceStatus: item.status ?? null, candidates: [], note: 'No printed numbers to compare; human review only.' }
    }
    const candidates = []
    run.rows.forEach((row, rowIndex) => {
      const q = row.quantity || {}
      let reversed = false
      if (e.value != null) {
        if (!close(q.value, e.value)) return
      } else if (close(q.first_value, e.first_value) && close(q.second_value, e.second_value)) {
        reversed = false
      } else if (!same(e.first_value, e.second_value) && close(q.first_value, e.second_value) && close(q.second_value, e.first_value)) {
        reversed = true
      } else return
      matchedRows.add(rowIndex)
      candidates.push({
        rowIndex,
        extractedName: q.name ?? null,
        tier: row.tier ?? null,
        numbers: {
          value: e.value != null ? 'match' : null,
          ci: e.ci_low == null && e.ci_high == null ? 'not-expected' : same(q.ci_low, e.ci_low) && same(q.ci_high, e.ci_high) ? 'match' : q.ci_low == null && q.ci_high == null ? 'missing' : 'mismatch',
          p: e.p_value == null ? (q.p_value == null ? 'not-expected' : 'extra') : q.p_value == null ? 'missing' : close(q.p_value, e.p_value) ? 'match' : 'mismatch',
          reversed,
        },
        review: { endpoint: null, population: null, timepoint: null, arms: null, pBinding: null, reviewer: null },
      })
    })
    return { id: item.id, referenceStatus: item.status, candidates }
  })
  return {
    scored: false,
    status: 'numeric-candidates-pending-review',
    referenceAdjudicationStatus: reference?.adjudicationStatus ?? null,
    note: 'Unscored numeric candidates. A person must review each candidate\'s endpoint, population, timepoint, arms and P binding before any result is counted.',
    items: out,
    rowsWithoutCandidates: run.rows.map((row, i) => ({ rowIndex: i, name: row.quantity?.name ?? null, tier: row.tier ?? null })).filter((r) => !matchedRows.has(r.rowIndex)),
  }
}
