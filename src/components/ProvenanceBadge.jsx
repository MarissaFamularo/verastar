// components/ProvenanceBadge.jsx — the badge is the product. It reflects a verdict the
// APP proved, never something the model asserted. Four tiers, visually distinct so a
// flagged value can never be mistaken for a verified one. Styled in the observatory
// palette (design/Verastar.dc.html): full-text green, registry blue, abstract amber,
// flagged muted grey.

import { badgeWord } from '../lib/badgeWord.js'

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

export default function ProvenanceBadge({ tier, sourceTier }) {
  const s = (tier === 'verified-estimate' && ESTIMATE_SOURCE[sourceTier]) || (tier === 'verified-comparison' && COMPARISON_SOURCE[sourceTier]) || (tier === 'verified-proportion' && PROPORTION_SOURCE[sourceTier]) || (tier === 'verified-heterogeneity' && HETEROGENEITY_SOURCE[sourceTier]) || STYLES[tier] || STYLES.flagged
  return (
    <span
      title={s.label}
      className="inline-flex items-center"
      style={{ gap: 6, borderRadius: 999, padding: '2px 10px', fontSize: 11.5, fontWeight: 600, background: s.bg, color: s.text, cursor: 'help' }}
    >
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: s.dot }} />
      {badgeWord(tier)}
    </span>
  )
}
