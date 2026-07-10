// components/ConstellationView.jsx — the "Constellations" page: roam your knowledge as a
// star map of CONCEPTS and confirm the connections the app (and Claude) propose.
//
// Nodes are concepts (topic/"wiki" stars), not individual papers — mirroring the clinician's
// real KG. North stars + projects are the bright anchors; each concept aggregates its source
// papers under a synthesized evidence summary. Structural noticing proposes the obvious /
// serendipitous links for free; Claude proposes semantic ones on demand. Every proposal is a
// dashed, pulsing "maybe" until the clinician clicks it — then StarMap charts the line.
// Styled to the observatory design (Verastar.dc.html): a full-bleed star field + right detail rail.

import { useEffect, useRef, useState } from 'react'
import { hasApiKey } from '../lib/anthropic.js'
import { getProfile, store } from '../lib/store.js'
import {
  loadGraph,
  syncAnchors,
  proposeEdge,
  dismissEdge,
  removeNode,
  refreshStructuralSuggestions,
  confirmAllEdges,
} from '../pipeline/graph.js'
import { proposeConnections } from '../pipeline/connect.js'
import { DOMAINS, PROJECT_COLOR, domainColor, domainLabel } from '../lib/domains.js'
import StarMap from './StarMap.jsx'

const KIND_LABEL = { northStar: 'North star', project: 'Project', concept: 'Concept' }

