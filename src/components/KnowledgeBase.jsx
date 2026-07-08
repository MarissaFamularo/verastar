// components/KnowledgeBase.jsx — the "Knowledge Base" page: browse everything you've saved,
// the way the clinician browses her own graph. The hierarchy is category → group → paper, where
// a CATEGORY is one of her north stars / projects (from her steering profile) and a GROUP is
// either a finer concept beneath a category, or a category anchor holding papers directly (when
// a paper's topic IS a north star). Search reaches title, summary, and tags across the group and
// its papers; the filter narrows to one category. This is also where "Claude applies, you prune"
// completes: notes and tags are editable here. buildKB (lib/kb.js) does the pure search/filter.

import { useEffect, useMemo, useRef, useState } from 'react'
import { getProfile, store } from '../lib/store.js'
import { hasApiKey } from '../lib/anthropic.js'
import { loadGraph, setConceptTags, removeNode, syncAnchors } from '../pipeline/graph.js'
import { refileKB } from '../pipeline/deposit.js'
import { buildKB } from '../lib/kb.js'
import { categoryList, categoryMap, colorOf, categoryLabelOf } from '../lib/domains.js'

const KIND_LABEL = { northStar: 'North star', project: 'Project' }

export default function KnowledgeBase() {
  const [nodes, setNodes] = useState([]) // all graph nodes (categories + concepts)
  const [papers, setPapers] = useState([])
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [loading, setLoading] = useState(true)
  const [refiling, setRefiling] = useState('') // '' | progress string
  const [confirmRefile, setConfirmRefile] = useState(false)
  const keySet = hasApiKey()

  async function refresh() {
    const [{ nodes }, p] = await Promise.all([loadGraph(), store.all('papers')])
    setNodes(nodes || [])
    setPapers(p || [])
  }

  useEffect(() => {
    ;(async () => {
      // ensure the profile's categories exist + are colored, even if Constellations was never opened
      await syncAnchors(await getProfile())
      await refresh()
      setLoading(false)
    })()
  }, [])

  const catMap = useMemo(() => categoryMap(nodes), [nodes])
  const categories = useMemo(() => categoryList(nodes), [nodes])
  const { groups, unfiled, counts } = useMemo(
    () => buildKB(nodes, papers, { query, category }),
    [nodes, papers, query, category],
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

  // only concept groups carry prunable tags
  async function removeGroupTag(group, tag) {
    const node = await setConceptTags(group.id, (group.tags || []).filter((t) => t !== tag))
    if (node) setNodes((prev) => prev.map((n) => (n.id === group.id ? node : n)))
  }

  // removing a concept drops its papers UP to the parent category (clear conceptId; keep
  // category so they re-file under the north-star/project anchor). Categories themselves live in
  // the profile and aren't deletable here.
  async function deleteGroup(group) {
    if (group.kind !== 'concept') return
    await removeNode(group.id)
    const orphans = papers.filter(
      (p) => p.conceptId === group.id || (group.sourcePmids || []).includes(String(p.pmid)),
    )
    await Promise.all(orphans.map((p) => savePaper(p.id, { conceptId: null })))
    setNodes((prev) => prev.filter((n) => n.id !== group.id))
  }

  async function deletePaper(paper) {
    await store.delete('papers', paper.id)
    setPapers((prev) => prev.filter((p) => p.id !== paper.id))
  }

  // Re-classify every saved paper under the current profile categories (rebuilds concepts). Paid:
  // one Claude call per paper + per group. Used to bring pre-refactor saves into the new model.
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

  const totalConcepts = nodes.filter((n) => n.kind === 'concept').length
  const totalPapers = papers.length

  return (
    <section className="mt-8 rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="border-b border-slate-200 p-6 dark:border-slate-800">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-medium">Knowledge Base</h2>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
              Everything you've saved, organized by your north stars and projects. Search title,
              summary, and tags; filter by category. Claude tags on deposit — prune what's wrong and
              add your own notes.
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
                  title="Re-classify every saved paper under your current north stars & projects"
                  className="rounded-md border border-slate-300 px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  ↻ Re-file with Claude
                </button>
              )
            )}
          </div>
        </div>

        {/* search + category filter */}
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
            <FilterChip active={category === 'all'} onClick={() => setCategory('all')}>
              All categories
            </FilterChip>
            {categories.map((c) => (
              <FilterChip
                key={c.key}
                active={category === c.key}
                color={c.color}
                onClick={() => setCategory(c.key)}
              >
                {c.label}
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
            Nothing saved yet. Run a scan and use “Save to KB” — papers file under your north stars
            and projects here.
          </p>
        ) : counts.papers === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            No matches for “{query}”
            {category !== 'all' ? ` in ${catMap.get(category)?.label || 'this category'}` : ''}.
          </p>
        ) : (
          <div className="space-y-4">
            {groups.map(({ group, papers }) => (
              <GroupCard
                key={group.id}
                group={group}
                papers={papers}
                query={query}
                color={colorOf(group, catMap)}
                categoryLabel={
                  group.kind === 'concept' ? categoryLabelOf(group, catMap) : KIND_LABEL[group.kind]
                }
                onRemoveGroupTag={(t) => removeGroupTag(group, t)}
                onRemovePaperTag={removePaperTag}
                onSaveNote={(id, notes) => savePaper(id, { notes })}
                onDeleteGroup={() => deleteGroup(group)}
                onDeletePaper={deletePaper}
              />
            ))}
            {unfiled.length > 0 && (
              <div className="rounded-lg border border-dashed border-slate-300 p-4 dark:border-slate-700">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  Unfiled ({unfiled.length}) — not yet filed under a category
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

// One grouping node (a concept, or a category anchor holding papers): colored by its category,
// a category header, title, summary, prunable tags (concepts only), and its source papers.
function GroupCard({
  group,
  papers,
  query,
  color,
  categoryLabel,
  onRemoveGroupTag,
  onRemovePaperTag,
  onSaveNote,
  onDeleteGroup,
  onDeletePaper,
}) {
  const [open, setOpen] = useState(true)
  const isConcept = group.kind === 'concept'
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
      <div className="border-l-4 p-4" style={{ borderColor: color }}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <span className="text-[11px] font-bold uppercase tracking-wide" style={{ color }}>
              {categoryLabel}
            </span>
            <h3 className="mt-0.5 text-base font-semibold leading-snug text-slate-800 dark:text-slate-100">
              {group.label}
            </h3>
          </div>
          <button
            onClick={() => setOpen((o) => !o)}
            className="shrink-0 rounded px-2 py-0.5 text-xs font-medium text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            {papers.length} source{papers.length === 1 ? '' : 's'} {open ? '▲' : '▼'}
          </button>
        </div>

        {group.summary ? (
          <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">{group.summary}</p>
        ) : (
          <p className="mt-2 text-sm italic text-slate-400">Summary pending.</p>
        )}

        {isConcept && <TagRow tags={group.tags} onRemove={onRemoveGroupTag} max={10} />}

        {isConcept && (
          <button
            onClick={onDeleteGroup}
            className="mt-2 text-[11px] font-medium text-rose-500 hover:underline"
          >
            Remove concept
          </button>
        )}
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

  // keep the local draft in sync if the record changes underneath us (e.g. background patch)
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

      {/* editable note — the "you prune / you annotate" half */}
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
