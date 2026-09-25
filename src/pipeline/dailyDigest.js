// pipeline/dailyDigest.js — the daily digest as a headless run.
//
// SpineCheck.jsx drives the same loop interactively: search PubMed per topic → score the
// pool against the rubric → read and verify the picks → rank and summarize → persist →
// stamp the seen ledger. This module is that loop with no screen attached, so a scheduled
// run on the server can leave a finished digest in the account's `daily:latest` slot for
// the app to restore exactly as if the reader had pressed the button.
//
// Two properties the server needs that the button does not:
//   - RESUMABLE. An edge function has a wall-clock limit shorter than a full run. Every
//     paper is persisted as it finishes and the record carries a `server.phase`; a later
//     tick continues from where the last one stopped (search once, read the rest, rank).
//   - BUDGETED. `budgetMs` bounds the reading loop; when it runs out the run returns with
//     phase 'reading' and the next tick picks up the remaining candidates.
//
// It writes the same record shape SpineCheck reads (lib/digestStore.js), the same seen
// ledger, and the same successful-scan checkpoint. It never writes papers.

import { store, getProfile, SEEN_KEY } from '../lib/store.js'
import { saveDailyDigest, loadDailyDigest, saveSuccessfulScan, serializeDigest } from '../lib/digestStore.js'
import { digestProjects } from '../lib/trellis.js'
import { runPaper, searchCandidates } from './pipeline.js'
import { triage } from './triage.js'
import {
  selectCandidates,
  capScoredByTopic,
  applyScoreFloor,
  applyPostReadFloor,
  planCoverageFallbacks,
  normalizeScoreFloor,
  preReadFloor,
} from './select.js'
import { skipSet, seenIds, mergeSeen, capLedger, stampableIds } from './seen.js'
import { profileTopics, profileSearchDays, profileTopicCap } from './topics.js'
import { DEFAULT_SELECT_COUNT } from './onboard.js'
import { isRelationshipValidated } from '../lib/evidenceVersion.js'
import { fmtNum } from '../lib/format.js'
import { isCapReached } from '../lib/anthropic.js'

// Past this share of the budget, a tick that read papers hands ranking to the next tick.
export const RANK_HANDOFF_FRACTION = 0.35

const titleOf = (res) => res.paper.title || res.citation?.title || `PMID ${res.paper.pmid}`

// --- pure helpers -------------------------------------------------------------------------

// What a resumed tick still has to read: chosen candidates not yet in processedResults.
export function remainingToRead(candidates, selectedIds, processedResults) {
  const done = new Set((processedResults || []).map((r) => r?.paper?.id))
  const chosen = new Set(selectedIds || [])
  return (candidates || []).filter((c) => chosen.has(c.id) && !done.has(c.id))
}

// The triage take map from a rankings array. Same shape SpineCheck builds.
export function takesById(rankings) {
  const byId = {}
  for (const rk of rankings || []) {
    byId[rk.id] = {
      score: rk.score,
      tier: rk.tier,
      finding: rk.finding,
      designCaution: rk.designCaution,
      relevance: rk.relevance,
      check: rk.check,
      cautionCheck: rk.cautionCheck,
    }
  }
  return byId
}

// --- the run ----------------------------------------------------------------------------

