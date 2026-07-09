// components/SpineCheck.jsx — the spine-day test oracle, made demoable.
//
// Runs the REAL pipeline on the demo corpus live (fetch -> extract -> verify) and shows
// each proven value with its badge, plus a deliberately corrupted value that the gate
// flags. This is the "cool to watch" 45s of the demo video.

import { useEffect, useState } from 'react'
import { hasApiKey } from '../lib/anthropic.js'
import { getProfile, store } from '../lib/store.js'
import { DEMO_PAPERS, runPaper, corruptAndReverify, searchCandidates } from '../pipeline/pipeline.js'
import { triage } from '../pipeline/triage.js'
import { selectCandidates } from '../pipeline/select.js'
import { filePaper, synthesizeGroup } from '../pipeline/deposit.js'
import { resolveOaPdf } from '../pipeline/openaccess.js'
import { depositPaperToLibrary } from '../lib/library.js'
import ProvenanceBadge from './ProvenanceBadge.jsx'
import SourceViewer from './SourceViewer.jsx'

const STAGE_LABEL = {
  fetching: 'Fetching source…',
  extracting: 'Extracting (Claude)…',
  verifying: 'Verifying…',
  done: 'Done',
  error: 'Error',
}

function fmtNum(q) {
  if (q.value == null) return ''
  let s = String(q.value)
  if (q.unit) s += ` ${q.unit}`
  if (q.ci_low != null && q.ci_high != null) s += ` (CI ${q.ci_low}–${q.ci_high})`
  if (q.p_value != null) s += `, P=${q.p_value}`
  return s
}

const TIER_STYLE = {
  1: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  2: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300',
  3: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
}

