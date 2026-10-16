// Result proposals are not scientific proof. Exact source location and numeric
// verification are deterministic; relationships require the independent checker.
import { verify, normalize } from './verify.js'
import { fmtNum } from '../lib/format.js'
import { numbersGrounded } from './numberFree.js'

export const HANDOFF_VERSION = 'result-handoff-v3'
export const MAX_HANDOFF_BYTES = 127232
export const CONTEXT_FIELDS = ['outcome', 'intervention', 'comparator', 'analysis', 'interventionTiming', 'outcomeTimepoint', 'endpointRole', 'analysisRole', 'effect']
const object = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties })
const string = { type: 'string' }
const spanSchema = object({ text: string, quote: string, corpus: { type: 'string', enum: ['text', 'tables'] } })
export const RESULT_CONTEXT_SCHEMA = object({
  quantity_index: { type: 'integer' },
  // Provider supports minItems 0/1, not maxItems. Cardinality stays strict locally.
  ...Object.fromEntries(CONTEXT_FIELDS.map(key => [key, { type: 'array', minItems: 0, items: spanSchema }])),
  qualifications: { type: 'array', items: spanSchema },
})
export const RESULT_CONTEXT_INSTRUCTIONS = `Also return result_contexts, one per quantity, linked by zero-based quantity_index. These are PROPOSED relationships, not verified facts. Each context field is an array containing zero or one span. Use [] for unknown and [span] for known; never emit null or more than one span. Each span has text (an exact source substring), quote (a complete supporting passage copied exactly), and corpus (text or tables). An empty array means unknown, never secondary. Preserve outcome, ordered intervention/comparator (do not infer ratio orientation), analysis, intervention timing separately from outcome timepoint, endpoint role separately from analysis role, and a qualitative effect phrase. For effect and qualifications use number-free source phrases, not statistics. Keep clinically necessary qualifications, conflicting analyses, nonproportional hazards and preferred versus supplementary estimators. Preserve withdrawal timing and comparator duration explicitly. Include null or conflicting results, not only favorable ones. Source quotations may span sentences and must preserve context. Never infer fields from a quantity's name. Do not change the numeric extraction rules.`

// Wire-only representation avoids provider union compilation limits. Saved records
// and the checker retain the original null-or-span contract. Reject malformed
// responses before verification; never choose the first of competing spans.
export function normalizeResultContexts(contexts) {
  const diagnostics = []
  const validSpan = span => span && typeof span === 'object' && !Array.isArray(span)
    && Object.keys(span).sort().join(',') === 'corpus,quote,text'
    && typeof span.text === 'string' && Boolean(span.text.trim())
    && typeof span.quote === 'string' && Boolean(span.quote.trim())
    && ['text', 'tables'].includes(span.corpus)
  if (!Array.isArray(contexts)) diagnostics.push({ reason: 'result-contexts-not-array' })
  const normalized = (Array.isArray(contexts) ? contexts : []).map((context, index) => {
    if (!context || typeof context !== 'object' || Array.isArray(context)) {
      diagnostics.push({ index, reason: 'malformed-context' }); return null
    }
    const expected = ['quantity_index', ...CONTEXT_FIELDS, 'qualifications']
    if (!Number.isInteger(context.quantity_index) || context.quantity_index < 0
      || Object.keys(context).some(key => !expected.includes(key))) diagnostics.push({ index, reason: 'malformed-context' })
    const fields = Object.fromEntries(CONTEXT_FIELDS.map(key => {
      const spans = context[key]
      if (!Array.isArray(spans) || spans.length > 1 || (spans.length === 1 && !validSpan(spans[0]))) {
        diagnostics.push({ index, field: key, reason: 'expected-zero-or-one-valid-span' }); return [key, null]
      }
      return [key, spans.length ? spans[0] : null]
    }))
    if (!Array.isArray(context.qualifications) || !context.qualifications.every(validSpan)) diagnostics.push({ index, field: 'qualifications', reason: 'malformed-qualifications' })
    return { quantity_index: context.quantity_index, ...fields, qualifications: context.qualifications }
  })
  if (diagnostics.length) {
    const error = new Error(`Invalid result context wire response: ${JSON.stringify(diagnostics)}`)
    error.diagnostics = diagnostics
    throw error
  }
  return normalized
}

