// pipeline/select.js — the rubric-driven selection funnel (cheap pre-extraction pass).
//
// A hand-run morning digest starts from ~50+ candidates and keeps ~10. Verastar mirrors
// that: search PubMed WIDE, then score every candidate's title + journal + publication
// type against the clinician's own rubric in ONE cheap Sonnet call — no full-text fetch,
// no extraction. Only the selected top N go on to the expensive verify pipeline, so
// searching wider costs almost nothing extra. Editing the rubric re-scores the SAME cached
// pool (no re-fetch), which is what makes the live re-rank cheap.
//
// Selection is floor-then-cap, not top-N: a score floor decides who EARNED a slot and
// selectCount only caps a good day. See applyScoreFloor at the bottom of this file.

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

// --- the score floor: a slot has to be EARNED ---
//
// Taking the top N unconditionally means a thin day still fills ten slots, and slots
// six through ten are padding she has to read to discover they were padding. Her own
// rubric norm is the opposite: if two papers pass, the digest has two. The floor is the
// bar; selectCount is only a ceiling on how much of a good day she wants.

export const DEFAULT_SCORE_FLOOR = 60

// Profiles predate this field, and the number arrives from a text input — anything
// unusable falls back to the default rather than silently becoming a floor of 0 (which
// would restore the padding this exists to stop).
export function normalizeScoreFloor(raw) {
  // null and '' both coerce to 0 through Number() — an absent field must not read as
  // "she set the floor to zero", which is exactly the padding case.
  if (raw === null || raw === undefined || raw === '') return DEFAULT_SCORE_FLOOR
  const n = Math.round(Number(raw))
  if (!Number.isFinite(n)) return DEFAULT_SCORE_FLOOR
  return Math.min(Math.max(n, 0), 100)
}

// Floor first, THEN cap. `scored` is already sorted highest-first. Returns the picks
// plus the counts the UI needs to say plainly what the floor did.
export function applyScoreFloor(scored, { floor = DEFAULT_SCORE_FLOOR, count } = {}) {
  const bar = normalizeScoreFloor(floor)
  const ceiling = Number.isFinite(Number(count)) && Number(count) > 0 ? Math.round(Number(count)) : Infinity
  const cleared = (scored || []).filter((c) => Number(c?.score ?? 0) >= bar)
  return { picked: cleared.slice(0, ceiling), cleared: cleared.length, total: (scored || []).length, floor: bar }
}

// The one honest sentence about today's funnel. Empty when the floor did nothing worth
// reporting (everything scored cleared it and fit). A zero day states the count and stops:
// it renders in the muted note slot rather than the error red, which is what says it isn't
// a failure. Reassuring her in prose that a short digest is legitimate would read as the
// app defending itself.
// It also has to name WHICH score it is counting. Two different 0–100 numbers reach the
// digest and only one of them is this one — see the pre-read/post-read note below.
export function floorSummary({ total = 0, cleared = 0, picked = 0, floor = DEFAULT_SCORE_FLOOR } = {}) {
  if (!total) return ''
  if (!cleared)
    return `On title and journal, nothing cleared your bar today — ${total} paper${total === 1 ? '' : 's'} scored, none reached ${floor}.`
  if (cleared < total) {
    const trimmed = `On title and journal, ${cleared} of ${total} cleared your bar today (score ${floor}+).`
    return picked < cleared ? `${trimmed} The top ${picked} made the digest.` : trimmed
  }
  return picked < cleared ? `On title and journal, all ${total} cleared your bar — the top ${picked} made the digest.` : ''
}

// --- the pre-read screen vs the post-read judgment ---------------------------
//
// TWO 0–100 scores reach the digest and they are not the same number. This file's score
// (selectCandidates) reads title + journal + publication type BEFORE the paper is fetched,
// and it is the one the floor filters on. The card's number comes from pipeline/triage,
// written AFTER the paper was fetched and read. Unlabelled, they read as the app
// contradicting itself: "3 of 27 cleared your bar today (score 60+)" sitting directly
// above a card marked 58. Both are true; only the labels were missing. So floorSummary
// names its input ("on title and journal") and the card says "after reading" — and a
// post-read score under the bar is stated on its own card, because a screen that
// mis-ranked a paper is signal she can act on.
//
// Nothing here re-filters. She already paid to extract the paper; dropping it after the
// fact would spend her money and show her nothing.

// Coerce a UI-supplied score/floor to a usable number, or null. '' and null must not
// coerce to 0 the way Number() does — an absent score is not a score of zero.
const asScore = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// The card's score label, in the tight header row next to the tier chip. Empty for a paper
// triage never scored, so the card drops the label rather than showing a bare "after
// reading".
export function readFitLabel({ score } = {}) {
  const n = asScore(score)
  return n === null ? '' : `fit ${n} after reading`
}

// Stated, muted, on a card whose post-read score came in under her bar — the pre-read
// screen let it through and reading it disagreed. Not amber and not red: the
// withheld-summary amber and the error red both mean other things, and nothing here
// failed. Empty when there is nothing to report: no score, no floor configured, or a score
// at or above the bar (the boundary clears, exactly as applyScoreFloor treats it).
export function belowFloorNote({ score, floor } = {}) {
  const n = asScore(score)
  const bar = asScore(floor)
  if (n === null || bar === null || n >= bar) return ''
  return `${n} after reading — below your bar of ${bar}.`
}
