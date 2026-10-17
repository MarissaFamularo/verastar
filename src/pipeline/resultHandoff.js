// pipeline/resultHandoff.js — the per-paper RESULT HANDOFF the summary path reads.
//
// Result proposals (the extractor's typed quantities and their quoted context spans) are
// not scientific proof. This module does three deterministic things with them:
//   1. normalizeResultContexts — wire (array-of-zero-or-one) -> saved (null-or-span) form,
//      refusing malformed responses before anything is verified (170a26c contract).
//   2. buildResultHandoff — locate EVERY proposed span in the saved source with the shared
//      locator (quoteLocate.js), keep the result of every attempt, and attach the row's
//      numeric verdict. Nothing is dropped: a record whose field failed to locate stays a
//      record with that field marked, a partial comparison stays a partial comparison, a
//      label that its quote does not print is reported as such. The 170a26c rules that
//      removed a whole record on one failed field, rejected non-verbatim labels by token
//      membership and refused partial comparisons are deliberately NOT adopted (the final
//      five-paper evaluation showed they rejected supported material for mechanical
//      reasons).
//   3. The approval key — a stale summary approval is invalidated when the source, the
//      proposals, the approved text or the contract version changed (170a26c).
import { isRelationshipValidated } from '../lib/evidenceVersion.js'
import { CONTEXT_FIELDS, CONTEXT_LISTS } from '../../supabase/functions/_shared/extractionContract.js'
import { locateQuote, locateSpan, labelInQuote, locateAudit } from './quoteLocate.js'
import { completeEvidenceFor } from './evidencePassages.js'
import { abstractTextFor } from './obligations.js'

export { CONTEXT_FIELDS, CONTEXT_LISTS, RESULT_CONTEXT_SCHEMA } from '../../supabase/functions/_shared/extractionContract.js'
export const HANDOFF_VERSION = 'result-handoff-v5'
// Bytes of source text one summary request may carry; mirrors evidencePassages.js.
export const MAX_HANDOFF_BYTES = 127232

export const RESULT_CONTEXT_INSTRUCTIONS = `Also return result_contexts, one per quantity, linked by zero-based quantity_index. These are PROPOSED relationships, not verified facts. Each single-span field is an array containing zero or one span. Use [] for unknown and [span] for known; never emit null or more than one span. Each span has text (an exact source substring), quote (a complete supporting passage copied exactly, usually the whole sentence), and corpus (text or tables). An empty array means unknown, never secondary. Preserve outcome, ordered intervention/comparator (do not infer ratio orientation), analysis, intervention timing separately from outcome timepoint, endpoint role separately from analysis role, and a qualitative effect phrase. For effect and qualifications use number-free source phrases, not statistics. endpointRole must quote the sentence that DECLARES the endpoint's role (for example "The primary outcome was ..."), when the paper prints one. qualifications lists clinically necessary caveats the source attaches to this result (certainty grade, power, exploratory status, nonproportional hazards, preferred versus supplementary estimators). conflictingAnalyses lists passages where a DIFFERENT analysis of the same outcome reaches a different conclusion (intention-to-treat versus per-protocol, conventional versus weighted or propensity-adjusted, Cox versus restricted mean survival time, primary versus sensitivity analysis); use [] when the source reports none. Preserve withdrawal timing and comparator duration explicitly. Include null or conflicting results, not only favorable ones. Source quotations may span sentences and must preserve context. Never infer fields from a quantity's name. Do not change the numeric extraction rules.`

const validSpan = (span) => span && typeof span === 'object' && !Array.isArray(span)
  && Object.keys(span).sort().join(',') === 'corpus,quote,text'
  && typeof span.text === 'string' && Boolean(span.text.trim())
  && typeof span.quote === 'string' && Boolean(span.quote.trim())
  && ['text', 'tables'].includes(span.corpus)

