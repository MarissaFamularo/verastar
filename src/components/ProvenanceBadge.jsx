// components/ProvenanceBadge.jsx — the badge is the product. It reflects a verdict the
// APP proved, never something the model asserted. Four tiers, visually distinct so a
// flagged value can never be mistaken for a verified one. Styled in the observatory
// palette (design/Verastar.dc.html): full-text green, registry blue, abstract amber,
// flagged muted grey.

const STYLES = {
  'verified-registry': { label: 'Verified · registry', dot: 'var(--color-registry)', text: 'var(--color-registry-soft)', bg: 'rgba(143,189,230,.15)' },
  'verified-full-text': { label: 'Verified · full text', dot: 'var(--color-verified)', text: 'var(--color-verified-soft)', bg: 'rgba(127,191,154,.14)' },
  'abstract-only': { label: 'Verified · abstract', dot: 'var(--color-abstract)', text: 'var(--color-abstract)', bg: 'rgba(230,184,119,.14)' },
  flagged: { label: 'Flagged — not verified', dot: 'var(--color-fg-muted)', text: 'var(--color-fg-muted)', bg: 'rgba(255,255,255,.05)' },
}

export default function ProvenanceBadge({ tier }) {
  const s = STYLES[tier] || STYLES.flagged
  return (
    <span
      className="inline-flex items-center"
      style={{ gap: 6, borderRadius: 999, padding: '2px 10px', fontSize: 11.5, fontWeight: 600, background: s.bg, color: s.text }}
    >
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: s.dot }} />
      {s.label}
    </span>
  )
}
