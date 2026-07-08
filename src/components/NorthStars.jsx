// components/NorthStars.jsx — the steering profile: north-star concepts + active projects.
//
// These persist locally (IndexedDB via store.js) and drive the digest: north stars frame
// what gets surfaced; projects make the relevance line personal ("validates your
// hospital-free-days endpoint"). Later, triage ranks candidates against both.

import { useEffect, useState } from 'react'
import { getProfile, saveProfile } from '../lib/store.js'

const STAR_SEED = ['CLTI outcomes', 'Carotid revascularization', 'AI in medicine']
const PROJECT_SEED = ['Limb Preservation Program', 'COSMOS utilization study']

function ChipGroup({ label, hint, seed, items, onAdd, onRemove, placeholder, accent }) {
  const [draft, setDraft] = useState('')
  const chip =
    accent === 'sky'
      ? 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200'
      : 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200'
  const chipBtn =
    accent === 'sky'
      ? 'text-sky-500 hover:bg-sky-200 hover:text-sky-900 dark:hover:bg-sky-800'
      : 'text-violet-500 hover:bg-violet-200 hover:text-violet-900 dark:hover:bg-violet-800'

  return (
    <div>
      <h3 className="text-sm font-medium">{label}</h3>
      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{hint}</p>

      <div className="mt-3 flex flex-wrap gap-2">
        {items.map((s) => (
          <span key={s} className={`inline-flex items-center gap-1.5 rounded-full py-1 pl-3 pr-1.5 text-sm font-medium ${chip}`}>
            {s}
            <button
              onClick={() => onRemove(s)}
              aria-label={`Remove ${s}`}
              className={`flex h-4 w-4 items-center justify-center rounded-full ${chipBtn}`}
            >
              ×
            </button>
          </span>
        ))}
        {items.length === 0 && <span className="text-sm text-slate-400">None yet.</span>}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (draft.trim()) {
            onAdd(draft.trim())
            setDraft('')
          }
        }}
        className="mt-3 flex gap-2"
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-950"
        />
        <button type="submit" className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800">
          Add
        </button>
      </form>

      {items.length === 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {seed.map((s) => (
            <button
              key={s}
              onClick={() => onAdd(s)}
              className="rounded-full border border-dashed border-slate-300 px-3 py-1 text-xs text-slate-600 hover:border-slate-500 hover:text-slate-900 dark:border-slate-700 dark:text-slate-400 dark:hover:text-slate-100"
            >
              + {s}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function NorthStars() {
  const [stars, setStars] = useState([])
  const [projects, setProjects] = useState([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    getProfile().then((profile) => {
      setStars(profile?.northStars ?? [])
      setProjects(profile?.projects ?? [])
      setLoaded(true)
    })
  }, [])

  useEffect(() => {
    if (!loaded) return
    getProfile().then((profile) => saveProfile({ ...(profile || {}), northStars: stars, projects }))
  }, [stars, projects, loaded])

  const addTo = (setter, list) => (v) => {
    if (!list.includes(v)) setter([...list, v])
  }
  const removeFrom = (setter, list) => (v) => setter(list.filter((x) => x !== v))

  return (
    <section className="mt-8 rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <h2 className="text-lg font-medium">Your steering profile</h2>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
        The concepts you steer by and the projects you're driving. Your daily scan surfaces
        and ranks papers against these.
      </p>

      <div className="mt-5 grid gap-6 sm:grid-cols-2">
        <ChipGroup
          label="North stars"
          hint="Concepts you steer by"
          seed={STAR_SEED}
          items={stars}
          onAdd={addTo(setStars, stars)}
          onRemove={removeFrom(setStars, stars)}
          placeholder="e.g. CLTI outcomes"
          accent="sky"
        />
        <ChipGroup
          label="Active projects"
          hint="What the relevance line speaks to"
          seed={PROJECT_SEED}
          items={projects}
          onAdd={addTo(setProjects, projects)}
          onRemove={removeFrom(setProjects, projects)}
          placeholder="e.g. Limb Preservation Program"
          accent="violet"
        />
      </div>
    </section>
  )
}