// Run (or continue) the daily digest for the account the store is bound to.
// Options: budgetMs (reading budget for this tick), now, log (fn), days (window override).
// Resolves { phase: 'done' | 'reading' | 'rank' | 'empty' | 'capped', papers, read, note }.
export async function runDailyDigest({ budgetMs = 100_000, now = () => Date.now(), log = () => {}, days } = {}) {
  const startedAt = now()
  const profile = await getProfile()
  if (!profile?.onboarded) return { phase: 'empty', papers: 0, read: 0, note: 'Profile not onboarded.' }

  // Resume if a scheduler run is mid-flight; otherwise start clean.
  const existing = await loadDailyDigest()
  const resuming = existing?.runBy === 'scheduler' && existing.server?.phase && existing.server.phase !== 'done'
  let state = resuming
    ? { ...existing, selectedIds: new Set(existing.selectedIds) }
    : { results: [], processedResults: [], triaged: {}, candidates: [], preCapCandidates: [], searchContext: { counts: [], failed: [], days: null }, selectedIds: new Set(), openedAt: null, runBy: 'scheduler', ranAt: new Date(startedAt).toISOString(), server: { phase: 'search', startedAt: new Date(startedAt).toISOString() } }

  const persist = async (patch = {}) => {
    state = { ...state, ...patch }
    await saveDailyDigest(state)
  }

  // Phase 1: search + score. Once per digest.
  if (state.server.phase === 'search') {
    const searchDays = days ?? profileSearchDays(profile)
    const [ledger, saved] = await Promise.all([store.get('seen', SEEN_KEY), store.all('papers')])
    const search = await searchCandidates({
      topics: profileTopics(profile),
      northStars: profile?.northStars ?? [],
      perTopic: profileTopicCap(profile),
      days: searchDays,
      skipIds: skipSet(seenIds(ledger), saved || []),
    })
    const allTopicsSearched = search.failed.length === 0
    log(`search: ${search.candidates.length} candidates, ${search.failed.length} failed topics`)
    if (!search.candidates.length) {
      if (allTopicsSearched) await saveSuccessfulScan({ windowDays: search.days }).catch(() => {})
      await persist({ searchContext: { counts: search.counts, failed: search.failed, days: search.days }, server: { ...state.server, phase: 'done', finishedAt: new Date(now()).toISOString(), empty: true } })
      return { phase: 'empty', papers: 0, read: 0, note: 'Nothing new in the window.' }
    }

    const projects = await digestProjects(profile)
    const wideScored = await selectCandidates({
      rubric: profile?.rubric?.criteria ?? '',
      northStars: profile?.northStars ?? [],
      projects,
      journalPreferences: profile?.journalPreferences,
      candidates: search.candidates,
    })
    const capped = capScoredByTopic(wideScored, { cap: profileTopicCap(profile), counts: search.counts })
    const finalFloor = normalizeScoreFloor(profile?.rubric?.scoreFloor)
    const selection = applyScoreFloor(capped.candidates, {
      floor: preReadFloor(finalFloor),
      count: profile?.rubric?.selectCount ?? DEFAULT_SELECT_COUNT,
    })
    const chosenIds = new Set(selection.picked.map((c) => c.id))
    const coverageIds = new Set(selection.picked.slice(0, selection.coveragePicked).map((c) => c.id))
    const ranked = capped.candidates.map((candidate) => ({
      ...candidate,
      selectionRole: chosenIds.has(candidate.id) ? (coverageIds.has(candidate.id) ? 'coverage' : 'score') : '',
    }))
    if (allTopicsSearched) await saveSuccessfulScan({ windowDays: search.days }).catch(() => {})
    log(`score: ${selection.cleared} cleared, ${chosenIds.size} chosen, floor ${finalFloor}`)
    await persist({
      candidates: ranked,
      preCapCandidates: wideScored,
      searchContext: { counts: capped.counts, failed: search.failed, days: search.days },
      selectedIds: chosenIds,
      server: { ...state.server, phase: chosenIds.size ? 'reading' : 'done', floor: finalFloor, ...(chosenIds.size ? {} : { finishedAt: new Date(now()).toISOString(), empty: true }) },
    })
    if (!chosenIds.size) {
      // Nothing cleared the bar; nothing is stamped seen (SpineCheck does the same).
      return { phase: 'empty', papers: 0, read: 0, note: 'Nothing cleared the bar.' }
    }
  }

  // Phase 2: read and verify, one paper at a time, persisting after each, within budget.
  let read = 0
  if (state.server.phase === 'reading' || state.server.phase === 'fallback') {
    const remaining = remainingToRead(state.candidates, state.selectedIds, state.processedResults)
    for (const paper of remaining) {
      if (now() - startedAt > budgetMs) {
        log(`budget: ${remaining.length - read} papers left for the next tick`)
        return { phase: 'reading', papers: state.results.length, read, note: 'Budget reached; will resume.' }
      }
      const res = await runPaper(paper)
      if (res.error && isCapReached(res.errorObject)) {
        await persist({ server: { ...state.server, phase: 'reading', capped: true } })
        return { phase: 'capped', papers: state.results.length, read, note: res.error }
      }
      read++
      const processed = [...state.processedResults, res]
      const results = res.retracted ? state.results : [...state.results, res]
      await persist({ processedResults: processed, results })
    }
    await persist({ server: { ...state.server, phase: 'rank' } })
    // Ranking is one large model call over every paper read (full text each), routinely
    // a minute or more. A tick that has already spent much of its budget reading must not
    // start it: the edge runtime's wall clock would kill the tick mid-call, wasting the
    // call. Hand the rank phase to the next tick, which starts with a full budget.
    if (read > 0 && now() - startedAt > budgetMs * RANK_HANDOFF_FRACTION) {
      log('handoff: ranking deferred to the next tick')
      return { phase: 'rank', papers: state.results.length, read, note: 'Read done; ranking next tick.' }
    }
  }

  // Phase 3: rank, post-read floor, coverage fallback (one extra reading pass), final rank.
  if (state.server.phase === 'rank') {
    const ok = state.processedResults.filter((r) => !r.error && !r.retracted)
    let triaged = state.triaged || {}
    let visible = state.results
    if (ok.length) {
      const projects = await digestProjects(profile)
      const rankings = await triage({
        northStars: profile?.northStars ?? [],
        projects,
        journalPreferences: profile?.journalPreferences,
        rubric: profile?.rubric?.criteria ?? '',
        candidates: ok.map((r) => ({
          id: r.paper.id,
          title: titleOf(r),
          design: r.design,
          topics: r.paper.topics,
          topicSteering: r.paper.topicSteering,
          summary: r.sourceDoc?.text || '',
          verified: r.rows.filter((row) => isRelationshipValidated(row.verdict)).map((row) => ({ name: row.quantity.name, value: fmtNum(row.quantity) })),
        })),
      })
      triaged = takesById(rankings)
      const post = applyPostReadFloor(state.processedResults, triaged, profile?.rubric?.scoreFloor)
      visible = post.kept

      // Coverage fallback: protected topics left empty after the floor get one more read
      // each, once. Marks the extra candidates chosen and drops back to the reading phase.
      if (!state.server.fallbackDone) {
        const fallback = planCoverageFallbacks({
          candidates: state.candidates,
          processedResults: state.processedResults,
          visibleResults: visible,
          rankings: triaged,
          floor: post.floor,
          counts: state.searchContext?.counts,
        })
        if (fallback.candidates.length) {
          log(`fallback: reading ${fallback.candidates.length} more for ${fallback.rescuedTopics.length} topics`)
          const selectedIds = new Set([...state.selectedIds, ...fallback.candidates.map((c) => c.id)])
          await persist({ triaged, results: visible, selectedIds, server: { ...state.server, phase: 'reading', fallbackDone: true } })
          // Continue immediately within this tick if budget allows; otherwise resume later.
          return runDailyDigest({ budgetMs: Math.max(0, budgetMs - (now() - startedAt)), now, log })
        }
      }
    }
    await persist({ triaged, results: visible, selectedIds: new Set(visible.map((r) => r.paper.id)), server: { ...state.server, phase: 'done', finishedAt: new Date(now()).toISOString() } })

    // Seen ledger LAST, and only for what actually ran or was passed over.
    const outcomes = state.processedResults.map((r) => ({ id: r.paper.id, error: r.error }))
    const ids = stampableIds(state.candidates, outcomes)
    if (ids.length) {
      try {
        const ledger = await store.get('seen', SEEN_KEY)
        await store.put('seen', SEEN_KEY, capLedger(mergeSeen(ledger, ids, new Date(now()).toISOString())))
      } catch (err) {
        log(`seen ledger failed: ${err.message}`)
      }
    }
    log(`done: ${visible.length} papers in the digest`)
    return { phase: 'done', papers: visible.length, read, note: '' }
  }

  return { phase: state.server.phase, papers: state.results.length, read, note: '' }
}

export { serializeDigest }
