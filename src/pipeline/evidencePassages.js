// pipeline/evidencePassages.js — COMPLETE evidence passages for the summary path
// (context-only checkpoint 575504a, reconstructed).
//
// The production window (evidenceWindow.js) clips Results at a character boundary, which
// can omit an exception while keeping the statement it qualified. The summary path instead
// sends the complete normalized abstract and the complete outermost Results sections (the
// complete Methods when there is no abstract), identical for the writer, the rewrite and
// the checker. Oversized evidence fails explicitly before dispatch rather than silently
// truncating. The production window and its callers are untouched.
import { PRICES } from '../../supabase/functions/_shared/pricing.js'
import { parseAbstractText, sectionKind } from './evidenceWindow.js'

// Budget against the smaller prose model. One token per serialized UTF-8 byte, plus 25%
// and a fixed pad, deliberately overestimates ordinary prose: a conservative local
// admission estimate, not a provider token count.
export const PROSE_CONTEXT_TOKENS = Math.min(...Object.values(PRICES).map((p) => p.contextWindowTokens))
export const PROSE_OUTPUT_TOKENS = 8192
const PROMPT_HEADROOM_TOKENS = 32768
export const COMPLETE_WINDOW_CHARS = Math.floor((PROSE_CONTEXT_TOKENS - PROSE_OUTPUT_TOKENS - PROMPT_HEADROOM_TOKENS) / 1.25)
export const COMPLETE_WINDOW_VERSION = '2026-10-17.complete-passages-v7'
const utf8Bytes = (text) => new TextEncoder().encode(String(text ?? '')).length
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

function unavailable(reason, blocked = false) {
  return { version: COMPLETE_WINDOW_VERSION, kind: 'unavailable', basis: 'none', limited: true, blocked, hasResults: false, text: '', parts: [], reason }
}

// source: { tier, text, tables?, abstractParts?, abstract?, sections? } — the shape runPaper
// saves as `evidenceSource` (plus sourceDoc.text). All returned parts are complete
// normalized source sections, in source order.
export function completeEvidence(source, { budget = COMPLETE_WINDOW_CHARS } = {}) {
  const limit = Math.min(COMPLETE_WINDOW_CHARS, Math.max(0, Number(budget) || 0))
  const tier = source?.tier || 'abstract_only'
  const abstract = source?.abstractParts?.length
    ? source.abstractParts.map((p) => ({ label: clean(p.label), kind: p.kind || sectionKind(p.label), text: clean(p.text), from: 'abstract' })).filter((p) => p.text)
    : tier === 'abstract_only'
      ? parseAbstractText(source?.text).parts.map((p) => ({ ...p, from: 'abstract' }))
      : source?.abstract ? [{ label: '', kind: 'abstract', text: clean(source.abstract), from: 'abstract' }] : []
  let parts = [...abstract]
  let kind = 'abstract'
  let basis = 'abstract'
  if (tier === 'full_text') {
    const sections = Array.isArray(source?.sections) ? source.sections : []
    // A parent Results section already contains its descendants. Avoid duplication.
    const results = sections.filter((s, index) => {
      if (s.kind !== 'results' || !clean(s.text)) return false
      let parent = s.parent
      const seen = new Set([index])
      while (Number.isInteger(parent) && parent >= 0 && sections[parent] && !seen.has(parent)) {
        if (sections[parent].kind === 'results') return false
        seen.add(parent)
        parent = sections[parent].parent
      }
      return true
    })
    if (results.length) {
      kind = 'results'
      basis = 'full_text_sections'
      if (!abstract.length) parts.push(...sections.filter((s) => s.kind === 'methods' && !(s.depth > 0)).map((s) => ({ ...s, from: 'body' })))
      parts.push(...results.map((s) => ({ ...s, from: 'body' })))
    } else if (!abstract.length) {
      return unavailable('No complete abstract or identifiable Results sections were saved. Re-read the source before summarizing.')
    }
  } else if (tier === 'user_text') {
    kind = 'opening'
    basis = 'supplied_text'
    parts = [{ label: 'Supplied text', kind: 'opening', text: clean(source?.text), from: 'supplied' }]
  }
  parts = parts.map((p) => ({ label: p.label || '', kind: p.kind, from: p.from, text: clean(p.text) })).filter((p) => p.text)
  if (!parts.length) return unavailable('No source evidence available.')
  const header = kind === 'results'
    ? abstract.length ? '[Evidence window: complete abstract and complete Results sections of the full text]' : '[Evidence window: complete Results sections of the full text, with available Methods context]'
    : kind === 'opening' ? '[Evidence window: complete supplied text; sections not identified]' : "[Evidence window: the paper's complete abstract]"
  const lines = parts.map((p) => `${p.label ? p.label.toUpperCase() : p.from === 'abstract' ? 'ABSTRACT' : 'TEXT'}${p.from === 'abstract' && kind === 'results' ? ' (abstract)' : ''}: ${p.text}`)
  const text = [header, ...lines].join('\n')
  if (text.length > limit || utf8Bytes(text) > COMPLETE_WINDOW_CHARS) {
    return unavailable(`Complete abstract and relevant source sections require ${text.length} characters, exceeding the ${limit}-character evidence limit. No truncated evidence was sent; review this source directly.`, true)
  }
  return {
    version: COMPLETE_WINDOW_VERSION, kind, basis, limited: kind === 'opening', blocked: false,
    hasResults: parts.some((p) => p.kind === 'results'), structured: parts.some((p) => p.label),
    reason: kind === 'results' ? 'Complete Results sections and available abstract retained.' : tier === 'full_text' ? 'No Results section identified in the full text; complete abstract retained.' : 'Complete abstract retained; no sections were truncated.',
    text, parts: parts.map((p, i) => ({ label: p.label, kind: p.kind, from: p.from, chars: lines[i].length })),
  }
}