// Two separate questions, answered separately and reported separately:
//   1. Is the QUOTE real evidence?  Exact, unique substring of the supplied corpus.
//   2. Is the LABEL faithful to it?  Verbatim is accepted as before, bar negation. A non-verbatim label
//      is accepted only when every word of it is printed in its own quote (it may drop
//      or reorder source words, never add any), a claim-bearing label keeps the quote's
//      negation (verbatim or not), and its numbers are typed contextual descriptors printed in
//      that quote.
// Neither answer proves the label MEANS what the quote means; the checker judges that
// against the complete source, and this gate records which labels are paraphrases.
const LABEL_TOKEN = /[^a-z0-9]+/
const tokens = s => normalize(s).split(LABEL_TOKEN).filter(Boolean)
const NEGATION = new Set(['not', 'no', 'never', 'neither', 'nor', 'without', 'lack', 'lacked', 'lacking', 'absence', 'absent'])
const CLAIM_FIELDS = ['effect', 'qualification']
function labelFidelity(field, key) {
  const verbatim = field.quote.includes(field.text)
  const quoteTokens = new Set(tokens(field.quote))
  const labelTokens = tokens(field.text)
  if (!verbatim && (!labelTokens.length || labelTokens.some(t => !quoteTokens.has(t)))) return 'label-not-in-quote'
  // A claim-bearing label may not shed its quote's negation, verbatim or not: "differ
  // significantly" is a substring of "did not differ significantly".
  const claim = CLAIM_FIELDS.some(k => key.startsWith(k))
  if (claim && [...quoteTokens].some(t => NEGATION.has(t)) && !labelTokens.some(t => NEGATION.has(t))) return 'label-drops-negation'
  return verbatim ? 'verbatim' : 'paraphrase'
}
// Typed contextual numbers: time units (including prefix and hyphenated forms), short
// length units for anatomic descriptors, structural analysis counts, and numbered endpoint
// classifications. No paper-specific values. They are admitted in every field, including
// qualifications and roles, because "30-day MACEs" is an endpoint name wherever it sits.
// Anything else numeric stays an explicit coverage failure, never pooled with estimate
// numbers, and a number a paraphrase carries must be printed in its own quote (fidelity
// above). The checker must still approve the meaning.
const UNITS = '(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?|mm|cm)'
const NUMBER = '(?:[≤≥<>]\\s*)?\\d+(?:\\.\\d+)?(?:\\s*(?:[-–]|to)\\s*\\d+(?:\\.\\d+)?)?'
const CONTEXTUAL_UNIT = new RegExp(`\\b${UNITS}\\s+${NUMBER}|${NUMBER}(?:-|\\s+)${UNITS}\\b`, 'gi')
function contextualNumbersStripped(text, key) {
  let contextual = text.replace(CONTEXTUAL_UNIT, '')
  if (key === 'analysis') contextual = contextual.replace(/\b\d+[- ](?:stage|step|level|way)\b/gi, '')
  if (key === 'outcome') contextual = contextual
    .replace(/\b(?:types?|grades?|stages?|classes?)\s+\d+(?:\s*(?:,|or|and|[-–])\s*\d+)*/gi, '')
    .replace(/(^|[;])\s*\(?\d+\)?[.):]\s*/g, '$1 ')
  return contextual
}

function locateField(field, source, id, key) {
  const invalid = reason => ({ invalid: true, reason })
  if (field == null) return null
  if (!field || typeof field.text !== 'string' || !field.text.trim() || typeof field.quote !== 'string' || !['text', 'tables'].includes(field.corpus)) return invalid('malformed-context-field')
  const text = source[field.corpus] || ''
  const start = text.indexOf(field.quote)
  if (!field.quote || start < 0) return invalid('context-not-located')
  if (text.indexOf(field.quote, start + 1) !== -1) return invalid('ambiguous-context-passage')
  const fidelity = labelFidelity(field, key)
  if (fidelity !== 'verbatim' && fidelity !== 'paraphrase') return invalid(fidelity)
  if (!numbersGrounded(contextualNumbersStripped(field.text, key), [])) return invalid('unsupported-context-number')
  return { text: field.text, fidelity, passageId: `${id}:${key}`, corpus: field.corpus, start, end: start + field.quote.length, quote: field.quote }
}

