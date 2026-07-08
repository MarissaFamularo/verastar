// components/ConstellationView.jsx — the "Constellations" page: roam your knowledge as a
// star map of CONCEPTS and confirm the connections the app (and Claude) propose.
//
// Nodes are concepts (topic/"wiki" stars), not individual papers — mirroring the clinician's
// real KG. North stars + projects are the bright anchors; each concept aggregates its source
// papers under a synthesized evidence summary. Structural noticing proposes the obvious /
// serendipitous links for free; Claude proposes semantic ones on demand. Every proposal is a
// dashed, pulsing "maybe" until the clinician clicks it — then StarMap charts the line.

import { useEffect, useRef, useState } from 'react'
import { hasApiKey } from '../lib/anthropic.js'
import { getProfile, store } from '../lib/store.js'
import {
  loadGraph,
  syncAnchors,
  proposeEdge,
  confirmEdge,
  dismissEdge,
  removeNode,
  refreshStructuralSuggestions,
} from '../pipeline/graph.js'
import { proposeConnections } from '../pipeline/connect.js'
import { categoryList, categoryMap, colorOf, categoryLabelOf } from '../lib/domains.js'
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
        await refresh()
      } catch (err) {
        setError(err.message)
      }
      setBusy('')
    })()
  }, [])

  const catMap = categoryMap(nodes)
  const categories = categoryList(nodes)
  const isAnchor = (n) => n?.kind === 'northStar' || n?.kind === 'project'

  const selected = nodes.find((n) => n.id === selectedId) || null
  const neighborsOf = (id) =>
    edges
      .filter((e) => e.source === id || e.target === id)
      .map((e) => ({ edge: e, other: nodes.find((n) => n.id === (e.source === id ? e.target : e.source)) }))
      .filter((x) => x.other)

  // The source papers filed under a node: a concept (by conceptId / its pmid set), or a category
  // anchor holding papers directly (paper.category === anchor.id with no concept / its pmid set).
  const sourcePapersOf = (node) =>
    papers.filter(
      (p) =>
        p.conceptId === node.id ||
        (isAnchor(node) && !p.conceptId && p.category === node.id) ||
        (node.sourcePmids || []).includes(String(p.pmid)),
    )

  async function handleConfirm(edge) {
    setNote('')
    await confirmEdge(edge.id)
    await refresh()
  }
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
      let added = 0
      for (const c of conns) {
        const e = await proposeEdge({
          source: selected.id,
          target: c.target_id,
          rationale: c.rationale,
          origin: 'claude',
        })
        if (e) added++
      }
      await refresh()
      setNote(
        added
          ? `Claude proposed ${added} connection${added === 1 ? '' : 's'} — click a glowing marker to confirm.`
          : 'Claude found no new connections for this concept.',
      )
    } catch (err) {
      setError(`Connection proposal failed: ${err.message}`)
    }
    setBusy('')
  }

  const suggestedCount = edges.filter((e) => e.status === 'suggested').length
  const confirmedCount = edges.filter((e) => e.status === 'confirmed').length
  const conceptCount = nodes.filter((n) => n.kind === 'concept').length

  // The standing status line, always derived from live state so it never goes stale.
  const statusLine =
    busy === 'loading'
      ? 'Mapping your concepts…'
      : busy === 'proposing'
        ? 'Claude is looking for connections…'
        : note
          ? note
          : suggestedCount
            ? `${suggestedCount} connection${suggestedCount === 1 ? '' : 's'} waiting — click a glowing marker to chart it.`
            : 'Save papers from your scan — they group into concept stars you can connect.'

  return (
    <section className="mt-8 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="border-b border-slate-200 p-6 dark:border-slate-800">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-medium">Constellations</h2>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
              Your knowledge as a star map. North stars and projects are the bright anchors; each
              concept star gathers its source papers under one synthesized summary. The app proposes
              connections — dashed and pulsing — and you chart them into constellations.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
            <span>{conceptCount} concepts</span>
            <span>{confirmedCount} charted</span>
            <span className="text-amber-500 dark:text-amber-400">{suggestedCount} proposed</span>
          </div>
        </div>
        {!error && <p className="mt-3 text-sm text-indigo-600 dark:text-indigo-300">{statusLine}</p>}
        {error && <p className="mt-3 text-sm text-rose-600 dark:text-rose-400">{error}</p>}
      </div>

      <div className="grid gap-0 lg:grid-cols-[1fr_340px]">
        {/* the map */}
        <div className="relative h-[560px] bg-[#05070f]">
          <StarMap
            nodes={nodes}
            edges={edges}
            selectedId={selectedId}
            onSelectNode={(n) => {
              setSelectedId(n.id)
              setOpenPaper(null)
            }}
            onConfirmEdge={handleConfirm}
            onBackground={() => setSelectedId(null)}
          />
          {nodes.length === 0 && busy !== 'loading' && (
            <div className="absolute inset-0 flex items-center justify-center p-8 text-center">
              <p className="text-sm text-slate-400">
                No stars yet. Add north stars and projects in your profile, and save papers from a
                scan — they'll group into concept stars here.
              </p>
            </div>
          )}
        </div>

        {/* detail panel */}
        <div className="max-h-[560px] overflow-y-auto border-t border-slate-200 p-4 dark:border-slate-800 lg:border-l lg:border-t-0">
          {!selected ? (
            <div className="text-sm text-slate-500 dark:text-slate-400">
              <p className="font-medium text-slate-700 dark:text-slate-300">Roam the map</p>
              <p className="mt-1">
                Drag to pan, scroll to zoom. Click a concept star to read its synthesized summary and
                source papers. Click a pulsing gold marker to confirm a proposed connection.
              </p>
              {/* legend lives here (not over the map) so it never covers a low star. Colors are
                  the clinician's own categories — each north star / project — and concepts take
                  the color of the category they belong to. */}
              <div className="mt-4 border-t border-slate-200 pt-3 dark:border-slate-800">
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  Your categories
                </p>
                {categories.length ? (
                  <div className="grid grid-cols-1 gap-y-1">
                    {categories.map((c) => (
                      <div key={c.key} className="flex items-center gap-2">
                        <ColorDot color={c.color} /> {c.label}
                        <span className="text-[10px] text-slate-400">
                          {c.kind === 'project' ? 'project' : 'north star'}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs italic text-slate-400">
                    Add north stars and projects in your profile — they become your categories.
                  </p>
                )}
                <p className="mt-2 border-t border-slate-200 pt-2 dark:border-slate-800">
                  <span className="text-amber-500 dark:text-amber-400">◌ pulsing</span> = proposed · click
                  to chart · solid = confirmed
                </p>
              </div>
            </div>
          ) : (
            <NodePanel
              node={selected}
              color={colorOf(selected, catMap)}
              categoryLabel={
                selected.kind === 'concept'
                  ? categoryLabelOf(selected, catMap)
                  : KIND_LABEL[selected.kind]
              }
              sources={sourcePapersOf(selected)}
              connections={neighborsOf(selected.id)}
              openPaper={openPaper}
              onTogglePaper={(pmid) => setOpenPaper((cur) => (cur === pmid ? null : pmid))}
              onAskClaude={askClaude}
              onConfirm={handleConfirm}
              onDismiss={handleDismiss}
              onRemove={() => handleRemoveNode(selected.id)}
              keySet={keySet}
              proposing={busy === 'proposing'}
              canAsk={selected.kind === 'concept'}
              canRemove={selected.kind === 'concept'}
            />
          )}
        </div>
      </div>
    </section>
  )
}

// A node's detail — mirrors the clinician's KG panel: colored category header, title, synthesized
// summary, source papers (each with a Summary toggle + Open source / PDF), tags, and connections.
// Works for a concept (colored by its parent category) OR a category anchor holding papers
// directly (colored by itself). `canAsk`/`canRemove` gate the concept-only actions.
function NodePanel({
  node,
  color,
  categoryLabel,
  sources,
  connections,
  openPaper,
  onTogglePaper,
  onAskClaude,
  onConfirm,
  onDismiss,
  onRemove,
  keySet,
  proposing,
  canAsk,
  canRemove,
}) {
  return (
    <div>
      <div className="flex items-start justify-between gap-2">
        <span className="text-[11px] font-bold uppercase tracking-wide" style={{ color }}>
          {categoryLabel}
        </span>
      </div>
      <h3 className="mt-1 text-base font-semibold leading-snug text-slate-800 dark:text-slate-100">
        {node.label}
      </h3>

      {node.summary ? (
        <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">{node.summary}</p>
      ) : (
        <p className="mt-2 text-sm italic text-slate-400">
          Summary pending — add another paper or re-open after the scan to synthesize it.
        </p>
      )}

      {node.tags?.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {node.tags.map((t) => (
            <span
              key={t}
              className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300"
            >
              {t}
            </span>
          ))}
        </div>
      )}

      {canAsk && keySet && (
        <button
          onClick={onAskClaude}
          disabled={proposing}
          className="mt-3 w-full rounded-lg bg-indigo-600 px-3 py-2 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {proposing ? 'Proposing…' : '✦ Ask Claude for connections'}
        </button>
      )}

      {/* SOURCE ARTICLES */}
      <div className="mt-4">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Source articles ({sources.length})
        </p>
        <ul className="mt-1.5 space-y-1.5">
          {sources.map((p) => {
            const cite = [p.citation?.author, p.citation?.journal, p.citation?.year].filter(Boolean).join(' · ')
            const isOpen = openPaper === p.pmid
            return (
              <li key={p.pmid} className="rounded-md border border-slate-200 p-2 text-xs dark:border-slate-800">
                <p className="font-medium leading-snug text-slate-700 dark:text-slate-200">{p.title}</p>
                {cite && <p className="mt-0.5 text-slate-500 dark:text-slate-400">{cite}</p>}
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  {p.finding && (
                    <button
                      onClick={() => onTogglePaper(p.pmid)}
                      className="rounded bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                    >
                      {isOpen ? 'Hide summary' : 'Summary'}
                    </button>
                  )}
                  <a
                    href={p.citation?.url || `https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[11px] font-medium text-sky-600 hover:underline dark:text-sky-400"
                  >
                    Open source ↗
                  </a>
                  {p.pdfUrl && (
                    <a
                      href={p.pdfUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded bg-rose-600/90 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-rose-600"
                    >
                      PDF
                    </a>
                  )}
                </div>
                {isOpen && p.finding && (
                  <p className="mt-1.5 border-t border-slate-100 pt-1.5 leading-5 text-slate-600 dark:border-slate-800 dark:text-slate-300">
                    {p.finding}
                  </p>
                )}
              </li>
            )
          })}
          {sources.length === 0 && <li className="text-xs text-slate-400">No source papers linked yet.</li>}
        </ul>
      </div>

      <ConnectionList connections={connections} onConfirm={onConfirm} onDismiss={onDismiss} />

      {canRemove && (
        <button onClick={onRemove} className="mt-4 text-xs font-medium text-rose-500 hover:underline">
          Remove concept from map
        </button>
      )}
    </div>
  )
}

function ConnectionList({ connections, onConfirm, onDismiss }) {
  return (
    <div className="mt-4">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Connections</p>
      <ul className="mt-1.5 space-y-1.5">
        {connections.map(({ edge, other }) => (
          <li key={edge.id} className="rounded-md border border-slate-200 p-2 text-xs dark:border-slate-800">
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate font-medium text-slate-700 dark:text-slate-200">{other.label}</span>
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                  edge.status === 'confirmed'
                    ? 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300'
                    : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                }`}
              >
                {edge.status === 'confirmed' ? 'charted' : 'proposed'}
              </span>
            </div>
            {edge.rationale && <p className="mt-0.5 italic text-slate-500 dark:text-slate-400">{edge.rationale}</p>}
            {edge.status === 'suggested' && (
              <div className="mt-1.5 flex gap-2">
                <button
                  onClick={() => onConfirm(edge)}
                  className="rounded bg-indigo-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-indigo-500"
                >
                  Chart it
                </button>
                <button
                  onClick={() => onDismiss(edge)}
                  className="rounded border border-slate-300 px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  Dismiss
                </button>
              </div>
            )}
          </li>
        ))}
        {connections.length === 0 && <li className="text-xs text-slate-400">No connections yet.</li>}
      </ul>
    </div>
  )
}

function ColorDot({ color }) {
  return <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
}
