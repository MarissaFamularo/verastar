// components/TopicsEditor.jsx — the search plan, editable.
//
// North stars steer the RUBRIC (what's worth her morning); topics steer the SEARCH (what
// PubMed is asked for). They were the same field for as long as the scan was one OR-joined
// query, and conflating them is what let a high-volume topic quietly eat a low-volume one.
// This is where the two come apart: a label she reads, and the boolean query that actually
// runs, one search each.
//
// The paste box is not a nicety. Her real ten topics already exist in a JSON file — a
// feature that makes her retype ten boolean queries into twenty inputs is a feature she
// won't adopt. parseTopicsText takes that file verbatim.

import { useState } from 'react'
import {
  TOPIC_HINT,
  parseTopicsText,
  normalizeSearchDays,
  normalizeTopicCap,
  topicsFromStars,
} from '../pipeline/topics.js'

const inputStyle = {
  width: '100%',
  borderRadius: 9,
  border: '1px solid rgba(255,255,255,.1)',
  background: 'var(--surface-input)',
  padding: '8px 11px',
  fontSize: 13,
  color: 'var(--color-fg)',
  fontFamily: 'inherit',
  outline: 'none',
}
const numberInput = { width: 58, borderRadius: 9, border: '1px solid rgba(255,255,255,.1)', background: 'var(--surface-input)', padding: '6px 10px', fontSize: 14, fontFamily: 'var(--font-mono)', textAlign: 'center', color: 'var(--color-fg)', outline: 'none' }
const ghostBtn = { borderRadius: 9, padding: '7px 12px', fontSize: 12, fontWeight: 500, fontFamily: 'inherit', border: '1px solid rgba(255,255,255,.12)', background: 'transparent', color: 'var(--color-fg-soft)', cursor: 'pointer' }

