// components/ChipGroup.jsx — an add/remove list of labeled chips.
//
// Shared by the steering-profile editor (NorthStars) and the onboarding review screen so
// north stars and projects edit identically wherever they appear. Styled to the observatory
// design: north-star chips glow gold, project chips sit on a neutral panel tint.

import { useState } from 'react'

export default function ChipGroup({ label, hint, seed = [], items, onAdd, onRemove, placeholder, accent }) {
  const [draft, setDraft] = useState('')
  const gold = accent === 'sky' // north stars use the gold accent; projects use neutral
  const chipStyle = gold
    ? { background: 'rgba(233,196,106,.11)', color: 'var(--color-gold-soft)' }
    : { background: 'var(--surface-2)', color: 'var(--color-fg-soft)' }
  const closeColor = gold ? '#b89a5a' : 'var(--color-fg-muted)'

  return (
    <div>
      <h3 style={{ margin: 0, fontSize: 13, fontWeight: 500, color: 'var(--color-fg-soft)' }}>{label}</h3>
      {hint && <p style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--color-fg-muted)' }}>{hint}</p>}

      <div className="flex flex-wrap" style={{ marginTop: 12, gap: 8 }}>
        {items.map((s) => (
          <span key={s} className="inline-flex items-center" style={{ gap: 8, borderRadius: 999, padding: '6px 8px 6px 12px', fontSize: 13, ...chipStyle }}>
            {s}
            <button onClick={() => onRemove(s)} aria-label={`Remove ${s}`} className="cursor-pointer" style={{ color: closeColor, background: 'transparent', border: 0, lineHeight: 1 }}>×</button>
          </span>
        ))}
        {items.length === 0 && <span style={{ fontSize: 13, color: 'var(--color-fg-faint)' }}>None yet.</span>}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (draft.trim()) {
            onAdd(draft.trim())
            setDraft('')
          }
        }}
        className="flex"
        style={{ marginTop: 12, gap: 8 }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          className="flex-1"
          style={{ borderRadius: 10, border: '1px solid rgba(255,255,255,.1)', background: 'var(--surface-input)', padding: '8px 12px', fontSize: 14, color: 'var(--color-fg)', fontFamily: 'inherit', outline: 'none' }}
        />
        <button type="submit" className="cursor-pointer" style={{ borderRadius: 10, border: '1px solid rgba(255,255,255,.12)', background: 'transparent', color: 'var(--color-fg-soft)', padding: '8px 14px', fontSize: 14, fontWeight: 500, fontFamily: 'inherit' }}>
          Add
        </button>
      </form>

      {items.length === 0 && seed.length > 0 && (
        <div className="flex flex-wrap" style={{ marginTop: 8, gap: 8 }}>
          {seed.map((s) => (
            <button key={s} onClick={() => onAdd(s)} className="cursor-pointer" style={{ borderRadius: 999, border: '1px dashed rgba(255,255,255,.18)', padding: '5px 12px', fontSize: 12, color: 'var(--color-fg-muted)', background: 'transparent' }}>
              + {s}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
