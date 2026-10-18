// Complete source passages for both prose stages. Extraction and numeric verification
// keep their original corpora. Never turn a qualified result into a clipped fragment.
import { PRICES } from '../../supabase/functions/_shared/pricing.js'
// Budget against the smaller prose model. One token per serialized UTF-8 byte,
// plus 25% and a fixed pad, deliberately overestimates ordinary prose. This is a
// conservative local admission estimate, not a provider token count.
export const PROSE_CONTEXT_TOKENS = Math.min(...Object.values(PRICES).map(p => p.contextWindowTokens))
export const PROSE_OUTPUT_TOKENS = 8192
const PROMPT_HEADROOM_TOKENS = 32768
export const SECTION_WINDOW_CHARS = Math.floor((PROSE_CONTEXT_TOKENS - PROSE_OUTPUT_TOKENS - PROMPT_HEADROOM_TOKENS) / 1.25)
export const EVIDENCE_WINDOW_VERSION = '2026-10-16.complete-passages-v6'
const utf8Bytes = text => new TextEncoder().encode(String(text ?? '')).length
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

// Section kind from a label (and a JATS sec-type when present). Results must START the
// label ("Results", "3. Results", "Main findings", "Results and discussion") so a
// Discussion subsection like "Comparison with previous results" is never taken for them.
export function sectionKind(label, secType = '') {
  const type = clean(secType).toLowerCase()
  if (type) {
    if (/^results?(?:\||$)/.test(type)) return 'results'
    if (/method|subjects|cases|patients/.test(type)) return 'methods'
    if (/intro|background/.test(type)) return 'background'
    if (/discussion/.test(type)) return 'discussion'
    if (/conclusion/.test(type)) return 'conclusions'
  }
  const l = clean(label).toLowerCase().replace(/^(?:[ivx]+|\d+(?:\.\d+)*)[.)]?\s+/, '').replace(/[:.]+$/, '')
  if (!l) return 'other'
  if (/^(?:main |key |principal |primary )?(?:results?|findings)\b/.test(l)) return 'results'
  if (/^(?:conclusions?|interpretation|relevance|implications)\b|^conclusions? and relevance/.test(l)) return 'conclusions'
  if (/^(?:introduction|background|context|rationale)\b/.test(l)) return 'background'
  if (/^(?:objectives?|aims?|purpose|importance|question)\b/.test(l)) return 'objective'
  if (/^(?:discussion|limitations?|comment|strengths)\b/.test(l)) return 'discussion'
  if (/method|design|setting|participants|patients|population|materials|subjects|interventions?|exposures?|outcomes? and measures|main outcome|data sources?|study selection|eligibility|data extraction/.test(l)) return 'methods'
  return 'other'
}

// A labelled paragraph in a PubMed plain-text abstract: "RESULTS: ...". The label must be
// one sectionKind recognizes, so an ordinary sentence with a colon is never split.
const LABELLED = /^([A-Za-z][A-Za-z ,&/-]{1,60}?):\s+([\s\S]+)$/

// Cleaned PubMed text (sources.js cleanAbstractText) -> [{ label, kind, text }]. The first
// unlabelled block of a structured record is its title and is dropped (triage shows the
// title separately). Unstructured: one part with the abstract body.
export function parseAbstractText(text) {
  // Preserve wrapped prose, but start recognized labelled sections even when PubMed
  // separates them with only one newline. Do this before whitespace normalization.
  const separated = String(text ?? '').replace(/\r\n?/g, '\n').replace(
    /\n[ \t]*([A-Za-z][A-Za-z ,&/-]{1,60}?):(?=\s)/g,
    (match, label) => sectionKind(label) !== 'other' ? `\n\n${label}:` : match,
  )
  const blocks = separated.split(/\n\s*\n/).map(clean).filter(Boolean)
  const parts = blocks.map((block) => {
    const m = block.match(LABELLED)
    const kind = m ? sectionKind(m[1]) : 'other'
    return m && kind !== 'other' ? { label: m[1].trim(), kind, text: clean(m[2]) } : { label: '', kind: 'other', text: block }
  })
  const structured = parts.some((p) => p.label)
  if (structured) return { structured, parts: parts.filter((p) => p.label || p !== parts[0]) }
  // Unstructured: drop a short leading title block when a longer body follows.
  const body = parts.length > 1 && parts[0].text.length < 300 ? parts.slice(1) : parts
  return { structured: false, parts: body.length ? [{ label: '', kind: 'abstract', text: body.map((p) => p.text).join(' ') }] : [] }
}


