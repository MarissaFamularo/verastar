// components/KnowledgeBase.jsx — the "Knowledge Base" page: browse everything you've saved, the
// way the clinician browses her real KG. Concepts are the top level (topic "wiki" nodes grouping
// source papers under one synthesized summary), each in one broad DOMAIN. Search reaches title,
// summary, and tags across the concept and its papers; a domain filter narrows by her taxonomy.
//
// This is also where "Claude applies, you prune" completes: notes and tags are editable here. The
// "Re-file with Claude" action re-classifies existing saves into concepts/domains. buildKB
// (lib/kb.js) does the pure search/filter. Styled to the observatory design (Verastar.dc.html);
// the flat-file vault lives on its own Library surface now.

import { useEffect, useMemo, useRef, useState } from 'react'
import { store } from '../lib/store.js'
import { hasApiKey } from '../lib/anthropic.js'
import { loadConcepts, setConceptTags, removeNode } from '../pipeline/graph.js'
import { refileKB } from '../pipeline/deposit.js'
import { buildKB } from '../lib/kb.js'
import { backfillOaPdfs } from '../pipeline/save.js'
import { listDomains, domainColor, domainLabel } from '../lib/domains.js'
import AddPaper from './AddPaper.jsx'
import FileToDisk from './LibraryPanel.jsx'

