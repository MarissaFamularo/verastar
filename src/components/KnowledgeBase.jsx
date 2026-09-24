// components/KnowledgeBase.jsx — the "Knowledge Base" page: browse everything you've saved, the
// way the clinician browses her real KG. Concepts are the top level (topic "wiki" nodes grouping
// source papers under one synthesized summary), each in one broad DOMAIN. Search reaches title,
// summary, and tags across the concept and its papers; a domain filter narrows by her taxonomy.
//
// This is also where "Claude applies, you prune" completes: notes and tags are editable here. The
// "Re-file with Claude" action re-classifies existing saves into concepts/domains. buildKB
// (lib/kb.js) does the pure search/filter. Styled to the observatory design (Verastar.dc.html);
// the flat-file vault lives on its own Library surface now.

import { useEffect, useMemo, useState } from 'react'
import { store } from '../lib/store.js'
import { logEvent } from '../lib/events.js'
import { hasModelAccess } from '../lib/anthropic.js'
import { loadConcepts, setConceptTags, removeNode } from '../pipeline/graph.js'
import { refileKB } from '../pipeline/deposit.js'
import { categorizeLibrary } from '../pipeline/categorize.js'
import { buildKB, listTopics, topicIndex } from '../lib/kb.js'
import { backfillOaPdfs } from '../pipeline/save.js'
import { pmcUrl } from '../pipeline/openaccess.js'
import { listDomains, domainColor, domainLabel } from '../lib/domains.js'
import { isSignedIn } from '../lib/supabase.js'
import { PAPERTRELLIS_URL } from '../lib/trellis.js'
import { useWindowFocusRefresh } from '../lib/focusRefresh.js'
import { useIsMobile } from '../lib/useMobile.js'
import { setPaperFavorite } from '../lib/favorites.js'
import { paperIndicatesRetraction, removePaperFromConcepts } from '../pipeline/retractions.js'
import { acknowledgeRetraction, checkSavedRetractions, noteRetractionRemoved } from '../lib/retractionWatch.js'
import { useRetractionAlerts } from '../lib/useRetractionAlerts.js'
import AddPaper from './AddPaper.jsx'
import FileToDisk from './LibraryPanel.jsx'
import HeartButton from './HeartButton.jsx'
import SharePaperButton from './SharePaperButton.jsx'
import { fmtNum } from '../lib/format.js'
import { evidenceVerdict, isRelationshipValidated, extractionVersionStatus } from '../lib/evidenceVersion.js'
import { needsDigestDetails, refreshSavedPaperEvidence } from '../pipeline/refreshEvidence.js'

const REFRESH_STAGE_LABEL = {
  fetching: 'Fetching…',
  extracting: 'Extracting…',
  verifying: 'Verifying…',
  summarizing: 'Summarizing…',
  saving: 'Saving…',
  done: 'Done',
}

