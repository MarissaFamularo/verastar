// components/OnboardingQuiz.jsx — "watch it build my profile in 60 seconds."
//
// A short intake → one Claude call drafts the steering profile → the clinician reviews
// and edits → save. This replaces manual chip entry as the first-run experience. A skip
// path seeds the real named user's profile (Dr. Famularo) so the demo starts from empty
// and steers in one click.

import { useState } from 'react'
import { hasApiKey } from '../lib/anthropic.js'
import { saveProfile } from '../lib/store.js'
import { draftProfile, DEMO_PROFILE, DEFAULT_RUBRIC, DEFAULT_SELECT_COUNT } from '../pipeline/onboard.js'
import ChipGroup from './ChipGroup.jsx'
import RubricEditor from './RubricEditor.jsx'

const QUESTIONS = [
  {
    key: 'focus',
    label: 'Your specialty and how the digest should address you',
    placeholder: "e.g. I'm a vascular surgeon — call me Dr. Reyes.",
  },
  {
    key: 'projects',
    label: "What you're actively working on",
    placeholder: 'e.g. Running a limb-preservation program; a utilization study on CLTI admissions.',
  },
  {
    key: 'priorities',
    label: 'What makes a paper worth your morning — and what to skip',
    placeholder: 'e.g. Practice-changing trials with hard endpoints. Skip preclinical work and editorials.',
  },
]

export default function OnboardingQuiz({ onDone }) {
  const [phase, setPhase] = useState('quiz') // quiz | drafting | review
  const [answers, setAnswers] = useState({})
  const [draft, setDraft] = useState(null) // { name, northStars, projects, rubric:{criteria,selectCount} }
  const [error, setError] = useState('')
  const keySet = hasApiKey()
  const answered = QUESTIONS.some((q) => (answers[q.key] || '').trim())

  async function build() {
    setError('')
    setPhase('drafting')
    try {
      const labeled = Object.fromEntries(
        QUESTIONS.map((q) => [q.label, answers[q.key] || '']),
      )
      const profile = await draftProfile({ answers: labeled })
      setDraft({ name: profile.name, ...profile })
      setPhase('review')
    } catch (err) {
      setError(err?.message || String(err))
      setPhase('quiz')
    }
  }

  function useDemo() {
    saveProfile({ ...DEMO_PROFILE }).then(() => onDone?.(DEMO_PROFILE))
  }

  async function save() {
    const profile = {
      name: (draft.name || 'Doctor').trim(),
      northStars: draft.northStars,
      projects: draft.projects,
      rubric: {
        criteria: (draft.rubric?.criteria || DEFAULT_RUBRIC).trim(),
        selectCount: draft.rubric?.selectCount || DEFAULT_SELECT_COUNT,
      },
      onboarded: true,
    }
    await saveProfile(profile)
    onDone?.(profile)
  }

  // Draft edit helpers.
  const setField = (patch) => setDraft((d) => ({ ...d, ...patch }))
  const addTo = (field) => (v) => setDraft((d) => (d[field].includes(v) ? d : { ...d, [field]: [...d[field], v] }))
  const removeFrom = (field) => (v) => setDraft((d) => ({ ...d, [field]: d[field].filter((x) => x !== v) }))

  return (
    <section className="mt-8 rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium">Build your steering profile</h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Answer a few questions and Claude drafts your north stars, projects, and digest
            rubric. You review and edit everything before it's saved.
          </p>
        </div>
        <button
          onClick={useDemo}
          className="shrink-0 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          Skip — use demo profile
        </button>
      </div>

      {!keySet && (
        <p className="mt-3 text-sm text-amber-600 dark:text-amber-400">
          Set your API key above to build a profile from your answers — or skip to the demo profile.
        </p>
      )}

      {/* QUIZ — the intake questions. */}
      {phase !== 'review' && (
        <div className="mt-5 space-y-5">
          {QUESTIONS.map((q) => (
            <div key={q.key}>
              <label className="text-sm font-medium">{q.label}</label>
              <textarea
                value={answers[q.key] || ''}
                onChange={(e) => setAnswers((a) => ({ ...a, [q.key]: e.target.value }))}
                rows={2}
                placeholder={q.placeholder}
                disabled={phase === 'drafting'}
                className="mt-2 w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm leading-6 outline-none focus:border-slate-500 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-950"
              />
            </div>
          ))}

          {error && <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}

          <button
            onClick={build}
            disabled={!keySet || !answered || phase === 'drafting'}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
          >
            {phase === 'drafting' ? 'Claude is drafting your profile…' : 'Build my profile'}
          </button>
        </div>
      )}

      {/* REVIEW — the drafted profile, fully editable, before save. */}
      {phase === 'review' && draft && (
        <div className="mt-6 space-y-6">
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-200">
            Drafted your profile{draft.name ? ` for ${draft.name}` : ''} — review and edit, then save.
          </div>

          <div>
            <label className="text-sm font-medium">Digest greeting</label>
            <input
              value={draft.name || ''}
              onChange={(e) => setField({ name: e.target.value })}
              className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-950"
            />
          </div>

          <div className="grid gap-6 sm:grid-cols-2">
            <ChipGroup
              label="North stars"
              hint="Concepts you steer by (used as search terms)"
              items={draft.northStars}
              onAdd={addTo('northStars')}
              onRemove={removeFrom('northStars')}
              placeholder="e.g. CLTI outcomes"
              accent="sky"
            />
            <ChipGroup
              label="Active projects"
              hint="What the relevance line speaks to"
              items={draft.projects}
              onAdd={addTo('projects')}
              onRemove={removeFrom('projects')}
              placeholder="e.g. Limb Preservation Program"
              accent="violet"
            />
          </div>

          <RubricEditor
            criteria={draft.rubric.criteria}
            selectCount={draft.rubric.selectCount}
            onChange={(rubric) => setField({ rubric })}
          />

          <div className="flex flex-wrap gap-2">
            <button
              onClick={save}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
            >
              Save profile
            </button>
            <button
              onClick={() => setPhase('quiz')}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              Back to questions
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
