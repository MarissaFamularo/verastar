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
  required: ['concept', 'hub', 'domain', 'tags'],
  properties: {
    concept: { type: 'string' }, // the paper's SPECIFIC topic (a small satellite node)
    hub: { type: 'string' }, // the BROAD parent topic it lives under (the grouping node)
    domain: { type: 'string' }, // one of the domain keys (colors both concept + hub)
    tags: { type: 'array', items: { type: 'string' } },
  },
}

const ANALYZE_SYSTEM = `You file papers into a vascular surgeon-scientist's concept-based knowledge graph. The graph has TWO tiers, mirroring her real one: broad "hub" topics that gather many papers (e.g. "Carotid Revascularization", "CLTI Management", "Clinical AI in Vascular Care"), and specific "concept" satellites beneath them (e.g. "Transcarotid Revascularization Stroke Risk", "Pedal Bypass Patency"). A paper is a SOURCE under one specific concept, and that concept hangs off one broad hub. This is what makes the map read like a constellation — big hubs with small satellites orbiting them — instead of a handful of lonely stars. For the given paper return:

- concept: the paper's SPECIFIC topic — a small, reusable node capturing its actual angle (technique, endpoint, cohort). Reuse an EXISTING concept name VERBATIM only if the paper is truly the SAME specific topic; otherwise mint a new specific concept. Do NOT collapse everything into the hub, and do NOT use the paper's exact title — name the topic it exemplifies (e.g. a paper on TCAR 30-day stroke → "Transcarotid Revascularization Outcomes", not the title). Keeping specific concepts as their own satellites is intended: singletons stay visible.
- hub: the BROAD parent topic this concept belongs under. STRONGLY prefer an existing hub from the list — a TCAR paper, a CEA-vs-CAS paper, and an asymptomatic-stenosis paper all share the hub "Carotid Revascularization". Only mint a new hub when none fits. A hub is broad enough to gather a dozen concepts. If the paper's specific topic already IS that broad (no finer angle), you may return the same string for both concept and hub.
- domain: the single best-fit domain, returned as its key. Domains:
${DOMAINS.map((d) => `  - "${d.key}": ${d.label}`).join('\n')}
- tags: 3–6 SHORT lowercase topic tags (conditions, endpoints, techniques, methods) the clinician would search by. Tags carry the finest angle; the concept is specific and the hub is broad.`

// Analyze a paper. `paper` = { title, finding, relevance, text? }; `concepts` = existing
// [{ name, domain, isHub }]. Returns { concept, hub, domain, tags } — the paper's specific
// concept (satellite) AND the broad hub it hangs under. domain validated to a real key.
export async function analyzePaper({ paper, concepts = [], model = MODELS.triage, maxTokens = 1024 }) {
  const hubs = concepts.filter((c) => c.isHub)
  const sats = concepts.filter((c) => !c.isHub)
  const listOf = (arr) =>
    arr.length ? arr.map((c) => `- "${c.name}"${c.domain ? ` (${c.domain})` : ''}`).join('\n') : '(none yet)'
  const content =
    `EXISTING HUBS (broad — reuse one if it fits):\n${listOf(hubs)}\n\n` +
    `EXISTING CONCEPTS (specific satellites):\n${listOf(sats)}\n\n` +
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
  const concept = (r.concept || '').trim() || 'Uncategorized'
  const hub = (r.hub || '').trim() || concept
  return { concept, hub, domain, tags }
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