// Wire -> saved form. Rejects malformed responses before verification; never chooses the
// first of competing spans. A saved record (already null-or-span) passes through unchanged
// so frozen records and cache replays normalize identically. A missing multi-span list is
// empty (records written before `conflictingAnalyses` existed).
export function normalizeResultContexts(contexts) {
  const diagnostics = []
  if (!Array.isArray(contexts)) diagnostics.push({ reason: 'result-contexts-not-array' })
  const normalized = (Array.isArray(contexts) ? contexts : []).map((context, index) => {
    if (!context || typeof context !== 'object' || Array.isArray(context)) {
      diagnostics.push({ index, reason: 'malformed-context' }); return null
    }
    const expected = ['quantity_index', ...CONTEXT_FIELDS, ...CONTEXT_LISTS]
    if (!Number.isInteger(context.quantity_index) || context.quantity_index < 0
      || Object.keys(context).some(key => !expected.includes(key))) diagnostics.push({ index, reason: 'malformed-context' })
    const fields = Object.fromEntries(CONTEXT_FIELDS.map(key => {
      const value = context[key]
      if (value === null || value === undefined) return [key, null]
      if (!Array.isArray(value)) {
        if (validSpan(value)) return [key, value]
        diagnostics.push({ index, field: key, reason: 'expected-zero-or-one-valid-span' }); return [key, null]
      }
      if (value.length > 1 || (value.length === 1 && !validSpan(value[0]))) {
        diagnostics.push({ index, field: key, reason: 'expected-zero-or-one-valid-span' }); return [key, null]
      }
      return [key, value.length ? value[0] : null]
    }))
    const lists = Object.fromEntries(CONTEXT_LISTS.map(key => {
      const value = context[key]
      if (value === undefined) return [key, []]
      if (!Array.isArray(value) || !value.every(validSpan)) { diagnostics.push({ index, field: key, reason: `malformed-${key}` }); return [key, []] }
      return [key, value]
    }))
    return { quantity_index: context.quantity_index, ...fields, ...lists }
  })
  if (diagnostics.length) {
    const error = new Error(`Invalid result context wire response: ${JSON.stringify(diagnostics)}`)
    error.diagnostics = diagnostics
    throw error
  }
  return normalized
}

// Cheap deterministic text fingerprint (FNV-1a, 32-bit, two seeds). The approval key binds
// to the source sha256 when the run recorded one; this fingerprint covers saved text that
// has no stamp. Not cryptographic; tampering is not the threat, staleness is.
export function textFingerprint(text) {
  const s = String(text ?? '')
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ c, 0x811c9dc5) >>> 0
  }
  return `${s.length}:${a.toString(16)}${b.toString(16)}`
}

function kindOf(fields) {
  const present = ['intervention', 'comparator', 'effect'].filter((k) => fields[k]?.status === 'located')
  return present.length === 3 ? 'comparative' : present.length === 0 ? 'descriptive' : 'partial'
}

// Build the handoff for one runPaper() result: { version, paperId, complete, source,
// records, audit, diagnostics, key }. Pure, synchronous, no model.
export function buildResultHandoff(result) {
  const source = { text: result?.sourceDoc?.text || '', tables: result?.sourceDoc?.tables || '' }
  const bytes = new TextEncoder().encode(source.text + source.tables).length
  const complete = Boolean(source.text || source.tables) && bytes <= MAX_HANDOFF_BYTES
  const contexts = Array.isArray(result?.resultContexts) ? result.resultContexts : []
  const rows = Array.isArray(result?.rows) ? result.rows : []
  const id = String(result?.paper?.id ?? '')
  const records = []
  const diagnostics = []
  const attempts = []
  const seen = new Set()
  const duplicate = new Set()
  for (const context of contexts) {
    const index = context?.quantity_index
    if (seen.has(index)) duplicate.add(index)
    seen.add(index)
  }
  for (const context of contexts) {
    const index = context?.quantity_index
    if (!Number.isInteger(index) || index < 0 || !rows[index]?.quantity || duplicate.has(index)) {
      diagnostics.push({ quantityIndex: index, reason: duplicate.has(index) ? 'duplicate-context-index' : 'invalid-context-index' })
      continue
    }
    const row = rows[index]
    const quantity = row.quantity
    // Anchor: the row's own quote, located in its corpus. Repeated context text is then
    // resolved to the occurrence nearest the result it describes.
    const anchorCorpus = row.verdict?.matched?.corpus === 'tables' ? 'tables' : 'text'
    const anchor = locateQuote(source[anchorCorpus], quantity.source_quote)
    const near = anchor.status === 'located' ? anchor.normStart : null
    const nearFor = (span) => (span?.corpus === anchorCorpus ? near : null)
    const locateField = (span) => {
      if (span == null) return null
      const located = locateSpan(source, span, { near: nearFor(span) })
      const out = { ...located, labelInQuote: labelInQuote(span) }
      attempts.push(out)
      return out
    }
    const fields = Object.fromEntries(CONTEXT_FIELDS.map((key) => [key, locateField(context[key])]))
    const lists = Object.fromEntries(CONTEXT_LISTS.map((key) => [key, (Array.isArray(context[key]) ? context[key] : []).map(locateField)]))
    const unlocated = [
      ...Object.entries(fields).filter(([, f]) => f && f.status !== 'located').map(([field, f]) => ({ field, status: f.status })),
      ...CONTEXT_LISTS.flatMap((key) => lists[key].map((f, i) => ({ field: `${key}[${i}]`, status: f.status })).filter((x) => x.status !== 'located')),
    ]
    if (unlocated.length) diagnostics.push({ quantityIndex: index, unlocated })
    const numeric = isRelationshipValidated(row.verdict)
    records.push({
      id: `${id}:result:${index}`,
      rowIndex: index,
      kind: kindOf(fields),
      fields,
      ...lists,
      unlocated,
      quantity,
      verdict: row.verdict,
      numeric,
      numericStatus: numeric ? 'tuple-verified' : row.verdict?.numericCoverage ? 'tokens-present-tuple-unproven' : 'numeric-or-source-failure',
      anchor: anchor.status === 'located' ? { corpus: anchorCorpus, start: anchor.start, end: anchor.end, normStart: anchor.normStart } : { status: anchor.status },
    })
  }
  const key = JSON.stringify([
    HANDOFF_VERSION, id, result?.source?.tier || null, result?.source?.hash || null,
    textFingerprint(source.text), textFingerprint(source.tables),
    contexts, rows.map((row) => row.quantity),
  ])
  return { version: HANDOFF_VERSION, paperId: id, complete, bytes, source, records, audit: locateAudit(attempts), diagnostics, key }
}