export default function ConstellationView() {
  const [nodes, setNodes] = useState([])
  const [edges, setEdges] = useState([])
  const [papers, setPapers] = useState([]) // all KB papers (source articles for concepts)
  const [selectedId, setSelectedId] = useState(null)
  const [openPaper, setOpenPaper] = useState(null) // pmid whose summary is expanded
  const [busy, setBusy] = useState('') // '', 'loading', 'proposing'
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const keySet = hasApiKey()
  const didInit = useRef(false)

  async function refresh() {
    const { nodes, edges } = await loadGraph()
    const kb = (await store.all('papers')) || []
    setNodes(nodes)
    setEdges(edges)
    setPapers(kb)
    return { nodes, edges }
  }

  // On mount: sync anchors from the profile, notice the free structural connections between
  // the concept stars, then render. (Concept stars are created at deposit time.)
  useEffect(() => {
    if (didInit.current) return
    didInit.current = true
    ;(async () => {
      setBusy('loading')
      try {
        await syncAnchors(await getProfile())
        await refreshStructuralSuggestions()
        await confirmAllEdges() // connections just appear — promote any legacy "suggested" links
        await refresh()
      } catch (err) {
        setError(err.message)
      }
      setBusy('')
    })()
  }, [])

  const selected = nodes.find((n) => n.id === selectedId) || null
  const neighborsOf = (id) =>
    edges
      .filter((e) => e.source === id || e.target === id)
      .map((e) => ({ edge: e, other: nodes.find((n) => n.id === (e.source === id ? e.target : e.source)) }))
      .filter((x) => x.other)

  // The source papers filed under a concept (by conceptId, or the concept's pmid set).
  const sourcePapersOf = (node) =>
    papers.filter((p) => p.conceptId === node.id || (node.sourcePmids || []).includes(String(p.pmid)))

  async function handleDismiss(edge) {
    setNote('')
    await dismissEdge(edge.id)
    await refresh()
  }
  async function handleRemoveNode(id) {
    await removeNode(id)
    setSelectedId(null)
    await refresh()
  }

  // Ask Claude to propose semantic connections for the selected concept. Framed as
  // suggestions: every returned link lands as a dashed "maybe" to confirm.
  async function askClaude() {
    if (!selected || selected.kind !== 'concept' || !keySet) return
    setBusy('proposing')
    setError('')
    try {
      const candidates = nodes
        .filter((n) => n.id !== selected.id)
        .map((n) => ({ id: n.id, kind: n.kind, label: n.label }))
      const conns = await proposeConnections({
        paper: { title: selected.label, finding: selected.summary, relevance: '' },
        candidates,
      })
      const existingIds = new Set(edges.map((e) => e.id))
      let added = 0
      for (const c of conns) {
        const e = await proposeEdge({
          source: selected.id,
          target: c.target_id,
          rationale: c.rationale,
          origin: 'claude',
        })
        if (e && !existingIds.has(e.id)) added++ // count only brand-new links
      }
      await refresh()
      setNote(
        added
          ? `Claude linked ${added} new connection${added === 1 ? '' : 's'}.`
          : 'Claude found no new connections for this concept.',
      )
    } catch (err) {
      setError(`Connection proposal failed: ${err.message}`)
    }
    setBusy('')
  }

  const connectionCount = edges.length
  const conceptCount = nodes.filter((n) => n.kind === 'concept').length

  // The standing status line, always derived from live state so it never goes stale.
  const statusLine =
    busy === 'loading'
      ? 'Mapping your concepts…'
      : busy === 'proposing'
        ? 'Claude is looking for connections…'
        : note
          ? note
          : connectionCount
            ? 'Hover a star to light its connections; click to read its evidence.'
            : 'Save papers from today\'s digest — they group into concept stars that link themselves.'

  return (
    <div className="flex" style={{ height: '100%', minHeight: '100%' }}>
      {/* star field */}
      <div className="relative" style={{ flex: 1, minWidth: 0, overflow: 'hidden', background: 'radial-gradient(120% 90% at 60% 30%,#141a2e,#080a12 70%)' }}>
        <div className="vs-stars absolute" style={{ inset: 0, opacity: 1 }} />
        <StarMap
          nodes={nodes}
          edges={edges}
          selectedId={selectedId}
          onSelectNode={(n) => {
            setSelectedId(n.id)
            setOpenPaper(null)
          }}
          onBackground={() => setSelectedId(null)}
        />
        {/* status ribbon, top-left over the field */}
        <div className="absolute" style={{ top: 20, left: 24, right: 24, pointerEvents: 'none' }}>
          <p style={{ margin: 0, fontSize: 12, letterSpacing: '.15em', textTransform: 'uppercase', color: 'var(--color-fg-faint)', fontWeight: 600 }}>Constellations</p>
          <p style={{ margin: '6px 0 0', fontSize: 13, color: error ? 'var(--color-domain-vascular)' : 'var(--color-accent)' }}>{error || statusLine}</p>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--color-fg-faint)', fontFamily: 'var(--font-mono)' }}>{conceptCount} concepts · {connectionCount} connections</p>
        </div>
        {nodes.length === 0 && busy !== 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center" style={{ padding: 32, textAlign: 'center' }}>
            <p style={{ fontSize: 14, color: 'var(--color-fg-muted)', maxWidth: 360 }}>
              No stars yet. Add north stars and projects in your profile, and save papers from a scan — they'll group into concept stars here.
            </p>
          </div>
        )}
      </div>

      {/* detail panel */}
      <aside style={{ width: 340, flex: '0 0 auto', padding: '34px 28px', overflowY: 'auto', borderLeft: '1px solid var(--hairline)', background: 'rgba(255,255,255,.012)' }}>
        {!selected ? (
          <div style={{ fontSize: 14, color: 'var(--color-fg-dim)' }}>
            <p style={{ margin: 0, fontWeight: 600, color: 'var(--color-fg-soft)' }}>Roam the map</p>
            <p style={{ margin: '8px 0 0', lineHeight: 1.6 }}>
              Drag to pan, scroll to zoom. Hover a star to light its connections; click it to read its synthesized summary and source papers. Bigger stars have more connections.
            </p>
            <div style={{ marginTop: 20, borderTop: '1px solid var(--hairline)', paddingTop: 16 }}>
              <p style={{ margin: '0 0 10px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.14em', color: 'var(--color-fg-faint)' }}>Fields</p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 7 }}>
                {DOMAINS.map((d) => (
                  <span key={d.key} className="inline-flex items-center" style={{ gap: 9, fontSize: 12.5, color: 'var(--color-fg-soft)' }}>
                    <ColorDot color={d.color} /> {d.label}
                  </span>
                ))}
                <span className="inline-flex items-center" style={{ gap: 9, fontSize: 12.5, color: 'var(--color-fg-soft)', marginTop: 4, borderTop: '1px solid var(--hairline)', paddingTop: 8 }}>
                  <ColorDot color={PROJECT_COLOR} /> Project (anchor)
                </span>
              </div>
            </div>
          </div>
        ) : (
          <NodePanel
            node={selected}
            color={selected.kind === 'concept' ? domainColor(selected.domain) : PROJECT_COLOR}
            categoryLabel={selected.kind === 'concept' ? domainLabel(selected.domain) : KIND_LABEL[selected.kind]}
            sources={sourcePapersOf(selected)}
            connections={neighborsOf(selected.id)}
            openPaper={openPaper}
            onTogglePaper={(pmid) => setOpenPaper((cur) => (cur === pmid ? null : pmid))}
            onAskClaude={askClaude}
            onDismiss={handleDismiss}
            onRemove={() => handleRemoveNode(selected.id)}
            keySet={keySet}
            proposing={busy === 'proposing'}
            canAsk={selected.kind === 'concept'}
            canRemove={selected.kind === 'concept'}
          />
        )}
      </aside>
    </div>
  )
}