export default function KnowledgeBase() {
  const [concepts, setConcepts] = useState([])
  const [papers, setPapers] = useState([])
  const [query, setQuery] = useState('')
  const [domain, setDomain] = useState('all')
  const [loading, setLoading] = useState(true)
  const [refiling, setRefiling] = useState('') // '' | progress string
  const [confirmRefile, setConfirmRefile] = useState(false)
  const keySet = hasApiKey()

  async function refresh() {
    const [c, p] = await Promise.all([loadConcepts(), store.all('papers')])
    setConcepts(c || [])
    setPapers(p || [])
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
    })()
  }, [])

  const { groups, unfiled, counts } = useMemo(
    () => buildKB(concepts, papers, { query, domain }),
    [concepts, papers, query, domain],
  )

  // --- mutations (persist, then patch local state so edits feel instant) ---

  async function savePaper(id, patch) {
    const current = await store.get('papers', id)
    if (!current) return
    const next = { ...current, ...patch }
    await store.put('papers', id, next)
    setPapers((prev) => prev.map((p) => (p.id === id ? next : p)))
  }

  async function removePaperTag(paper, tag) {
    await savePaper(paper.id, { tags: (paper.tags || []).filter((t) => t !== tag) })
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

  async function deletePaper(paper) {
    await store.delete('papers', paper.id)
    setPapers((prev) => prev.filter((p) => p.id !== paper.id))
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

  const totalConcepts = concepts.length
  const totalPapers = papers.length

  return (
    <div className="vs-page-pad" style={{ maxWidth: 1240, padding: '46px 56px 64px' }}>
      <div style={{ display: 'flex', gap: 40, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 440px', minWidth: 0, maxWidth: 720 }}>
      <p style={{ margin: 0, fontSize: 12, letterSpacing: '.15em', textTransform: 'uppercase', color: 'var(--color-fg-faint)', fontWeight: 600 }}>Your knowledge graph</p>
      <div className="flex items-end justify-between" style={{ gap: 20, marginTop: 9 }}>
        <h1 style={{ margin: 0, fontFamily: 'var(--font-serif)', fontSize: 34, fontWeight: 500, letterSpacing: '-.01em', color: 'var(--color-fg)' }}>Library</h1>
        <div className="flex items-center" style={{ gap: 14 }}>
          {keySet && totalPapers > 0 &&
            (refiling ? (
              <span style={{ fontSize: 12, color: 'var(--color-accent)', fontFamily: 'var(--font-mono)' }}>{refiling}</span>
            ) : confirmRefile ? (
              <span className="flex items-center" style={{ gap: 8, fontSize: 12 }}>
                <span style={{ color: 'var(--color-fg-muted)' }}>Re-run Claude on all {totalPapers}?</span>
                <button onClick={handleRefile} className="cursor-pointer" style={{ borderRadius: 8, background: 'var(--color-accent)', color: '#1c1206', padding: '3px 10px', fontWeight: 600, border: 0 }}>Re-file</button>
                <button onClick={() => setConfirmRefile(false)} className="cursor-pointer" style={{ color: 'var(--color-fg-muted)', background: 'transparent', border: 0 }}>cancel</button>
              </span>
            ) : (
              <button
                onClick={() => setConfirmRefile(true)}
                title="Re-classify every saved paper into concepts + domains"
                className="inline-flex items-center cursor-pointer"
                style={{ gap: 7, padding: '6px 12px', borderRadius: 9, border: '1px solid rgba(255,255,255,.1)', color: 'var(--color-fg-soft)', fontSize: 12.5, background: 'transparent' }}
              >
                ↻ Re-file with Claude
              </button>
            ))}
          <span style={{ fontSize: 13, color: 'var(--color-fg-muted)', fontFamily: 'var(--font-mono)' }}>
            {totalConcepts} concept{totalConcepts === 1 ? '' : 's'} · {totalPapers} paper{totalPapers === 1 ? '' : 's'}
          </span>
        </div>
      </div>
      <p style={{ margin: '12px 0 0', fontSize: 15, color: 'var(--color-fg-dim)', maxWidth: 640, lineHeight: 1.55 }}>
        Everything you've saved, grouped into concept nodes and colored by domain. Search title, summary, and tags;
        filter by domain. Claude tags each paper on deposit — prune what's wrong and add your own notes.
      </p>

      {/* search + domain filter */}
      <div className="flex items-center" style={{ marginTop: 26, gap: 12, background: 'var(--surface-2)', borderRadius: 12, padding: '11px 15px' }}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--color-fg-muted)" strokeWidth="1.8"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search title, summary, tags…"
          style={{ flex: 1, background: 'transparent', border: 0, outline: 'none', color: 'var(--color-fg)', fontSize: 14, fontFamily: 'inherit' }}
        />
        {query && (
          <button onClick={() => setQuery('')} className="cursor-pointer" style={{ fontSize: 12, color: 'var(--color-fg-muted)', background: 'transparent', border: 0 }}>clear</button>
        )}
      </div>
      <div className="flex flex-wrap" style={{ marginTop: 14, gap: 8 }}>
        <FilterChip active={domain === 'all'} onClick={() => setDomain('all')}>All domains</FilterChip>
        {listDomains().map((d) => (
          <FilterChip key={d.key} active={domain === d.key} color={d.color} onClick={() => setDomain(d.key)}>{d.label}</FilterChip>
        ))}
      </div>

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
            No matches for “{query}”{domain !== 'all' ? ` in ${domainLabel(domain)}` : ''}.
          </p>
        ) : (
          <>
            {groups.map(({ group, papers }) => (
              <ConceptCard
                key={group.id}
                concept={group}
                papers={papers}
                query={query}
                onRemoveConceptTag={(t) => removeConceptTag(group, t)}
                onRemovePaperTag={removePaperTag}
                onSaveNote={(id, notes) => savePaper(id, { notes })}
                onDeleteConcept={() => deleteConcept(group)}
                onDeletePaper={deletePaper}
              />
            ))}
            {unfiled.length > 0 && (
              <div style={{ borderRadius: 16, border: '1px dashed rgba(255,255,255,.12)', padding: 20 }}>
                <p style={{ margin: 0, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--color-fg-muted)' }}>
                  Unfiled ({unfiled.length}) — not yet grouped into a concept
                </p>
                <ul style={{ margin: '12px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {unfiled.map((p) => (
                    <PaperRow key={p.id} paper={p} onRemoveTag={(t) => removePaperTag(p, t)} onSaveNote={(notes) => savePaper(p.id, { notes })} onDelete={() => deletePaper(p)} />
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

// One concept node: colored DOMAIN eyebrow + glow dot, Spectral title, synthesized summary,
// prunable concept tags, and the source papers under it (each with an editable note + tags).
function ConceptCard({ concept, papers, query, onRemoveConceptTag, onRemovePaperTag, onSaveNote, onDeleteConcept, onDeletePaper }) {
  const [open, setOpen] = useState(true)
  const color = domainColor(concept.domain)
  return (
    <div style={{ borderRadius: 16, overflow: 'hidden', background: 'var(--surface-1)' }}>
      <div style={{ padding: '24px 26px 22px' }}>
        <div className="flex items-start justify-between" style={{ gap: 16 }}>
          <div className="min-w-0">
            <span className="inline-flex items-center" style={{ gap: 7, fontSize: 11, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, boxShadow: `0 0 8px ${color}` }} />
              {domainLabel(concept.domain)}
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
              <PaperRow paper={p} onRemoveTag={(t) => onRemovePaperTag(p, t)} onSaveNote={(notes) => onSaveNote(p.id, notes)} onDelete={() => onDeletePaper(p)} />
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

// One saved paper: title, mono citation, collapsible finding, editable note, prunable tags, links.
function PaperRow({ paper, onRemoveTag, onSaveNote, onDelete }) {
  const [showFinding, setShowFinding] = useState(false)
  const [note, setNote] = useState(paper.notes || '')
  const dirty = note !== (paper.notes || '')
  const cite = [paper.citation?.author, paper.citation?.journal, paper.citation?.year].filter(Boolean).join(' · ')

  const lastSaved = useRef(paper.notes || '')
  useEffect(() => {
    if ((paper.notes || '') !== lastSaved.current) {
      lastSaved.current = paper.notes || ''
      setNote(paper.notes || '')
    }
  }, [paper.notes])

  function commit() {
    if (!dirty) return
    lastSaved.current = note
    onSaveNote(note)
  }

  const pill = { borderRadius: 7, padding: '3px 9px', fontSize: 11, background: 'var(--surface-2)', color: 'var(--color-fg-dim)', border: 0, cursor: 'pointer' }

  // Share the paper itself (canonical PubMed/DOI link, not app state): native share sheet
  // on phones, mailto fallback on desktop. A cancelled share sheet rejects — that's not an error.
  async function share() {
    const url = paper.citation?.url || `https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/`
    const text = [paper.title, cite].filter(Boolean).join(' — ')
    if (navigator.share) {
      try {
        await navigator.share({ title: paper.title, text, url })
      } catch {}
    } else {
      const ft = paper.pdfUrl || paper.oaUrl
      const body = [text, url, ft && `Full text: ${ft}`].filter(Boolean).join('\n')
      window.location.href = `mailto:?subject=${encodeURIComponent(paper.title)}&body=${encodeURIComponent(body)}`
    }
  }

  return (
    <div>
      <p style={{ margin: 0, fontSize: 14.5, fontWeight: 500, color: 'var(--color-fg-soft)', lineHeight: 1.4 }}>{paper.title}</p>
      {cite && <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--color-fg-muted)', fontFamily: 'var(--font-mono)' }}>{cite}</p>}

      <div className="flex flex-wrap items-center" style={{ marginTop: 9, gap: 8 }}>
        {paper.finding && (
          <button onClick={() => setShowFinding((s) => !s)} style={pill}>{showFinding ? 'Hide summary' : 'Summary'}</button>
        )}
        <a href={paper.citation?.url || `https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/`} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11.5, color: 'var(--color-accent)' }}>
          View article ↗
        </a>
        <button onClick={share} style={{ ...pill, background: 'rgba(239,143,91,.14)', color: 'var(--color-accent-bright)', fontWeight: 600 }}>Share ↑</button>
        {(paper.pdfUrl || paper.oaUrl) && (
          <a href={paper.pdfUrl || paper.oaUrl} target="_blank" rel="noopener noreferrer" style={{ borderRadius: 7, padding: '3px 9px', fontSize: 11, fontWeight: 600, color: '#fff', background: 'rgba(224,96,90,.85)' }}>
            {paper.pdfUrl ? 'PDF' : 'Free full text'}
          </a>
        )}
        <button onClick={onDelete} className="cursor-pointer" style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--color-fg-faint)', background: 'transparent', border: 0 }}>Delete</button>
      </div>

      {showFinding && paper.finding && (
        <p style={{ margin: '9px 0 0', borderLeft: '2px solid var(--hairline)', paddingLeft: 10, fontSize: 12, lineHeight: 1.5, color: 'var(--color-fg-dim)' }}>{paper.finding}</p>
      )}

      <TagRow tags={paper.tags} onRemove={onRemoveTag} />

      <div style={{ marginTop: 10 }}>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={commit}
          rows={note ? 2 : 1}
          placeholder="Add a note…"
          style={{ width: '100%', resize: 'vertical', borderRadius: 8, border: '1px solid var(--hairline)', background: 'var(--surface-input)', padding: '6px 9px', fontSize: 12, color: 'var(--color-fg-soft)', fontFamily: 'inherit', outline: 'none' }}
        />
        {dirty && (
          <button onClick={commit} className="cursor-pointer" style={{ marginTop: 6, borderRadius: 7, background: 'var(--color-accent)', color: '#1c1206', padding: '3px 10px', fontSize: 11, fontWeight: 600, border: 0 }}>Save note</button>
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
