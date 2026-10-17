// pipeline/obligations.js — COVERAGE OBLIGATIONS and PRIMARY STATUS, both from located
// quotes only.
//
// An obligation is a passage the summary of this paper must either carry or may omit only
// immaterially: the extractor's endpoint-role, qualification, conflicting-analysis and
// intervention-timing spans, plus the abstract's conclusion sentence. The list is built
// from the SOURCE, independently of which rows the writer cites or the numeric verifier
// admits, so a summary cannot escape an obligation by not citing the row it hangs on.
// Every obligation is a located quote (quoteLocate.js): model text that does not locate
// is reported in `unlocated` and is NOT an obligation.
//
// Primary status: a located endpoint-role quote that names a row's outcome as primary
// establishes primary status for that row. A model label without a located quote never
// does. A declaration that names the outcome as both primary and secondary, or names
// neither, leaves the row unknown — genuinely unknown status stays explicit.
import { normalize } from './verify.js'
import { locateQuote } from './quoteLocate.js'
import { parseAbstractText } from './evidenceWindow.js'

const OBLIGATION_KINDS = {
  endpointRole: 'endpoint-role',
  interventionTiming: 'intervention-timing',
  analysisRole: 'conflicting-analysis',
  conflictingAnalyses: 'conflicting-analysis',
  qualifications: 'qualification',
}

// The abstract's conclusion sentence: the first sentence of a labelled Conclusions part,
// else the last sentence of an unstructured abstract. '' when there is no abstract.
export function conclusionSentence(abstractText) {
  const text = String(abstractText || '').trim()
  if (!text) return ''
  const parsed = parseAbstractText(text)
  const conclusions = parsed.parts.find((p) => p.kind === 'conclusions')
  const sentences = (s) => String(s || '').match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g)?.map((x) => x.trim()).filter(Boolean) || []
  if (conclusions) return sentences(conclusions.text)[0] || ''
  const body = parsed.parts.map((p) => p.text).join(' ')
  const list = sentences(body)
  return list[list.length - 1] || ''
}

// Abstract text for a result: the saved evidence source, else the PUBLISHER ABSTRACT block
// of the corpus, else (abstract-only) the corpus itself.
export function abstractTextFor(result) {
  const parts = result?.evidenceSource?.abstractParts
  if (Array.isArray(parts) && parts.length) return parts.map((p) => (p.label ? `${p.label}: ${p.text}` : p.text)).join('\n')
  if (result?.evidenceSource?.abstract) return String(result.evidenceSource.abstract)
  const text = String(result?.sourceDoc?.text || '')
  if (text.startsWith('PUBLISHER ABSTRACT:')) {
    const end = text.indexOf('\n\n')
    return text.slice('PUBLISHER ABSTRACT:'.length, end > 0 ? end : undefined).trim()
  }
  if ((result?.source?.tier || 'abstract_only') === 'abstract_only') return text
  return ''
}

// Build the obligation list for a handoff. `abstract` is the abstract text (abstractTextFor).
// Returns { obligations: [...], unlocated: [...], key }.
export function buildObligations(handoff, { abstract = '' } = {}) {
  const obligations = []
  const unlocated = []
  const seen = new Set()
  const push = (kind, span, extra) => {
    if (!span) return
    if (span.status !== 'located') {
      unlocated.push({ kind, status: span.status, text: span.text ?? null, quote: span.quote ?? null, ...extra })
      return
    }
    const dedupe = `${span.corpus}:${span.start}:${span.end}`
    if (seen.has(dedupe)) return
    seen.add(dedupe)
    obligations.push({
      id: `ob${obligations.length + 1}`,
      kind,
      corpus: span.corpus,
      start: span.start,
      end: span.end,
      quote: handoff.source[span.corpus].slice(span.start, span.end),
      text: span.text ?? null,
      ...extra,
    })
  }
  for (const record of handoff?.records || []) {
    const extra = { recordId: record.id, rowIndex: record.rowIndex }
    for (const field of ['endpointRole', 'interventionTiming', 'analysisRole']) push(OBLIGATION_KINDS[field], record.fields?.[field], extra)
    for (const list of ['qualifications', 'conflictingAnalyses']) for (const span of record[list] || []) push(OBLIGATION_KINDS[list], span, extra)
  }
  const conclusion = conclusionSentence(abstract)
  if (conclusion) {
    const located = locateQuote(handoff?.source?.text || '', conclusion)
    if (located.status === 'located') push('conclusion', { ...located, corpus: 'text', text: conclusion }, { recordId: null, rowIndex: null })
    else unlocated.push({ kind: 'conclusion', status: located.status, text: conclusion, quote: conclusion })
  }
  obligations.sort((a, b) => (a.corpus === b.corpus ? a.start - b.start : a.corpus < b.corpus ? -1 : 1))
  obligations.forEach((o, i) => { o.id = `ob${i + 1}` })
  const key = JSON.stringify(obligations.map((o) => [o.kind, o.corpus, o.start, o.end]))
  return { obligations, unlocated, key }
}

