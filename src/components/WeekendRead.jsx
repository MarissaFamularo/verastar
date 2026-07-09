// components/WeekendRead.jsx — the "Weekend Read" page: a narrative brief that threads the papers
// you've saved through your projects & north stars. The "connected" thesis told as prose — the
// narrative sibling of the Constellations map. Same trust ethos as the verifier: every thread is a
// SUGGESTED reading Claude proposes and you judge, grounded in the papers' own findings, written
// number-free (statistics stay the app's verified channel), and it names the gaps it can't fill.
//
// synthesizeWeekendRead (pipeline/weekend.js) does the one cheap Sonnet call + shaping; this
// component owns loading the saved papers/profile, persisting the read to the `digests` store, and
// rendering it. Regenerating overwrites the day's read; the latest is reloaded on every visit.

import { useEffect, useMemo, useState } from 'react'
import { store, getProfile } from '../lib/store.js'
import { hasApiKey } from '../lib/anthropic.js'
import { synthesizeWeekendRead } from '../pipeline/weekend.js'
import { appendConnectionsToLibrary } from '../lib/library.js'

// Which kind of anchor a thread hangs off — colors the pill so projects/north stars/cross-cutting
// read distinctly (echoing the map: north stars gold, projects yellow).
function anchorKind(anchor, profile) {
  const eq = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase()
  if ((profile?.projects || []).some((p) => eq(p, anchor))) return 'project'
  if ((profile?.northStars || []).some((n) => eq(n, anchor))) return 'northStar'
  return 'cross'
}

const ANCHOR_STYLE = {
  project: { dot: '#eec13a', cls: 'text-amber-700 dark:text-amber-300' },
  northStar: { dot: '#f4c542', cls: 'text-yellow-700 dark:text-yellow-300' },
  cross: { dot: '#94a3b8', cls: 'text-slate-600 dark:text-slate-300' },
}

