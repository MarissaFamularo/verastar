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

import { checkTopics } from '../pipeline/interview.js'

export default function QueryFlags({ topics }) {
  const { ok, rows, list, count } = checkTopics(topics)

  if (!topics?.length) return null // the editor's own empty state already speaks

  if (ok) {
    return (
      <p style={{ margin: '10px 0 0', fontSize: 12.5, color: 'var(--color-verified-soft)' }}>
        ✓ {topics.length} topics, no obvious query problems — nothing over-specified, no field
        tags, nothing too broad to be useful.
      </p>
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
    </div>
  )
}
