// components/SpineCheck.jsx — the spine-day test oracle, made demoable.
//
// Runs the REAL pipeline on the demo corpus live (fetch -> extract -> verify) and shows
// each proven value with its badge, plus a deliberately corrupted value that the gate
// flags. This is the "cool to watch" 45s of the demo video.

import { useEffect, useRef, useState } from 'react'
import { hasApiKey } from '../lib/anthropic.js'
import { getProfile, store } from '../lib/store.js'
import { saveDailyDigest, loadDailyDigest, clearDailyDigest } from '../lib/digestStore.js'
import { DEMO_PAPERS, runPaper, corruptAndReverify, searchCandidates } from '../pipeline/pipeline.js'
import { triage } from '../pipeline/triage.js'
import { selectCandidates } from '../pipeline/select.js'
import { savePaper } from '../pipeline/save.js'
import { resolveOaLink } from '../pipeline/openaccess.js'
import { fmtNum } from '../lib/format.js'
import ProvenanceBadge from './ProvenanceBadge.jsx'
import SourceViewer from './SourceViewer.jsx'

const STAGE_LABEL = {
  fetching: 'Fetching source…',
  extracting: 'Extracting (Claude)…',
  verifying: 'Verifying…',
  done: 'Done',
  error: 'Error',
}

// Verification tier → the card's provenance chip. Mirrors the observatory design:
// full text (green), registry (blue), abstract (amber). tier comes from triage.
const TIER_CHIP = {
  1: { label: 'Verified · full text', dot: 'var(--color-verified)', text: 'var(--color-verified-soft)', bg: 'rgba(127,191,154,.14)' },
  2: { label: 'Verified · registry', dot: 'var(--color-registry)', text: 'var(--color-registry-soft)', bg: 'rgba(143,189,230,.15)' },
  3: { label: 'Verified · abstract', dot: 'var(--color-abstract)', text: 'var(--color-abstract)', bg: 'rgba(230,184,119,.14)' },
}

function TierChip({ tier }) {
  const t = TIER_CHIP[tier]
  if (!t) return null
  return (
    <span className="inline-flex items-center" style={{ gap: 6, padding: '4px 10px', borderRadius: 999, background: t.bg, color: t.text, fontSize: 11.5, fontWeight: 600 }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: t.dot, boxShadow: `0 0 6px ${t.dot}` }} />
      {t.label}
    </span>
  )
}

// The citation line — authors · journal · year · clickable PMID, in mono, with the
// "citation verified" mark (the app confirmed the PMID resolves to a real indexed paper)
// and, when Unpaywall found one, the free-full-text link — the digest workflow is
// read-the-paper-first, so the link belongs here, before Save.
function Citation({ citation, oa }) {
  if (!citation) return null
  const bits = [citation.author, citation.journal, citation.year].filter(Boolean).join(' · ')
  return (
    <p style={{ margin: '7px 0 0', fontSize: 13, color: 'var(--color-fg-muted)', fontFamily: 'var(--font-mono)' }}>
      {bits && <span>{bits} · </span>}
      <a href={citation.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-accent)' }}>
        PMID {citation.pmid} ↗
      </a>
      {oa?.url && (
        <a href={oa.url} target="_blank" rel="noopener noreferrer" style={{ marginLeft: 8, color: 'var(--color-accent)' }}>
          {oa.isPdf ? 'PDF ↗' : 'Free full text ↗'}
        </a>
      )}
      {citation.verified && (
        <span className="inline-flex items-center" style={{ marginLeft: 8, gap: 5, color: 'var(--color-verified-soft)' }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--color-verified)' }} /> citation verified
        </span>
      )}
    </p>
  )
}