// The complete window for a runPaper() result. A full-text result saved without its
// section tree (an older record) gets the whole saved verification corpus with honest
// provenance, never a clipped window or an inferred Results boundary.
export function completeEvidenceFor(result) {
  const tier = result?.source?.tier || 'abstract_only'
  if (result?.evidenceSource) return completeEvidence({ tier, text: result.sourceDoc?.text || '', ...result.evidenceSource })
  if (tier === 'full_text') {
    const body = result?.sourceDoc?.text
    if (!String(body || '').trim()) return unavailable('Saved full-text evidence is missing. Re-read the source before summarizing.', true)
    const text = '[Complete saved full-text source; original section structure unavailable]\n' + body + (result.sourceDoc.tables ? '\nTABLES:\n' + result.sourceDoc.tables : '')
    if (utf8Bytes(text) > COMPLETE_WINDOW_CHARS) return unavailable('Complete saved source exceeds the conservative model budget. Re-read the source to recover its complete abstract and Results sections.', true)
    return { version: COMPLETE_WINDOW_VERSION, kind: 'complete_source', basis: 'saved_full_text', legacy: true, limited: true, blocked: false, hasResults: true, text, reason: 'Complete saved verification corpus retained; no section boundaries inferred.', parts: [{ from: 'saved_source', chars: text.length }] }
  }
  return completeEvidence({ tier, text: result?.sourceDoc?.text || '' })
}

export function assertCompleteEvidence(text) {
  if (utf8Bytes(text) > COMPLETE_WINDOW_CHARS) throw new Error('Evidence exceeds the complete-passage model budget; no truncated evidence was sent.')
}
// Conservative request admission: serialized UTF-8 bytes × 1.25 + 1,024 overhead tokens,
// plus the requested output, against the smaller prose model's context.
export function proseRequestBudget(system, content, schema = {}, maxTokens = PROSE_OUTPUT_TOKENS) {
  const serialized = JSON.stringify({ system, messages: [{ role: 'user', content }], output_config: { format: { type: 'json_schema', schema } } })
  const inputTokens = Math.ceil(utf8Bytes(serialized) * 1.25) + 1024
  return { inputTokens, outputTokens: maxTokens, contextTokens: PROSE_CONTEXT_TOKENS, fits: inputTokens + maxTokens <= PROSE_CONTEXT_TOKENS }
}
export function assertProseRequest(system, content, schema, maxTokens) {
  if (!proseRequestBudget(system, content, schema, maxTokens).fits) throw new Error('Complete prose request exceeds the conservative token budget. No truncated evidence was sent.')
}