function TierBadge({ tier }) {
  if (!tier) return null
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ${TIER_STYLE[tier] || TIER_STYLE[3]}`}>
      Tier {tier}
    </span>
  )
}

// The citation line — authors · journal · year · clickable PMID, plus the "citation
// verified" mark (the app confirmed the PMID resolves to a real indexed paper).
function Citation({ citation }) {
  if (!citation) return null
  const bits = [citation.author, citation.journal, citation.year].filter(Boolean).join(' · ')
  return (
    <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
      {bits && <span>{bits} · </span>}
      <a
        href={citation.url}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-sky-700 hover:underline dark:text-sky-300"
      >
        PMID {citation.pmid} ↗
      </a>
      {citation.verified && (
        <span className="ml-2 inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> citation verified
        </span>
      )}
    </p>
  )
}

function Row({ quantity, verdict, onOpenSource, hero }) {
  const clickable = verdict.found && onOpenSource
  return (
    <div className="flex flex-col gap-1 border-t border-slate-100 py-3 dark:border-slate-800">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className={hero ? 'font-semibold' : 'font-medium'}>{quantity.name}</span>
        {clickable ? (
          <button
            onClick={onOpenSource}
            title="Show this value in the source"
            className={`tabular-nums font-semibold text-sky-700 underline decoration-dotted underline-offset-4 hover:decoration-solid dark:text-sky-300 ${hero ? 'text-lg' : ''}`}
          >
            {fmtNum(quantity)}
          </button>
        ) : (
          <span className={`tabular-nums text-slate-700 dark:text-slate-300 ${hero ? 'text-lg font-semibold' : ''}`}>
            {fmtNum(quantity)}
          </span>
        )}
        <ProvenanceBadge tier={verdict.tier} />
      </div>
      {quantity.source_quote && (
        <blockquote className="border-l-2 border-slate-200 pl-3 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
          “{quantity.source_quote}”
          {quantity.location_hint ? <span className="not-italic"> — {quantity.location_hint}</span> : null}
        </blockquote>
      )}
      {verdict.flagged && (
        <p className="text-xs text-rose-600 dark:text-rose-400">{verdict.reason}</p>
      )}
    </div>
  )
}

// Score → chip color. Just a visual bucket; the number is the real signal.
function scoreChip(score) {
  if (score >= 70) return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
  if (score >= 40) return 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300'
  return 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
}

// The selection funnel surface: the wide candidate pool ranked by rubric fit, with the top
// N pre-checked. The clinician confirms/adjusts the selection, then runs the digest on only
// those — mirroring the ~50-candidates → ~10-kept step of a hand-run morning review. Once a
// digest exists the pool COLLAPSES (the digest is the centerpiece); reopening it lets you
// check more papers and top up the digest later WITHOUT re-running the ones already done —
// only the newly-checked papers go through the pipeline and append to the existing digest.
function CandidatePool({
  candidates,
  selectedIds,
  digestedIds,
  open,
  onToggleOpen,
  onToggle,
  onRunDigest,
  onAddToDigest,
  onRescore,
  selecting,
  running,
}) {
  const hasDigest = digestedIds.size > 0
  const chosen = candidates.filter((c) => selectedIds.has(c.id)).length
  // papers checked but not yet run — the incremental additions.
  const pending = candidates.filter((c) => selectedIds.has(c.id) && !digestedIds.has(c.id)).length
  const available = candidates.filter((c) => !digestedIds.has(c.id)).length

  return (
    <div className="mt-5 rounded-lg border border-indigo-200 bg-indigo-50/40 p-4 dark:border-indigo-900/50 dark:bg-indigo-950/20">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-indigo-900 dark:text-indigo-200">
            Selection funnel — {candidates.length} candidates
            {hasDigest ? `, ${digestedIds.size} in digest` : `, ${chosen} selected`}
          </h3>
          <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-400">
            {hasDigest
              ? open
                ? 'Check any others to add them to the digest — only the new ones run; the rest stay as they are.'
                : `${available} more paper${available === 1 ? '' : 's'} available — open the list to add any without re-running the digest.`
              : 'Every recent match, ranked against your rubric. The top papers are pre-selected; adjust below, then run the digest on just those.'}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <button
            onClick={onToggleOpen}
            className="rounded-lg border border-indigo-300 px-3 py-2 text-xs font-medium text-indigo-800 hover:bg-indigo-100 dark:border-indigo-800 dark:text-indigo-200 dark:hover:bg-indigo-900/40"
          >
            {open ? '▾ Hide list' : `▸ Show all ${candidates.length}`}
          </button>
          {open && (
            <button
              onClick={onRescore}
              disabled={selecting || running}
              title="Re-score this same pool against your current rubric — no new search"
              className="rounded-lg border border-indigo-300 px-3 py-2 text-xs font-medium text-indigo-800 hover:bg-indigo-100 disabled:opacity-50 dark:border-indigo-800 dark:text-indigo-200 dark:hover:bg-indigo-900/40"
            >
              {selecting ? 'Re-ranking…' : 'Re-rank with current rubric'}
            </button>
          )}
          {open &&
            (hasDigest ? (
              <button
                onClick={onAddToDigest}
                disabled={!pending || selecting || running}
                className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {running ? 'Adding…' : pending ? `Add ${pending} to digest` : 'Add to digest'}
              </button>
            ) : (
              <button
                onClick={onRunDigest}
                disabled={!chosen || selecting || running}
                className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {running ? 'Running…' : `Run digest on ${chosen} selected`}
              </button>
            ))}
        </div>
      </div>

      {open && (
        <ol className="mt-3 max-h-96 space-y-1.5 overflow-y-auto pr-1">
          {candidates.map((c, i) => {
            const inDigest = digestedIds.has(c.id)
            const picked = inDigest || selectedIds.has(c.id)
            const types = (c.pubtypes || []).filter((t) => t && t !== 'Journal Article').join(' · ')
            return (
              <li
                key={c.id}
                className={`flex items-start gap-3 rounded-md border p-2.5 ${
                  inDigest
                    ? 'border-emerald-300 bg-white dark:border-emerald-800/70 dark:bg-slate-900'
                    : picked
                      ? 'border-indigo-300 bg-white dark:border-indigo-700 dark:bg-slate-900'
                      : 'border-transparent bg-white/50 opacity-70 dark:bg-slate-900/40'
                }`}
              >
                <label className={`flex items-center pt-0.5 ${inDigest ? 'cursor-default' : 'cursor-pointer'}`}>
                  <input
                    type="checkbox"
                    checked={picked}
                    disabled={inDigest || running}
                    onChange={() => onToggle(c.id)}
                    title={inDigest ? 'Already in the digest' : undefined}
                    className={`h-4 w-4 ${inDigest ? 'accent-emerald-600' : 'accent-indigo-600'}`}
                  />
                </label>
                <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[11px] font-bold tabular-nums ${scoreChip(c.score)}`}>
                  {c.score}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium leading-snug text-slate-800 dark:text-slate-100">
                    <span className="text-slate-400">{i + 1}.</span> {c.title}
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {[c.journal, c.year].filter(Boolean).join(' · ')}
                    {types && <span className="text-slate-400"> · {types}</span>}
                  </p>
                  {c.reason && <p className="mt-0.5 text-xs italic text-slate-500 dark:text-slate-400">{c.reason}</p>}
                </div>
                {inDigest && (
                  <span className="mt-0.5 shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                    in digest
                  </span>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}

export default function SpineCheck() {
  const [running, setRunning] = useState(false)
  const [searching, setSearching] = useState(false)
  const [selecting, setSelecting] = useState(false) // selection funnel LLM call in flight
  const [candidates, setCandidates] = useState([]) // scored candidate pool (funnel output)
  const [selectedIds, setSelectedIds] = useState(() => new Set()) // ids chosen for the digest
  const [poolOpen, setPoolOpen] = useState(false) // funnel is a disclosure — collapsed by default
  const [scanError, setScanError] = useState('')
  const [stages, setStages] = useState({})
  const [results, setResults] = useState([]) // runPaper results (live or showcase)
  const [triaged, setTriaged] = useState({}) // id -> { score, tier, finding, relevance }
  const [ranking, setRanking] = useState(false)
  const [expanded, setExpanded] = useState({}) // id -> bool: show verified values
  const [viewer, setViewer] = useState(null) // { title, corpusLabel, corpusText, quote, valueLabel }
  const [savedIds, setSavedIds] = useState(() => new Set()) // ids deposited to the Knowledge Base
  const keySet = hasApiKey()

  const titleOf = (res) => res.paper.title || res.citation?.title || `PMID ${res.paper.pmid}`

  // Load which papers are already in the Knowledge Base (persisted in IndexedDB).
  useEffect(() => {
    store.all('papers').then((papers) => setSavedIds(new Set((papers || []).map((p) => p.id))))
  }, [])

  // Deposit / withdraw a paper to the Knowledge Base — the citation, finding, relevance, the
  // app-verified numbers, and the FULL fetched source text (no longer truncated), persisted
  // locally. The save is instant; Claude auto-classifies the domain + topic tags in the
  // background (she prunes later) and the record is patched when they arrive.
  async function toggleSave(res, take, verifiedRows, title) {
    const id = res.paper.id
    if (savedIds.has(id)) {
      await store.delete('papers', id)
      setSavedIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      return
    }
    const record = {
      id,
      pmid: res.paper.pmid,
      title,
      citation: res.citation || null,
      tier: take?.tier ?? null,
      finding: take?.finding ?? '',
      relevance: take?.relevance ?? '',
      quantities: verifiedRows.map((r) => ({ ...r.quantity, tier: r.verdict.tier })),
      fullText: res.sourceDoc?.text || '', // untruncated (was sliced to 6000)
      tables: res.sourceDoc?.tables || '',
      pdfUrl: null, // resolved to an open-access LINK via Unpaywall in the background (the old PMC
      // template link 404s since NCBI's host migration; byte-download is CORS-blocked anyway)
      domain: null, // one of the 6 domain keys — filled by the background analyze (colors the node)
      tags: [],
      conceptId: null, // the concept node it's filed under
      notes: '', // clinician's own notes — editable in the KB view
      savedAt: new Date().toISOString(),
    }
    await store.put('papers', id, record)
    setSavedIds((prev) => new Set(prev).add(id))

    // Background: file the paper under a topic concept (classified into one of the 6 domains),
    // then re-synthesize that concept's summary. Shared with the "re-file" action via
    // pipeline/deposit.js. Never blocks the save.
    ;(async () => {
      try {
        const res = await filePaper(record)
        if (res?.groupId) await synthesizeGroup(res.groupId)
      } catch (err) {
        console.warn('Concept filing failed (paper still saved):', err.message)
      }
      // Resolve a legal open-access PDF LINK via Unpaywall (DOI → best OA pdf url) and patch it on.
      // Null when there's no DOI or no OA copy — behaves as before. A link, not a fetched file: the
      // bytes are CORS-blocked, but the clinician can open the link in their own browser.
      try {
        const doi = record.citation?.doi
        if (doi) {
          const oaPdf = await resolveOaPdf(doi)
          if (oaPdf) {
            const cur = await store.get('papers', id)
            if (cur) await store.put('papers', id, { ...cur, pdfUrl: oaPdf })
          }
        }
      } catch (err) {
        console.warn('OA PDF resolve failed (paper still saved):', err.message)
      }
      // If a flat-file library is connected, write the source note (+ its concept) to disk. Re-fetch
      // so conceptId (patched by filePaper) and pdfUrl (patched above) are on the record we deposit.
      // No-op when no folder is connected; never allowed to affect the save.
      try {
        const filed = await store.get('papers', id)
        if (filed) await depositPaperToLibrary(filed)
      } catch (err) {
        console.warn('Library deposit failed (paper still saved):', err.message)
      }
    })()
  }

  // Open the source panel for a located quote, picking the corpus (prose/table) it
  // matched against so the highlight lands in the right text.
  function openSource(quantity, verdict, sourceDoc, paperTitle) {
    const corpusLabel = verdict.matched?.corpus || 'prose'
    const corpusText = corpusLabel === 'tables' ? sourceDoc.tables : sourceDoc.text
    setViewer({
      title: paperTitle,
      corpusLabel,
      corpusText,
      quote: quantity.source_quote,
      valueLabel: fmtNum(quantity),
    })
  }

  // Run a list of papers through the pipeline, then rank + summarize them. Shared by the
  // live scan, the reference-proof showcase, and incremental "add to digest". In append mode
  // we keep the existing results and only run papers not already in the digest — so topping
  // up later never re-extracts (the expensive Opus step) the papers already done.
  async function runList(papers, { injectCorrupt = false, append = false } = {}) {
    setRunning(true)
    const base = append ? results : []
    if (!append) {
      setResults([])
      setStages({})
      setTriaged({})
      setExpanded({})
    }
    const onStage = (id, stage) => setStages((prev) => ({ ...prev, [id]: stage }))

    const existingIds = new Set(base.map((r) => r.paper.id))
    const toRun = papers.filter((p) => !existingIds.has(p.id))
    const collected = [...base]
    for (const paper of toRun) {
      const res = await runPaper(paper, { onStage })
      // Showcase only: prove the gate rejects a corrupted value on the first clean paper.
      if (injectCorrupt && !res.error && collected.every((r) => !r.corrupt)) {
        const corrupt = corruptAndReverify(res, res.sourceDoc)
        if (corrupt) res.corrupt = corrupt
      }
      collected.push(res)
      setResults([...collected])
    }
    setRunning(false)

    // Reasoning channel: one cheap call ranks the papers and writes the tier + finding +
    // relevance. Every fetched paper gets a blurb — even ones with no verified numbers
    // (reviews, methods pieces) still belong in the digest. A failure here never touches
    // the proven facts.
    const ok = collected.filter((r) => !r.error)
    if (ok.length) {
      setRanking(true)
      try {
        const profile = await getProfile()
        const rankings = await triage({
          northStars: profile?.northStars ?? [],
          projects: profile?.projects ?? [],
          rubric: profile?.rubric?.criteria ?? '',
          candidates: ok.map((r) => ({
            id: r.paper.id,
            title: titleOf(r),
            design: r.design,
            summary: r.sourceDoc?.text || '',
            // The finding is written only from values the app verified.
            verified: r.rows
              .filter((row) => !row.verdict.flagged)
              .map((row) => ({ name: row.quantity.name, value: fmtNum(row.quantity) })),
          })),
        })
        const byId = {}
        for (const rk of rankings) {
          byId[rk.id] = { score: rk.score, tier: rk.tier, finding: rk.finding, relevance: rk.relevance }
        }
        setTriaged(byId)
      } catch (err) {
        console.warn('Triage failed (facts unaffected):', err.message)
      }
      setRanking(false)
    }
  }

  // Score a candidate pool against the current rubric and pre-check the top N. Shared by
  // the initial scan and the re-rank button. `pool` is candidate stubs (metadata only).
  async function scorePool(pool) {
    const profile = await getProfile()
    const scored = await selectCandidates({
      rubric: profile?.rubric?.criteria ?? '',
      northStars: profile?.northStars ?? [],
      projects: profile?.projects ?? [],
      candidates: pool,
    })
    setCandidates(scored)
    const n = profile?.rubric?.selectCount ?? 10
    const chosenIds = new Set(scored.slice(0, n).map((c) => c.id))
    setSelectedIds(chosenIds)
    return { scored, chosenIds }
  }

  // The product loop, in ONE click: search PubMed WIDE → score every candidate against the
  // rubric (metadata only) → run the digest immediately on the rubric's top picks. The
  // selection funnel stays collapsed underneath the digest — open it to adjust the picks,
  // re-rank against an edited rubric, or top up. The daily user never has to touch it.
  async function startScan() {
    setScanError('')
    setResults([])
    setTriaged({})
    setCandidates([])
    setPoolOpen(false) // digest is the centerpiece; the funnel is a disclosure underneath
    setSearching(true)
    let pool = []
    try {
      const profile = await getProfile()
      pool = await searchCandidates({ northStars: profile?.northStars ?? [], retmax: 40, days: 90 })
    } catch (err) {
      setScanError(`PubMed search failed: ${err.message}`)
      setSearching(false)
      return
    }
    setSearching(false)
    if (!pool.length) {
      setScanError('No recent papers matched your north stars — broaden them or widen the window.')
      return
    }
    setSelecting(true)
    let scored, chosenIds
    try {
      ;({ scored, chosenIds } = await scorePool(pool))
    } catch (err) {
      setScanError(`Selection failed: ${err.message}`)
      setSelecting(false)
      return
    }
    setSelecting(false)
    // Auto-run the digest on the top picks — one button, digest pops.
    const chosen = scored.filter((c) => chosenIds.has(c.id))
    if (chosen.length) await runList(chosen, { injectCorrupt: false })
  }

  // Live re-rank: re-score the SAME cached pool against the (edited) rubric — no re-fetch,
  // no extraction. This is the cheap rubric-swing: edit the rubric above, watch it re-order.
  async function rescore() {
    if (!candidates.length || selecting) return
    setSelecting(true)
    setScanError('')
    try {
      await scorePool(candidates.map(({ score, reason, ...c }) => c)) // strip old scores
    } catch (err) {
      setScanError(`Re-rank failed: ${err.message}`)
    }
    setSelecting(false)
  }

  // The product loop, step 2: run the verify pipeline on ONLY the selected candidates,
  // then rank + summarize them. This is where the (expensive) extraction happens. Once it's
  // done the funnel collapses so the digest itself is the centerpiece.
  async function runDigest() {
    const chosen = candidates.filter((c) => selectedIds.has(c.id))
    if (!chosen.length) return
    await runList(chosen, { injectCorrupt: false })
    setPoolOpen(false)
  }

  // Top up an existing digest: run ONLY the newly-checked candidates and append them, then
  // re-rank the combined set. The papers already in the digest are never re-run.
  async function addToDigest() {
    const digested = new Set(results.map((r) => r.paper.id))
    const additions = candidates.filter((c) => selectedIds.has(c.id) && !digested.has(c.id))
    if (!additions.length) return
    await runList(additions, { append: true })
  }

  function toggleCandidate(id) {
    // Papers already in the digest are locked in — you add more, you don't uncheck done work.
    if (results.some((r) => r.paper.id === id)) return
    setSelectedIds((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  // Proof surface: the three reference trials, always demonstrating the hard guarantees
  // (registry match, the corruption catch) deterministically.
  async function runShowcase() {
    setScanError('')
    setCandidates([])
    await runList(DEMO_PAPERS, { injectCorrupt: true })
  }

  // Order the digest by relevance to the north stars (highest first).
  const ordered = [...results].sort(
    (a, b) => (triaged[b.paper.id]?.score ?? -1) - (triaged[a.paper.id]?.score ?? -1),
  )
  // Which candidates are already in the digest (locked in; can't be re-run, only added to).
  const digestedIds = new Set(results.map((r) => r.paper.id))

  return (
    <section className="mt-8 rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium">Today's digest</h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            A live search of recent literature on your north stars — each headline verified
            against the source (abstract, or full text when open-access), or flagged.
          </p>
          {savedIds.size > 0 && (
            <p className="mt-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
              {savedIds.size} paper{savedIds.size === 1 ? '' : 's'} in your Library
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            onClick={runShowcase}
            disabled={!keySet || running || searching || selecting}
            title="Three reference trials that demonstrate the verifier's guarantees"
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            Verifier proof
          </button>
          <button
            onClick={startScan}
            disabled={!keySet || running || searching || selecting}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
          >
            {searching ? 'Searching…' : selecting ? 'Scoring…' : running ? 'Building digest…' : "Run today's digest"}
          </button>
        </div>
      </div>
      {!keySet && (
        <p className="mt-3 text-sm text-amber-600 dark:text-amber-400">Set your API key above first.</p>
      )}
      {searching && (
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">Searching PubMed wide for recent papers…</p>
      )}
      {selecting && (
        <p className="mt-3 text-sm text-indigo-600 dark:text-indigo-300">
          Claude is scoring every candidate against your rubric…
        </p>
      )}
      {scanError && <p className="mt-3 text-sm text-rose-600 dark:text-rose-400">{scanError}</p>}
      {ranking && (
        <p className="mt-3 text-sm text-indigo-600 dark:text-indigo-300">
          Claude is ranking and summarizing against your steering profile…
        </p>
      )}
      {!running && !searching && !selecting && !ranking && results.length === 0 && candidates.length === 0 && !scanError && (
        <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
          Run today's digest — Verastar searches recent literature, scores it against your rubric,
          and verifies the top papers into a digest. Or hit “Verifier proof” to see the guarantees
          on three reference trials.
        </p>
      )}

      {/* The selection funnel: the wide candidate pool, scored against the rubric, with the
          top N pre-checked. This is the ~50-candidates → ~10-selected step, on screen. */}
      {candidates.length > 0 && (
        <CandidatePool
          candidates={candidates}
          selectedIds={selectedIds}
          digestedIds={digestedIds}
          open={poolOpen}
          onToggleOpen={() => setPoolOpen((o) => !o)}
          onToggle={toggleCandidate}
          onRunDigest={runDigest}
          onAddToDigest={addToDigest}
          onRescore={rescore}
          selecting={selecting}
          running={running}
        />
      )}

      <div className="mt-5 space-y-5">
        {ordered.map((res, idx) => {
          const paper = res.paper
          const stage = stages[paper.id]
          const take = triaged[paper.id]
          const title = titleOf(res)
          const verifiedRows = !res.error ? res.rows.filter((r) => !r.verdict.flagged) : []
          const heroRow = verifiedRows[0] || null
          return (
            <div key={paper.id} className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
              {/* Header — tier · rank · title · citation (the digest line). */}
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    {take && (
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white dark:bg-slate-100 dark:text-slate-900">
                        {idx + 1}
                      </span>
                    )}
                    <TierBadge tier={take?.tier} />
                    <h3 className="font-semibold leading-snug">{title}</h3>
                  </div>
                  <Citation citation={res.citation} />
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {stage && stage !== 'done' && (
                    <span className="text-sm text-slate-500 dark:text-slate-400">{STAGE_LABEL[stage]}</span>
                  )}
                  {!res.error && (
                    <label className="flex cursor-pointer items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100">
                      <input
                        type="checkbox"
                        checked={savedIds.has(paper.id)}
                        onChange={() => toggleSave(res, take, verifiedRows, title)}
                        className="h-4 w-4 accent-emerald-600"
                      />
                      {savedIds.has(paper.id) ? 'Saved' : 'Save to Library'}
                    </label>
                  )}
                </div>
              </div>

              {/* Relevance to the clinician's projects — italic, number-free. */}
              {take?.relevance && (
                <p className="mt-2 text-sm italic text-slate-600 dark:text-slate-400">{take.relevance}</p>
              )}

              {/* The finding — what the study showed, in prose, written only from verified
                  values. "grounded in source" opens the sentence it rests on. */}
              {take?.finding && (
                <p className="mt-1.5 text-[15px] leading-6 text-slate-800 dark:text-slate-200">
                  {take.finding}{' '}
                  {heroRow && (
                    <button
                      onClick={() => openSource(heroRow.quantity, heroRow.verdict, res.sourceDoc, title)}
                      className="whitespace-nowrap text-xs font-medium text-emerald-600 hover:underline dark:text-emerald-400"
                    >
                      grounded in source ↗
                    </button>
                  )}
                </p>
              )}

              {res?.error && (
                <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">Error: {res.error}</p>
              )}

              {res &&
                !res.error &&
                (() => {
                  const flaggedRows = res.rows.filter((r) => r.verdict.flagged)
                  const isOpen = !!expanded[paper.id]
                  const total = verifiedRows.length
                  // No numeric results (review / methods piece) — the finding + citation
                  // carry the card, like a hand-written digest entry.
                  if (res.rows.length === 0 && !res.corrupt) return null
                  return (
                    <div className="mt-3">
                      {/* Numbers demoted — the verifier is the engine, not the dashboard. */}
                      <button
                        onClick={() => setExpanded((p) => ({ ...p, [paper.id]: !isOpen }))}
                        className="text-sm font-medium text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100"
                      >
                        {isOpen
                          ? '▾ Hide verified evidence'
                          : `▸ Show verified evidence (${total} value${total === 1 ? '' : 's'})`}
                      </button>

                      {isOpen && (
                        <div className="mt-2 rounded-md border border-slate-100 bg-slate-50/70 px-3 pb-2 dark:border-slate-800 dark:bg-slate-950/40">
                          <p className="pt-2 text-[11px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                            Every value re-verified against the source — click any to see it
                          </p>
                          {verifiedRows.map((row, i) => (
                            <Row
                              key={i}
                              quantity={row.quantity}
                              verdict={row.verdict}
                              hero={i === 0}
                              onOpenSource={() => openSource(row.quantity, row.verdict, res.sourceDoc, title)}
                            />
                          ))}

                          {flaggedRows.length > 0 && (
                            <div className="mt-2">
                              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                                {flaggedRows.length} value{flaggedRows.length === 1 ? '' : 's'} flagged — greyed, never charted
                              </p>
                              {flaggedRows.map((row, i) => (
                                <Row
                                  key={i}
                                  quantity={row.quantity}
                                  verdict={row.verdict}
                                  onOpenSource={() => openSource(row.quantity, row.verdict, res.sourceDoc, title)}
                                />
                              ))}
                            </div>
                          )}

                          {res.corrupt && (
                            <div className="mt-3 rounded-md bg-rose-50 p-3 dark:bg-rose-950/30">
                              <p className="text-xs font-medium text-rose-700 dark:text-rose-300">
                                Corruption test — value {res.corrupt.original} nudged to {res.corrupt.quantity.value}:
                              </p>
                              <Row
                                quantity={res.corrupt.quantity}
                                verdict={res.corrupt.verdict}
                                onOpenSource={() =>
                                  openSource(res.corrupt.quantity, res.corrupt.verdict, res.sourceDoc, title)
                                }
                              />
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })()}
            </div>
          )
        })}
      </div>

      <SourceViewer
        open={viewer !== null}
        onClose={() => setViewer(null)}
        title={viewer?.title}
        corpusLabel={viewer?.corpusLabel}
        corpusText={viewer?.corpusText}
        quote={viewer?.quote}
        valueLabel={viewer?.valueLabel}
      />
    </section>
  )
}
