// components/DomainEditor.jsx — Settings editor for the user's domain taxonomy.
//
// Domains are minted automatically as Claude files papers (lib/domains.js), so most users
// never need this — it's the steering wheel for the ones who do: rename a field (filed
// papers follow, the key is stable), add one ahead of time, or remove one (its concepts
// fall back to "Unclassified" until a re-file). Colors are assigned from the palette.

import { useEffect, useState } from 'react'
import { listDomains, addDomain, renameDomain, removeDomain } from '../lib/domains.js'
import { store } from '../lib/store.js'

export default function DomainEditor() {
  const [domains, setDomains] = useState(listDomains())
  const [draft, setDraft] = useState('')
  const [inUse, setInUse] = useState({}) // key -> concept count

  useEffect(() => {
    store.all('graphNodes').then((nodes = []) => {
      const counts = {}
      for (const n of nodes) if (n?.kind === 'concept' && n.domain) counts[n.domain] = (counts[n.domain] || 0) + 1
      setInUse(counts)
    }).catch(() => {})
  }, [])

  const refresh = () => setDomains([...listDomains()])

  async function handleAdd(e) {
    e.preventDefault()
    if (!draft.trim()) return
    await addDomain(draft)
    setDraft('')
    refresh()
  }

  async function handleRemove(d) {
    const n = inUse[d.key] || 0
    if (n > 0 && !window.confirm(`“${d.label}” colors ${n} concept${n === 1 ? '' : 's'} — they'll show as Unclassified until you re-file. Remove it?`)) return
    await removeDomain(d.key)
    refresh()
  }

  return (
    <div>
      <h3 style={{ margin: 0, fontSize: 13, fontWeight: 500, color: 'var(--color-fg-soft)' }}>Domains</h3>
      <p style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--color-fg-muted)', lineHeight: 1.5 }}>
        The broad fields your library is grouped and colored by. Claude creates these
        automatically as you save papers — rename or prune them here.
      </p>

      <div className="flex flex-col" style={{ marginTop: 12, gap: 7 }}>
        {domains.length === 0 && (
          <span style={{ fontSize: 13, color: 'var(--color-fg-faint)' }}>
            None yet — they'll appear as you save papers.
          </span>
        )}
        {domains.map((d) => (
          <div key={d.key} className="flex items-center" style={{ gap: 10 }}>
            <span style={{ width: 9, height: 9, borderRadius: '50%', flex: '0 0 auto', background: d.color, boxShadow: `0 0 7px ${d.color}` }} />
            <input
              value={d.label}
              onChange={(e) => { renameDomain(d.key, e.target.value); refresh() }}
              aria-label={`Rename ${d.label}`}
              style={{ flex: 1, minWidth: 0, borderRadius: 9, border: '1px solid transparent', background: 'transparent', padding: '6px 9px', fontSize: 13.5, color: 'var(--color-fg-soft)', fontFamily: 'inherit', outline: 'none' }}
              onFocus={(e) => { e.target.style.border = '1px solid rgba(255,255,255,.14)'; e.target.style.background = 'var(--surface-input)' }}
              onBlur={(e) => { e.target.style.border = '1px solid transparent'; e.target.style.background = 'transparent' }}
            />
            {(inUse[d.key] || 0) > 0 && (
              <span style={{ fontSize: 11, color: 'var(--color-fg-faint)', fontFamily: 'var(--font-mono)', flex: '0 0 auto' }}>{inUse[d.key]}</span>
            )}
            <button
              onClick={() => handleRemove(d)}
              aria-label={`Remove ${d.label}`}
              className="cursor-pointer"
              style={{ border: 0, background: 'transparent', color: 'var(--color-fg-muted)', fontSize: 15, lineHeight: 1, padding: '2px 4px', flex: '0 0 auto' }}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <form onSubmit={handleAdd} className="flex" style={{ marginTop: 12, gap: 8 }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="e.g. Cardiology"
          className="flex-1"
          style={{ borderRadius: 10, border: '1px solid rgba(255,255,255,.1)', background: 'var(--surface-input)', padding: '8px 12px', fontSize: 14, color: 'var(--color-fg)', fontFamily: 'inherit', outline: 'none' }}
        />
        <button type="submit" className="cursor-pointer" style={{ borderRadius: 10, border: '1px solid rgba(255,255,255,.12)', background: 'transparent', color: 'var(--color-fg-soft)', padding: '8px 14px', fontSize: 14, fontWeight: 500, fontFamily: 'inherit' }}>
          Add
        </button>
      </form>
    </div>
  )
}
