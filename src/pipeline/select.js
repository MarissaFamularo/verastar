// pipeline/select.js — the rubric-driven selection funnel (cheap pre-extraction pass).
//
// A hand-run morning digest starts from ~50+ candidates and keeps ~10. Verastar mirrors
// that: search PubMed WIDE, then score every candidate's title + journal + publication
// type against the clinician's own rubric in ONE cheap Sonnet call — no full-text fetch,
// no extraction. Only the selected top N go on to the expensive verify pipeline, so
// searching wider costs almost nothing extra. Editing the rubric re-scores the SAME cached
// pool (no re-fetch), which is what makes the live re-rank cheap.

import { extractStructured, MODELS } from '../lib/anthropic.js'

export const SELECTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['selections'],
  properties: {
    selections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'score', 'reason'],
        properties: {
          id: { type: 'string' }, // the candidate's pmid
          score: { type: 'integer' }, // 0–100 fit to the rubric; ranking only
          reason: { type: 'string' }, // one short clause: why it scored where it did
        },
      },
    },
  },
}

const SYSTEM = `You are the gatekeeper for a busy clinician's morning literature digest. You get their rubric (their editorial priorities, in their own words), their north stars, their active projects, and a list of candidate papers — each with only its title, journal, year, and publication types. Score EVERY candidate 0–100 for how well it fits the rubric and deserves a slot in today's digest (100 = exactly what they want to see; 0 = off-topic or explicitly the kind of thing they said to skip). The rubric is the deciding voice — honor what it says to prioritize, downrank, and skip. Use journal and publication type as evidence-strength signals. Give each a one-clause reason. You are working from metadata only; be decisive but don't invent findings. Return a score for every candidate id you were given.`

// Score a wide candidate pool against the rubric. `candidates` is
// [{ id, title, journal, year, pubtypes }]. Returns the same list annotated with
// { score, reason }, sorted highest-first — the caller slices the top N. One structured
// call on the cheap model, thinking disabled (ranking, and adaptive thinking truncates JSON).
export async function selectCandidates({
  rubric = '',
  northStars = [],
  projects = [],
  candidates,
  model = MODELS.triage,
  maxTokens = 4096,
}) {
  if (!candidates?.length) return []

  const stars = northStars.length ? northStars.join(', ') : '(none set)'
  const projs = projects.length ? projects.join(', ') : '(none set)'
  const rubricText = (rubric || '').trim() || '(no rubric set — fall back to the north stars)'

  const content =
    `RUBRIC (the deciding voice):\n${rubricText}\n\n` +
    `North stars: ${stars}\nActive projects: ${projs}\n\n` +
    `Candidates (${candidates.length}):\n\n` +
    candidates
      .map((c) => {
        const types = (c.pubtypes || []).filter((t) => t && t !== 'Journal Article').join(', ')
        return `[${c.id}] ${c.title}\n  ${c.journal || 'unknown journal'}${c.year ? ` (${c.year})` : ''}${types ? ` · ${types}` : ''}`
      })
      .join('\n\n')

  const result = await extractStructured({
    model,
    system: SYSTEM,
    content,
    schema: SELECTION_SCHEMA,
    maxTokens,
    thinking: { type: 'disabled' },
  })

  const scoreById = new Map((result.selections || []).map((s) => [String(s.id), s]))
  return candidates
    .map((c) => {
      const s = scoreById.get(String(c.id))
      return { ...c, score: s?.score ?? 0, reason: s?.reason ?? '' }
    })
    .sort((a, b) => b.score - a.score)
}