export function buildResultHandoff(result) {
  const source = { text: result?.sourceDoc?.text || '', tables: result?.sourceDoc?.tables || '' }
  const complete = Boolean(source.text || source.tables) && new TextEncoder().encode(source.text + source.tables).length <= MAX_HANDOFF_BYTES
  const contexts = result?.resultContexts || []
  const rows = result?.rows || []
  const id = String(result?.paper?.id ?? '')
  const records = []
  const diagnostics = []
  const seen = new Set()
  const duplicate = new Set()
  for (const context of contexts) {
    const index = context?.quantity_index
    if (seen.has(index)) duplicate.add(index)
    seen.add(index)
  }
  for (const context of contexts) {
    const index = context?.quantity_index
    if (!Number.isInteger(index) || index < 0 || !rows[index]?.quantity || duplicate.has(index)) { diagnostics.push({ quantityIndex: index, reason: duplicate.has(index) ? 'duplicate-context-index' : 'invalid-context-index' }); continue }
    const recordId = `${id}:result:${index}`
    const fields = Object.fromEntries(CONTEXT_FIELDS.map(key => [key, locateField(context[key], source, recordId, key)]))
    if (!Array.isArray(context.qualifications)) { diagnostics.push({ quantityIndex: index, failures: [{ field: 'qualifications', reason: 'missing-qualifications-array' }], missing: [] }); continue }
    const located = context.qualifications.map((f, i) => [`qualification-${i}`, locateField(f, source, recordId, `qualification-${i}`), f])
    // A field failure removes the record: the statement's identity is unsourced. A
    // qualification failure withholds only that caveat: the statement stays sourced, the
    // withheld caveat is disclosed to the checker and never rendered, and the checker
    // must refute the presentation if it misleads without it.
    const failures = Object.entries(fields).filter(([, f]) => f?.invalid)
    const comparison = ['intervention', 'comparator', 'effect'].filter(k => fields[k])
    const kind = comparison.length === 3 ? 'comparative' : comparison.length === 0 ? 'descriptive' : 'partial'
    const missing = [...(fields.outcome ? [] : ['outcome']), ...(kind === 'partial' ? ['intervention', 'comparator', 'effect'].filter(k => !fields[k]) : [])]
    const withheld = located.filter(([, f]) => f?.invalid).map(([field, f, proposed]) => ({ field, reason: f.reason, text: typeof proposed?.text === 'string' ? proposed.text : '' }))
    if (failures.length || missing.length) { diagnostics.push({ quantityIndex: index, failures: failures.map(([field, f]) => ({ field, reason: f.reason })), missing }); continue }
    if (withheld.length) diagnostics.push({ quantityIndex: index, withheld: withheld.map(({ field, reason }) => ({ field, reason })) })
    const qualifications = located.filter(([, f]) => !f?.invalid).map(([, f]) => f)
    const quantity = rows[index].quantity
    const verdict = verify(quantity, source, { sourceTier: result?.source?.tier || 'full_text' })
    const numeric = verdict.relationshipValidated === true && !verdict.flagged
    records.push({ id: recordId, rowIndex: index, kind, fields, qualifications, withheldQualifications: withheld, quantity, numeric, numericStatus: numeric ? 'tuple-verified' : verdict.numericCoverage ? 'tokens-present-tuple-unproven' : 'numeric-or-source-failure', verdict })
  }
  // Exact snapshot binding, deliberately not a lossy/non-cryptographic hash.
  // Kept app-side; never ask the checker to echo this potentially large string.
  const key = JSON.stringify([HANDOFF_VERSION, id, result?.source?.tier || null, result?.source?.hash || null, source, contexts, rows.map(row => row.quantity)])
  return { version: HANDOFF_VERSION, paperId: id, complete, source, records, diagnostics, key }
}

export function resultCandidate(result) { return { resultHandoff: buildResultHandoff(result) } }

export function prepareResultPlan(handoff, selections) {
  if (!handoff?.complete || !Array.isArray(selections)) return []
  const counts = new Map()
  for (const item of selections) counts.set(item?.id, (counts.get(item?.id) || 0) + 1)
  return selections.flatMap(item => {
    const record = handoff.records.find(r => r.id === item?.id)
    if (!record || counts.get(item.id) !== 1 || typeof item.includeEstimate !== 'boolean') return []
    // A failed numeric receipt can still support a checked qualitative comparison. A
    // descriptive result IS its number: without a verified tuple there is nothing to say.
    if (record.kind === 'descriptive' && !(item.includeEstimate && record.numeric)) return []
    return [{ id: record.id, includeEstimate: item.includeEstimate && record.numeric }]
  })
}

export function renderResult(record, selection) {
  const f = record.fields
  // A descriptive result names no comparison and the template invents none.
  let text = record.kind === 'descriptive' ? `${f.outcome.text}.` : `${f.outcome.text}: ${f.intervention.text} versus ${f.comparator.text}; ${f.effect.text}.`
  if (f.analysis) text += ` Analysis: ${f.analysis.text}${f.analysisRole ? ` (${f.analysisRole.text})` : ''}.`
  else if (f.analysisRole) text += ` Analysis role: ${f.analysisRole.text}.`
  if (f.endpointRole) text += ` Endpoint role: ${f.endpointRole.text}.`
  if (f.interventionTiming) text += ` Intervention timing: ${f.interventionTiming.text}.`
  if (f.outcomeTimepoint) text += ` Outcome timepoint: ${f.outcomeTimepoint.text}.`
  if (selection.includeEstimate && record.numeric) text += ` Estimate: ${fmtNum(record.quantity)}.`
  for (const qualification of record.qualifications) text += ` ${qualification.text}.`
  return text
}

