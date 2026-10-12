import { digestCount } from '../pipeline/digestLimit.js'
// lib/digestScorePool.js — the digest screen's pool scoring and re-score, outside the component.
//
// Moved out of components/SpineCheck.jsx for the same reason as lib/digestRunAndRank.js: so the
// orchestration itself can be driven in tests with deferred dependencies.
//
// scoreCandidatePool is shared. A new scan calls it with no ticket and behaves as it always
// has. A re-score of the pool on screen is a continuation of that digest, so it passes its
// continuation ticket (lib/continuationTicket.js) and the ticket is shown after every await:
// before the project read, immediately before the selection call, and before the reply is
// applied or saved. A selection call already sent is not recalled; only its reply is discarded.

import { getProfile } from './store.js'
import { digestProjects } from './trellis.js'
import {
  selectCandidates,
  capScoredByTopic,
  applyScoreFloor,
  normalizeScoreFloor,
  preReadFloor,
  coverageSelectionSummary,
} from '../pipeline/select.js'
import { profileTopicCap, topicReportRows } from '../pipeline/topics.js'
import { DEFAULT_SELECT_COUNT } from '../pipeline/onboard.js'

const REAL_DEPS = { getProfile, digestProjects, selectCandidates }

// Score a candidate pool against the current rubric and pre-check the ones that EARNED a
// slot. `pool` is candidate stubs; selection fetches their abstracts before scoring. Floor
// first, then the count cap — a thin day yields a short digest, never ten slots padded out
// with whatever scored highest among the mediocre.
//
// With a ticket that has gone stale, resolves `{ blocked: true }` having sent nothing further
// and applied nothing.
//
//   env.ui            the screen's setters (setCandidates, setSelectedIds, ...)
//   env.persistDigest the screen's save
//   env.tickets, env.ticket   only for a continuation (re-score); a new scan passes neither
//   env.deps          { getProfile, digestProjects, selectCandidates } (tests replace these)
export async function scoreCandidatePool(pool, context, env) {
  const { ui, persistDigest, tickets = null, ticket = null } = env
  const deps = { ...REAL_DEPS, ...(env.deps || {}) }
  const live = () => !ticket || tickets.valid(ticket)
  const stale = { blocked: true }

  const profile = await deps.getProfile()
  if (!live()) return stale
  const projects = await deps.digestProjects(profile)
  // Shown again here, after both reads and immediately before the call: the digest can be
  // found held while either is still loading, and the selection call must not go out after that.
  if (!live()) return stale
  const wideScored = await deps.selectCandidates({
    rubric: profile?.rubric?.criteria ?? '',
    northStars: profile?.northStars ?? [],
    projects,
    journalPreferences: profile?.journalPreferences,
    candidates: pool,
  })
  // A reply that came back after the digest was held, stopped or replaced is discarded.
  if (!live()) return stale
  const capped = capScoredByTopic(wideScored, {
    cap: profileTopicCap(profile),
    counts: context?.counts,
  })
  const scored = capped.candidates
  const nextContext = { ...(context || {}), counts: capped.counts }
  ui.setPreCapCandidates(wideScored)
  ui.setSearchContext(nextContext)
  ui.setTopicReport(topicReportRows(capped.counts, context?.failed))
  const finalFloor = normalizeScoreFloor(profile?.rubric?.scoreFloor)
  const screeningFloor = preReadFloor(finalFloor)
  const selection = applyScoreFloor(scored, {
    floor: screeningFloor,
    count: digestCount(profile?.rubric?.selectCount, DEFAULT_SELECT_COUNT),
  })
  const { picked, cleared, total } = selection
  const chosenIds = new Set(picked.map((c) => c.id))
  const coverageIds = new Set(picked.slice(0, selection.coveragePicked).map((c) => c.id))
  const ranked = scored.map((candidate) => ({
    ...candidate,
    selectionRole: chosenIds.has(candidate.id) ? (coverageIds.has(candidate.id) ? 'coverage' : 'score') : '',
  }))
  ui.setCandidates(ranked)
  ui.setSelectedIds(chosenIds)
  ui.setScoreFloor(finalFloor) // the post-read admission bar; screening gets a 20-point allowance
  const slate = picked.length < cleared ? ` ${coverageSelectionSummary({ picked: picked.length, ...selection })}` : ''
  const screened = cleared
    ? `On title, abstract, and journal, ${cleared} of ${total} came within 20 points of your final bar of ${finalFloor}.${slate}`
    : `On title, abstract, and journal, nothing came within 20 points of your final bar of ${finalFloor} today.`
  ui.setScanNote(screened)
  // The pool + picks survive a tab switch even before any digest runs.
  persistDigest({
    candidates: ranked,
    preCapCandidates: wideScored,
    searchContext: nextContext,
    selectedIds: chosenIds,
  })
  return {
    scored: ranked,
    chosenIds,
    cleared,
    floor: finalFloor,
    screeningFloor,
    prescored: capped.prescored,
    counts: capped.counts,
  }
}

// Live re-rank: re-score the SAME cached pool against the (edited) rubric — no re-fetch, no
// extraction. Never for a held or stopped server digest, and a re-score that goes stale while
// it waits shows nothing: no scores, no note, no error. It puts away its own busy flag unless
// a later operation has started and owns it.
//
//   env.snapshot  { candidates, preCapCandidates, searchContext, selecting } as rendered
export async function rescorePool(env) {
  const { tickets, snapshot, ui } = env
  const { candidates, preCapCandidates, searchContext, selecting } = snapshot
  if (tickets.blocked()) return { blocked: true }
  if (!candidates.length || selecting) return { skipped: true }
  const ticket = tickets.begin()
  ui.setSelecting(true)
  ui.setScanError('')
  ui.setScanNote('')
  let out
  try {
    const source = preCapCandidates.length ? preCapCandidates : candidates
    // The old scores and roles are dropped on purpose: the pool is scored afresh.
    out = await scoreCandidatePool(source.map(({ score, reason, selectionRole, retainedTopics, ...c }) => c), searchContext, { ...env, ticket })
  } catch (err) {
    // A stale re-score's failure is not this screen's news.
    if (tickets.valid(ticket)) ui.setScanError(`Re-rank failed: ${err.message}`)
    out = tickets.valid(ticket) ? { failed: true } : { blocked: true }
  }
  if (tickets.latest(ticket)) ui.setSelecting(false)
  return out
}