function Row({ quantity, verdict, onOpenSource, hero }) {
  const clickable = verdict.found && onOpenSource
  return (
    <div className="flex flex-col" style={{ gap: 4, borderTop: '1px solid var(--hairline)', padding: '12px 0' }}>
      <div className="flex flex-wrap items-center" style={{ columnGap: 12, rowGap: 4 }}>
        <span style={{ fontWeight: hero ? 600 : 500, color: 'var(--color-fg-soft)' }}>{quantity.name}</span>
        {clickable ? (
          <button
            onClick={onOpenSource}
            title="Show this value in the source"
            className="cursor-pointer"
            style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--color-fg)', borderBottom: '1px dotted rgba(239,143,91,.55)', fontSize: hero ? 17 : 14 }}
          >
            {fmtNum(quantity)}
          </button>
        ) : (
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-fg-dim)', fontSize: hero ? 17 : 14, fontWeight: hero ? 600 : 400 }}>
            {fmtNum(quantity)}
          </span>
        )}
        <ProvenanceBadge tier={verdict.tier} />
      </div>
      {quantity.source_quote && (
        <blockquote style={{ margin: 0, borderLeft: '2px solid var(--hairline)', paddingLeft: 12, fontSize: 13, color: 'var(--color-fg-muted)' }}>
          “{quantity.source_quote}”
          {quantity.location_hint ? <span> — {quantity.location_hint}</span> : null}
        </blockquote>
      )}
      {verdict.flagged && <p style={{ margin: 0, fontSize: 12, color: 'var(--color-domain-vascular)' }}>{verdict.reason}</p>}
    </div>
  )
}

