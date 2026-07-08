// components/RubricEditor.jsx — the user-owned steering rubric.
//
// This is the editorial half of triage: the criteria that decide which papers are worth
// the clinician's morning and how they rank. It feeds the selection funnel and the
// digest's scoring. The app's integrity rules (the number-free two-channel contract, the
// output schema) are NOT here — those stay locked in triage.js. Editing this re-ranks.

export default function RubricEditor({ criteria, selectCount, onChange }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">Digest rubric</h3>
        <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          Papers per day
          <input
            type="number"
            min="1"
            max="30"
            value={selectCount}
            onChange={(e) => onChange({ criteria, selectCount: clampCount(e.target.value) })}
            className="w-16 rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm tabular-nums outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-950"
          />
        </label>
      </div>
      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
        What makes a paper worth your morning. Your scan scores every candidate against
        this and selects the top {selectCount}. Edit it and re-scan to re-rank.
      </p>
      <textarea
        value={criteria}
        onChange={(e) => onChange({ criteria: e.target.value, selectCount })}
        rows={7}
        placeholder="Prioritize… Rank lower… Skip…"
        className="mt-3 w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm leading-6 outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-950"
      />
    </div>
  )
}

function clampCount(raw) {
  const n = Math.round(Number(raw))
  if (!Number.isFinite(n) || n < 1) return 1
  return Math.min(n, 30)
}