function unavailable(reason, blocked = false) {
  return { version: EVIDENCE_WINDOW_VERSION, kind: 'unavailable', basis: 'none',
    limited: true, blocked, hasResults: false, text: '', parts: [], reason }
}

// All returned parts are complete normalized source sections, in source order.
// Whole Results sections deliberately keep adjacent exceptions, secondary analyses,
// and contrasts; selecting isolated sentences cannot safely establish their scope.
export function selectEvidenceWindow(source, { budget = SECTION_WINDOW_CHARS } = {}) {
  const limit = Math.min(SECTION_WINDOW_CHARS, Math.max(0, Number(budget) || 0))
  const tier = source?.tier || 'abstract_only'
  const abstract = source?.abstractParts?.length
    ? source.abstractParts.map(p => ({ label: clean(p.label), kind: p.kind || sectionKind(p.label), text: clean(p.text), from: 'abstract' })).filter(p => p.text)
    : tier === 'abstract_only'
      ? parseAbstractText(source?.text).parts.map(p => ({ ...p, from: 'abstract' }))
      : source?.abstract ? [{ label: '', kind: 'abstract', text: clean(source.abstract), from: 'abstract' }] : []
  let parts = [...abstract]
  let kind = 'abstract', basis = 'abstract'
  if (tier === 'full_text') {
    const sections = source?.sections || []
    // A parent Results section already contains its descendants. Avoid duplication.
    const results = sections.filter((s, index) => {
      if (s.kind !== 'results' || !clean(s.text)) return false
      let parent = s.parent; const seen = new Set([index])
      while (Number.isInteger(parent) && parent >= 0 && sections[parent] && !seen.has(parent)) {
        if (sections[parent].kind === 'results') return false
        seen.add(parent); parent = sections[parent].parent
      }
      return true
    })
    if (results.length) {
      kind = 'results'; basis = 'full_text_sections'
      // Without an abstract, preserve the complete Methods context too.
      if (!abstract.length) parts.push(...sections.filter(s => s.kind === 'methods' && !(s.depth > 0)).map(s => ({ ...s, from: 'body' })))
      parts.push(...results.map(s => ({ ...s, from: 'body' })))
    } else if (!abstract.length) return unavailable('No complete abstract or identifiable Results sections were saved. Re-read the source before summarizing.')
  } else if (tier === 'user_text') {
    kind = 'opening'; basis = 'supplied_text'
    // No reliable paragraph structure: include the whole document or decline it.
    parts = [{ label: 'Supplied text', kind: 'opening', text: clean(source?.text), from: 'supplied' }]
  }
  parts = parts.map(p => ({ label: p.label || '', kind: p.kind, from: p.from, text: clean(p.text) })).filter(p => p.text)
  if (!parts.length) return unavailable('No source evidence available.')
  const header = kind === 'results'
    ? abstract.length ? '[Evidence window: complete abstract and complete Results sections of the full text]' : '[Evidence window: complete Results sections of the full text, with available Methods context]'
    : kind === 'opening'
      ? '[Evidence window: complete supplied text; sections not identified]'
      : "[Evidence window: the paper's complete abstract]"
  const lines = parts.map(p => `${p.label ? p.label.toUpperCase() : p.from === 'abstract' ? 'ABSTRACT' : 'TEXT'}${p.from === 'abstract' && kind === 'results' ? ' (abstract)' : ''}: ${p.text}`)
  const text = [header, ...lines].join('\n')
  if (text.length > limit || utf8Bytes(text) > SECTION_WINDOW_CHARS) return unavailable(`Complete abstract and relevant source sections require ${text.length} characters, exceeding the ${limit}-character evidence limit. No truncated evidence was sent; review this source directly; its complete evidence cannot fit the conservative model budget.`, true)
  return { version: EVIDENCE_WINDOW_VERSION, kind, basis, limited: kind === 'opening', blocked: false,
    hasResults: parts.some(p => p.kind === 'results'), structured: parts.some(p => p.label),
    combinedWithDiscussion: parts.some(p => p.kind === 'results' && /discussion/i.test(p.label)),
    reason: kind === 'results' ? 'Complete Results sections and available abstract retained.' : tier === 'full_text' ? 'No Results section identified in the full text; complete abstract retained.' : !parts.some(p => p.kind === 'results') ? 'Complete source retained; no Results section identified.' : 'Complete abstract retained; no sections were truncated.',
    text, parts: parts.map((p, i) => ({ label: p.label, kind: p.kind, from: p.from, chars: lines[i].length })) }
}

