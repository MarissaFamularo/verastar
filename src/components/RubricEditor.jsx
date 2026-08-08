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

import { useState } from 'react'
import { hasApiKey } from '../lib/anthropic.js'
import { normalizeScoreFloor } from '../pipeline/select.js'
import { rubricScopeIssues } from '../pipeline/rubricScope.js'
import {
  normalizeJournalPreferences,
  proposeJournalMigration,
  rubricWordCount,
  RUBRIC_WORD_WARNING,
} from '../pipeline/journals.js'

export default function RubricEditor({
  criteria,
  selectCount,
  scoreFloor,
  journalPreferences,
  onJournalPreferencesChange = () => {},
  onChange,
}) {
  const floor = normalizeScoreFloor(scoreFloor)
  const scopeIssues = rubricScopeIssues(criteria)
  const wordCount = rubricWordCount(criteria)
  const journals = normalizeJournalPreferences(journalPreferences)
  const [migration, setMigration] = useState(null)
  const [migrationState, setMigrationState] = useState('idle')
  const [migrationError, setMigrationError] = useState('')
  const emit = (patch) => onChange({ criteria, selectCount, scoreFloor: floor, ...patch })

  async function reviewMigration() {
    setMigrationState('loading')
    setMigrationError('')
    try {
      const proposal = await proposeJournalMigration({ rubric: criteria, journalPreferences: journals })
      setMigration(proposal)
      setMigrationState(proposal.changed ? 'preview' : 'none')
    } catch (err) {
      setMigrationError(err?.message || String(err))
      setMigrationState('error')
    }
  }

  function applyMigration() {
    if (!migration?.changed) return
    onJournalPreferencesChange(migration.journalPreferences)
    emit({ criteria: migration.rubric })
    setMigration(null)
    setMigrationState('idle')
  }

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
      <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--color-fg-faint)', lineHeight: 1.5 }}>
        For each score, the paper scorer uses that paper&rsquo;s title, abstract, journal and
        design signals; its mapped search steering; and your north stars, projects and
        rubric. It cannot see your saved library or prior runs. Topic coverage is applied
        afterward across the slate.
      </p>
      <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
        <JournalList
          label="Must-not-miss journals"
          hint="A strong signal that a paper should reach you."
          items={journals.mustNotMiss}
          onChange={(mustNotMiss) => onJournalPreferencesChange(normalizeJournalPreferences({ ...journals, mustNotMiss }))}
        />
        <JournalList
          label="Preferred journals"
          hint="A positive signal, not an automatic inclusion."
          items={journals.preferred}
          onChange={(preferred) => onJournalPreferencesChange(normalizeJournalPreferences({ ...journals, preferred }))}
        />
      </div>
      <textarea
        value={criteria}
        onChange={(e) => emit({ criteria: e.target.value })}
        rows={7}
        placeholder="Prioritize… Rank lower… Skip…"
        style={{ marginTop: 12, width: '100%', resize: 'vertical', borderRadius: 10, border: '1px solid rgba(255,255,255,.1)', background: 'var(--surface-input)', padding: '11px 13px', fontSize: 13.5, lineHeight: 1.55, color: 'var(--color-fg-soft)', fontFamily: 'inherit', outline: 'none' }}
      />
      <div className="flex flex-wrap items-center justify-between" style={{ marginTop: 6, gap: 8 }}>
        <span style={{ fontSize: 11.5, color: wordCount > RUBRIC_WORD_WARNING ? 'var(--color-abstract)' : 'var(--color-fg-faint)' }}>
          {wordCount} words{wordCount > RUBRIC_WORD_WARNING ? ` · long rubrics repeat in every scoring batch` : ''}
        </span>
        {criteria?.trim() && (
          <button
            type="button"
            onClick={reviewMigration}
            disabled={!hasApiKey() || migrationState === 'loading'}
            className="cursor-pointer"
            style={{ ...smallButton, opacity: !hasApiKey() || migrationState === 'loading' ? .5 : 1 }}
            title={!hasApiKey() ? 'Connect Claude to review an existing rubric' : ''}
          >
            {migrationState === 'loading' ? 'Reviewing…' : 'Move journal lists out of rubric'}
          </button>
        )}
      </div>
      {migrationState === 'none' && <p role="status" style={migrationNote}>No separable journal-only text was found. Nothing changed.</p>}
      {migrationState === 'error' && <p role="alert" style={{ ...migrationNote, color: 'var(--color-danger)' }}>{migrationError}</p>}
      {migrationState === 'preview' && migration && (
        <div role="status" style={{ marginTop: 10, borderRadius: 9, border: '1px solid rgba(115,184,205,.28)', background: 'rgba(115,184,205,.06)', padding: '10px 11px' }}>
          <p style={{ margin: 0, fontSize: 12, fontWeight: 600, color: 'var(--color-fg-soft)' }}>Review before applying</p>
          <p style={{ margin: '4px 0 7px', fontSize: 11.5, color: 'var(--color-fg-muted)', lineHeight: 1.45 }}>
            Only exact journal-only text is removed. All other editorial criteria remain verbatim.
          </p>
          <textarea readOnly value={migration.rubric} rows={5} aria-label="Shortened rubric preview" style={{ width: '100%', resize: 'vertical', borderRadius: 8, border: '1px solid rgba(255,255,255,.1)', background: 'var(--surface-input)', padding: '9px 10px', fontSize: 12, lineHeight: 1.45, color: 'var(--color-fg-soft)', fontFamily: 'inherit' }} />
          <p style={{ margin: '6px 0 0', fontSize: 11.5, color: 'var(--color-fg-muted)' }}>
            Must-not-miss: {migration.journalPreferences.mustNotMiss.join(', ') || 'none'} · Preferred: {migration.journalPreferences.preferred.join(', ') || 'none'}
          </p>
          <div className="flex items-center" style={{ marginTop: 9, gap: 8 }}>
            <button type="button" onClick={applyMigration} className="cursor-pointer" style={smallButton}>Apply migration</button>
            <button type="button" onClick={() => { setMigration(null); setMigrationState('idle') }} className="cursor-pointer" style={{ ...smallButton, background: 'transparent' }}>Cancel</button>
          </div>
        </div>
      )}
      {scopeIssues.length > 0 && (
        <div role="status" style={{ marginTop: 9, borderRadius: 9, border: '1px solid rgba(230,184,119,.28)', background: 'rgba(230,184,119,.06)', padding: '9px 11px' }}>
          <p style={{ margin: 0, fontSize: 11.5, fontWeight: 600, color: 'var(--color-abstract)' }}>
            {scopeIssues.length} rubric instruction{scopeIssues.length === 1 ? '' : 's'} outside the paper scorer&rsquo;s scope
          </p>
          <ul style={{ margin: '6px 0 0', paddingLeft: 17, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {scopeIssues.map((entry, index) => (
              <li key={`${entry.code}-${index}`} style={{ fontSize: 11.5, lineHeight: 1.45, color: 'var(--color-fg-muted)' }}>
                <span style={{ color: 'var(--color-fg-soft)' }}>&ldquo;{entry.sentence}&rdquo;</span>{' '}
                {entry.message}
              </li>
            ))}
          </ul>
          <p style={{ margin: '6px 0 0', fontSize: 11, color: 'var(--color-fg-faint)' }}>
            Your text is preserved and saving remains allowed.
          </p>
        </div>
      )}
    </div>
  )
}

