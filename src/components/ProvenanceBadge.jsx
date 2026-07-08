// components/ProvenanceBadge.jsx — the badge is the product. It reflects a verdict the
// APP proved, never something the model asserted. Four tiers, visually distinct so a
// flagged value can never be mistaken for a verified one.

const STYLES = {
  'verified-registry': {
    label: 'Verified · registry',
    cls: 'bg-violet-100 text-violet-800 ring-violet-300 dark:bg-violet-900/40 dark:text-violet-200 dark:ring-violet-700',
    dot: 'bg-violet-500',
  },
  'verified-full-text': {
    label: 'Verified · full text',
    cls: 'bg-emerald-100 text-emerald-800 ring-emerald-300 dark:bg-emerald-900/40 dark:text-emerald-200 dark:ring-emerald-700',
    dot: 'bg-emerald-500',
  },
  'abstract-only': {
    label: 'Verified · abstract',
    cls: 'bg-amber-100 text-amber-900 ring-amber-300 dark:bg-amber-900/40 dark:text-amber-200 dark:ring-amber-700',
    dot: 'bg-amber-500',
  },
  flagged: {
    label: 'Flagged — not verified',
    cls: 'bg-slate-200 text-slate-600 ring-slate-300 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-600',
    dot: 'bg-slate-400',
  },
}

export default function ProvenanceBadge({ tier }) {
  const s = STYLES[tier] || STYLES.flagged
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${s.cls}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  )
}
