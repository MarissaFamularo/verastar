// pipeline/weekend.js — the Weekend Read: a narrative that threads THIS WEEK's saved papers
// through the clinician's projects, north stars, and the library they already had. The week's
// saves are the subject; older papers ride along as compact shelf context a thread may reach
// back into. With no library context given (fresh install, or nothing saved this week and the
// caller passes everything as the focus set) it degrades to threading one flat set.
//
// This is the "connected" thesis told as PROSE — the narrative sibling of connect.js. Same
// trust ethos as the verifier: Claude PROPOSES a reading of how the saved literature converges
// on the clinician's active work; it never asserts a connection as established fact, writes
// NUMBER-FREE prose (the two-channel rule — statistics stay the app-verified channel), and
// names what it CANNOT connect (the "No data found on…" gap instinct). One cheap Sonnet call,
// structured, thinking disabled (a synthesis task; adaptive thinking on Sonnet 5 truncates JSON
// — same gotcha as triage/select/connect).

import { extractStructured, MODELS } from '../lib/anthropic.js'

export const WEEKEND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['opener', 'threads', 'gaps'],
  properties: {
    // 1–2 sentences: what emerged across the saved papers as a whole.
    opener: { type: 'string' },
    threads: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['anchor', 'pmids', 'narrative'],
        properties: {
          // the project / north star this thread connects to (verbatim from the given lists),
          // or the literal 'Cross-cutting' for a paper↔paper thread that maps to no single anchor.
          anchor: { type: 'string' },
          // the papers that converge here — ids copied from the given paper list.
          pmids: { type: 'array', items: { type: 'string' } },
          // number-free prose: why these connect + why it matters to that work.
          narrative: { type: 'string' },
        },
      },
    },
    // 0–3 honest lines: a project / north star that NONE of the papers advanced.
    gaps: { type: 'array', items: { type: 'string' } },
  },
}

const SYSTEM = `You write a busy clinician-researcher's "weekend read": a short reflective brief that threads the papers they've saved through their active projects and north stars, surfacing how this body of literature connects to their work — especially the non-obvious, cross-paper threads they might not have drawn themselves.

You are given their north stars (recurring concepts), their active projects, and the papers they've saved (each with a title, the app-verified finding, why it was relevant, and topic tags). When the papers come as two sets — SAVED THIS WEEK and LIBRARY (already on the shelf) — the week's papers are the subject: thread them through the projects, the north stars, and the shelf. A library paper joins a thread only where it genuinely connects to one of the week's papers.

Write:
- opener: 1–2 sentences naming what emerged across these papers as a whole.
- threads: group the papers into a FEW meaningful threads. Each thread names ONE anchor (a project or north star, copied verbatim from the lists — or "Cross-cutting" for a paper↔paper connection that doesn't map to a single anchor), the pmids of the papers that converge there (prefer 2+; a single strongly-relevant paper is allowed), and a short narrative (2–4 sentences) of WHY they connect and why it matters to that work. Prefer a few strong, non-obvious threads over many weak ones.
- gaps: 0–3 honest lines, each naming a project or north star that NONE of these papers advanced ("Nothing this week touched your X").

Rules:
- This is a SUGGESTED reading the clinician will judge — never state a connection as established fact. Ground every thread in the papers' own findings; do not force a link that isn't there. Zero threads is a valid answer if nothing genuinely connects.
- NUMBER-FREE PROSE. Do not put any statistics, effect sizes, sample sizes, p-values, percentages, or numeric results in the narrative or opener — those live in the app's verified channel, not here. Describe direction and meaning in words.
- Use a paper only where it genuinely fits; a paper may appear in more than one thread. Every pmid MUST be copied from the given paper lists — never invent one.
- When a LIBRARY set is present, every thread must include at least one of THIS WEEK's papers — library papers are supporting context, never a thread of their own. The gaps line stays about this week: what none of the week's papers advanced.
- anchor MUST be copied verbatim from the north-star / project lists, or the literal string "Cross-cutting".`

