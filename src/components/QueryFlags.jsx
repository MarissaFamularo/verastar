// components/QueryFlags.jsx — the query-quality read-out, shown under the topics editor.
//
// A PubMed query can be wrong in a way that is invisible: over-specify it and MeSH expansion
// returns zero rows, and a topic with zero rows reads exactly like a quiet morning in that
// field. That is her documented failure mode ("complex AND chains expand to zero results"),
// and it got worse the moment a model started writing the queries instead of her.
//
// So the flags render at the one moment she is looking at the queries — the review screen,
// before anything is saved — and they are ADVISORY. Nothing here blocks a save: her queries
// are better than this checker's opinion of them, and a gate would be wrong more often than
// it would be right. The most it does is point at a row.

import { useState } from 'react'
import { checkTopics } from '../pipeline/interview.js'
import { searchPubmed, fetchCitations, searchPaceMs } from '../pipeline/sources.js'

export default function QueryFlags({ topics }) {
  const { ok, rows, list, count } = checkTopics(topics)
  const [previewing, setPreviewing] = useState(false)
  const [preview, setPreview] = useState([])
  const [previewError, setPreviewError] = useState('')

  async function previewMatches() {
    setPreviewing(true)
    setPreviewError('')
    try {
      const found = []
      const seen = new Set()
      const matches = []
      for (let i = 0; i < (topics || []).length; i++) {
        const topic = topics[i]
        if (i > 0) await new Promise((resolve) => setTimeout(resolve, searchPaceMs()))
        const ids = await searchPubmed(topic.query || topic.label, { retmax: 10, days: 90 })
        matches.push({ topic: topic.label || topic.query, ids })
      }
      // Round-robin so a high-volume first topic cannot consume the whole preview.
      for (let depth = 0; found.length < 10 && matches.some((m) => depth < m.ids.length); depth++) {
        for (const match of matches) {
          const id = match.ids[depth]
          if (id && !seen.has(id) && found.length < 10) {
            seen.add(id)
            found.push({ id, topic: match.topic })
          }
        }
      }
      const cites = found.length ? await fetchCitations(found.map((r) => r.id)) : []
      const topicById = new Map(found.map((r) => [String(r.id), r.topic]))
      setPreview(cites.map((c) => ({ ...c, topic: topicById.get(String(c.pmid)) || '' })))
    } catch (err) {
      setPreviewError(err?.message || String(err))
    } finally {
      setPreviewing(false)
    }
  }

  const previewBlock = (
    <div style={{ marginTop: 10 }}>
      <button onClick={previewMatches} disabled={previewing} style={{ borderRadius: 8, border: '1px solid rgba(255,255,255,.14)', background: 'transparent', color: 'var(--color-fg-soft)', padding: '6px 10px', fontSize: 12, fontFamily: 'inherit', cursor: 'pointer', opacity: previewing ? 0.6 : 1 }}>
        {previewing ? 'Checking PubMed…' : 'Preview 10 recent matches'}
      </button>
      {previewError && <p style={{ margin: '7px 0 0', fontSize: 12, color: 'var(--color-domain-vascular)' }}>Couldn’t preview PubMed: {previewError}</p>}
      {preview.length > 0 && (
        <ol style={{ margin: '8px 0 0', paddingLeft: 20, color: 'var(--color-fg-muted)', fontSize: 11.5, lineHeight: 1.45 }}>
          {preview.map((paper) => <li key={paper.pmid}>{paper.title} <span style={{ color: 'var(--color-fg-faint)' }}>— found by {paper.topic}</span></li>)}
        </ol>
      )}
      {!previewing && !previewError && preview.length === 0 && <p style={{ margin: '6px 0 0', fontSize: 11.5, color: 'var(--color-fg-faint)' }}>This runs the actual searches so you can spot off-topic drift before saving.</p>}
    </div>
  )

  if (!topics?.length) return null // the editor's own empty state already speaks

  if (ok) {
    return (
      <div style={{ margin: '10px 0 0' }}>
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--color-verified-soft)' }}>
          ✓ No obvious query-syntax problems. A syntax check cannot tell whether the results are relevant.
        </p>
        {previewBlock}
      </div>
    )
  }

  return (
    <div
      style={{
        marginTop: 12,
        borderRadius: 10,
        border: '1px solid rgba(233,196,106,.28)',
        background: 'rgba(233,196,106,.07)',
        padding: '11px 13px',
      }}
    >
      <p style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: 'var(--color-gold)' }}>
        {count} thing{count === 1 ? '' : 's'} worth a look before you save
      </p>
      <ul style={{ margin: '7px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 5 }}>
        {list.map((f) => (
          <li key={f.code} style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--color-fg-dim)' }}>
            {f.message}
          </li>
        ))}
        {rows.map((row) =>
          row.issues.map((issue) => (
            <li key={`${row.index}-${issue.code}`} style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--color-fg-dim)' }}>
              <span style={{ color: 'var(--color-fg-soft)' }}>
                Row {row.index + 1}
                {row.label ? ` · ${row.label}` : ''}:
              </span>{' '}
              {issue.message}
            </li>
          )),
        )}
      </ul>
      <p style={{ margin: '8px 0 0', fontSize: 11.5, color: 'var(--color-fg-faint)' }}>
        Advice, not a gate — save anyway if you know better than we do.
      </p>
      {previewBlock}
    </div>
  )
}