export const RELATIONSHIP_DIMENSIONS = ['outcome', 'orderedComparison', 'analysis', 'timing', 'roles', 'qualifications', 'interpretation']
export function applyResultApproval(handoff, plan, response, cautionInput = '') {
  const designCaution = typeof cautionInput === 'string' && cautionInput.trim() && numbersGrounded(cautionInput, []) && response?.caution_supported === true ? cautionInput : ''
  const cautionCheck = { verdict: designCaution ? 'supported' : 'refuted', reason: designCaution ? 'Exact caution checked by a model.' : 'Caution not approved.' }
  const finish = take => ({ ...take, resultContract: HANDOFF_VERSION, designCaution, cautionCheck,
    resultApproval: JSON.parse(JSON.stringify({ version: HANDOFF_VERSION, key: handoff.key,
      requestKey: JSON.stringify({ plan, cautionInput }), planKey: JSON.stringify(plan), plan, response,
      finding: take.finding, cautionInput, designCaution })) })
  const empty = { finding: '', check: { verdict: 'refuted', reason: 'Result relationships or summary coverage were not approved.' } }
  if (!handoff?.complete || !Array.isArray(plan)) return { ...empty, designCaution: '', cautionCheck: { verdict: 'refuted', reason: 'Evidence unavailable.' } }
  if (response?.summary?.supported !== true) return finish(empty)
  const included = response.summary.included_ids
  if (!Array.isArray(included) || !included.length || new Set(included).size !== included.length) return finish(empty)
  const approved = new Set()
  for (const selected of plan) {
    const decisions = (response.decisions || []).filter(d => d.id === selected.id)
    // Missing, duplicate, unknown or partially supported verdicts fail this claim.
    if (decisions.length === 1 && RELATIONSHIP_DIMENSIONS.every(key => decisions[0][key] === 'supported')) approved.add(selected.id)
  }
  if (included.some(id => !approved.has(id) || !handoff.records.some(r => r.id === id))) return finish(empty)
  const retained = included.map(id => plan.find(p => p.id === id))
  const findingBindings = []
  let finding = ''
  for (const selected of retained) {
    const record = handoff.records.find(r => r.id === selected.id)
    const text = renderResult(record, selected)
    if (finding) finding += ' '
    if (selected.includeEstimate && record.numeric) {
      const tuple = fmtNum(record.quantity)
      const start = finding.length + text.indexOf(` Estimate: ${tuple}`) + ' Estimate: '.length
      findingBindings.push({ start, end: start + tuple.length, text: tuple, quote: record.quantity.source_quote })
    }
    finding += text
  }
  return finish({ finding, findingBindings, check: { verdict: 'supported', reason: 'Result relationships and the complete retained summary were checked by a model.' } })
}

export function restoreResultApproval(result, take) {
  const approval = take?.resultApproval
  const handoff = buildResultHandoff(result)
  const stale = reason => ({ ...take, finding: '', findingBindings: [], designCaution: '',
    check: { verdict: 'refuted', reason }, cautionCheck: { verdict: 'refuted', reason } })
  if ((take?.resultContract && take.resultContract !== HANDOFF_VERSION) || !approval || approval.planKey !== JSON.stringify(approval.plan) ||
      approval.requestKey !== JSON.stringify({ plan: approval.plan, cautionInput: approval.cautionInput }) ||
      approval.version !== HANDOFF_VERSION || approval.key !== handoff.key) return stale('Result or caution approval is missing or stale.')
  const plan = prepareResultPlan(handoff, approval.plan)
  if (JSON.stringify(plan) !== JSON.stringify(approval.plan)) return stale('Result plan changed.')
  const restored = applyResultApproval(handoff, plan, approval.response, approval.cautionInput)
  if (restored.finding !== approval.finding || take.finding !== approval.finding) return stale('Approved presentation changed.')
  if (restored.designCaution !== approval.designCaution || String(take.designCaution || '') !== approval.designCaution) {
    return { ...take, ...restored, designCaution: '', cautionCheck: { verdict: 'refuted', reason: 'Approved caution text changed.' } }
  }
  return { ...take, ...restored }
}


// Read-only Library adapter. Legacy papers retain their previous policy; new
// approvals are re-derived from saved evidence, never written back on read.
export function currentResultPaper(paper) {
  if (!paper || (!paper.resultContract && !paper.resultApproval)) return paper
  const result = { paper: { id: paper.id }, sourceDoc: { text: paper.fullText || '', tables: paper.tables || '' },
    source: { tier: paper.sourceTier, hash: paper.sourceHash }, resultContexts: paper.resultContexts || [],
    rows: (paper.quantities || []).map(saved => { const quantity = { ...saved }; delete quantity.tier; delete quantity.verdict; return { quantity, verdict: saved.verdict } }) }
  return restoreResultApproval(result, paper)
}
