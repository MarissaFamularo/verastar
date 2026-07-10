// components/RubricEditor.jsx — the user-owned steering rubric.
//
// This is the editorial half of triage: the criteria that decide which papers are worth
// the clinician's morning and how they rank. It feeds the selection funnel and the
// digest's scoring. The app's integrity rules (the number-free two-channel contract, the
// output schema) are NOT here — those stay locked in triage.js. Editing this re-ranks.

export default function RubricEditor({ criteria, selectCount, onChange }) {
  return (
    <div>
      <div className="flex items-center justify-between" style={{ gap: 12 }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 500, color: 'var(--color-fg-soft)' }}>Digest rubric</h3>
        <label className="flex items-center" style={{ gap: 8, fontSize: 12, color: 'var(--color-fg-muted)' }}>
          Papers per day
          <input
            type="number"
            min="1"
            max="30"
            value={selectCount}
            onChange={(e) => onChange({ criteria, selectCount: clampCount(e.target.value) })}
            style={{ width: 58, borderRadius: 9, border: '1px solid rgba(255,255,255,.1)', background: 'var(--surface-input)', padding: '6px 10px', fontSize: 14, fontFamily: 'var(--font-mono)', textAlign: 'center', color: 'var(--color-fg)', outline: 'none' }}
          />
        </label>
      </div>
      <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--color-fg-muted)', lineHeight: 1.5 }}>
        What makes a paper worth your morning. Your digest scores every candidate against
        this and selects the top {selectCount}. Edit it, then re-rank the candidates to see it swing.
      </p>
      <textarea
        value={criteria}
        onChange={(e) => onChange({ criteria: e.target.value, selectCount })}
        rows={7}
        placeholder="Prioritize… Rank lower… Skip…"
        style={{ marginTop: 12, width: '100%', resize: 'vertical', borderRadius: 10, border: '1px solid rgba(255,255,255,.1)', background: 'var(--surface-input)', padding: '11px 13px', fontSize: 13.5, lineHeight: 1.55, color: 'var(--color-fg-soft)', fontFamily: 'inherit', outline: 'none' }}
      />
    </div>
  )
}

function clampCount(raw) {
  const n = Math.round(Number(raw))
  if (!Number.isFinite(n) || n < 1) return 1
  return Math.min(n, 30)
}
