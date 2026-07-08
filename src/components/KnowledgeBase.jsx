// components/KnowledgeBase.jsx — the "Knowledge Base" page: browse everything you've saved, the way
// the clinician browses her real KG. Concepts are the top level (topic "wiki" nodes grouping source
// papers under one synthesized summary), each in one broad DOMAIN. Search reaches title, summary,
// and tags across the concept and its papers; a domain filter narrows by her taxonomy.
//
// This is also where "Claude applies, you prune" completes: notes and tags are editable here. The
// "Re-file with Claude" action re-classifies existing saves into concepts/domains. buildKB
// (lib/kb.js) does the pure search/filter.

import { useEffect, useMemo, useRef, useState } from 'react'
import { store } from '../lib/store.js'
import { hasApiKey } from '../lib/anthropic.js'
import { loadConcepts, setConceptTags, removeNode } from '../pipeline/graph.js'
import { refileKB } from '../pipeline/deposit.js'
import { buildKB } from '../lib/kb.js'
import { DOMAINS, domainColor, domainLabel } from '../lib/domains.js'

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
    <section className="mt-8 rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="border-b border-slate-200 p-6 dark:border-slate-800">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-medium">Knowledge Base</h2>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
              Everything you've saved, grouped into concept nodes and colored by domain. Search title,
              summary, and tags; filter by domain. Claude tags on deposit — prune what's wrong and add
              your own notes.
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {totalConcepts} concept{totalConcepts === 1 ? '' : 's'} · {totalPapers} paper
              {totalPapers === 1 ? '' : 's'}
            </span>
            {keySet && totalPapers > 0 && (
              refiling ? (
                <span className="text-[11px] font-medium text-indigo-600 dark:text-indigo-300">{refiling}</span>
              ) : confirmRefile ? (
                <span className="flex items-center gap-1.5 text-[11px]">
                  <span className="text-slate-500 dark:text-slate-400">Re-run Claude on all {totalPapers}?</span>
                  <button
                    onClick={handleRefile}
                    className="rounded bg-indigo-600 px-2 py-0.5 font-medium text-white hover:bg-indigo-500"
                  >
                    Re-file
                  </button>
                  <button
                    onClick={() => setConfirmRefile(false)}
                    className="rounded px-1.5 py-0.5 font-medium text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
                  >
                    cancel
                  </button>
                </span>
              ) : (
                <button
                  onClick={() => setConfirmRefile(true)}
                  title="Re-classify every saved paper into concepts + domains"
                  className="rounded-md border border-slate-300 px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  ↻ Re-file with Claude
                </button>
              )
            )}
          </div>
        </div>

        {/* search + domain filter */}
        <div className="mt-4 flex flex-col gap-3">
          <div className="relative">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search title, summary, tags…"
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-950"
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1.5 text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              >
                clear
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <FilterChip active={domain === 'all'} onClick={() => setDomain('all')}>
              All domains
            </FilterChip>
            {DOMAINS.map((d) => (
              <FilterChip key={d.key} active={domain === d.key} color={d.color} onClick={() => setDomain(d.key)}>
                {d.label}
              </FilterChip>
            ))}
          </div>
        </div>
      </div>

      <div className="p-6">
        {loading ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">Loading your knowledge base…</p>
        ) : totalPapers === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Nothing saved yet. Run a scan and use “Save to KB” — papers group into concept nodes here.
          </p>
        ) : counts.papers === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            No matches for “{query}”
            {domain !== 'all' ? ` in ${domainLabel(domain)}` : ''}.
          </p>
        ) : (
          <div className="space-y-4">
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
              <div className="rounded-lg border border-dashed border-slate-300 p-4 dark:border-slate-700">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  Unfiled ({unfiled.length}) — not yet grouped into a concept
                </p>
                <ul className="mt-2 space-y-2">
                  {unfiled.map((p) => (
                    <PaperRow
                      key={p.id}
                      paper={p}
                      onRemoveTag={(t) => removePaperTag(p, t)}
                      onSaveNote={(notes) => savePaper(p.id, { notes })}
                      onDelete={() => deletePaper(p)}
                    />
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

// One concept node: colored DOMAIN header + left border, title, synthesized summary, prunable
// concept tags, and the source papers under it (each with an editable note + prunable tags).
function ConceptCard({
  concept,
  papers,
  query,
  onRemoveConceptTag,
  onRemovePaperTag,
  onSaveNote,
  onDeleteConcept,
  onDeletePaper,
}) {
  const [open, setOpen] = useState(true)
  const color = domainColor(concept.domain)
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
      <div className="border-l-4 p-4" style={{ borderColor: color }}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <span className="text-[11px] font-bold uppercase tracking-wide" style={{ color }}>
              {domainLabel(concept.domain)}
            </span>
            <h3 className="mt-0.5 text-base font-semibold leading-snug text-slate-800 dark:text-slate-100">
              {concept.label}
            </h3>
          </div>
          <button
            onClick={() => setOpen((o) => !o)}
            className="shrink-0 rounded px-2 py-0.5 text-xs font-medium text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            {papers.length} source{papers.length === 1 ? '' : 's'} {open ? '▲' : '▼'}
          </button>
        </div>

        {concept.summary ? (
          <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">{concept.summary}</p>
        ) : (
          <p className="mt-2 text-sm italic text-slate-400">Summary pending.</p>
        )}

        <TagRow tags={concept.tags} onRemove={onRemoveConceptTag} max={10} />

        <button
          onClick={onDeleteConcept}
          className="mt-2 text-[11px] font-medium text-rose-500 hover:underline"
        >
          Remove concept
        </button>
      </div>

      {open && (
        <ul className="divide-y divide-slate-100 border-t border-slate-100 dark:divide-slate-800 dark:border-slate-800">
          {papers.map((p) => (
            <li key={p.id} className="p-4">
              <PaperRow
                paper={p}
                onRemoveTag={(t) => onRemovePaperTag(p, t)}
                onSaveNote={(notes) => onSaveNote(p.id, notes)}
                onDelete={() => onDeletePaper(p)}
              />
            </li>
          ))}
          {papers.length === 0 && (
            <li className="p-4 text-xs text-slate-400">
              {query ? 'No source papers match your search.' : 'No source papers linked yet.'}
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

// One saved paper: title, citation, collapsible finding, editable note, prunable tags, links.
function PaperRow({ paper, onRemoveTag, onSaveNote, onDelete }) {
  const [showFinding, setShowFinding] = useState(false)
  const [note, setNote] = useState(paper.notes || '')
  const dirty = note !== (paper.notes || '')
  const cite = [paper.citation?.author, paper.citation?.journal, paper.citation?.year]
    .filter(Boolean)
    .join(' · ')

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

  return (
    <div className="text-sm">
      <p className="font-medium leading-snug text-slate-800 dark:text-slate-100">{paper.title}</p>
      {cite && <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{cite}</p>}

      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        {paper.finding && (
          <button
            onClick={() => setShowFinding((s) => !s)}
            className="rounded bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
          >
            {showFinding ? 'Hide summary' : 'Summary'}
          </button>
        )}
        <a
          href={paper.citation?.url || `https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] font-medium text-sky-600 hover:underline dark:text-sky-400"
        >
          Open source ↗
        </a>
        {paper.pdfUrl && (
          <a
            href={paper.pdfUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded bg-rose-600/90 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-rose-600"
          >
            PDF
          </a>
        )}
        <button
          onClick={onDelete}
          className="ml-auto text-[11px] font-medium text-slate-400 hover:text-rose-500"
        >
          Delete
        </button>
      </div>

      {showFinding && paper.finding && (
        <p className="mt-1.5 border-l-2 border-slate-200 pl-2 text-xs leading-5 text-slate-600 dark:border-slate-700 dark:text-slate-300">
          {paper.finding}
        </p>
      )}

      <TagRow tags={paper.tags} onRemove={onRemoveTag} />

      <div className="mt-2">
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={commit}
          rows={note ? 2 : 1}
          placeholder="Add a note…"
          className="w-full resize-y rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs outline-none focus:border-slate-400 dark:border-slate-700 dark:bg-slate-950"
        />
        {dirty && (
          <button
            onClick={commit}
            className="mt-1 rounded bg-slate-900 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900"
          >
            Save note
          </button>
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
    <div className="mt-2 flex flex-wrap items-center gap-1">
      {capped.map((t) => (
        <span
          key={t}
          className="inline-flex items-center gap-1 rounded-full bg-slate-100 py-0.5 pl-2 pr-1 text-[10px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300"
        >
          {t}
          <button
            onClick={() => onRemove(t)}
            aria-label={`Remove tag ${t}`}
            className="rounded-full px-1 text-slate-400 hover:bg-slate-300 hover:text-slate-700 dark:hover:bg-slate-600 dark:hover:text-slate-100"
          >
            ×
          </button>
        </span>
      ))}
      {(hidden > 0 || (max && expanded && tags.length > max)) && (
        <button
          onClick={() => setExpanded((e) => !e)}
          className="rounded-full px-2 py-0.5 text-[10px] font-medium text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
        >
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
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition ${
        active
          ? 'border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900'
          : 'border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800'
      }`}
    >
      {color && (
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ backgroundColor: active ? 'currentColor' : color }}
        />
      )}
      {children}
    </button>
  )
}