function JournalList({ label, hint, items, onChange }) {
  const [input, setInput] = useState('')
  const add = () => {
    const value = input.trim()
    if (!value || items.some((item) => item.toLocaleLowerCase() === value.toLocaleLowerCase())) return
    onChange([...items, value])
    setInput('')
  }
  return (
    <div>
      <label style={{ display: 'block', fontSize: 12, color: 'var(--color-fg-soft)' }}>{label}</label>
      <p style={{ margin: '2px 0 6px', fontSize: 11, color: 'var(--color-fg-faint)' }}>{hint}</p>
      <div className="flex items-center" style={{ gap: 6 }}>
        <input value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add() } }} placeholder="Add journal" style={{ flex: 1, minWidth: 0, borderRadius: 8, border: '1px solid rgba(255,255,255,.1)', background: 'var(--surface-input)', padding: '7px 9px', color: 'var(--color-fg)', fontFamily: 'inherit', fontSize: 12 }} />
        <button type="button" onClick={add} className="cursor-pointer" style={smallButton}>Add</button>
      </div>
      {items.length > 0 && <div className="flex flex-wrap" style={{ marginTop: 7, gap: 6 }}>{items.map((item) => <button type="button" key={item} onClick={() => onChange(items.filter((entry) => entry !== item))} title={`Remove ${item}`} className="cursor-pointer" style={{ border: '1px solid rgba(255,255,255,.1)', borderRadius: 999, background: 'var(--surface-2)', padding: '4px 8px', color: 'var(--color-fg-muted)', fontSize: 11 }}>{item} ×</button>)}</div>}
    </div>
  )
}

const numberInput = { width: 58, borderRadius: 9, border: '1px solid rgba(255,255,255,.1)', background: 'var(--surface-input)', padding: '6px 10px', fontSize: 14, fontFamily: 'var(--font-mono)', textAlign: 'center', color: 'var(--color-fg)', outline: 'none' }
const smallButton = { borderRadius: 8, border: '1px solid rgba(255,255,255,.12)', background: 'var(--surface-2)', padding: '6px 9px', fontSize: 11.5, color: 'var(--color-fg-soft)', fontFamily: 'inherit' }
const migrationNote = { margin: '7px 0 0', fontSize: 11.5, color: 'var(--color-fg-muted)' }

function clampCount(raw) {
  const n = Math.round(Number(raw))
  if (!Number.isFinite(n) || n < 1) return 1
  return Math.min(n, 30)
}
