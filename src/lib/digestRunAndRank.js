import { resultCandidate, summaryFields } from '../pipeline/resultHandoff.js'
import { fitDigestPapers, PILOT_DIGEST_LIMIT, DIGEST_LIMIT_NOTE, LEGACY_DIGEST_LIMIT_NOTE } from '../pipeline/digestLimit.js'
// lib/digestRunAndRank.js — the digest screen's read-then-rank run, outside the component.
//
// Moved out of components/SpineCheck.jsx so the orchestration itself can be driven in tests
// with deferred dependencies. The screen passes its state setters and its persist function;
// nothing here knows about React.
//
// Every await below is a place where the digest on screen can be found held, stopped or
// replaced. The run holds a continuation ticket (lib/continuationTicket.js) and shows it
// after each one: immediately before sending the next call, and before applying or saving
// anything that came back. A stale run sends nothing more and applies nothing more. A call
// already sent is not recalled; only its reply is discarded.

import { isCapReached } from './anthropic.js'
import { getProfile } from './store.js'
import { withOaLinks } from './digestStore.js'
import { digestProjects } from './trellis.js'
import { logEvent } from './events.js'
import { fmtNum } from './format.js'
import { isRelationshipValidated } from './evidenceVersion.js'
import { runPaper, corruptAndReverify } from '../pipeline/pipeline.js'
import { triage } from '../pipeline/triage.js'
import { findPrimary, verificationCorpus } from '../pipeline/primaryResult.js'
import { evidenceSummary } from '../pipeline/evidenceWindow.js'
import { applyPostReadFloor } from '../pipeline/select.js'

const REAL_DEPS = { runPaper, getProfile, digestProjects, triage, logEvent }

// One sentence, one period. The cap message already ends with a period; appending another
// produced "works.. They were left out". A retry that read nothing must not say "0 papers".
export function rankingFailureNote({ append = false, added = 0, message = '' } = {}) {
  const detail = String(message || 'unknown error').trim().replace(/[.]+$/, '')
  const n = Number(added) || 0
  if (append && n > 0) {
    const paper = n === 1 ? 'paper was' : 'papers were'
    const pronoun = n === 1 ? 'it' : 'them'
    return `The ${n} added ${paper} read but Claude could not score and summarize ${pronoun}: ${detail}. They were left out of the digest rather than shown unsummarized; use “Finish this digest” to retry without reading them again.`
  }
  if (append) {
    return `Claude could not score and summarize the papers already read: ${detail}. Nothing new was read. Use “Finish this digest” to retry the summaries.`
  }
  return `The papers were read and verified, but Claude could not finish their summaries: ${detail}. Your completed reading was saved; use “Finish this digest” to retry the summaries without reading the papers again.`
}

