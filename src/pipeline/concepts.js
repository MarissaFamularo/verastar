// pipeline/concepts.js — the concept layer. Verastar's knowledge graph nodes are CONCEPTS
// (topic/"wiki" nodes), not individual papers — mirroring the clinician's real KG, where a
// node like "Multidisciplinary Team for Diabetic Foot" aggregates many source articles under
// one synthesized evidence summary. Papers are the SOURCES that hang under a concept.
//
// Three cheap Claude calls (Sonnet, structured, thinking disabled — the triage/select gotcha):
//   - analyzePaper: on deposit, assign the paper to a concept (reuse an existing one or name a
//     new topic-level concept), plus its domain + topic tags.
//   - synthesizeConcept: (re)write the concept's evidence summary from its source papers'
//     VERIFIED findings — number-free prose that also names what's NOT yet established (the
//     same evidence-careful instinct as the verifier; specific numbers stay with each source).
//   - proposeDomainMerges: taxonomy tidying — when the field set grows past a handful, decide
//     which sparse fields are needless splinters of another and should merge into it.

import { extractStructured, MODELS } from '../lib/anthropic.js'
import { listDomains, ensureDomain, ensureDomainsLoaded } from '../lib/domains.js'

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

// The domain rule, built from the reader's CURRENT taxonomy. Two regimes, because the right
// answer differs completely:
//
//   - Empty taxonomy: there is nothing to match, so name the field by DISCIPLINE (department
//     level) and lean against collapsing everything into the clinical specialty.
//   - Existing taxonomy: the list itself is the spec. A single-specialty reader whose fields are
//     subject-level ("Carotid Disease", "Aneurysm", "Limb") gets NO grouping from a discipline
//     that swallows the whole library — every paper lands in "Vascular Surgery" and the tier is
//     dead. So the model matches the granularity it is shown rather than the one we'd prescribe,
//     and fields the user created themselves outrank anything the model would name itself.
//
// Pure — exported so the preference rule is testable without an API call.
export function domainGuidance(domains = []) {
  const head = `the broad GROUPING this paper is filed under — one tier wider than a hub (a domain gathers several hubs). A paper's DISCIPLINE can differ from its clinical subject: a machine-learning model for aneurysm growth contributes AI methods, a data-interoperability or genomic-database paper contributes data science, a training-curriculum paper contributes education.`
  if (!domains.length) {
    return `${head} This reader's taxonomy is empty so far — propose the domain as a short field-level name (2–4 words, Title Case), broad enough that a dozen hubs could live under it, chosen by the paper's discipline rather than merely its clinical subject. A clinician-scientist's library normally spans SEVERAL such fields — if you find yourself filing methods, data, AI, and education papers all under one clinical specialty, you are collapsing the taxonomy.`
  }
  const list = domains
    .map((d) => `  - "${d.key}": ${d.label}${d.source === 'user' ? '   ← the reader created this field themselves' : ''}`)
    .join('\n')
  return `${head} This reader ALREADY HAS a taxonomy — file the paper INTO it. Return the KEY verbatim:
${list}
Match the granularity of that list; infer it from the list itself. If the fields are SUBJECT-level (conditions, anatomy, populations), file at that level — do NOT fall back to the broad specialty or discipline that contains all of them, because a field that swallows the reader's whole library groups nothing. If the fields are DISCIPLINE-level, file by discipline. When the list MIXES levels — a broad specialty sitting alongside narrower fields — file into the narrowest field the paper actually fits; the broad one is the last resort, for papers no narrower field covers. Fields the reader created themselves are the strongest available signal of how they want their library organized: prefer them over any field you would name yourself, and pick the closest one whenever the paper plausibly belongs there.
Mint a NEW field ONLY when the paper genuinely fits none of the above — not merely because no field is a perfect fit. Name a new field at the SAME level of granularity as the existing list (2–4 words, Title Case), never a paper- or disease-instance-specific topic, and never a near-duplicate of a field already listed.`
}

const analyzeSystem = (domains, projects) => `You file papers into a clinician-scientist's concept-based knowledge graph. The reader may be from ANY specialty — derive every topic name from the papers themselves, never from these examples. The graph has TWO tiers: broad "hub" topics that gather many papers (a vascular surgeon might accrue "Carotid Revascularization" and "CLTI Management"; an orthopedic surgeon "Knee Arthroplasty" and "Resident Education"), and specific "concept" satellites beneath them (e.g. "Transcarotid Revascularization Stroke Risk" under the former, "Cementless Fixation Outcomes" under the latter). A paper is a SOURCE under one specific concept, and that concept hangs off one broad hub. This is what makes the map read like a constellation — big hubs with small satellites orbiting them — instead of a handful of lonely stars. For the given paper return:

- concept: the paper's SPECIFIC topic — a small, reusable node capturing its actual angle (technique, endpoint, cohort). Reuse an EXISTING concept name VERBATIM only if the paper is truly the SAME specific topic; otherwise mint a new specific concept. Do NOT collapse everything into the hub, and do NOT use the paper's exact title — name the topic it exemplifies (e.g. a paper on TCAR 30-day stroke → "Transcarotid Revascularization Outcomes", not the title). Keeping specific concepts as their own satellites is intended: singletons stay visible.
- hub: the BROAD parent topic this concept belongs under. STRONGLY prefer an existing hub from the list — a TCAR paper, a CEA-vs-CAS paper, and an asymptomatic-stenosis paper all share the hub "Carotid Revascularization". Only mint a new hub when none fits. A hub is broad enough to gather a dozen concepts. If the paper's specific topic already IS that broad (no finer angle), you may return the same string for both concept and hub.
- domain: ${domainGuidance(domains)}
- tags: 3–6 SHORT lowercase topic tags (conditions, endpoints, techniques, methods) the clinician would search by. Tags carry the finest angle; the concept is specific and the hub is broad.${projectBan(projects)}`

