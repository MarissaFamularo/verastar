// components/NorthStars.jsx — the steering profile editor (post-onboarding).
//
// North stars frame what the scan surfaces; projects make the relevance line personal;
// the rubric decides which candidates are worth the morning and how they rank. All persist
// locally (IndexedDB via store.js) and drive the digest. The onboarding quiz drafts these;
// this is where they're refined afterward.

import { useEffect, useState } from 'react'
import { getProfile, saveProfile } from '../lib/store.js'
import { DEFAULT_RUBRIC, DEFAULT_SELECT_COUNT } from '../pipeline/onboard.js'
import ChipGroup from './ChipGroup.jsx'
import RubricEditor from './RubricEditor.jsx'

const STAR_SEED = ['CLTI outcomes', 'Carotid revascularization', 'AI in medicine']
const PROJECT_SEED = ['Limb Preservation Program', 'COSMOS utilization study']

export default function NorthStars() {
  const [stars, setStars] = useState([])
  const [projects, setProjects] = useState([])
  const [rubric, setRubric] = useState({ criteria: DEFAULT_RUBRIC, selectCount: DEFAULT_SELECT_COUNT })
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    getProfile().then((profile) => {
      setStars(profile?.northStars ?? [])
      setProjects(profile?.projects ?? [])
      setRubric({
        criteria: profile?.rubric?.criteria ?? DEFAULT_RUBRIC,
        selectCount: profile?.rubric?.selectCount ?? DEFAULT_SELECT_COUNT,
      })
      setLoaded(true)
    })
  }, [])

  useEffect(() => {
    if (!loaded) return
    getProfile().then((profile) =>
      saveProfile({ ...(profile || {}), northStars: stars, projects, rubric }),
    )
  }, [stars, projects, rubric, loaded])

  const addTo = (setter, list) => (v) => {
    if (!list.includes(v)) setter([...list, v])
  }
  const removeFrom = (setter, list) => (v) => setter(list.filter((x) => x !== v))

  return (
    <section className="mt-8 rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <h2 className="text-lg font-medium">Your steering profile</h2>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
        The concepts you steer by, the projects you're driving, and the rubric your digest
        ranks against. Your daily digest surfaces and selects papers using these.
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

      <div className="mt-6 border-t border-slate-100 pt-6 dark:border-slate-800">
        <RubricEditor criteria={rubric.criteria} selectCount={rubric.selectCount} onChange={setRubric} />
      </div>
    </section>
  )
}
