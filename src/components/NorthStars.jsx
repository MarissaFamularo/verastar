// components/NorthStars.jsx — the steering profile editor (post-onboarding).
//
// Four fields, and the split between the first two is the load-bearing one: search TOPICS
// decide what PubMed is asked for (one query each), north stars and projects make the
// rubric's relevance line personal, and the rubric decides which candidates are worth the
// morning and how they rank. All persist locally (IndexedDB via store.js) and drive the
// digest. The onboarding quiz drafts these; this is where they're refined afterward.

import { useEffect, useState } from 'react'
import { getProfile, saveProfile } from '../lib/store.js'
import { DEFAULT_RUBRIC, DEFAULT_SELECT_COUNT } from '../pipeline/onboard.js'
import { normalizeScoreFloor } from '../pipeline/select.js'
import { normalizeTopics, normalizeSearchDays, normalizeTopicCap } from '../pipeline/topics.js'
import ChipGroup from './ChipGroup.jsx'
import RubricEditor from './RubricEditor.jsx'
import TopicsEditor from './TopicsEditor.jsx'

const STAR_SEED = ['CLTI outcomes', 'Carotid revascularization', 'AI in medicine']
const PROJECT_SEED = ['Limb Preservation Program', 'COSMOS utilization study']

export default function NorthStars() {
  const [stars, setStars] = useState([])
  const [projects, setProjects] = useState([])
  const [rubric, setRubric] = useState({
    criteria: DEFAULT_RUBRIC,
    selectCount: DEFAULT_SELECT_COUNT,
    scoreFloor: normalizeScoreFloor(undefined),
  })
  // Topic rows are held RAW, not normalized: a row mid-typing is legitimately half empty,
  // and normalizing on every keystroke would delete the row she's in the middle of writing.
  // Normalization happens once, on the way to storage.
  const [topics, setTopics] = useState([])
  const [search, setSearch] = useState({ days: normalizeSearchDays(undefined), perTopic: normalizeTopicCap(undefined) })
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    getProfile().then((profile) => {
      setStars(profile?.northStars ?? [])
      setProjects(profile?.projects ?? [])
      setRubric({
        criteria: profile?.rubric?.criteria ?? DEFAULT_RUBRIC,
        selectCount: profile?.rubric?.selectCount ?? DEFAULT_SELECT_COUNT,
        // Profiles written before the floor existed have no scoreFloor — normalize
        // rather than let `undefined` reach the input and blank the field.
        scoreFloor: normalizeScoreFloor(profile?.rubric?.scoreFloor),
      })
      // Same story for topics and the window: a profile that predates them normalizes to an
      // empty list and the 3-day default, and the scan degrades to the north stars.
      setTopics(normalizeTopics(profile?.topics))
      setSearch({
        days: normalizeSearchDays(profile?.search?.days),
        perTopic: normalizeTopicCap(profile?.search?.perTopic),
      })
      setLoaded(true)
    })
  }, [])

  useEffect(() => {
    if (!loaded) return
    getProfile().then((profile) =>
      saveProfile({
        ...(profile || {}),
        northStars: stars,
        projects,
        rubric,
        topics: normalizeTopics(topics),
        search,
      }),
    )
  }, [stars, projects, rubric, topics, search, loaded])

  const addTo = (setter, list) => (v) => {
    if (!list.includes(v)) setter([...list, v])
  }
  const removeFrom = (setter, list) => (v) => setter(list.filter((x) => x !== v))

  return (
    <section style={{ marginTop: 14 }}>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--color-fg-muted)', lineHeight: 1.55 }}>
        The topics you search, the concepts you steer by, the projects you're driving, and
        the rubric your digest ranks against. Your daily digest surfaces and selects papers
        using these.
      </p>

      <div className="grid gap-6 sm:grid-cols-2" style={{ marginTop: 20 }}>
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
          label="Active Work"
          hint="What the relevance line speaks to"
          seed={PROJECT_SEED}
          items={projects}
          onAdd={addTo(setProjects, projects)}
          onRemove={removeFrom(setProjects, projects)}
          placeholder="e.g. Limb Preservation Program"
          accent="violet"
        />
      </div>

      <div style={{ marginTop: 24, borderTop: '1px solid var(--hairline)', paddingTop: 24 }}>
        <TopicsEditor
          topics={topics}
          days={search.days}
          perTopic={search.perTopic}
          northStars={stars}
          onChange={({ topics: next, days, perTopic }) => {
            setTopics(next)
            setSearch({ days, perTopic })
          }}
        />
      </div>

      <div style={{ marginTop: 24, borderTop: '1px solid var(--hairline)', paddingTop: 24 }}>
        <RubricEditor
          criteria={rubric.criteria}
          selectCount={rubric.selectCount}
          scoreFloor={rubric.scoreFloor}
          onChange={setRubric}
        />
      </div>
    </section>
  )
}