// The reader's own projects leak into filing via the paper's Relevance line ("…informs your
// Limb Preservation Program") — the model then mints a topic named after the project, which
// duplicates the map's yellow project star as a red concept star. Ban them explicitly.
const projectBan = (projects) =>
  projects?.length
    ? `\n\nThe reader's own projects/programs are CONTEXT, not topics — the Relevance line may mention them, but topics are named by scientific subject matter. NEVER name the concept or hub after any of these:\n${projects.map((p) => `  - "${p}"`).join('\n')}`
    : ''

// Deterministic guard behind the prompt (the model proposes; the code disposes): a filing that
// still names a topic after a project is repaired — a banned hub collapses onto the concept, a
// banned concept files directly under its hub, both banned falls back to Uncategorized. Pure.
export function sanitizeFiling({ concept, hub }, projects = []) {
  const banned = new Set(projects.map((p) => (p || '').trim().toLowerCase()).filter(Boolean))
  const bad = (name) => banned.has((name || '').trim().toLowerCase())
  let c = concept
  let h = hub
  if (bad(h)) h = c
  if (bad(c)) c = bad(h) ? 'Uncategorized' : h
  if (bad(h)) h = c
  return { concept: c, hub: h }
}

// Analyze a paper. `paper` = { title, finding, relevance, text? }; `concepts` = existing
// [{ name, domain, isHub }]; `projects` = the reader's project names (banned as topic names).
// Returns { concept, hub, domain, tags } — the paper's specific concept (satellite) AND the
// broad hub it hangs under. domain validated to a real key.
export async function analyzePaper({ paper, concepts = [], projects = [], model = MODELS.triage, maxTokens = 1024 }) {
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

  await ensureDomainsLoaded() // the prompt must show the reader's real taxonomy, not an empty one
  const r = await extractStructured({
    model,
    system: analyzeSystem(listDomains(), projects),
    content,
    schema: ANALYZE_SCHEMA,
    maxTokens,
    thinking: { type: 'disabled' },
  })
  // Existing key → reused as-is; anything else is a proposed new field → minted with the
  // next palette color. Either way the paper gets a real key.
  const domain = await ensureDomain(r.domain)
  const seen = new Set()
  const tags = (r.tags || [])
    .map((t) => (t || '').trim().toLowerCase())
    .filter((t) => t && !seen.has(t) && seen.add(t))
    .slice(0, 6)
  const rawConcept = (r.concept || '').trim() || 'Uncategorized'
  const rawHub = (r.hub || '').trim() || rawConcept
  const { concept, hub } = sanitizeFiling({ concept: rawConcept, hub: rawHub }, projects)
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

// --- tidy the field taxonomy: merge sparse near-duplicate domains ---

export const MERGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['merges'],
  properties: {
    merges: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['from', 'into'],
        properties: {
          from: { type: 'string' }, // key of the sparse field being merged away
          into: { type: 'string' }, // key of the field that absorbs it
        },
      },
    },
  },
}

const MERGE_SYSTEM = `You tidy the FIELD taxonomy of a clinician-scientist's knowledge graph. Fields are broad research disciplines — department-level, like "Vascular Surgery" or "Health Data Science" — that color the map's stars. A good taxonomy is a handful of well-populated fields (roughly 4–8), not a long tail of one-paper micro-fields. You get every field with its paper count; the papers themselves are listed under the SPARSE fields. Decide which sparse fields (if any) should MERGE into another field. Merge when a sparse field is a near-duplicate, a subset, or a needless splinter of another (e.g. "Clinical AI" into "AI & Technology in Medicine"). KEEP a sparse field that is a genuinely distinct discipline likely to accrue more papers — every new field starts with one paper, so small is not, by itself, a reason to merge. Never merge two healthy distinct fields. Return merges: [] when the taxonomy is already right.`

// Propose taxonomy merges. `fields` = [{ key, label, count, pinned, papers }] — papers (titles)
// are provided only for the sparse fields, and `pinned` marks the user's own fields (off-limits
// as a merge source). Returns raw [{ from, into }] by key; the caller sanitizes
// (deposit.pickMerges) and applies. Claude proposes; the code disposes.
export async function proposeDomainMerges({ fields, model = MODELS.triage, maxTokens = 1024 }) {
  const lines = fields.map(
    (f) =>
      `- "${f.key}" (${f.label}) — ${f.count} paper${f.count === 1 ? '' : 's'}` +
      (f.pinned ? ' [the reader created this field — never merge it away; it may absorb others]' : '') +
      (f.papers?.length ? `\n${f.papers.map((t) => `    · ${t}`).join('\n')}` : ''),
  )
  const r = await extractStructured({
    model,
    system: MERGE_SYSTEM,
    content: `FIELDS (papers listed under the sparse ones):\n${lines.join('\n')}`,
    schema: MERGE_SCHEMA,
    maxTokens,
    thinking: { type: 'disabled' },
  })
  return r.merges || []
}

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