const PRIMARY_RE = /\b(?:co-?)?primary\b/
const SECONDARY_RE = /\bsecondary\b/
const GENERIC = new Set(['the', 'a', 'an', 'of', 'in', 'at', 'to', 'for', 'and', 'or', 'with', 'rate', 'rates', 'risk', 'incidence', 'overall', 'primary', 'secondary', 'outcome', 'outcomes', 'endpoint', 'endpoints', 'end', 'point', 'points', 'composite', 'was', 'were', 'is', 'are'])
const words = (s) => normalize(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !GENERIC.has(w))

// Does a declaration quote NAME this outcome? The outcome phrase (normalized) is printed
// in the quote, or every content word of the outcome is printed in it.
export function quoteNamesOutcome(quote, outcome) {
  const q = normalize(quote)
  const o = normalize(outcome)
  if (!q || !o) return false
  if (q.includes(o)) return true
  const w = words(o)
  return w.length > 0 && w.every((x) => new RegExp(`(?<![a-z0-9])${x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`).test(q))
}

// The row's outcome: the located outcome span's text when the record has one, else the
// outcome part of the row's name (before the first comma), stripped of a leading role.
export function recordOutcome(record) {
  const span = record?.fields?.outcome
  if (span?.status === 'located' && span.text) return span.text
  const name = String(record?.quantity?.name || '')
  return name.split(',')[0].replace(/^(?:the\s+)?(?:co-?)?primary\s+(?:efficacy\s+|safety\s+|composite\s+)?(?:end\s?-?points?|outcomes?|analysis)\s*[:\-—]?\s*/i, '').trim()
}

// { status: 'primary' | 'secondary' | 'unknown', quote, reason }
export function primaryStatusFor(record) {
  const role = record?.fields?.endpointRole
  if (!role || role.status !== 'located') return { status: 'unknown', quote: null, reason: role ? `endpoint-role span ${role.status}` : 'no endpoint-role span' }
  const q = normalize(role.quote)
  const outcome = recordOutcome(record)
  if (!quoteNamesOutcome(role.quote, outcome)) return { status: 'unknown', quote: role.quote, reason: 'located endpoint-role quote does not name this row\'s outcome' }
  const primary = PRIMARY_RE.test(q)
  const secondary = SECONDARY_RE.test(q)
  if (primary && !secondary) return { status: 'primary', quote: role.quote, reason: 'located endpoint-role quote names this outcome as primary' }
  if (secondary && !primary) return { status: 'secondary', quote: role.quote, reason: 'located endpoint-role quote names this outcome as secondary' }
  return { status: 'unknown', quote: role.quote, reason: primary ? 'quote names both primary and secondary roles; unresolved' : 'quote names no role' }
}

// A findPrimary-compatible primary state built from located quotes. `fallback` is the
// production findPrimary() result; it is used only when it is itself 'identified' and no
// located quote contradicts it. Otherwise unknown stays unknown.
export function primaryFromLocatedQuotes(handoff, { fallback = null } = {}) {
  const records = handoff?.records || []
  const statuses = records.map((r) => ({ record: r, status: primaryStatusFor(r) }))
  const primary = statuses.filter((s) => s.status.status === 'primary')
  if (primary.length) {
    return {
      state: 'identified',
      name: String(primary[0].record.quantity?.name || ''),
      names: primary.map((s) => String(s.record.quantity?.name || '')),
      verified: primary.some((s) => s.record.numeric),
      indexes: primary.map((s) => s.record.rowIndex),
      basis: 'located-endpoint-role',
      quote: primary[0].status.quote,
    }
  }
  if (fallback?.state === 'identified') return { ...fallback, basis: fallback.basis || 'declaration' }
  if (!records.length) return { state: 'no-results', name: null, verified: false, indexes: [], basis: null }
  return { state: 'unknown', name: null, verified: false, indexes: [], basis: null }
}