function AnchorPill({ anchor, profile }) {
  const kind = anchorKind(anchor, profile)
  const s = ANCHOR_STYLE[kind]
  const kindLabel = kind === 'project' ? 'Project' : kind === 'northStar' ? 'North star' : 'Cross-cutting'
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide ${s.cls}`}>
      <span className="h-2 w-2 rounded-full" style={{ background: s.dot }} />
      {anchor}
      <span className="font-normal text-slate-400 dark:text-slate-500">· {kindLabel}</span>
    </span>
  )
}

// One paper cited inside a thread: title, citation line, the app-verified finding.
function PaperRow({ paper }) {
  const c = paper?.citation
  const bits = c ? [c.author, c.journal, c.year].filter(Boolean).join(' · ') : ''
  return (
    <li className="border-l-2 border-slate-200 py-1.5 pl-3 dark:border-slate-700">
      <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{paper?.title || 'Untitled paper'}</p>
      {c && (
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          {bits && <span>{bits} · </span>}
          <a
            href={c.url}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-sky-700 hover:underline dark:text-sky-300"
          >
            PMID {c.pmid} ↗
          </a>
          {c.verified && (
            <span className="ml-2 inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> citation verified
            </span>
          )}
        </p>
      )}
      {paper?.finding && (
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{paper.finding}</p>
      )}
    </li>
  )
}

export default function WeekendRead() {
  const [papers, setPapers] = useState([])
  const [profile, setProfile] = useState(null)
  const [read, setRead] = useState(null) // { opener, threads, gaps } | null
  const [generatedAt, setGeneratedAt] = useState('')
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')
  const keySet = hasApiKey()

  useEffect(() => {
    ;(async () => {
      const [p, prof, digests] = await Promise.all([store.all('papers'), getProfile(), store.all('digests')])
      setPapers(p || [])
      setProfile(prof || null)
      // Reopen the most recent weekend read, if one was generated before.
      const latest = (digests || [])
        .filter((d) => d?.type === 'weekend' && d?.read)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0]
      if (latest) {
        setRead(latest.read)
        setGeneratedAt(latest.createdAt || '')
      }
      setLoading(false)
    })()
  }, [])

  // pmid/id -> paper, so a thread's pmids resolve to full records for rendering.
  const byId = useMemo(() => {
    const m = new Map()
    for (const p of papers) m.set(String(p.pmid || p.id), p)
    return m
  }, [papers])

  async function handleGenerate() {
    setGenerating(true)
    setError('')
    try {
      const result = await synthesizeWeekendRead({
        papers,
        northStars: profile?.northStars || [],
        projects: profile?.projects || [],
      })
      const createdAt = new Date().toISOString()
      setRead(result)
      setGeneratedAt(createdAt)
      // Persist keyed by day so a same-day regenerate overwrites rather than piling up.
      const dayKey = `weekend:${createdAt.slice(0, 10)}`
      await store.put('digests', dayKey, {
        type: 'weekend',
        createdAt,
        paperCount: papers.length,
        read: result,
      })
      // If a flat-file library is connected, prepend this read to connections.md (newest-first).
      // No-op when no folder is connected; never allowed to break generation.
      try {
        await appendConnectionsToLibrary(createdAt.slice(0, 10), result)
      } catch (err) {
        console.warn('Library connections write failed (read still saved):', err?.message || err)
      }
    } catch (err) {
      setError(err?.message || String(err))
    }
    setGenerating(false)
  }

  const when = generatedAt
    ? new Date(generatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : ''
  const hasContent = read && (read.opener || read.threads?.length || read.gaps?.length)

  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Weekend Read</h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            How the papers you've saved connect to your projects and north stars — a suggested reading,
            grounded in each paper's verified finding.
          </p>
        </div>
        {papers.length > 0 && keySet && (
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="shrink-0 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
          >
            {generating ? 'Reading…' : read ? 'Regenerate' : 'Generate weekend read'}
          </button>
        )}
      </div>

      {loading ? (
        <p className="mt-6 text-sm text-slate-500 dark:text-slate-400">Loading…</p>
      ) : papers.length === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center dark:border-slate-700 dark:bg-slate-900">
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Nothing saved yet. Save a few papers to your Knowledge Base, then come back for a weekend read
            that threads them through your work.
          </p>
        </div>
      ) : (
        <>
          {error && (
            <div className="mt-6 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-200">
              <span className="font-medium">Couldn't generate:</span> {error}
            </div>
          )}

          {generating && !hasContent && (
            <p className="mt-6 text-sm text-slate-500 dark:text-slate-400">
              Threading your {papers.length} saved papers through your projects…
            </p>
          )}

          {/* A persisted read is viewable without a key — only GENERATING needs one. So show the
              read whenever we have it; fall back to the key/generate prompt only when we don't. */}
          {!hasContent && !generating && !keySet && (
            <div className="mt-6 rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
              <p className="text-sm text-slate-600 dark:text-slate-400">
                Set your Anthropic key above to generate the weekend read over your {papers.length} saved{' '}
                {papers.length === 1 ? 'paper' : 'papers'}.
              </p>
            </div>
          )}

          {!hasContent && !generating && keySet && !error && (
            <div className="mt-6 rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
              <p className="text-sm text-slate-600 dark:text-slate-400">
                Generate a weekend read over your {papers.length} saved{' '}
                {papers.length === 1 ? 'paper' : 'papers'} — Claude will surface the threads connecting them
                to your active work, and name what none of them advanced.
              </p>
            </div>
          )}

          {hasContent && (
            <div className="mt-6 space-y-6">
              {read.opener && (
                <p className="text-lg leading-relaxed text-slate-800 dark:text-slate-100">{read.opener}</p>
              )}

              {read.threads?.length > 0 && (
                <div className="space-y-4">
                  {read.threads.map((t, i) => (
                    <div
                      key={i}
                      className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900"
                    >
                      <AnchorPill anchor={t.anchor} profile={profile} />
                      <p className="mt-2 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                        {t.narrative}
                      </p>
                      <ul className="mt-3 space-y-2">
                        {t.pmids.map((id) => {
                          const paper = byId.get(String(id))
                          return paper ? <PaperRow key={id} paper={paper} /> : null
                        })}
                      </ul>
                    </div>
                  ))}
                </div>
              )}

              {read.gaps?.length > 0 && (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-5 dark:border-slate-800 dark:bg-slate-900/50">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Not advanced this week
                  </h3>
                  <ul className="mt-2 space-y-1">
                    {read.gaps.map((g, i) => (
                      <li key={i} className="text-sm text-slate-600 dark:text-slate-400">
                        {g}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {when && (
                <p className="text-xs text-slate-400 dark:text-slate-500">
                  Generated {when} · over {papers.length} saved {papers.length === 1 ? 'paper' : 'papers'} · a
                  suggested reading you judge
                </p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}