export function evidenceWindowFor(result) {
  const stored = result?.evidenceWindow
  if (stored?.version === EVIDENCE_WINDOW_VERSION && typeof stored.text === 'string') return stored
  // Old full-text rows keep the complete verification corpus, but not its section
  // tree. Use that whole corpus verbatim, never an old clipped window or an inferred
  // Results boundary. The checker sees honest provenance, not fabricated labels.
  if (result?.source?.tier === 'full_text' && !result?.evidenceSource) {
    const body = result?.sourceDoc?.text
    if (!String(body || '').trim()) return unavailable('Saved full-text evidence is missing. Re-read the source before summarizing.', true)
    const text = '[Complete saved full-text source; original section structure unavailable]\n' + body + (result.sourceDoc.tables ? '\nTABLES:\n' + result.sourceDoc.tables : '')
    if (utf8Bytes(text) > SECTION_WINDOW_CHARS) return unavailable('Complete saved source exceeds the conservative model budget. Re-read the source to recover its complete abstract and Results sections.', true)
    return { version: EVIDENCE_WINDOW_VERSION, kind: 'complete_source', basis: 'saved_full_text', legacy: true, limited: true, blocked: false, text,
      reason: 'Complete saved verification corpus retained; no section boundaries inferred.', parts: [{ from: 'saved_source', chars: text.length }] }
  }
  const rebuilt = selectEvidenceWindow(result?.evidenceSource || { tier: result?.source?.tier || 'abstract_only', text: result?.sourceDoc?.text || '' })
  return { ...rebuilt, legacy: true }
}

export function evidenceSummary(result) {
  const window = evidenceWindowFor(result)
  if (window.blocked) throw new Error(`Cannot summarize this paper: ${window.reason}`)
  assertCompleteEvidence(window.text)
  return window.text
}

// Per-paper source admission reserves room for profile, claims and output. The
// final request check below includes those fields and the structured-output schema.
export function assertCompleteEvidence(text) {
  if (utf8Bytes(text) > SECTION_WINDOW_CHARS) throw new Error('Evidence exceeds the complete-passage model budget; no truncated evidence was sent.')
}
export function assertEvidenceBatch(texts) {
  for (const text of texts) assertCompleteEvidence(text)
}
export function proseRequestBudget(system, content, schema = {}, maxTokens = PROSE_OUTPUT_TOKENS) {
  const serialized = JSON.stringify({ system, messages: [{ role: 'user', content }], output_config: { format: { type: 'json_schema', schema } } })
  const inputTokens = Math.ceil(utf8Bytes(serialized) * 1.25) + 1024
  return { inputTokens, outputTokens: maxTokens, contextTokens: PROSE_CONTEXT_TOKENS, fits: inputTokens + maxTokens <= PROSE_CONTEXT_TOKENS }
}
export function assertProseRequest(system, content, schema, maxTokens) {
  if (!proseRequestBudget(system, content, schema, maxTokens).fits) throw new Error('Complete prose request exceeds the conservative token budget. No truncated evidence was sent.')
}
