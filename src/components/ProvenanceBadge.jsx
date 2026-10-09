// components/ProvenanceBadge.jsx — the badge is the product. It reflects a verdict the
// APP proved, never something the model asserted. Four tiers, visually distinct so a
// flagged value can never be mistaken for a verified one. Styled in the observatory
// palette (design/Verastar.dc.html): full-text green, registry blue, abstract amber,
// flagged muted grey.

import { useId, useState } from 'react'
import { badgeWord, badgeExplanation } from '../lib/badgeWord.js'

const STYLES = {
  'verified-registry': { label: 'Relationship validated · registry', dot: 'var(--color-registry)', text: 'var(--color-registry-soft)', bg: 'rgba(143,189,230,.15)' },
  'verified-full-text': { label: 'Relationship validated · full text', dot: 'var(--color-verified)', text: 'var(--color-verified-soft)', bg: 'rgba(127,191,154,.14)' },
  'abstract-only': { label: 'Relationship validated · abstract', dot: 'var(--color-abstract)', text: 'var(--color-abstract)', bg: 'rgba(230,184,119,.14)' },
  'verified-user-text': { label: 'Verified against user-supplied text', dot: 'var(--color-abstract)', text: 'var(--color-abstract)', bg: 'rgba(230,184,119,.14)' },
  'verified-estimate': { label: 'Estimate verified as printed · endpoint unchecked', dot: 'var(--color-verified)', text: 'var(--color-verified-soft)', bg: 'rgba(127,191,154,.10)' },
  'verified-comparison': { label: 'Values verified as printed · groups unchecked', dot: 'var(--color-verified)', text: 'var(--color-verified-soft)', bg: 'rgba(127,191,154,.10)' },
  'verified-proportion': { label: 'Percentage recomputed from its count · endpoint unchecked', dot: 'var(--color-verified)', text: 'var(--color-verified-soft)', bg: 'rgba(127,191,154,.10)' },
  'verified-heterogeneity': { label: 'I² verified as printed · analysis unchecked', dot: 'var(--color-verified)', text: 'var(--color-verified-soft)', bg: 'rgba(127,191,154,.10)' },
  'source-located': { label: 'Source located · relationship unresolved', dot: 'var(--color-abstract)', text: 'var(--color-abstract)', bg: 'rgba(230,184,119,.14)' },
  'legacy-unchecked': { label: 'Earlier evidence · relationships unchecked', dot: 'var(--color-fg-muted)', text: 'var(--color-fg-muted)', bg: 'rgba(255,255,255,.05)' },
  flagged: { label: 'Flagged — not verified', dot: 'var(--color-fg-muted)', text: 'var(--color-fg-muted)', bg: 'rgba(255,255,255,.05)' },
}

// An estimate tuple can come from any source tier; say which when it is not the full text.
const ESTIMATE_SOURCE = { abstract_only: { label: 'Estimate verified as printed · abstract · endpoint unchecked', dot: 'var(--color-abstract)', text: 'var(--color-abstract)', bg: 'rgba(230,184,119,.14)' }, user_text: { label: 'Estimate verified as printed · your file · endpoint unchecked', dot: 'var(--color-abstract)', text: 'var(--color-abstract)', bg: 'rgba(230,184,119,.14)' } }
const PROPORTION_SOURCE = { abstract_only: { label: 'Percentage recomputed from its count · abstract · endpoint unchecked', dot: 'var(--color-abstract)', text: 'var(--color-abstract)', bg: 'rgba(230,184,119,.14)' }, user_text: { label: 'Percentage recomputed from its count · your file · endpoint unchecked', dot: 'var(--color-abstract)', text: 'var(--color-abstract)', bg: 'rgba(230,184,119,.14)' } }
const HETEROGENEITY_SOURCE = { abstract_only: { label: 'I² verified as printed · abstract · analysis unchecked', dot: 'var(--color-abstract)', text: 'var(--color-abstract)', bg: 'rgba(230,184,119,.14)' }, user_text: { label: 'I² verified as printed · your file · analysis unchecked', dot: 'var(--color-abstract)', text: 'var(--color-abstract)', bg: 'rgba(230,184,119,.14)' } }
const COMPARISON_SOURCE = { abstract_only: { label: 'Values verified as printed · abstract · groups unchecked', dot: 'var(--color-abstract)', text: 'var(--color-abstract)', bg: 'rgba(230,184,119,.14)' }, user_text: { label: 'Values verified as printed · your file · groups unchecked', dot: 'var(--color-abstract)', text: 'var(--color-abstract)', bg: 'rgba(230,184,119,.14)' } }

// The badge stays one word. Tapping it (or Enter/Space) opens a short panel saying what the
// app checked and what it did not — hover text alone never reaches a phone. The badge is
// its own button, never nested in another control; the panel takes a full row of the
// parent's flex-wrap line (display: block elsewhere), so the value's source link beside it
// keeps working. `initialOpen` exists for rendering tests.
export default function ProvenanceBadge({ tier, sourceTier, initialOpen = false }) {
  const s = (tier === 'verified-estimate' && ESTIMATE_SOURCE[sourceTier]) || (tier === 'verified-comparison' && COMPARISON_SOURCE[sourceTier]) || (tier === 'verified-proportion' && PROPORTION_SOURCE[sourceTier]) || (tier === 'verified-heterogeneity' && HETEROGENEITY_SOURCE[sourceTier]) || STYLES[tier] || STYLES.flagged
  const [open, setOpen] = useState(initialOpen)
  const panelId = useId()
  const why = badgeExplanation(tier, sourceTier)
  const word = badgeWord(tier)
  return (
    <>
      <button
        type="button"
        title={s.label}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${word}: ${s.label}. ${open ? 'Hide' : 'Show'} what was checked`}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false) } }}
        className="inline-flex items-center cursor-pointer"
        style={{ gap: 6, minHeight: 24, borderRadius: 999, border: 0, padding: '2px 10px', fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit', background: s.bg, color: s.text }}
      >
        <span aria-hidden="true" style={{ width: 5, height: 5, borderRadius: '50%', background: s.dot }} />
        {word}
        <span aria-hidden="true" style={{ fontSize: 9, opacity: 0.7 }}>{open ? '▴' : 'ⓘ'}</span>
      </button>
      {open && (
        <span
          id={panelId}
          role="note"
          style={{ display: 'block', flexBasis: '100%', margin: '2px 0 4px', borderRadius: 9, border: '1px solid var(--hairline)', background: 'rgba(255,255,255,.03)', padding: '8px 11px', fontSize: 12, lineHeight: 1.5, color: 'var(--color-fg-dim)', fontWeight: 400 }}
        >
          <span style={{ display: 'block', fontWeight: 600, color: s.text }}>{s.label}</span>
          {why.checked.length > 0 && (
            <span style={{ display: 'block', marginTop: 4 }}>
              <span style={{ color: 'var(--color-fg-soft)', fontWeight: 600 }}>Checked: </span>{why.checked.join(' ')}
            </span>
          )}
          <span style={{ display: 'block', marginTop: 3 }}>
            <span style={{ color: 'var(--color-abstract)', fontWeight: 600 }}>Not checked: </span>{why.unchecked.join(' ')}
          </span>
        </span>
      )}
    </>
  )
}