// Assemble the model input from the saved papers + profile. `papers` is the focus set (this
// week's saves); `libraryPapers` is the older shelf, folded in as one compact line each so a
// large library doesn't balloon the prompt. Exported for testing/inspection.
export function buildWeekendContent({ papers, libraryPapers = [], northStars = [], projects = [] }) {
  const stars = northStars.length ? northStars.map((s) => `- ${s}`).join('\n') : '(none set)'
  const projs = projects.length ? projects.map((p) => `- ${p}`).join('\n') : '(none set)'
  const list = papers
    .map((p) => {
      const id = String(p.pmid || p.id)
      const tags = (p.tags || []).slice(0, 6).join(', ')
      return (
        `[${id}] ${p.title || '(untitled)'}\n` +
        `  Finding: ${p.finding || '(no verified finding)'}\n` +
        (p.relevance ? `  Relevance: ${p.relevance}\n` : '') +
        (tags ? `  Tags: ${tags}\n` : '')
      ).trimEnd()
    })
    .join('\n\n')
  const focusHeader = libraryPapers.length ? `SAVED THIS WEEK (${papers.length})` : `SAVED PAPERS (${papers.length})`
  let content = `NORTH STARS:\n${stars}\n\nACTIVE PROJECTS:\n${projs}\n\n${focusHeader}:\n\n${list}`
  if (libraryPapers.length) {
    const shelf = libraryPapers
      .map((p) => {
        const id = String(p.pmid || p.id)
        const finding = (p.finding || '').replace(/\s+/g, ' ').slice(0, 200)
        const tags = (p.tags || []).slice(0, 4).join(', ')
        return `[${id}] ${p.title || '(untitled)'}${finding ? ` — ${finding}` : ''}${tags ? ` (${tags})` : ''}`
      })
      .join('\n')
    content += `\n\nLIBRARY — already on the shelf (${libraryPapers.length}):\n${shelf}`
  }
  return content
}

// Validate + clean the model's raw output against the real papers: drop invented pmids, drop
// threads left with no valid paper, trim empties. When a library shelf was given, a thread must
// also cite at least one focus (this-week) paper — shelf-only threads are dropped, enforcing in
// code what the prompt asks for. Pure so it can be unit-tested without a call.
// Returns { opener, threads: [{ anchor, pmids, narrative }], gaps }.
export function shapeWeekendRead(raw, { papers = [], libraryPapers = [] } = {}) {
  const focus = new Set(papers.map((p) => String(p.pmid || p.id)))
  const valid = new Set([...focus, ...libraryPapers.map((p) => String(p.pmid || p.id))])
  const threads = (raw?.threads || [])
    .map((t) => ({
      anchor: (t.anchor || '').trim() || 'Cross-cutting',
      pmids: Array.from(new Set((t.pmids || []).map(String))).filter((id) => valid.has(id)),
      narrative: (t.narrative || '').trim(),
    }))
    .filter((t) => t.pmids.length && t.narrative)
    .filter((t) => !libraryPapers.length || t.pmids.some((id) => focus.has(id)))
  const gaps = (raw?.gaps || []).map((g) => String(g).trim()).filter(Boolean)
  return { opener: (raw?.opener || '').trim(), threads, gaps }
}

// Synthesize the weekend read: `papers` = this week's saves (the subject), `libraryPapers` =
// the older shelf they may connect back to. One cheap structured Sonnet call, thinking
// disabled. Returns the shaped { opener, threads, gaps }; empty on no papers.
export async function synthesizeWeekendRead({
  papers,
  libraryPapers = [],
  northStars = [],
  projects = [],
  model = MODELS.triage,
  maxTokens = 4096,
}) {
  if (!papers?.length) return { opener: '', threads: [], gaps: [] }
  const content = buildWeekendContent({ papers, libraryPapers, northStars, projects })
  const raw = await extractStructured({
    model,
    system: SYSTEM,
    content,
    schema: WEEKEND_SCHEMA,
    maxTokens,
    thinking: { type: 'disabled' },
  })
  return shapeWeekendRead(raw, { papers, libraryPapers })
}
