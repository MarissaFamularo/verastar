// components/RubricEditor.jsx — the user-owned steering rubric.
//
// This is the editorial half of triage: the criteria that decide which papers are worth
// the clinician's morning and how they rank. It feeds the selection funnel and the
// digest's scoring. The app's integrity rules (the number-free two-channel contract, the
// output schema) are NOT here — those stay locked in triage.js. Editing this re-ranks.
//
// Two numbers, and the distinction between them is the point: the floor is the BAR a
// paper has to clear to earn a slot; the count is only a CEILING on a good day. A thin
// day is meant to produce a short digest, not ten slots of filler.

import { normalizeScoreFloor } from '../pipeline/select.js'

export default function RubricEditor({ criteria, selectCount, scoreFloor, onChange }) {
  const floor = normalizeScoreFloor(scoreFloor)
  const emit = (patch) => onChange({ criteria, selectCount, scoreFloor: floor, ...patch })

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between" style={{ gap: 12 }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 500, color: 'var(--color-fg-soft)' }}>Digest rubric</h3>
        <div className="flex flex-wrap items-center" style={{ gap: 16 }}>
          <label className="flex items-center" style={{ gap: 8, fontSize: 12, color: 'var(--color-fg-muted)' }}>
            Minimum score
            <input
              type="number"
              min="0"
              max="100"
              value={floor}
              onChange={(e) => emit({ scoreFloor: normalizeScoreFloor(e.target.value) })}
              style={numberInput}
            />
          </label>
          <label className="flex items-center" style={{ gap: 8, fontSize: 12, color: 'var(--color-fg-muted)' }}>
            Papers per day
            <input
              type="number"
              min="1"
              max="30"
              value={selectCount}
              onChange={(e) => emit({ selectCount: clampCount(e.target.value) })}
              style={numberInput}
            />
          </label>
        </div>
      </div>
      <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--color-fg-muted)', lineHeight: 1.5 }}>
        What makes a paper worth your morning. Your digest scores every candidate against
        this, keeps the ones scoring {floor} or better, and shows at most {selectCount}.
        Edit it, then re-rank the candidates to see it swing.
      </p>
      <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--color-fg-faint)', lineHeight: 1.5 }}>
        Minimum score is the bar a paper must clear to earn a slot — a thin day gets a
        short digest, not filler. Set it to 0 to always fill every slot.
      </p>
      <textarea
        value={criteria}
        onChange={(e) => emit({ criteria: e.target.value })}
        rows={7}
        placeholder="Prioritize… Rank lower… Skip…"
        style={{ marginTop: 12, width: '100%', resize: 'vertical', borderRadius: 10, border: '1px solid rgba(255,255,255,.1)', background: 'var(--surface-input)', padding: '11px 13px', fontSize: 13.5, lineHeight: 1.55, color: 'var(--color-fg-soft)', fontFamily: 'inherit', outline: 'none' }}
      />
    </div>
  )
}

const numberInput = { width: 58, borderRadius: 9, border: '1px solid rgba(255,255,255,.1)', background: 'var(--surface-input)', padding: '6px 10px', fontSize: 14, fontFamily: 'var(--font-mono)', textAlign: 'center', color: 'var(--color-fg)', outline: 'none' }

function clampCount(raw) {
  const n = Math.round(Number(raw))
  if (!Number.isFinite(n) || n < 1) return 1
  return Math.min(n, 30)
}