export default function TopicsEditor({ topics, days, perTopic, northStars = [], onChange }) {
  const [pasteOpen, setPasteOpen] = useState(false)
  const [paste, setPaste] = useState('')
  const [pasteError, setPasteError] = useState('')

  const windowDays = normalizeSearchDays(days)
  const cap = normalizeTopicCap(perTopic)
  const emit = (patch) => onChange({ topics, days: windowDays, perTopic: cap, ...patch })

  // What a profile with no topics of its own actually searches. Shown rather than silently
  // written into the profile: seeing the derived plan is honest, persisting it behind her
  // back would quietly decouple the search from north stars she's still editing.
  const derived = topicsFromStars(northStars)

  const setRow = (i, patch) => emit({ topics: topics.map((t, j) => (j === i ? { ...t, ...patch } : t)) })
  const removeRow = (i) => emit({ topics: topics.filter((_, j) => j !== i) })
  const addRow = () => emit({ topics: [...topics, { label: '', query: '' }] })

  function applyPaste() {
    const parsed = parseTopicsText(paste)
    if (!parsed.length) {
      setPasteError("Couldn't read any topics out of that — one per line, or paste the JSON.")
      return
    }
    emit({ topics: parsed })
    setPaste('')
    setPasteError('')
    setPasteOpen(false)
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between" style={{ gap: 12 }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 500, color: 'var(--color-fg-soft)' }}>Search topics</h3>
        <div className="flex flex-wrap items-center" style={{ gap: 16 }}>
          <label className="flex items-center" style={{ gap: 8, fontSize: 12, color: 'var(--color-fg-muted)' }}>
            Days back
            <input
              type="number"
              min="1"
              max="90"
              value={windowDays}
              onChange={(e) => emit({ days: normalizeSearchDays(e.target.value) })}
              style={numberInput}
            />
          </label>
          <label className="flex items-center" style={{ gap: 8, fontSize: 12, color: 'var(--color-fg-muted)' }}>
            Per topic
            <input
              type="number"
              min="1"
              max="50"
              value={cap}
              onChange={(e) => emit({ perTopic: normalizeTopicCap(e.target.value) })}
              style={numberInput}
            />
          </label>
        </div>
      </div>

      <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--color-fg-muted)', lineHeight: 1.5 }}>
        Each topic gets its OWN PubMed search, so a busy area can't crowd out a quiet one.
        Your digest takes the newest {cap} per topic from the last {windowDays} day
        {windowDays === 1 ? '' : 's'} — up to {topics.length ? topics.length * cap : derived.length * cap} candidates before duplicates. More topics and a higher cap increase Claude usage; Settings shows the tokens and estimated spend, including failed runs.
      </p>
      <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--color-fg-faint)', lineHeight: 1.5 }}>
        {TOPIC_HINT}
      </p>

      {topics.length === 0 && (
        <div style={{ marginTop: 12, borderRadius: 10, border: '1px dashed rgba(255,255,255,.14)', padding: 12 }}>
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--color-fg-muted)', lineHeight: 1.5 }}>
            No topics set — your scan searches your north stars, one query each:{' '}
            <span style={{ color: 'var(--color-fg-soft)' }}>
              {derived.length ? derived.map((t) => t.query).join(' · ') : 'vascular surgery'}
            </span>
            .
          </p>
          {derived.length > 0 && (
            <button onClick={() => emit({ topics: derived })} style={{ ...ghostBtn, marginTop: 10 }}>
              Start from my north stars
            </button>
          )}
        </div>
      )}

      {topics.length > 0 && (
        <ul style={{ margin: '12px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {topics.map((t, i) => (
            // Index-keyed on purpose: these rows are positional and freely edited, so a
            // key derived from the (changing) label would remount the input mid-keystroke.
            <li key={i} className="flex items-start" style={{ gap: 8 }}>
              <div className="min-w-0 flex-1" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <input
                  value={t.label ?? ''}
                  onChange={(e) => setRow(i, { label: e.target.value })}
                  placeholder="Label — e.g. Aortic Disease"
                  style={inputStyle}
                />
                <input
                  value={t.query ?? ''}
                  onChange={(e) => setRow(i, { query: e.target.value })}
                  placeholder="Query — e.g. aortic aneurysm OR aortic dissection OR TEVAR OR EVAR"
                  style={{ ...inputStyle, fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--color-fg-soft)' }}
                />
              </div>
              <button
                onClick={() => removeRow(i)}
                aria-label={`Remove ${t.label || t.query || 'topic'}`}
                className="cursor-pointer"
                style={{ marginTop: 6, border: 0, background: 'transparent', color: 'var(--color-fg-muted)', fontSize: 15, lineHeight: 1, padding: '4px 6px' }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center" style={{ marginTop: 12, gap: 8 }}>
        <button onClick={addRow} style={ghostBtn}>+ Add topic</button>
        <button onClick={() => setPasteOpen((v) => !v)} style={ghostBtn}>
          {pasteOpen ? 'Cancel paste' : 'Paste a list'}
        </button>
      </div>

      {pasteOpen && (
        <div style={{ marginTop: 10 }}>
          <textarea
            value={paste}
            onChange={(e) => {
              setPaste(e.target.value)
              setPasteError('')
            }}
            rows={7}
            placeholder={'Paste your topics — JSON rows like { "topic": "Aortic Disease", "query": "aortic aneurysm OR TEVAR" }, or one "Label: query" per line.'}
            style={{ width: '100%', resize: 'vertical', borderRadius: 10, border: '1px solid rgba(255,255,255,.1)', background: 'var(--surface-input)', padding: '11px 13px', fontSize: 12.5, lineHeight: 1.55, color: 'var(--color-fg-soft)', fontFamily: 'var(--font-mono)', outline: 'none' }}
          />
          <div className="flex flex-wrap items-center" style={{ marginTop: 8, gap: 10 }}>
            <button onClick={applyPaste} disabled={!paste.trim()} style={{ ...ghostBtn, opacity: paste.trim() ? 1 : 0.5 }}>
              Replace my topics with this
            </button>
            <span style={{ fontSize: 11.5, color: 'var(--color-fg-faint)' }}>
              Replaces the whole list — {topics.length} topic{topics.length === 1 ? '' : 's'} right now.
            </span>
          </div>
          {pasteError && <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--color-domain-vascular)' }}>{pasteError}</p>}
        </div>
      )}
    </div>
  )
}