// Score → chip color. Just a visual bucket; the number is the real signal.
function scoreChip(score) {
  if (score >= 70) return { bg: 'rgba(127,191,154,.14)', color: 'var(--color-verified-soft)' }
  if (score >= 40) return { bg: 'rgba(143,189,230,.15)', color: 'var(--color-registry-soft)' }
  return { bg: 'rgba(255,255,255,.05)', color: 'var(--color-fg-muted)' }
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

  const ghostBtn = { borderRadius: 9, padding: '8px 12px', fontSize: 12, fontWeight: 500, fontFamily: 'inherit', border: '1px solid rgba(255,255,255,.12)', background: 'transparent', color: 'var(--color-fg-soft)', cursor: 'pointer' }
  const accentBtn = { borderRadius: 9, padding: '8px 12px', fontSize: 12, fontWeight: 600, fontFamily: 'inherit', border: 0, background: 'var(--color-accent)', color: '#1c1206', cursor: 'pointer' }

  return (
    <div style={{ marginTop: 20, borderRadius: 14, border: '1px solid var(--hairline)', background: 'var(--surface-1)', padding: 18 }}>
      <div className="flex flex-wrap items-start justify-between" style={{ gap: 12 }}>
        <div className="min-w-0">
          <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--color-fg-soft)' }}>
            Selection funnel — {candidates.length} candidates
            {hasDigest ? `, ${digestedIds.size} in digest` : `, ${chosen} selected`}
          </h3>
          <p style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--color-fg-muted)', lineHeight: 1.5, maxWidth: 560 }}>
            {hasDigest
              ? open
                ? 'Check any others to add them to the digest — only the new ones run; the rest stay as they are.'
                : `${available} more paper${available === 1 ? '' : 's'} available — open the list to add any without re-running the digest.`
              : 'Every recent match, ranked against your rubric. The top papers are pre-selected; adjust below, then run the digest on just those.'}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end" style={{ gap: 8 }}>
          <button onClick={onToggleOpen} style={ghostBtn}>
            {open ? '▾ Hide list' : `▸ Show all ${candidates.length}`}
          </button>
          {open && (
            <button onClick={onRescore} disabled={selecting || running} title="Re-score this same pool against your current rubric — no new search" style={{ ...ghostBtn, opacity: selecting || running ? 0.5 : 1 }}>
              {selecting ? 'Re-ranking…' : 'Re-rank with current rubric'}
            </button>
          )}
          {open &&
            (hasDigest ? (
              <button onClick={onAddToDigest} disabled={!pending || selecting || running} style={{ ...accentBtn, opacity: !pending || selecting || running ? 0.5 : 1 }}>
                {running ? 'Adding…' : pending ? `Add ${pending} to digest` : 'Add to digest'}
              </button>
            ) : (
              <button onClick={onRunDigest} disabled={!chosen || selecting || running} style={{ ...accentBtn, opacity: !chosen || selecting || running ? 0.5 : 1 }}>
                {running ? 'Running…' : `Run digest on ${chosen} selected`}
              </button>
            ))}
        </div>
      </div>

      {open && (
        <ol className="overflow-y-auto" style={{ marginTop: 12, maxHeight: 384, listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {candidates.map((c, i) => {
            const inDigest = digestedIds.has(c.id)
            const picked = inDigest || selectedIds.has(c.id)
            const types = (c.pubtypes || []).filter((t) => t && t !== 'Journal Article').join(' · ')
            const sc = scoreChip(c.score)
            return (
              <li
                key={c.id}
                className="flex items-start"
                style={{
                  gap: 12,
                  borderRadius: 10,
                  padding: 10,
                  border: `1px solid ${inDigest ? 'rgba(127,191,154,.4)' : picked ? 'rgba(239,143,91,.4)' : 'transparent'}`,
                  background: picked ? 'var(--surface-1)' : 'rgba(255,255,255,.015)',
                  opacity: picked ? 1 : 0.7,
                }}
              >
                <label className="flex items-center" style={{ paddingTop: 2, cursor: inDigest ? 'default' : 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={picked}
                    disabled={inDigest || running}
                    onChange={() => onToggle(c.id)}
                    title={inDigest ? 'Already in the digest' : undefined}
                    style={{ width: 16, height: 16, accentColor: inDigest ? '#7fbf9a' : '#ef8f5b' }}
                  />
                </label>
                <span className="shrink-0" style={{ marginTop: 2, borderRadius: 6, padding: '2px 7px', fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)', background: sc.bg, color: sc.color }}>
                  {c.score}
                </span>
                <div className="min-w-0 flex-1">
                  <p style={{ margin: 0, fontSize: 13.5, fontWeight: 500, lineHeight: 1.35, color: 'var(--color-fg-soft)' }}>
                    <span style={{ color: 'var(--color-fg-faint)' }}>{i + 1}.</span> {c.title}
                  </p>
                  <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--color-fg-muted)', fontFamily: 'var(--font-mono)' }}>
                    {[c.journal, c.year].filter(Boolean).join(' · ')}
                    {types && <span style={{ color: 'var(--color-fg-faint)' }}> · {types}</span>}
                  </p>
                  {c.reason && <p style={{ margin: '2px 0 0', fontSize: 12, fontStyle: 'italic', color: 'var(--color-fg-muted)' }}>{c.reason}</p>}
                </div>
                {inDigest && (
                  <span className="shrink-0" style={{ marginTop: 2, borderRadius: 999, background: 'rgba(127,191,154,.14)', padding: '2px 8px', fontSize: 10, fontWeight: 600, color: 'var(--color-verified-soft)' }}>
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
  const [restored, setRestored] = useState(false) // digest rehydrated from IndexedDB this mount
  const keySet = hasApiKey()

  // Latest digest state, mirrored every render — async runs would otherwise persist stale
  // closed-over values. ranRef stops a slow restore from clobbering a run already started.
  const digestRef = useRef(null)
  digestRef.current = { results, triaged, candidates, selectedIds }
  const ranRef = useRef(false)

  // Persist the digest snapshot. Fire-and-forget — never blocks the UI, never throws.
  function persistDigest(overrides = {}) {
    saveDailyDigest({ ...digestRef.current, ...overrides }).catch(console.warn)
  }

  const titleOf = (res) => res.paper.title || res.citation?.title || `PMID ${res.paper.pmid}`

  // Load which papers are already in the Knowledge Base (persisted in IndexedDB).
  useEffect(() => {
    store.all('papers').then((papers) => setSavedIds(new Set((papers || []).map((p) => p.id))))
  }, [])

  // Rehydrate the last digest — App unmounts this component on every tab switch, and
  // re-running would re-pay the extraction calls. Stages stay empty: labels only render
  // while a stage is in flight.
  useEffect(() => {
    loadDailyDigest()
      .then((saved) => {
        if (!saved || ranRef.current) return
        if (!saved.results.length && !saved.candidates.length) return
        setResults(saved.results)
        setTriaged(saved.triaged)
        setCandidates(saved.candidates)
        setSelectedIds(saved.selectedIds)
        setRestored(true)
      })
      .catch(console.warn)
  }, [])

  // Resolve free-full-text links for the digest cards — the workflow is read-the-paper-first,
  // save-later, so the link belongs on the card, not just the Library. One Unpaywall call per
  // paper, sequential (polite), attempted once: `oa: null` marks a miss so a paper with no OA
  // copy never re-fires. Results are patched in place and persisted with the digest snapshot,
  // so a restored digest keeps its links without re-resolving.
  const oaBusy = useRef(false)
  const oaTried = useRef(new Set()) // paper ids attempted this mount — never re-hit Unpaywall
  useEffect(() => {
    if (oaBusy.current) return
    const pending = results.filter(
      (r) => r.oa === undefined && !r.error && r.citation?.doi && !oaTried.current.has(r.paper.id),
    )
    if (!pending.length) return
    oaBusy.current = true
    ;(async () => {
      for (const r of pending) {
        oaTried.current.add(r.paper.id)
        const oa = await resolveOaLink(r.citation.doi).catch(() => null)
        setResults((prev) => prev.map((x) => (x.paper.id === r.paper.id ? { ...x, oa: oa || null } : x)))
      }
      oaBusy.current = false
      persistDigest()
    })()
  }, [results])

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
    setSavedIds((prev) => new Set(prev).add(id))
    // One shared path (pipeline/save.js): persist the record, then in the background file it under a
    // concept, resolve an open-access PDF link, and write it to the connected on-disk folder. The
    // "Add a paper" entry point in the Library uses the exact same path so they never drift.
    try {
      await savePaper(res, take, { title })
    } catch (err) {
      console.warn('Save failed:', err.message)
    }
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
    ranRef.current = true
    setRestored(false)
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
    // What actually landed in triage — fresh runs cleared it, appends keep the old map
    // until the combined re-rank replaces it.
    let triagedNow = append ? triaged : {}
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
        triagedNow = byId
      } catch (err) {
        console.warn('Triage failed (facts unaffected):', err.message)
      }
      setRanking(false)
    }
    // Persist so a tab switch (which unmounts this component) never costs a re-run.
    persistDigest({ results: collected, triaged: triagedNow })
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
    // The pool + picks survive a tab switch even before any digest runs.
    persistDigest({ candidates: scored, selectedIds: chosenIds })
    return { scored, chosenIds }
  }

  // The product loop, in ONE click: search PubMed WIDE → score every candidate against the
  // rubric (metadata only) → run the digest immediately on the rubric's top picks. The
  // selection funnel stays collapsed underneath the digest — open it to adjust the picks,
  // re-rank against an edited rubric, or top up. The daily user never has to touch it.
  async function startScan() {
    setScanError('')
    ranRef.current = true
    setRestored(false)
    setResults([])
    setTriaged({})
    setCandidates([])
    // Clear the persisted digest too — closing mid-scan must not resurrect stale results.
    clearDailyDigest().catch(console.warn)
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

  const busy = running || searching || selecting
  const primaryLabel = searching ? 'Searching…' : selecting ? 'Scoring…' : running ? 'Building digest…' : "Run today's digest"
  const showEmpty = !running && !searching && !selecting && !ranking && results.length === 0 && candidates.length === 0 && !scanError

  return (
    <section>
      {/* Run controls — the big centered primary action, with the deterministic proof
          surface as a small secondary beneath it. */}
      <div className="flex flex-col items-center" style={{ gap: 12, marginTop: 6 }}>
        <button
          onClick={startScan}
          disabled={!keySet || busy}
          className="cursor-pointer"
          style={{ padding: '14px 34px', borderRadius: 13, border: 0, background: 'var(--color-accent)', color: '#1c1206', fontSize: 15.5, fontWeight: 600, fontFamily: 'inherit', boxShadow: '0 10px 34px -10px rgba(239,143,91,.7)', opacity: !keySet || busy ? 0.6 : 1 }}
        >
          {primaryLabel}
        </button>
        <button
          onClick={runShowcase}
          disabled={!keySet || busy}
          title="Three reference trials that demonstrate the verifier's guarantees"
          className="cursor-pointer"
          style={{ padding: '7px 13px', borderRadius: 999, border: '1px solid rgba(255,255,255,.12)', background: 'transparent', color: 'var(--color-fg-muted)', fontSize: 12.5, fontWeight: 500, fontFamily: 'inherit', opacity: !keySet || busy ? 0.5 : 1 }}
        >
          Verifier proof
        </button>
      </div>

      {/* "Today's scan" section rule. */}
      <div className="flex items-center" style={{ gap: 14, margin: '30px 0 4px' }}>
        <span style={{ fontFamily: 'var(--font-serif)', fontSize: 16, fontStyle: 'italic', color: 'var(--color-fg-dim)' }}>Today's scan</span>
        <span style={{ flex: 1, height: 1, background: 'var(--hairline)' }} />
        {candidates.length > 0 && (
          <span style={{ fontSize: 12, color: 'var(--color-fg-faint)', fontFamily: 'var(--font-mono)' }}>
            {candidates.length} candidates{results.length ? ` · ${results.length} in digest` : ''}
          </span>
        )}
      </div>

      {/* Status lines. */}
      {!keySet && <p style={{ margin: '12px 0 0', fontSize: 13, color: 'var(--color-abstract)' }}>Add your API key in Settings first.</p>}
      {searching && <p style={{ margin: '12px 0 0', fontSize: 13, color: 'var(--color-fg-muted)' }}>Searching PubMed wide for recent papers…</p>}
      {selecting && <p style={{ margin: '12px 0 0', fontSize: 13, color: 'var(--color-accent)' }}>Claude is scoring every candidate against your rubric…</p>}
      {scanError && <p style={{ margin: '12px 0 0', fontSize: 13, color: 'var(--color-domain-vascular)' }}>{scanError}</p>}
      {restored && <p style={{ margin: '12px 0 0', fontSize: 13, color: 'var(--color-fg-muted)' }}>Restored your last digest — run again for fresh results.</p>}
      {ranking && <p style={{ margin: '12px 0 0', fontSize: 13, color: 'var(--color-accent)' }}>Claude is ranking and summarizing against your steering profile…</p>}
      {showEmpty && (
        <p style={{ margin: '16px 0 0', fontSize: 14.5, color: 'var(--color-fg-dim)', lineHeight: 1.6, maxWidth: 620 }}>
          Hit <span style={{ color: 'var(--color-accent)' }}>Run today's digest</span> — Verastar searches recent literature, scores it against your rubric, and
          verifies the top papers into a digest. Or hit “Verifier proof” to see the guarantees on three reference trials.
        </p>
      )}

      {/* The selection funnel: the wide candidate pool, scored against the rubric, top N pre-checked. */}
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

      {/* The digest — one observatory card per paper. */}
      <div className="flex flex-col" style={{ marginTop: 18, gap: 14 }}>
        {ordered.map((res, idx) => {
          const paper = res.paper
          const stage = stages[paper.id]
          const take = triaged[paper.id]
          const title = titleOf(res)
          const verifiedRows = !res.error ? res.rows.filter((r) => !r.verdict.flagged) : []
          const heroRow = verifiedRows[0] || null
          const rank = String(idx + 1).padStart(2, '0')
          return (
            <article key={paper.id} style={{ padding: '24px 26px', borderRadius: 15, background: 'var(--surface-1)' }}>
              {/* Header — rank · verification chip · fit score / save. */}
              <div className="flex items-center" style={{ gap: 11, marginBottom: 11 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--color-fg-faint)' }}>{rank}</span>
                {take?.tier ? <TierChip tier={take.tier} /> : stage && stage !== 'done' ? (
                  <span style={{ fontSize: 12.5, color: 'var(--color-fg-muted)' }}>{STAGE_LABEL[stage]}</span>
                ) : null}
                <div className="flex items-center" style={{ marginLeft: 'auto', gap: 14 }}>
                  {take?.score != null && (
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-fg-faint)' }}>fit {take.score}</span>
                  )}
                  {!res.error && (
                    <label className="flex items-center cursor-pointer" style={{ gap: 6, fontSize: 12.5, color: savedIds.has(paper.id) ? 'var(--color-verified-soft)' : 'var(--color-fg-muted)' }}>
                      <input type="checkbox" checked={savedIds.has(paper.id)} onChange={() => toggleSave(res, take, verifiedRows, title)} style={{ width: 15, height: 15, accentColor: '#7fbf9a' }} />
                      {savedIds.has(paper.id) ? 'Saved' : 'Save to Library'}
                    </label>
                  )}
                </div>
              </div>

              <h3 style={{ margin: 0, fontFamily: 'var(--font-serif)', fontSize: 21, fontWeight: 500, lineHeight: 1.32, color: 'var(--color-fg)' }}>{title}</h3>
              <Citation citation={res.citation} oa={res.oa} />

              {/* Relevance to the clinician's projects — italic Spectral, number-free. */}
              {take?.relevance && (
                <p style={{ margin: '12px 0 0', fontFamily: 'var(--font-serif)', fontStyle: 'italic', fontSize: 15, color: 'var(--color-fg-dim)', lineHeight: 1.55 }}>{take.relevance}</p>
              )}

              {/* The finding — verified prose. "grounded in source" opens the sentence it rests on. */}
              {take?.finding && (
                <p style={{ margin: '11px 0 0', fontSize: 15.5, lineHeight: 1.65, color: 'var(--color-fg-soft)' }}>
                  {take.finding}{' '}
                  {heroRow && (
                    <button onClick={() => openSource(heroRow.quantity, heroRow.verdict, res.sourceDoc, title)} className="cursor-pointer whitespace-nowrap" style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-verified-soft)' }}>
                      grounded in source ↗
                    </button>
                  )}
                </p>
              )}

              {res?.error && <p style={{ margin: '8px 0 0', fontSize: 13, color: 'var(--color-domain-vascular)' }}>Error: {res.error}</p>}

              {res &&
                !res.error &&
                (() => {
                  const flaggedRows = res.rows.filter((r) => r.verdict.flagged)
                  const isOpen = !!expanded[paper.id]
                  const total = verifiedRows.length
                  // No numeric results (review / methods piece) — the finding + citation carry the card.
                  if (res.rows.length === 0 && !res.corrupt) return null
                  return (
                    <div style={{ marginTop: 15 }}>
                      <button
                        onClick={() => setExpanded((p) => ({ ...p, [paper.id]: !isOpen }))}
                        className="cursor-pointer"
                        style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-fg-muted)' }}
                      >
                        {isOpen ? '▾ Hide verified evidence' : `▸ Show verified evidence (${total} value${total === 1 ? '' : 's'})`}
                      </button>

                      {isOpen && (
                        <div style={{ marginTop: 10, borderRadius: 10, border: '1px solid var(--hairline)', background: 'rgba(255,255,255,.015)', padding: '0 14px 8px' }}>
                          <p style={{ paddingTop: 12, margin: 0, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--color-verified-soft)' }}>
                            Every value re-verified against the source — click any to see it
                          </p>
                          {verifiedRows.map((row, i) => (
                            <Row key={i} quantity={row.quantity} verdict={row.verdict} hero={i === 0} onOpenSource={() => openSource(row.quantity, row.verdict, res.sourceDoc, title)} />
                          ))}

                          {flaggedRows.length > 0 && (
                            <div style={{ marginTop: 8 }}>
                              <p style={{ margin: 0, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--color-fg-muted)' }}>
                                {flaggedRows.length} value{flaggedRows.length === 1 ? '' : 's'} flagged — greyed, never charted
                              </p>
                              {flaggedRows.map((row, i) => (
                                <Row key={i} quantity={row.quantity} verdict={row.verdict} onOpenSource={() => openSource(row.quantity, row.verdict, res.sourceDoc, title)} />
                              ))}
                            </div>
                          )}

                          {res.corrupt && (
                            <div style={{ marginTop: 12, borderRadius: 8, background: 'rgba(224,96,90,.12)', padding: 12 }}>
                              <p style={{ margin: 0, fontSize: 12, fontWeight: 500, color: '#f0a9a4' }}>
                                Corruption test — value {res.corrupt.original} nudged to {res.corrupt.quantity.value}:
                              </p>
                              <Row quantity={res.corrupt.quantity} verdict={res.corrupt.verdict} onOpenSource={() => openSource(res.corrupt.quantity, res.corrupt.verdict, res.sourceDoc, title)} />
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })()}
            </article>
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