// Run a list of papers through the pipeline, then rank + summarize them. In append mode the
// existing results are kept and only papers not already in the digest are run, so topping up
// later never re-extracts the papers already done.
//
// Returns the run's outcomes as [{ id, error }] — the seen ledger needs to know which papers
// actually made it, and runPaper reports failure in its return value rather than by throwing.
// A run that was refused at entry, or went stale part-way, returns `blocked: true` with no
// outcomes: nothing it did counts as a run.
//
//   env.tickets       createContinuationTickets()
//   env.snapshot      { results, processedResults, triaged } as rendered when the run was asked for
//   env.ui            the screen's setters (setRunning, setRanking, setResults, ...)
//   env.onBegin       called once the run is admitted, before anything is cleared
//   env.persistDigest the screen's save
//   env.oaResolved    () => Map of open-access links resolved so far
//   env.titleOf       (result) => display title
//   env.deps          { runPaper, getProfile, digestProjects, triage, logEvent } (tests replace these)
export async function runAndRankDigest(papers, {
  injectCorrupt = false,
  append = false,
  forceIncludeIds = new Set(),
  baseSnapshot = null,
  suppressRunEvent = false,
} = {}, env) {
  const { tickets, snapshot, ui, persistDigest, titleOf } = env
  const deps = { ...REAL_DEPS, ...(env.deps || {}) }
  const oaResolved = env.oaResolved || (() => new Map())
  const { results, processedResults, triaged } = snapshot

  // Never for a held or stopped server digest, whichever control or queued callback asked.
  const ticket = tickets.begin()
  if (!ticket) return { outcomes: [], results, processedResults, triaged, post: null, blocked: true }
  const live = () => tickets.valid(ticket)

  const prior = append ? (baseSnapshot?.processedResults ?? processedResults) : []
  if (prior.length > PILOT_DIGEST_LIMIT) {
    ui.setScanError(LEGACY_DIGEST_LIMIT_NOTE)
    return { outcomes: [], results, processedResults, triaged, post: null, blocked: true }
  }
  env.onBegin?.()
  ui.setRunning(true)
  ui.setRestored(null)
  const base = append ? (baseSnapshot?.processedResults ?? processedResults) : []
  const baseVisible = append ? (baseSnapshot?.results ?? results) : []
  if (!append) {
    ui.setResults([])
    ui.setProcessedResults([])
    ui.setStages({})
    ui.setTriaged({})
    ui.setExpanded({})
  }
  // A stale run's stage labels would land on whatever is on screen now.
  const onStage = (id, stage) => { if (live()) ui.setStages((prev) => ({ ...prev, [id]: stage })) }

  const existingIds = new Set(base.map((r) => r.paper.id))
  const requested = papers.filter((p) => !existingIds.has(p.id))
  const toRun = fitDigestPapers(requested, base)
  if (append && requested.length && !toRun.length) {
    ui.setCapNotice(DIGEST_LIMIT_NOTE)
    ui.setRunning(false)
    return { outcomes: [], results: baseVisible, processedResults: base, triaged, post: null, blocked: true }
  }
  const collected = [...base]
  const processed = [...base]
  // What actually landed in triage — fresh runs cleared it, appends keep the old map
  // until the combined re-rank replaces it. Declared before the loop: each paper's
  // incremental persist below needs it too, so a digest already showing summaries for
  // the base papers doesn't restore looking blanker than it is.
  let triagedNow = append ? (baseSnapshot?.triaged ?? triaged) : {}
  let visible = append ? [...baseVisible] : collected
  ui.setCapNotice(toRun.length < requested.length ? DIGEST_LIMIT_NOTE : '')
  for (const paper of toRun) {
    // The digest was found held or stopped while this run was under way: read nothing more.
    if (!live()) break
    const res = await deps.runPaper(paper, { onStage })
    // Found held, stopped or replaced while this paper was being read: its result is not
    // shown and not saved. (The read itself was already sent and is not undone.)
    if (!live()) break
    if (res.error && isCapReached(res.errorObject)) {
      deps.logEvent('cap_reached', { surface: 'digest', remaining: toRun.length - processed.length })
      ui.setCapNotice(res.error)
      ui.setStages((prev) => ({ ...prev, [paper.id]: undefined }))
      break
    }
    processed.push(res)
    // Showcase only: prove the gate rejects a corrupted value on the first clean paper.
    if (injectCorrupt && !res.error && collected.every((r) => !r.corrupt)) {
      const corrupt = corruptAndReverify(res, res.sourceDoc)
      if (corrupt) res.corrupt = corrupt
    }
    // A retraction is exclusion, not a red error card. Keep it in the outcome ledger so
    // the run accounting is honest, but never place it in the visible/persisted digest.
    if (res.retracted) continue
    collected.push(res)
    ui.setProcessedResults([...collected])
    // During an append (the coverage fallback, or adding more) the new papers stay out of
    // the digest until the combined re-rank below scores them against her bar. They are
    // the weaker candidates by construction; if the summary call fails they must not
    // land at the bottom of the digest unsummarized. They are kept in processedResults,
    // so "Finish this digest" can still rank them without reading them again. A paper
    // that failed to read needs no ranking and shows its error card right away.
    if (!append) visible = [...collected]
    else if (res.error) visible = [...visible, res]
    ui.setResults([...visible])
    // Persist after EVERY paper, not just at the end of the whole run. Each extraction is
    // a paid Claude call, and a run is minutes long — if the screen sleeps mid-loop (the
    // wake lock is advisory and can fail to hold) the papers already verified must not be
    // lost. `collected` is the source of truth here, NOT the screen's `results` state —
    // setState is async and lags a render behind, so persisting through the screen's own
    // snapshot would silently drop the paper that just finished. Triage hasn't run for
    // anything newly fetched this loop, so this snapshot is honestly incomplete —
    // digestGaps/restoreNote already know how to say that on restore, and the seen ledger
    // is untouched either way (recordSeen only ever runs after the whole run finishes).
    persistDigest({
      results: withOaLinks(visible, oaResolved()),
      processedResults: withOaLinks(collected, oaResolved()),
      triaged: triagedNow,
    })
  }
  // A later run owns the busy flags once it has started; a stale run leaves them alone.
  if (tickets.latest(ticket)) ui.setRunning(false)

  const stale = () => ({ outcomes: [], results: visible, processedResults: collected, triaged: triagedNow, post: null, blocked: true })

  // Reasoning channel: one cheap call ranks the papers and writes the tier + finding +
  // relevance. Every fetched paper gets a blurb — even ones with no verified numbers
  // (reviews, methods pieces) still belong in the digest. A failure here never touches
  // the proven facts.
  // Found held or stopped during the run: no ranking call, no write, nothing recorded as a run.
  if (!live()) return stale()
  const ok = collected.filter((r) => !r.error)
  const rankedIds = new Set(Object.keys(triagedNow))
  const unranked = ok.filter((r) => !rankedIds.has(String(r.paper.id)))
  let postNow = null
  // Zero new papers to rank: papers already summarized are left as they are, and no
  // ranking call is sent.
  if (unranked.length) {
    ui.setRanking(true)
    try {
      // Each read is awaited, so the ticket is shown again after it: the digest can be found
      // held while the profile or the project list is still loading, and the ranking call
      // must not go out after that.
      const profile = await deps.getProfile()
      const projects = live() ? await deps.digestProjects(profile) : null
      const rankings = live()
        ? await deps.triage({
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
            summary: evidenceSummary(r),
            ...resultCandidate(r),
            primary: findPrimary(r.rows, (row) => isRelationshipValidated(row.verdict), verificationCorpus(r)),
            // The finding is written only from values the app verified.
            verified: r.rows
              .filter((row) => isRelationshipValidated(row.verdict))
              .map((row) => ({ name: row.quantity.name, value: fmtNum(row.quantity), quote: row.quantity.source_quote })),
          })),
        })
        : null
      // A ranking that came back after the digest was held, stopped or replaced is discarded.
      if (rankings && live()) {
        const byId = {}
        for (const rk of rankings) {
          byId[rk.id] = {
            score: rk.score,
            tier: rk.tier,
            finding: rk.finding,
            designCaution: rk.designCaution,
            relevance: rk.relevance,
            check: rk.check,
            cautionCheck: rk.cautionCheck,
            ...summaryFields(rk),
          }
        }
        ui.setTriaged(byId)
        triagedNow = byId

        // The user's minimum is a digest admission rule, not merely a pre-read cost
        // control. Reading can overturn the abstract screen; when it does, enforce the
        // better-informed score. Failed papers remain visible as failures, but a successful
        // paper below the bar is not padding in the digest.
        ui.setScanError('')
        if (!injectCorrupt) {
          const post = applyPostReadFloor(collected, byId, profile?.rubric?.scoreFloor)
          postNow = post
          const bar = post.floor
          // Every paper that was read stays on screen. The bar is a label on the card
          // and a sentence here. Removing the rest after Finish left a one-card digest
          // in place of the list (2026-10-12).
          const visibleById = new Map(collected.filter((r) => !r.retracted).map((r) => [r.paper.id, r]))
          for (const id of forceIncludeIds) {
            const forced = collected.find((r) => r.paper.id === id && !r.error && !r.retracted)
            if (forced) visibleById.set(id, forced)
          }
          visible = [...visibleById.values()]
          ui.setResults([...visible])
          ui.setProcessedResults([...collected])
          ui.setSelectedIds(new Set(visible.map((r) => r.paper.id)))
          ui.setScoreFloor(bar)
          const below = post.excluded === 1 ? 'paper is' : 'papers are'
          const stay = post.total === 1 ? 'paper stays' : 'papers stay'
          const postRead = post.total === 0
            ? ''
            : post.cleared === post.total
              ? `After reading, all ${post.total} cleared your bar of ${bar}.`
              : post.cleared
                ? `After reading, ${post.cleared} of ${post.total} cleared your bar of ${bar}. ${post.excluded} ${below} below that bar and stay in the list.`
                : `After reading, nothing cleared your bar of ${bar}. The ${post.total} read ${stay} in the list.`
          if (postRead) ui.setScanNote((prev) => prev ? `${prev} ${postRead}` : postRead)
        }
      }
    } catch (err) {
      console.warn('Triage failed (facts unaffected):', err.message)
      // A stale run's failure is not this screen's news either.
      if (live()) {
        ui.setScanError(rankingFailureNote({ append, added: toRun.length, message: err?.message }))
      }
    }
    if (tickets.latest(ticket)) ui.setRanking(false)
    // Found held, stopped or replaced while ranking: no write, nothing recorded as a run.
    if (!live()) return stale()
  }
  // Persist so a tab switch (which unmounts the screen) never costs a re-run. This is the
  // ONE write a run makes, so `collected` has to carry the open-access links that resolved
  // while it was building — it predates those patches, hence the merge.
  persistDigest({
    results: withOaLinks(visible, oaResolved()),
    processedResults: withOaLinks(collected, oaResolved()),
    triaged: triagedNow,
  })
  // Adoption telemetry: one row per completed run. `showcase` marks the keyless demo
  // trials, `append` the add-more path — both would otherwise inflate real-run counts.
  if (!suppressRunEvent) {
    deps.logEvent('digest_run', {
      papers: visible.length,
      processed: processed.length,
      errors: collected.filter((r) => r.error).length,
      append: !!append,
      showcase: !!injectCorrupt,
    })
  }
  return {
    outcomes: processed.map((r) => ({ id: r.paper.id, error: r.error })),
    results: visible,
    processedResults: collected,
    triaged: triagedNow,
    post: postNow,
  }
}