// What a call site spreads into a triage candidate: the handoff, the COMPLETE evidence
// passages (evidencePassages.js) and the abstract text the obligation list reads.
export function resultCandidate(result) {
  const window = completeEvidenceFor(result)
  return {
    resultHandoff: buildResultHandoff(result),
    evidence: window.blocked ? '' : window.text,
    evidenceMeta: { version: window.version, kind: window.kind, basis: window.basis, blocked: !!window.blocked, reason: window.reason, chars: window.text?.length || 0 },
    abstract: abstractTextFor(result),
  }
}

// The summary-path fields a take carries through every store (digest snapshot, library
// record, scheduled run). Absent on production-path takes.
export const SUMMARY_TAKE_FIELDS = ['summaryKind', 'summaryReason', 'summaryApproval', 'summaryChecks', 'summaryPath', 'rewriteUsed', 'checkerModel', 'checkVersion', 'excerptSpans', 'resultContract']
export function summaryFields(take) {
  const out = {}
  for (const key of SUMMARY_TAKE_FIELDS) if (take && take[key] !== undefined) out[key] = take[key]
  return out
}

// Fields a summary approval binds to. A restored take whose approval does not match the
// re-derived handoff (source, proposals, contract) or whose text changed is withheld.
export const SUMMARY_APPROVAL_VERSION = 'summary-approval-v1'
export function summaryApprovalFor(handoff, take, { checkerModel = null, writerModel = null, obligationsKey = null } = {}) {
  return {
    version: SUMMARY_APPROVAL_VERSION,
    contract: HANDOFF_VERSION,
    key: handoff.key,
    finding: String(take.finding ?? ''),
    summaryKind: take.summaryKind || 'unavailable',
    designCaution: String(take.designCaution ?? ''),
    checkerModel,
    writerModel,
    obligationsKey,
  }
}

export const STALE_SUMMARY_REASON = 'Summary withheld: its approval is missing or no longer matches the saved source, proposals, text or contract version.'

// Re-validate a saved take against the result it was saved with. Read-time only; nothing
// is written back. A take with no approval at all is left to the legacy policy (the
// production number guard), so papers summarized before this contract keep their behaviour.
export function restoreSummaryApproval(result, take) {
  if (!take || typeof take !== 'object') return take
  const approval = take.summaryApproval
  if (!approval && !take.summaryKind) return take
  const stale = (reason) => ({
    ...take, finding: '', summaryKind: 'unavailable', summaryReason: reason,
    check: { verdict: 'refuted', reason },
    designCaution: '', cautionCheck: { verdict: 'refuted', reason },
  })
  if (!approval || approval.version !== SUMMARY_APPROVAL_VERSION || approval.contract !== HANDOFF_VERSION) return stale(STALE_SUMMARY_REASON)
  const handoff = buildResultHandoff(result)
  if (approval.key !== handoff.key) return stale(STALE_SUMMARY_REASON)
  if (String(take.finding ?? '') !== approval.finding || (take.summaryKind || 'unavailable') !== approval.summaryKind) return stale(STALE_SUMMARY_REASON)
  if (String(take.designCaution ?? '') !== approval.designCaution) {
    return { ...take, designCaution: '', cautionCheck: { verdict: 'refuted', reason: 'Approved caution text changed.' } }
  }
  return take
}

// Read-only Library adapter: a saved paper carries its own source text, quantities and
// proposals, so the approval is re-derived from them. Legacy papers pass through.
export function currentResultPaper(paper) {
  if (!paper || (!paper.summaryApproval && !paper.summaryKind)) return paper
  const result = {
    paper: { id: paper.id },
    sourceDoc: { text: paper.fullText || '', tables: paper.tables || '' },
    source: { tier: paper.sourceTier, hash: paper.sourceHash },
    resultContexts: paper.resultContexts || [],
    rows: (paper.quantities || []).map((saved) => {
      const quantity = { ...saved }
      delete quantity.tier
      delete quantity.verdict
      return { quantity, verdict: saved.verdict }
    }),
  }
  return restoreSummaryApproval(result, paper)
}
