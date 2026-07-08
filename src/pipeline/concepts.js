// pipeline/concepts.js — the concept layer. Verastar's knowledge graph nodes are CONCEPTS
// (topic/"wiki" nodes), not individual papers — mirroring the clinician's real KG, where a
// node like "Multidisciplinary Team for Diabetic Foot" aggregates many source articles under
// one synthesized evidence summary. Papers are the SOURCES that hang under a concept.
//
// Two cheap Claude calls (Sonnet, structured, thinking disabled — the triage/select gotcha):
//   - analyzePaper: on deposit, assign the paper to a concept (reuse an existing one or name a
//     new topic-level concept), plus its domain + topic tags.
//   - synthesizeConcept: (re)write the concept's evidence summary from its source papers'
//     VERIFIED findings — number-free prose that also names what's NOT yet established (the
//     same evidence-careful instinct as the verifier; specific numbers stay with each source).

import { extractStructured, MODELS } from '../lib/anthropic.js'
import { DOMAINS, DOMAIN_KEYS } from '../lib/domains.js'

// concept id from its name — stable slug so re-using the same name collapses to one node.
export function conceptId(name) {
  return (
    'concept:' +
    String(name)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
  )
}

// --- analyze a deposited paper: concept (topic node) + domain (color) + tags ---

export const ANALYZE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['concept', 'domain', 'tags'],
  properties: {
    concept: { type: 'string' }, // topic-level concept name (existing verbatim, or new)
    domain: { type: 'string' }, // one of the domain keys (colors the node)
    tags: { type: 'array', items: { type: 'string' } },
  },
}

const ANALYZE_SYSTEM = `You file papers into a vascular surgeon-scientist's concept-based knowledge graph. Every paper becomes a source under a topic-level "concept" node (title-case, 2–6 words) that groups related papers — e.g. "CLTI Risk Stratification", "Multidisciplinary Team for Diabetic Foot", "Transcarotid Revascularization", "Clinical AI Prediction". Each concept sits in ONE broad DOMAIN, which colors it on the map. For the given paper return:

- concept: the SINGLE concept it belongs under. You are given the existing concepts — if the paper fits one, return that concept's name VERBATIM (so it groups there). Otherwise invent a new, reusable topic-level concept name at that granularity (not too broad like "Vascular Surgery", not as narrow as the paper's exact title). Every distinct topic gets its own concept.
- domain: the single best-fit domain, returned as its key. Domains:
${DOMAINS.map((d) => `  - "${d.key}": ${d.label}`).join('\n')}
- tags: 3–6 SHORT lowercase topic tags (conditions, endpoints, techniques, methods) the clinician would search by.

Prefer reusing an existing concept over minting a near-duplicate.`

// Analyze a paper. `paper` = { title, finding, relevance, text? }; `concepts` = existing
// [{ name, domain }]. Returns { concept, domain, tags } (domain validated to a real key).
export async function analyzePaper({ paper, concepts = [], model = MODELS.triage, maxTokens = 1024 }) {
  const existing = concepts.length
    ? concepts.map((c) => `- "${c.name}"${c.domain ? ` (${c.domain})` : ''}`).join('\n')
    : '(none yet — mint the first concept)'
  const content =
    `EXISTING CONCEPTS:\n${existing}\n\n` +
    `PAPER\nTitle: ${paper.title || '(untitled)'}\n` +
    (paper.finding ? `Finding: ${paper.finding}\n` : '') +
    (paper.relevance ? `Relevance: ${paper.relevance}\n` : '') +
    (paper.text ? `\nSource excerpt:\n${paper.text.slice(0, 2000)}` : '')

  const r = await extractStructured({
    model,
    system: ANALYZE_SYSTEM,
    content,
    schema: ANALYZE_SCHEMA,
    maxTokens,
    thinking: { type: 'disabled' },
  })
  const domain = DOMAIN_KEYS.includes(r.domain) ? r.domain : DOMAIN_KEYS[0]
  const seen = new Set()
  const tags = (r.tags || [])
    .map((t) => (t || '').trim().toLowerCase())
    .filter((t) => t && !seen.has(t) && seen.add(t))
    .slice(0, 6)
  return { concept: (r.concept || '').trim() || 'Uncategorized', domain, tags }
}

// --- synthesize a concept's evidence summary from its source papers ---

export const SYNTH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary'],
  properties: { summary: { type: 'string' } },
}

const SYNTH_SYSTEM = `You write the evidence summary for one node of a clinician's knowledge graph. You get the concept name and its source papers (each with a title and an app-verified finding). Write 2–4 sentences that synthesize what the evidence COLLECTIVELY shows about this concept: the direction and consistency of findings, and — critically — what is NOT yet established from these sources (e.g. "No data found on quality of life or long-term durability."). Be measured; do not overstate. Write in clean prose WITHOUT specific numbers or statistics (those live with each source article, not here). This is a synthesis a careful clinician would trust.`

// Synthesize a concept summary. `concept` = { label }; `papers` = [{ title, finding }].
// Returns a plain string summary. Number-free by contract (two-channel rule preserved).
export async function synthesizeConcept({ concept, papers, model = MODELS.triage, maxTokens = 1024 }) {
  if (!papers?.length) return ''
  const sources = papers
    .map((p, i) => `${i + 1}. ${p.title || '(untitled)'}\n   Finding: ${p.finding || '(no verified finding)'}`)
    .join('\n')
  const content = `CONCEPT: ${concept.label}\n\nSOURCE PAPERS (${papers.length}):\n${sources}`
  const r = await extractStructured({
    model,
    system: SYNTH_SYSTEM,
    content,
    schema: SYNTH_SCHEMA,
    maxTokens,
    thinking: { type: 'disabled' },
  })
  return (r.summary || '').trim()
}