export default function KnowledgeBase() {
  const [concepts, setConcepts] = useState([])
  const [papers, setPapers] = useState([])
  const [edges, setEdges] = useState([])
  const [query, setQuery] = useState('')
  const [domain, setDomain] = useState('all')
  const [topic, setTopic] = useState('all')
  const [favsOnly, setFavsOnly] = useState(false)
  const [loading, setLoading] = useState(true)
  const [refiling, setRefiling] = useState('') // '' | progress string
  const [confirmRefile, setConfirmRefile] = useState(false)
  const [reorg, setReorg] = useState('') // '' | 'running' | result/error message
  // Unacknowledged retractions, read off the saved records by the shared watch — the same
  // list the app-wide notice shows. A record the watch patches is swapped into `papers` in
  // place so the row warning appears without a reload.
  const retractionAlerts = useRetractionAlerts({
    onPatched: (patched) => {
      const byId = new Map(patched.map(({ id, record }) => [id, record]))
      setPapers((prev) => prev.map((p) => byId.get(p.id) || p))
    },
  })
  const [confirmRetractionDelete, setConfirmRetractionDelete] = useState(null)
  // On the phone the two chip rows eat most of a screen before the first paper —
  // collapsed behind one toggle line there; desktop keeps them always open.
  const isMobile = useIsMobile()
  const [filtersOpen, setFiltersOpen] = useState(false)
  const keySet = hasModelAccess()

  async function refresh() {
    const [c, p, e] = await Promise.all([loadConcepts(), store.all('papers'), store.all('graphEdges')])
    setConcepts(c || [])
    setPapers(p || [])
    setEdges(e || [])
  }

  useEffect(() => {
    ;(async () => {
      await refresh()
      setLoading(false)
      // Self-heal: resolve any open-access links that never got persisted, patching each
      // paper's badge in place as its link lands. One-time per paper — resolved ones are skipped.
      const all = await store.all('papers')
      backfillOaPdfs(all || [], (id, patch) =>
        setPapers((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p))),
      )
      // Retractions can happen years after a paper was saved. The shared watch re-checks
      // PubMed (throttled — boot or a digest scan may just have done it) and patches only
      // newly retracted records; a network miss changes nothing.
      checkSavedRetractions({ reason: 'library' }).catch(() => {})
    })()
  }, [])

  // Signed in, the phone may have saved papers while this tab was backgrounded —
  // pull fresh data on focus. Pure setState refresh; nothing remounts. Skipped
  // during a re-file so the progress flow can't have records swapped under it.
  useWindowFocusRefresh(() => {
    if (isSignedIn() && !refiling) refresh().catch(() => {})
  })

  // Favorites narrow the paper set BEFORE grouping, so a favorites-only view keeps
  // buildKB's own rule doing the work: concepts with no matching papers just vanish.
  const { groups, unfiled, counts } = useMemo(
    () => buildKB(concepts, favsOnly ? papers.filter((p) => p.favorite) : papers, { query, domain, topic, edges }),
    [concepts, papers, edges, query, domain, topic, favsOnly],
  )
  const topics = useMemo(() => listTopics(concepts, papers, edges), [concepts, papers, edges])
  const tIdx = useMemo(() => topicIndex(concepts, edges), [concepts, edges])

  // --- mutations (persist, then patch local state so edits feel instant) ---

  async function savePaper(id, patch, baseline) {
    const current = baseline || await store.get('papers', id)
    if (!current) return
    const next = { ...current, ...patch }
    await store.put('papers', id, next)
    setPapers((prev) => prev.map((p) => (p.id === id ? next : p)))
  }

  async function removePaperTag(paper, tag) {
    await savePaper(paper.id, { tags: (paper.tags || []).filter((t) => t !== tag) })
  }

  async function createDigestDetails(paper, onStage) {
    const next = await refreshSavedPaperEvidence(paper, { onStage })
    setPapers((prev) => prev.map((p) => (p.id === paper.id ? next : p)))
    return next
  }

  // Through lib/favorites.js, NOT the local savePaper patch — the heart must log its
  // telemetry row no matter which surface flips it, and this one is no exception.
  async function toggleFavorite(p) {
    const next = await setPaperFavorite(p.id, !p.favorite, { surface: 'library' })
    if (next) setPapers((prev) => prev.map((x) => (x.id === p.id ? next : x)))
  }

  async function removeConceptTag(concept, tag) {
    const node = await setConceptTags(concept.id, (concept.tags || []).filter((t) => t !== tag))
    if (node) setConcepts((prev) => prev.map((c) => (c.id === concept.id ? node : c)))
  }

  // removing a concept drops its papers to unfiled (clear conceptId); categories aren't deletable.
  async function deleteConcept(concept) {
    await removeNode(concept.id)
    const orphans = papers.filter(
      (p) => p.conceptId === concept.id || (concept.sourcePmids || []).includes(String(p.pmid)),
    )
    await Promise.all(orphans.map((p) => savePaper(p.id, { conceptId: null })))
    setConcepts((prev) => prev.filter((c) => c.id !== concept.id))
  }

  // "Keep with warning" persists on the record: the alert stays dismissed on every device;
  // the row warning is permanent.
  async function keepRetracted(paper) {
    const next = await acknowledgeRetraction(paper.id).catch(() => null)
    if (next) setPapers((prev) => prev.map((p) => (p.id === next.id ? next : p)))
  }

  async function deletePaper(paper) {
    const storedConcepts = await loadConcepts()
    const patched = removePaperFromConcepts(storedConcepts, paper)
    await Promise.all(patched.map((node) => store.put('graphNodes', node.id, node)))
    await store.delete('papers', paper.id)
    setPapers((prev) => prev.filter((p) => p.id !== paper.id))
    if (patched.length) {
      const byId = new Map(patched.map((node) => [node.id, node]))
      setConcepts((prev) => prev.map((node) => byId.get(node.id) || node))
    }
    setConfirmRetractionDelete(null)
    noteRetractionRemoved()
    if (paperIndicatesRetraction(paper)) {
      logEvent('retracted_paper_deleted', { pmid: paper.pmid || paper.id })
    }
  }

  // Re-classify every saved paper into concepts/domains. Paid: one Claude call per paper + concept.
  async function handleRefile() {
    setConfirmRefile(false)
    setRefiling('Re-filing…')
    try {
      await refileKB((d, t) => setRefiling(`Re-filing ${d}/${t}…`))
      await refresh()
    } catch (err) {
      console.warn('Re-file failed:', err.message)
    }
    setRefiling('')
  }

  // Ask the model to (re)shelve the whole library into at most 10 categories. Free when the
  // library is already organized; otherwise one cheap structured call. Reports honestly.
  async function handleReorganize() {
    setReorg('running')
    try {
      const res = await categorizeLibrary()
      if (res?.ok) {
        await refresh()
        setReorg(
          res.skipped
            ? `Already organized — ${res.categories} categor${res.categories === 1 ? 'y' : 'ies'}, everything filed.`
            : `${res.categories} categor${res.categories === 1 ? 'y' : 'ies'}, ${res.filed} filed.`,
        )
      } else {
        setReorg(`Couldn’t reorganize: ${res?.error || 'unknown error'}`)
      }
    } catch (err) {
      await refresh().catch(() => {}) // a mid-apply throw leaves a working superset — show it
      setReorg(`Couldn’t reorganize: ${err.message}`)
    }
  }

  const totalConcepts = concepts.length
  const totalPapers = papers.length

  return (
    <div className="vs-page-pad" style={{ maxWidth: 1240, padding: '46px 56px 64px' }}>
      <div style={{ display: 'flex', gap: 40, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 440px', minWidth: 0, maxWidth: 720 }}>
      <p style={{ margin: 0, fontSize: 12, letterSpacing: '.15em', textTransform: 'uppercase', color: 'var(--color-fg-faint)', fontWeight: 600 }}>Your knowledge graph</p>
      {retractionAlerts.map((paper) => (
        <div key={paper.id} role="alert" style={{ marginTop: 14, borderRadius: 12, border: '1px solid rgba(224,96,90,.45)', background: 'rgba(224,96,90,.10)', padding: '13px 15px' }}>
          <p style={{ margin: 0, fontSize: 12, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--color-domain-vascular)' }}>Retracted</p>
          <p style={{ margin: '5px 0 0', fontSize: 13.5, fontWeight: 600, lineHeight: 1.45, color: 'var(--color-fg-soft)' }}>{paper.title || `PMID ${paper.pmid}`}</p>
          <p style={{ margin: '4px 0 0', fontSize: 12, lineHeight: 1.5, color: 'var(--color-fg-muted)' }}>
            PubMed now classifies this saved paper as retracted. Keep it with a permanent warning for audit history, or delete its saved Library record, notes, verified values, tags, and concept membership. Past digest snapshots and files already written to disk are not deleted.
          </p>
          {confirmRetractionDelete === paper.id ? (
            <div className="flex flex-wrap items-center" style={{ marginTop: 10, gap: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-domain-vascular)' }}>Delete this saved paper and its metadata?</span>
              <button onClick={() => deletePaper(paper)} className="cursor-pointer" style={{ borderRadius: 8, border: 0, background: 'var(--color-domain-vascular)', color: '#fff', padding: '6px 10px', fontSize: 12, fontWeight: 700, fontFamily: 'inherit' }}>Delete permanently</button>
              <button onClick={() => setConfirmRetractionDelete(null)} className="cursor-pointer" style={{ borderRadius: 8, border: '1px solid rgba(255,255,255,.14)', background: 'transparent', color: 'var(--color-fg-soft)', padding: '6px 10px', fontSize: 12, fontFamily: 'inherit' }}>Cancel</button>
            </div>
          ) : (
            <div className="flex flex-wrap" style={{ marginTop: 10, gap: 8 }}>
              <button onClick={() => keepRetracted(paper)} className="cursor-pointer" style={{ borderRadius: 8, border: '1px solid rgba(255,255,255,.14)', background: 'transparent', color: 'var(--color-fg-soft)', padding: '6px 10px', fontSize: 12, fontFamily: 'inherit' }}>Keep with warning</button>
              <button onClick={() => setConfirmRetractionDelete(paper.id)} className="cursor-pointer" style={{ borderRadius: 8, border: 0, background: 'rgba(224,96,90,.18)', color: 'var(--color-domain-vascular)', padding: '6px 10px', fontSize: 12, fontWeight: 700, fontFamily: 'inherit' }}>Delete paper &amp; metadata</button>
            </div>
          )}
        </div>
      ))}
      {/* Desktop: title, re-file, and counts share one line. On the phone the
          re-file control drops to its own row under the title — beside it, the
          button wrapped into a tall pill that crowded out the counts. */}
      {(() => {
        const refileControl = keySet && totalPapers > 0 && (
          refiling ? (
            <span style={{ fontSize: 12, color: 'var(--color-accent)', fontFamily: 'var(--font-mono)' }}>{refiling}</span>
          ) : confirmRefile ? (
            <span className="flex items-center" style={{ gap: 8, fontSize: 12, flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--color-fg-muted)' }}>Re-run Claude on all {totalPapers}?</span>
              <button onClick={handleRefile} className="cursor-pointer" style={{ borderRadius: 8, background: 'var(--color-accent)', color: '#1c1206', padding: '3px 10px', fontWeight: 600, border: 0 }}>Re-file</button>
              <button onClick={() => setConfirmRefile(false)} className="cursor-pointer" style={{ color: 'var(--color-fg-muted)', background: 'transparent', border: 0 }}>cancel</button>
            </span>
          ) : (
            <button
              onClick={() => setConfirmRefile(true)}
              title="Re-classify every saved paper into concepts + domains"
              className="inline-flex items-center cursor-pointer"
              style={{ gap: 7, padding: '6px 12px', borderRadius: 9, border: '1px solid rgba(255,255,255,.1)', color: 'var(--color-fg-soft)', fontSize: 12.5, background: 'transparent', whiteSpace: 'nowrap' }}
            >
              ↻ Re-file with Claude
            </button>
          )
        )
        return (
          <>
            <div className="flex items-end justify-between" style={{ gap: 20, marginTop: 9 }}>
              <h1 style={{ margin: 0, fontFamily: 'var(--font-serif)', fontSize: 34, fontWeight: 500, letterSpacing: '-.01em', color: 'var(--color-fg)' }}>Library</h1>
              <div className="flex items-center" style={{ gap: 14 }}>
                {!isMobile && refileControl}
                <span style={{ fontSize: 13, color: 'var(--color-fg-muted)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                  {totalConcepts} concept{totalConcepts === 1 ? '' : 's'} · {totalPapers} paper{totalPapers === 1 ? '' : 's'}
                </span>
              </div>
            </div>
            {isMobile && refileControl && <div style={{ marginTop: 12 }}>{refileControl}</div>}
          </>
        )
      })()}
      <p style={{ margin: '12px 0 0', fontSize: 15, color: 'var(--color-fg-dim)', maxWidth: 640, lineHeight: 1.55 }}>
        Everything you've saved, grouped into concept nodes and colored by domain. Search title, summary, and tags;
        filter by topic. Claude tags each paper on deposit — prune what's wrong and add your own notes.
      </p>

      {/* search + domain filter */}
      <div className="flex items-center" style={{ marginTop: 26, gap: isMobile ? 8 : 12, background: 'var(--surface-2)', borderRadius: 12, padding: isMobile ? '11px 12px' : '11px 15px' }}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--color-fg-muted)" strokeWidth="1.8" style={{ flex: '0 0 auto' }}><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={isMobile ? 'Search library…' : 'Search title, summary, tags…'}
          style={{ flex: 1, minWidth: 0, background: 'transparent', border: 0, outline: 'none', color: 'var(--color-fg)', fontSize: 14, fontFamily: 'inherit' }}
        />
        {query && (
          <button onClick={() => setQuery('')} className="cursor-pointer" style={{ fontSize: 12, color: 'var(--color-fg-muted)', background: 'transparent', border: 0, flex: '0 0 auto' }}>clear</button>
        )}
        {/* Favorites-only lives beside search, not with the chips — it survives the
            mobile filter fold, so a hearted library is one tap away on the phone too.
            On the phone it folds to the heart alone; the label would crowd the input. */}
        <button
          onClick={() => setFavsOnly((f) => !f)}
          title={favsOnly ? 'Showing favorites only — click for all papers' : 'Show favorites only'}
          aria-label={favsOnly ? 'Showing favorites only — tap for all papers' : 'Show favorites only'}
          aria-pressed={favsOnly}
          className="cursor-pointer flex items-center"
          style={{ gap: 6, padding: isMobile ? '6px 8px' : '4px 10px', borderRadius: 8, border: 0, flex: '0 0 auto', fontFamily: 'inherit', fontSize: 12, fontWeight: 500, background: favsOnly ? 'rgba(224,96,90,.16)' : 'transparent', color: favsOnly ? 'var(--color-domain-vascular)' : 'var(--color-fg-muted)' }}
        >
          <svg width={isMobile ? 16 : 13} height={isMobile ? 16 : 13} viewBox="0 0 24 24" fill={favsOnly ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
            <path d="M12 20.3C7.2 16.7 3.5 13.5 3.5 9.8 3.5 7.1 5.6 5 8.1 5c1.5 0 3 .8 3.9 2.1C12.9 5.8 14.4 5 15.9 5c2.5 0 4.6 2.1 4.6 4.8 0 3.7-3.7 6.9-8.5 10.5z" />
          </svg>
          {!isMobile && 'Favorites'}
        </button>
      </div>
      {/* Mobile: the chip rows collapse behind this line. The active filters stay
          legible in the summary so collapsing never hides what's narrowing the list. */}
      {isMobile && (topics.length > 0 || listDomains().length > 1) && (
        <button
          onClick={() => setFiltersOpen((o) => !o)}
          className="cursor-pointer flex items-center"
          style={{ marginTop: 14, gap: 8, padding: 0, border: 0, background: 'transparent', fontFamily: 'inherit', fontSize: 12.5, color: 'var(--color-fg-muted)' }}
        >
          <span aria-hidden="true" style={{ fontSize: 10 }}>{filtersOpen ? '▾' : '▸'}</span>
          Filter by topic &amp; domain
          {!filtersOpen && (topic !== 'all' || domain !== 'all') && (
            <span style={{ color: 'var(--color-accent)' }}>
              · {[topic !== 'all' && topics.find((t) => t.id === topic)?.label, domain !== 'all' && domainLabel(domain)].filter(Boolean).join(' · ')}
            </span>
          )}
        </button>
      )}
      {/* Topic chips — the hub tier ("Carotid Revascularization"-level), the altitude a
          single-specialty reader actually browses by. The classifier caps hub growth by
          strongly preferring existing hubs, so this stays a handful of chips. */}
      {(!isMobile || filtersOpen) && topics.length > 0 && (
        <div className="flex flex-wrap" style={{ marginTop: 14, gap: 8 }}>
          <FilterChip active={topic === 'all'} onClick={() => setTopic('all')}>All topics</FilterChip>
          {topics.map((t) => (
            <FilterChip key={t.id} active={topic === t.id} color={tIdx.colorOf(t.id)} onClick={() => setTopic(t.id)}>
              {t.label} · {t.count}
            </FilterChip>
          ))}
        </div>
      )}
      {/* Domain chips only earn a row when the library actually spans disciplines — a
          single-domain library would render one always-on chip that filters nothing. */}
      {(!isMobile || filtersOpen) && listDomains().length > 1 && (
        <div className="flex flex-wrap" style={{ marginTop: 10, gap: 8 }}>
          <FilterChip active={domain === 'all'} onClick={() => setDomain('all')}>All domains</FilterChip>
          {listDomains().map((d) => (
            <FilterChip key={d.key} active={domain === d.key} color={d.color} onClick={() => setDomain(d.key)}>{d.label}</FilterChip>
          ))}
        </div>
      )}
      {/* Category upkeep — the library self-organizes into ≤10 shelves on its own (deposits
          trigger it when needed); this is the manual handle. Quiet by design. */}
      {keySet && totalConcepts > 0 && (
        <div className="flex flex-wrap items-center" style={{ marginTop: 12, gap: 10 }}>
          <button
            onClick={handleReorganize}
            disabled={reorg === 'running'}
            title="Ask Claude to reshelve the library into at most 10 categories"
            className="cursor-pointer"
            style={{ fontSize: 11.5, color: 'var(--color-fg-muted)', background: 'transparent', border: 0, padding: 0, textUnderlineOffset: 3, textDecoration: 'underline dotted' }}
          >
            {reorg === 'running' ? 'Reorganizing…' : '✦ Reorganize categories'}
          </button>
          {reorg && reorg !== 'running' && (
            <span style={{ fontSize: 11.5, color: 'var(--color-fg-faint)', fontFamily: 'var(--font-mono)' }}>{reorg}</span>
          )}
        </div>
      )}

      <div style={{ marginTop: 26 }}>
        <AddPaper onAdded={refresh} />
      </div>

      <div className="flex flex-col" style={{ marginTop: 24, gap: 16 }}>
        {loading ? (
          <p style={{ fontSize: 14, color: 'var(--color-fg-muted)' }}>Loading your knowledge base…</p>
        ) : totalPapers === 0 ? (
          <p style={{ fontSize: 14, color: 'var(--color-fg-muted)' }}>
            Nothing saved yet. Run today's digest and use “Save to Library” — papers group into concept nodes here.
          </p>
        ) : counts.papers === 0 ? (
          <p style={{ fontSize: 14, color: 'var(--color-fg-muted)' }}>
            {favsOnly && !query
              ? 'No favorites yet — tap the heart on any paper to keep it here.'
              : `No matches for “${query}”${domain !== 'all' ? ` in ${domainLabel(domain)}` : ''}${favsOnly ? ' among your favorites' : ''}.`}
          </p>
        ) : (
          <>
            {groups.map(({ group, papers }) => (
              <ConceptCard
                topicColor={tIdx.colorOf(group.id)}
                topicLabel={tIdx.labelOf(group.id)}
                key={group.id}
                concept={group}
                papers={papers}
                query={query}
                onRemoveConceptTag={(t) => removeConceptTag(group, t)}
                onRemovePaperTag={removePaperTag}
                onSaveNote={(id, notes, baseline) => savePaper(id, { notes }, baseline)}
                onDeleteConcept={() => deleteConcept(group)}
                onDeletePaper={deletePaper}
                onToggleFavorite={toggleFavorite}
                onCreateDetails={createDigestDetails}
                canCreateDetails={keySet}
              />
            ))}
            {unfiled.length > 0 && (
              <div style={{ borderRadius: 16, border: '1px dashed rgba(255,255,255,.12)', padding: 20 }}>
                <p style={{ margin: 0, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--color-fg-muted)' }}>
                  Unfiled ({unfiled.length}) — not yet grouped into a concept
                </p>
                <ul style={{ margin: '12px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {unfiled.map((p) => (
                    <PaperRow key={p.id} paper={p} onRemoveTag={(t) => removePaperTag(p, t)} onSaveNote={(notes, baseline) => savePaper(p.id, { notes }, baseline)} onDelete={() => deletePaper(p)} onToggleFavorite={() => toggleFavorite(p)} onCreateDetails={(onStage) => createDigestDetails(p, onStage)} canCreateDetails={keySet} />
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>

      </div>{/* /main column */}

      {/* The flat-file vault — a sticky right rail, so "what's in your folder" is always in view (no scroll to the bottom). */}
      <aside style={{ flex: '1 1 300px', maxWidth: 360, position: 'sticky', top: 24, alignSelf: 'flex-start' }}>
        <FileToDisk embedded />
      </aside>
      </div>{/* /library columns */}
    </div>
  )
}

// One concept node: colored TOPIC eyebrow + glow dot (the hub tier — falls back to the domain
// for a hub-less concept), Spectral title, synthesized summary, prunable concept tags, and the
// source papers under it (each with an editable note + tags).
function ConceptCard({ concept, papers, query, topicColor, topicLabel, onRemoveConceptTag, onRemovePaperTag, onSaveNote, onDeleteConcept, onDeletePaper, onToggleFavorite, onCreateDetails, canCreateDetails }) {
  const [open, setOpen] = useState(true)
  const color = topicColor || domainColor(concept.domain)
  return (
    <div style={{ borderRadius: 16, overflow: 'hidden', background: 'var(--surface-1)' }}>
      <div style={{ padding: '24px 26px 22px' }}>
        <div className="flex items-start justify-between" style={{ gap: 16 }}>
          <div className="min-w-0">
            <span className="inline-flex items-center" style={{ gap: 7, fontSize: 11, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, boxShadow: `0 0 8px ${color}` }} />
              {topicLabel || domainLabel(concept.domain)}
            </span>
            <h3 style={{ margin: '8px 0 0', fontFamily: 'var(--font-serif)', fontSize: 20, fontWeight: 500, color: 'var(--color-fg)' }}>{concept.label}</h3>
          </div>
          <button onClick={() => setOpen((o) => !o)} className="shrink-0 cursor-pointer" style={{ fontSize: 12.5, color: 'var(--color-fg-muted)', fontFamily: 'var(--font-mono)', background: 'transparent', border: 0 }}>
            {papers.length} source{papers.length === 1 ? '' : 's'} {open ? '▴' : '▾'}
          </button>
        </div>

        {concept.summary ? (
          <p style={{ margin: '12px 0 0', fontSize: 14.5, lineHeight: 1.6, color: 'var(--color-fg-soft)', maxWidth: 680 }}>{concept.summary}</p>
        ) : (
          <p style={{ margin: '12px 0 0', fontSize: 14.5, fontStyle: 'italic', color: 'var(--color-fg-faint)' }}>Summary pending.</p>
        )}

        <TagRow tags={concept.tags} onRemove={onRemoveConceptTag} max={10} />

        <button onClick={onDeleteConcept} className="cursor-pointer" style={{ marginTop: 10, fontSize: 11, fontWeight: 500, color: 'var(--color-domain-vascular)', background: 'transparent', border: 0, display: 'block' }}>
          Remove concept
        </button>
      </div>

      {open && (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', borderTop: '1px solid var(--hairline)' }}>
          {papers.map((p, i) => (
            <li key={p.id} style={{ padding: '16px 26px', borderTop: i === 0 ? 'none' : '1px solid var(--hairline-soft)' }}>
              <PaperRow paper={p} onRemoveTag={(t) => onRemovePaperTag(p, t)} onSaveNote={(notes, baseline) => onSaveNote(p.id, notes, baseline)} onDelete={() => onDeletePaper(p)} onToggleFavorite={() => onToggleFavorite(p)} onCreateDetails={(onStage) => onCreateDetails(p, onStage)} canCreateDetails={canCreateDetails} />
            </li>
          ))}
          {papers.length === 0 && (
            <li style={{ padding: '16px 26px', fontSize: 12, color: 'var(--color-fg-faint)' }}>
              {query ? 'No source papers match your search.' : 'No source papers linked yet.'}
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

// The saved snapshot from the paper's digest/manual-add run. One disclosure owns the whole
// context so the summary, project connection, caution, verified values, and reading links do not
// look like unrelated fragments. Exported for focused rendering tests.
export function SavedDigestDetails({ paper }) {
  const evidenceRows = Array.isArray(paper.quantities) ? paper.quantities : []
  const verifiedCount = evidenceRows.filter((quantity) => isRelationshipValidated(quantity.verdict)).length
  const extractionStatus = extractionVersionStatus(paper)
  const articleUrl = paper.citation?.url || `https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/`
  const fullTextUrl = paper.pdfUrl || paper.oaUrl || pmcUrl(paper.pmcid)

  return (
    <div style={{ marginTop: 10, borderRadius: 10, border: '1px solid var(--hairline)', background: 'rgba(255,255,255,.015)', padding: '12px 14px' }}>
      <p style={{ margin: 0, fontSize: 11, fontWeight: 600, letterSpacing: '.06em', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-mono)' }}>SAVED DIGEST DETAILS</p>

      {paper.relevance && (
        <p style={{ margin: '10px 0 0', borderLeft: '2px solid var(--color-accent)', paddingLeft: 10, fontSize: 12, lineHeight: 1.5, color: 'var(--color-fg-dim)' }}>
          <span style={{ fontWeight: 600, color: 'var(--color-accent-bright)' }}>Why it connects to your work:</span>{' '}
          {paper.relevance}
        </p>
      )}

      {paper.finding && (
        paper.check?.verdict === 'refuted' ? (
          <p style={{ margin: '10px 0 0', borderLeft: '2px solid var(--hairline)', paddingLeft: 10, fontSize: 12, lineHeight: 1.5, color: 'var(--color-abstract)' }}>
            ⚠︎ Summary withheld — the source check couldn't confirm it
            {paper.check?.reason ? ` (${paper.check.reason})` : ''}. Read the paper before repeating a takeaway.
          </p>
        ) : (
          <p style={{ margin: '10px 0 0', borderLeft: '2px solid var(--hairline)', paddingLeft: 10, fontSize: 12, lineHeight: 1.5, color: 'var(--color-fg-dim)' }}>
            <span style={{ fontWeight: 600, color: 'var(--color-fg-soft)' }}>Checked summary:</span>{' '}
            {paper.finding}
            {paper.check?.verdict === 'supported' && <span style={{ marginLeft: 5, color: 'var(--color-verified-soft)' }}>✓ checked</span>}
          </p>
        )
      )}

      {paper.designCaution && paper.cautionCheck?.verdict !== 'refuted' && (
        <p style={{ margin: '10px 0 0', borderLeft: '2px solid var(--color-abstract)', paddingLeft: 10, fontSize: 12, lineHeight: 1.5, color: 'var(--color-fg-dim)' }}>
          <span style={{ fontWeight: 600, color: 'var(--color-abstract)' }}>Design caution:</span>{' '}
          {paper.designCaution}
        </p>
      )}

      {evidenceRows.length > 0 ? (
        <div style={{ marginTop: 10, borderRadius: 9, border: '1px solid rgba(127,191,154,.2)', background: 'rgba(127,191,154,.04)', padding: '8px 10px' }}>
          <p style={{ margin: 0, fontSize: 11, fontWeight: 600, color: 'var(--color-verified-soft)', fontFamily: 'var(--font-mono)' }}>EVIDENCE · {verifiedCount} {verifiedCount === 1 ? 'VALUE' : 'VALUES'} VERIFIED</p>
          <ul style={{ margin: '7px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 7 }}>
            {paper.quantities.map((quantity, index) => (
              <li key={`${quantity.name || 'value'}-${index}`} style={{ fontSize: 12, lineHeight: 1.45, color: 'var(--color-fg-dim)' }}>
                <span style={{ color: 'var(--color-fg-soft)' }}>{quantity.name || 'Reported value'}:</span>{' '}
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-verified-soft)' }}>{isRelationshipValidated(quantity.verdict) ? fmtNum(quantity) : 'Claim withheld — review source'}</span>
                {(!isRelationshipValidated(quantity.verdict) || evidenceVerdict(quantity.verdict).relationshipStatus === 'estimate-validated') && <span style={{ display: 'block', color: 'var(--color-abstract)' }}>{evidenceVerdict(quantity.verdict).reason}</span>}
                {quantity.source_quote && <span style={{ display: 'block', marginTop: 2, fontSize: 11, color: 'var(--color-fg-faint)' }}>&ldquo;{quantity.source_quote}&rdquo;</span>}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p style={{ margin: '10px 0 0', fontSize: 11.5, lineHeight: 1.45, color: 'var(--color-fg-faint)', fontStyle: 'italic' }}>
          {extractionStatus === 'legacy'
            ? 'No verified values were saved with this legacy extraction.'
            : 'No numerical claims were verified for this paper.'}
        </p>
      )}

      {!paper.finding && !paper.relevance && !paper.designCaution && (
        <p style={{ margin: '10px 0 0', fontSize: 11.5, lineHeight: 1.45, color: 'var(--color-fg-faint)', fontStyle: 'italic' }}>
          No summary or connection to your work was saved with this paper.
        </p>
      )}

      <div className="flex flex-wrap items-center" style={{ marginTop: 11, gap: 12 }}>
        <a href={articleUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11.5, color: 'var(--color-accent)' }}>
          View article ↗
        </a>
        {fullTextUrl && (
          <a href={fullTextUrl} target="_blank" rel="noopener noreferrer" style={{ borderRadius: 7, padding: '3px 9px', fontSize: 11, fontWeight: 600, color: '#fff', background: 'rgba(224,96,90,.85)' }}>
            {paper.pdfUrl ? 'PDF' : paper.oaUrl ? 'Free full text' : 'Full text (PMC)'}
          </a>
        )}
      </div>
    </div>
  )
}

// One saved paper: title, mono citation, one digest-details disclosure, editable note, tags.
export function PaperRow({ paper, onRemoveTag, onSaveNote, onDelete, onToggleFavorite, onCreateDetails, canCreateDetails = true }) {
  const [showDigestDetails, setShowDigestDetails] = useState(false)
  const [refreshStage, setRefreshStage] = useState('')
  const [refreshError, setRefreshError] = useState('')
  const [noteDraft, setNoteDraft] = useState(null)
  const note = noteDraft?.text ?? (paper.notes || '')
  const [noteError, setNoteError] = useState('')
  const [noteSaving, setNoteSaving] = useState(false)
  const dirty = note !== (paper.notes || '')
  const cite = [paper.citation?.author, paper.citation?.journal, paper.citation?.year].filter(Boolean).join(' · ')
  const retracted = paperIndicatesRetraction(paper)
  const hasScore = paper.score != null && Number.isFinite(Number(paper.score))
  const extractionStatus = extractionVersionStatus(paper)
  const detailsId = `paper-details-${String(paper.id || paper.pmid).replace(/[^a-zA-Z0-9_-]/g, '-')}`
  const canRefresh = needsDigestDetails(paper)

  async function commit() {
    if (!dirty || noteSaving) return
    setNoteError('')
    setNoteSaving(true)
    try {
      await onSaveNote(note, noteDraft?.baseline || paper)
      setNoteDraft(null)
    } catch (err) {
      setNoteError(err?.message || 'Note not saved. Your draft is still here.')
    } finally { setNoteSaving(false) }
  }

  async function createDetails() {
    if (!canCreateDetails || !onCreateDetails || refreshStage) return
    setRefreshError('')
    setRefreshStage('fetching')
    try {
      await onCreateDetails((stage) => setRefreshStage(stage))
      setShowDigestDetails(true)
      setRefreshStage('')
    } catch (err) {
      setRefreshStage('')
      setRefreshError(err?.message || 'Digest details could not be created. The saved paper was not changed.')
    }
  }

  const pill = { borderRadius: 7, padding: '3px 9px', fontSize: 11, background: 'var(--surface-2)', color: 'var(--color-fg-dim)', border: 0, cursor: 'pointer' }

  return (
    <div>
      <p style={{ margin: 0, fontSize: 14.5, fontWeight: 500, color: 'var(--color-fg-soft)', lineHeight: 1.4 }}>{paper.title}</p>
      {cite && <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--color-fg-muted)', fontFamily: 'var(--font-mono)' }}>{cite}</p>}
      {retracted && (
        <p role="alert" style={{ margin: '7px 0 0', borderLeft: '2px solid var(--color-domain-vascular)', paddingLeft: 9, fontSize: 12, fontWeight: 600, lineHeight: 1.45, color: 'var(--color-domain-vascular)' }}>
          Retracted — PubMed classifies this article as a Retracted Publication. Do not rely on its findings.
        </p>
      )}

      <div className="flex flex-wrap items-center" style={{ marginTop: 9, gap: 8 }}>
        <HeartButton active={!!paper.favorite} onClick={onToggleFavorite} />
        {hasScore && <span style={{ ...pill, cursor: 'default', fontFamily: 'var(--font-mono)', color: 'var(--color-accent-bright)' }}>Fit {Math.round(Number(paper.score))}</span>}
        {paper.saveSource === 'manual' && <span style={{ ...pill, cursor: 'default' }}>Added manually</span>}
        {paper.saveSource === 'seed' && <span style={{ ...pill, cursor: 'default' }} title="Part of the starter collection for your specialty">Starter</span>}
        {paper.saveSource === 'papertrellis' && <span style={{ ...pill, cursor: 'default' }}>From PaperTrellis</span>}
        {extractionStatus !== 'current' && (
          <span
            title={extractionStatus === 'legacy'
              ? 'Saved before extraction versioning. Its evidence has not been automatically changed.'
              : 'Saved with an older extraction version. Its evidence has not been automatically changed.'}
            style={{ ...pill, cursor: 'default', color: 'var(--color-abstract)' }}
          >
            {extractionStatus === 'legacy' ? 'Legacy extraction' : 'Extraction update available'}
          </span>
        )}
        <button
          type="button"
          onClick={() => setShowDigestDetails((open) => !open)}
          aria-expanded={showDigestDetails}
          aria-controls={detailsId}
          style={{ ...pill, color: 'var(--color-verified-soft)', fontFamily: 'var(--font-mono)' }}
        >
          {showDigestDetails ? '▾ Hide digest details' : '▸ Digest details'}
        </button>
        <SharePaperButton paper={paper} />
        {canRefresh && (
          <button
            type="button"
            onClick={createDetails}
            disabled={!canCreateDetails || !!refreshStage}
            title={!canCreateDetails ? 'Sign in or set your API key in Settings to create digest details' : 'Re-reads and verifies this paper'}
            style={{ ...pill, background: 'rgba(230,184,119,.12)', color: 'var(--color-abstract)', fontWeight: 600, opacity: !canCreateDetails || refreshStage ? 0.55 : 1 }}
          >
            {refreshStage ? (REFRESH_STAGE_LABEL[refreshStage] || 'Working…') : '✦ Create digest details'}
          </button>
        )}
        <button onClick={onDelete} className="cursor-pointer" style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--color-fg-faint)', background: 'transparent', border: 0 }}>Delete</button>
      </div>

      {refreshError && (
        <p role="alert" style={{ margin: '8px 0 0', fontSize: 11.5, lineHeight: 1.45, color: 'var(--color-domain-vascular)' }}>
          {refreshError}
        </p>
      )}

      {showDigestDetails && <div id={detailsId}><SavedDigestDetails paper={paper} /></div>}

      {Array.isArray(paper.trellisProjects) && paper.trellisProjects.length > 0 && (
        <p style={{ margin: '8px 0 0', fontSize: 11.5, lineHeight: 1.5, color: 'var(--color-fg-muted)' }}>
          Used in PaperTrellis:{' '}
          {paper.trellisProjects.map((project, index) => (
            <span key={project.id || index}>
              {index > 0 && ', '}
              <a
                href={`${PAPERTRELLIS_URL}/projects/${project.id}/literature`}
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--color-verified-soft)', textDecoration: 'none' }}
              >
                {project.title || 'a project'}
              </a>
            </span>
          ))}
        </p>
      )}

      <TagRow tags={paper.tags} onRemove={onRemoveTag} />

      <div style={{ marginTop: 10 }}>
        <textarea
          value={note}
          disabled={noteSaving}
          onChange={(e) => { const text = e.target.value; setNoteDraft((draft) => ({ text, baseline: draft?.baseline || paper })) }}
          onBlur={commit}
          rows={note ? 2 : 1}
          placeholder="Add a note…"
          style={{ width: '100%', resize: 'vertical', borderRadius: 8, border: '1px solid var(--hairline)', background: 'var(--surface-input)', padding: '6px 9px', fontSize: 12, color: 'var(--color-fg-soft)', fontFamily: 'inherit', outline: 'none' }}
        />
        {noteError && <p role="alert" style={{ fontSize: 12, color: 'var(--color-domain-vascular)' }}>{noteError}</p>}
        {dirty && (
          <button disabled={noteSaving} onClick={commit} className="cursor-pointer" style={{ marginTop: 6, borderRadius: 7, background: 'var(--color-accent)', color: '#1c1206', padding: '3px 10px', fontSize: 11, fontWeight: 600, border: 0 }}>Save note</button>
        )}
      </div>
    </div>
  )
}

// Removable tag chips (the prune control). `max` caps how many show at once so a concept that
// accrued many tags doesn't drown the card; the rest collapse behind a "+N more" toggle.
function TagRow({ tags, onRemove, max }) {
  const [expanded, setExpanded] = useState(false)
  if (!tags?.length) return null
  const capped = max && !expanded ? tags.slice(0, max) : tags
  const hidden = tags.length - capped.length
  return (
    <div className="flex flex-wrap items-center" style={{ marginTop: 10, gap: 6 }}>
      {capped.map((t) => (
        <span key={t} className="inline-flex items-center" style={{ gap: 4, borderRadius: 999, background: 'var(--surface-2)', padding: '2px 4px 2px 10px', fontSize: 10.5, color: 'var(--color-fg-dim)' }}>
          {t}
          <button onClick={() => onRemove(t)} aria-label={`Remove tag ${t}`} className="cursor-pointer" style={{ borderRadius: 999, padding: '0 4px', color: 'var(--color-fg-faint)', background: 'transparent', border: 0 }}>×</button>
        </span>
      ))}
      {(hidden > 0 || (max && expanded && tags.length > max)) && (
        <button onClick={() => setExpanded((e) => !e)} className="cursor-pointer" style={{ borderRadius: 999, padding: '2px 8px', fontSize: 10.5, color: 'var(--color-fg-muted)', background: 'transparent', border: 0 }}>
          {expanded ? 'show fewer' : `+${hidden} more`}
        </button>
      )}
    </div>
  )
}

function FilterChip({ active, color, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center cursor-pointer"
      style={{
        gap: 7,
        padding: '6px 13px',
        borderRadius: 999,
        fontSize: 12.5,
        fontWeight: active ? 600 : 400,
        border: 0,
        background: active ? '#eef0f4' : 'var(--surface-2)',
        color: active ? '#14161c' : 'var(--color-fg-soft)',
        fontFamily: 'inherit',
      }}
    >
      {color && !active && <span style={{ width: 7, height: 7, borderRadius: '50%', background: color }} />}
      {children}
    </button>
  )
}