// A node's detail — mirrors the clinician's KG panel: colored category header, title, synthesized
// summary, source papers (each with a Summary toggle + Open source / PDF), tags, and connections.
function NodePanel({
  node,
  color,
  categoryLabel,
  sources,
  connections,
  openPaper,
  onTogglePaper,
  onAskClaude,
  onDismiss,
  onRemove,
  keySet,
  proposing,
  canAsk,
  canRemove,
}) {
  const isHub = node.isHub
  const pill = { borderRadius: 7, padding: '3px 9px', fontSize: 11, background: 'var(--surface-2)', color: 'var(--color-fg-dim)', border: 0, cursor: 'pointer' }
  return (
    <div>
      <div className="flex items-center" style={{ gap: 8 }}>
        <span className="inline-flex items-center" style={{ gap: 7, fontSize: 11, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, boxShadow: `0 0 8px ${color}` }} />
          {categoryLabel}
        </span>
        {isHub && (
          <span style={{ borderRadius: 999, border: `1px solid ${color}`, padding: '1px 6px', fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', color }}>Hub</span>
        )}
      </div>
      <h3 style={{ margin: '10px 0 0', fontFamily: 'var(--font-serif)', fontSize: 22, fontWeight: 500, lineHeight: 1.25, color: 'var(--color-fg)' }}>{node.label}</h3>

      {node.summary ? (
        <p style={{ margin: '12px 0 0', fontSize: 14, lineHeight: 1.6, color: 'var(--color-fg-soft)' }}>{node.summary}</p>
      ) : isHub ? (
        <p style={{ margin: '12px 0 0', fontSize: 14, fontStyle: 'italic', color: 'var(--color-fg-faint)' }}>A broad topic gathering the concepts below — click a linked concept to read its evidence.</p>
      ) : (
        <p style={{ margin: '12px 0 0', fontSize: 14, fontStyle: 'italic', color: 'var(--color-fg-faint)' }}>Summary pending — add another paper or re-open after the scan to synthesize it.</p>
      )}

      {node.tags?.length > 0 && (
        <div className="flex flex-wrap" style={{ marginTop: 10, gap: 6 }}>
          {node.tags.map((t) => (
            <span key={t} style={{ borderRadius: 999, background: 'var(--surface-2)', padding: '2px 10px', fontSize: 10.5, color: 'var(--color-fg-dim)' }}>{t}</span>
          ))}
        </div>
      )}

      {canAsk && keySet && (
        <button
          onClick={onAskClaude}
          disabled={proposing}
          className="cursor-pointer"
          style={{ marginTop: 18, width: '100%', padding: 11, border: 0, borderRadius: 11, background: 'rgba(239,143,91,.14)', color: 'var(--color-accent-bright)', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', opacity: proposing ? 0.6 : 1 }}
        >
          {proposing ? 'Linking…' : '✶ Find more connections with Claude'}
        </button>
      )}

      {/* SOURCE ARTICLES — hidden for a pure hub (no papers of its own; its concepts are below) */}
      {!(isHub && sources.length === 0) && (
        <div style={{ marginTop: 26 }}>
          <p style={{ margin: '0 0 12px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.14em', color: 'var(--color-fg-faint)' }}>Source articles ({sources.length})</p>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {sources.map((p) => {
              const cite = [p.citation?.author, p.citation?.journal, p.citation?.year].filter(Boolean).join(' · ')
              const isOpen = openPaper === p.pmid
              return (
                <li key={p.pmid} style={{ padding: '13px 15px', borderRadius: 11, background: 'var(--surface-1)' }}>
                  <p style={{ margin: 0, fontSize: 13, fontWeight: 500, color: 'var(--color-fg-soft)', lineHeight: 1.4 }}>{p.title}</p>
                  {cite && <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--color-fg-muted)', fontFamily: 'var(--font-mono)' }}>{cite}</p>}
                  <div className="flex flex-wrap items-center" style={{ marginTop: 9, gap: 8 }}>
                    {p.finding && <button onClick={() => onTogglePaper(p.pmid)} style={pill}>{isOpen ? 'Hide summary' : 'Summary'}</button>}
                    <a href={p.citation?.url || `https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11.5, color: 'var(--color-accent)' }}>Open source ↗</a>
                    {p.pdfUrl && <a href={p.pdfUrl} target="_blank" rel="noopener noreferrer" style={{ borderRadius: 7, padding: '3px 9px', fontSize: 11, fontWeight: 600, color: '#fff', background: 'rgba(224,96,90,.85)' }}>PDF</a>}
                  </div>
                  {isOpen && p.finding && <p style={{ margin: '9px 0 0', borderTop: '1px solid var(--hairline)', paddingTop: 9, fontSize: 12, lineHeight: 1.5, color: 'var(--color-fg-dim)' }}>{p.finding}</p>}
                </li>
              )
            })}
            {sources.length === 0 && <li style={{ fontSize: 12, color: 'var(--color-fg-faint)' }}>No source papers linked yet.</li>}
          </ul>
        </div>
      )}

      <ConnectionList connections={connections} onDismiss={onDismiss} />

      {canRemove && (
        <button onClick={onRemove} className="cursor-pointer" style={{ marginTop: 20, fontSize: 12, color: 'var(--color-domain-vascular)', background: 'transparent', border: 0 }}>Remove concept from map</button>
      )}
    </div>
  )
}

// Connections just exist (the app links related concepts automatically). Each row names the
// neighbor + why they're linked; a subtle × prunes a wrong auto-link (the only manual control).
function ConnectionList({ connections, onDismiss }) {
  return (
    <div style={{ marginTop: 26 }}>
      <p style={{ margin: '0 0 12px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.14em', color: 'var(--color-fg-faint)' }}>Connections ({connections.length})</p>
      <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 9 }}>
        {connections.map(({ edge, other }) => (
          <li key={edge.id} className="group" style={{ padding: '12px 15px', borderRadius: 11, background: 'var(--surface-1)' }}>
            <div className="flex items-center justify-between" style={{ gap: 8 }}>
              <span className="min-w-0 truncate" style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-fg-soft)' }}>{other.label}</span>
              <button onClick={() => onDismiss(edge)} title="Unlink" className="shrink-0 cursor-pointer opacity-0 transition group-hover:opacity-100" style={{ color: 'var(--color-fg-faint)', background: 'transparent', border: 0 }}>✕</button>
            </div>
            {edge.rationale && <p style={{ margin: '3px 0 0', fontSize: 12, fontStyle: 'italic', color: 'var(--color-fg-muted)' }}>{edge.rationale}</p>}
          </li>
        ))}
        {connections.length === 0 && <li style={{ fontSize: 12, color: 'var(--color-fg-faint)' }}>No connections yet.</li>}
      </ul>
    </div>
  )
}

function ColorDot({ color }) {
  return <span className="inline-block shrink-0" style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
}
