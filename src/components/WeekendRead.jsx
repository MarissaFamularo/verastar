// components/WeekendRead.jsx — the "Weekend Read" page: a narrative brief that threads THIS
// WEEK's saved papers through your projects, north stars, and the library you already had (the
// older shelf rides along as context a thread can reach back into; with nothing saved this week
// the whole library becomes the subject so the page still works). The "connected" thesis told as
// prose — the narrative sibling of the Constellations map. Same trust ethos as the verifier:
// every thread is a SUGGESTED reading Claude proposes and you judge, grounded in the papers' own
// findings, written number-free (statistics stay the app's verified channel), and it names the
// gaps it can't fill.
//
// synthesizeWeekendRead (pipeline/weekend.js) does the one cheap Sonnet call + shaping; this
// component owns loading the saved papers/profile, persisting the read to the `digests` store, and
// rendering it. Regenerating overwrites the day's read; the latest is reloaded on every visit.
// Styled to the observatory design (Verastar.dc.html).

import { useEffect, useMemo, useState } from 'react'
import { store, getProfile } from '../lib/store.js'
import { hasApiKey } from '../lib/anthropic.js'
import { synthesizeWeekendRead } from '../pipeline/weekend.js'
import { appendConnectionsToLibrary } from '../lib/library.js'

// Which kind of anchor a thread hangs off — colors the pill so projects/north stars/cross-cutting
// read distinctly. Projects and north stars both glow gold (echoing the map); cross-cutting greys.
function anchorKind(anchor, profile) {
  const eq = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase()
  if ((profile?.projects || []).some((p) => eq(p, anchor))) return 'project'
  if ((profile?.northStars || []).some((n) => eq(n, anchor))) return 'northStar'
  return 'cross'
}

const ANCHOR_STYLE = {
  project: { dot: 'var(--color-gold)', text: 'var(--color-gold-soft)' },
  northStar: { dot: 'var(--color-gold)', text: 'var(--color-gold-soft)' },
  cross: { dot: '#94a3b8', text: 'var(--color-fg-soft)' },
}

function AnchorPill({ anchor, profile }) {
  const kind = anchorKind(anchor, profile)
  const s = ANCHOR_STYLE[kind]
  const kindLabel = kind === 'project' ? 'Project' : kind === 'northStar' ? 'North star' : 'Cross-cutting'
  return (
    <span className="inline-flex items-center" style={{ gap: 8, fontSize: 11.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: s.text }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.dot, boxShadow: `0 0 8px ${s.dot}` }} />
      {anchor}
      <span style={{ fontWeight: 400, color: 'var(--color-fg-muted)', letterSpacing: 0, textTransform: 'none' }}>· {kindLabel}</span>
    </span>
  )
}

