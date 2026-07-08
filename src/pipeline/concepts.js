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

// --- analyze a deposited paper: category (a north star / project) + concept + tags ---

export const ANALYZE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['category', 'concept', 'tags'],
  properties: {
    category: { type: 'string' }, // one of the clinician's north stars / projects (verbatim), or ""
    concept: { type: 'string' }, // topic-level concept name (existing verbatim, a category name, or new)
    tags: { type: 'array', items: { type: 'string' } },
  },
}

const ANALYZE_SYSTEM = `You file papers into a clinician-scientist's OWN knowledge graph. The graph is organized by THEIR steering themes — their north stars and projects (the "categories") — not by any generic taxonomy. Under each category sit topic-level "concept" nodes (title-case, 2–6 words) that group several papers, e.g. "CLTI Risk Stratification", "Multidisciplinary Team for Diabetic Foot". For the given paper return:

- category: the SINGLE best-fit theme from the clinician's north stars / projects, returned as its label VERBATIM from the list provided. If NONE genuinely fit, return "" (empty).
- concept: the topic-level concept the paper belongs under.
    • If the paper's topic is essentially the SAME as its category (i.e. the category itself is the right level — nothing finer is warranted), return the category's label VERBATIM. (The paper then files directly under that north star / project — do NOT invent a near-duplicate concept.)
    • Otherwise, if it fits an EXISTING concept, return that concept's name VERBATIM. Failing that, mint a new reusable concept name FINER than the category but not as narrow as the paper's exact title.
- tags: 3–6 SHORT lowercase topic tags (conditions, endpoints, techniques, methods) the clinician would search by.

Prefer reusing an existing category and concept over minting near-duplicates.`

// Analyze a paper. `paper` = { title, finding, relevance, text? }; `categories` = the profile's
// [{ label, kind }] north stars + projects; `concepts` = existing [{ name, category }]. Returns
// { category, concept, tags } — category validated to a provided label (verbatim) or '' .
export async function analyzePaper({ paper, categories = [], concepts = [], model = MODELS.triage, maxTokens = 1024 }) {
  const cats = categories.length
    ? categories.map((c) => `  - "${c.label}" (${c.kind === 'project' ? 'project' : 'north star'})`).join('\n')
    : '  (none — the clinician has no north stars/projects yet)'
  const existing = concepts.length
    ? concepts.map((c) => `- "${c.name}"${c.category ? ` (under ${c.category})` : ''}`).join('\n')
    : '(none yet — mint the first concept)'
  const content =
    `CLINICIAN'S CATEGORIES (north stars & projects):\n${cats}\n\n` +
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
  // Validate the category against the provided labels (case-insensitive) so a stray/hallucinated
  // label can't create a phantom category; recover the verbatim label + kind.
  const norm = (s) => (s || '').trim().toLowerCase()
  const matched = categories.find((c) => norm(c.label) === norm(r.category)) || null
  const seen = new Set()
  const tags = (r.tags || [])
    .map((t) => (t || '').trim().toLowerCase())
    .filter((t) => t && !seen.has(t) && seen.add(t))
    .slice(0, 6)
  return {
    category: matched, // { label, kind } | null
    concept: (r.concept || '').trim() || 'Uncategorized',
    tags,
  }
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