// One paper cited inside a thread: title, mono citation line, the app-verified finding.
function PaperRow({ paper }) {
  const c = paper?.citation
  const bits = c ? [c.author, c.journal, c.year].filter(Boolean).join(' · ') : ''
  return (
    <li style={{ borderLeft: '2px solid rgba(255,255,255,.12)', paddingLeft: 16 }}>
      <p style={{ margin: 0, fontSize: 14.5, fontWeight: 500, color: 'var(--color-fg-soft)' }}>{paper?.title || 'Untitled paper'}</p>
      {c && (
        <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--color-fg-muted)', fontFamily: 'var(--font-mono)' }}>
          {bits && <span>{bits} · </span>}
          <a href={c.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-accent)' }}>PMID {c.pmid} ↗</a>
          {c.verified && (
            <span className="inline-flex items-center" style={{ marginLeft: 8, gap: 5, color: 'var(--color-verified-soft)' }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--color-verified)' }} /> citation verified
            </span>
          )}
        </p>
      )}
      {paper?.finding && <p style={{ margin: '7px 0 0', fontSize: 14, lineHeight: 1.55, color: 'var(--color-fg-dim)' }}>{paper.finding}</p>}
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

  // This week's saves are the subject; everything older (or legacy records without a savedAt)
  // is the shelf they connect back to. Nothing saved this week → the whole library is the
  // subject, same as the original behavior, so the page never goes dark.
  const { focus, shelf } = useMemo(() => {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    const recent = papers.filter((p) => p.savedAt && Date.parse(p.savedAt) >= cutoff)
    if (!recent.length) return { focus: papers, shelf: [] }
    const recentIds = new Set(recent.map((p) => p.id))
    return { focus: recent, shelf: papers.filter((p) => !recentIds.has(p.id)) }
  }, [papers])

  async function handleGenerate() {
    setGenerating(true)
    setError('')
    try {
      const result = await synthesizeWeekendRead({
        papers: focus,
        libraryPapers: shelf,
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
        paperCount: focus.length,
        libraryCount: shelf.length,
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

  const emptyCard = { marginTop: 24, borderRadius: 16, background: 'var(--surface-1)', padding: 24, fontSize: 14, color: 'var(--color-fg-dim)', lineHeight: 1.6 }

  return (
    <main className="relative" style={{ minHeight: '100%' }}>
      <div className="vs-stars absolute" style={{ top: 0, left: 0, right: 0, height: 300, opacity: 0.6 }} />
      <div className="vs-page-pad relative" style={{ maxWidth: 720, margin: '0 auto', padding: '52px 40px 72px' }}>
        <div className="flex items-center justify-between" style={{ gap: 16 }}>
          <p style={{ margin: 0, fontSize: 12, letterSpacing: '.15em', textTransform: 'uppercase', color: 'var(--color-fg-faint)', fontWeight: 600 }}>
            Connections{when ? ` · ${when}` : ''}
          </p>
          {papers.length > 0 && keySet && (
            <button
              onClick={handleGenerate}
              disabled={generating}
              className="cursor-pointer"
              style={{ padding: '9px 15px', border: '1px solid rgba(239,143,91,.4)', borderRadius: 10, background: 'transparent', color: 'var(--color-accent-bright)', fontSize: 13, fontWeight: 500, fontFamily: 'inherit', opacity: generating ? 0.6 : 1 }}
            >
              {generating ? 'Finding…' : read ? 'Regenerate' : 'Find Connections'}
            </button>
          )}
        </div>

        <h1 style={{ margin: '16px 0 0', fontFamily: 'var(--font-serif)', fontSize: 30, fontWeight: 500, lineHeight: 1.25, color: 'var(--color-fg)' }}>
          The threads across your reading.
        </h1>

        {loading ? (
          <p style={{ marginTop: 24, fontSize: 14, color: 'var(--color-fg-muted)' }}>Loading…</p>
        ) : papers.length === 0 ? (
          <div style={{ ...emptyCard, border: '1px dashed rgba(255,255,255,.12)', background: 'transparent', textAlign: 'center', padding: 40 }}>
            Nothing saved yet. Save a few papers to your Library, then come back to find the connections
            threading them through your work.
          </div>
        ) : (
          <>
            {error && (
              <div style={{ marginTop: 24, borderRadius: 12, background: 'rgba(224,96,90,.12)', padding: '12px 16px', fontSize: 14, color: '#f0a9a4' }}>
                <span style={{ fontWeight: 600 }}>Couldn't generate:</span> {error}
              </div>
            )}

            {generating && !hasContent && (
              <p style={{ marginTop: 24, fontSize: 14, color: 'var(--color-fg-muted)' }}>
                {shelf.length
                  ? `Threading this week's ${focus.length} ${focus.length === 1 ? 'paper' : 'papers'} through your library of ${shelf.length} and your projects…`
                  : `Threading your ${papers.length} saved papers through your projects…`}
              </p>
            )}

            {!hasContent && !generating && !keySet && (
              <div style={emptyCard}>
                Set your Anthropic key in Settings to find the connections across your {papers.length} saved {papers.length === 1 ? 'paper' : 'papers'}.
              </div>
            )}

            {!hasContent && !generating && keySet && !error && (
              <div style={emptyCard}>
                {shelf.length
                  ? `You saved ${focus.length} ${focus.length === 1 ? 'paper' : 'papers'} this week. Claude threads ${focus.length === 1 ? 'it' : 'them'} through your active work and the ${shelf.length} ${shelf.length === 1 ? 'paper' : 'papers'} already in your library — and names what this week didn't advance.`
                  : `Find the connections across your ${papers.length} saved ${papers.length === 1 ? 'paper' : 'papers'} — Claude surfaces the threads connecting them to your active work, and names what none of them advanced.`}
              </div>
            )}

            {hasContent && (
              <>
                {read.opener && (
                  <p style={{ margin: '18px 0 0', fontFamily: 'var(--font-serif)', fontSize: 19, fontStyle: 'italic', lineHeight: 1.6, color: 'var(--color-fg-soft)' }}>{read.opener}</p>
                )}

                {read.threads?.length > 0 && (
                  <div className="flex flex-col" style={{ marginTop: 40, gap: 20 }}>
                    {read.threads.map((t, i) => (
                      <div key={i} style={{ padding: 26, borderRadius: 16, background: 'var(--surface-1)' }}>
                        <AnchorPill anchor={t.anchor} profile={profile} />
                        <p style={{ margin: '14px 0 0', fontSize: 16, lineHeight: 1.7, color: 'var(--color-fg-soft)' }}>{t.narrative}</p>
                        <ul style={{ margin: '18px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 14 }}>
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
                  <div style={{ marginTop: 24, padding: '22px 26px', borderRadius: 16, background: 'rgba(255,255,255,.02)', border: '1px dashed rgba(255,255,255,.1)' }}>
                    <p style={{ margin: 0, fontSize: 11, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--color-fg-muted)', fontWeight: 600 }}>Not advanced this week</p>
                    <ul style={{ margin: '12px 0 0', paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {read.gaps.map((g, i) => (
                        <li key={i} style={{ fontSize: 14.5, color: 'var(--color-fg-dim)', lineHeight: 1.5 }}>{g}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {when && (
                  <p style={{ margin: '22px 2px 0', fontSize: 12.5, color: 'var(--color-fg-faint)' }}>
                    Generated {when} ·{' '}
                    {shelf.length
                      ? `${focus.length} saved this week, threaded against ${shelf.length} in your library`
                      : `over ${papers.length} saved ${papers.length === 1 ? 'paper' : 'papers'}`}{' '}
                    · a suggested reading you judge.
                  </p>
                )}
              </>
            )}
          </>
        )}
      </div>
    </main>
  )
}
