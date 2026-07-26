// components/NorthStars.jsx — the steering profile editor (post-onboarding).
//
// Four fields, and the split between the first two is the load-bearing one: search TOPICS
// decide what PubMed is asked for (one query each), north stars and projects make the
// rubric's relevance line personal, and the rubric decides which candidates are worth the
// morning and how they rank. All persist locally (IndexedDB via store.js) and drive the
// digest. The onboarding quiz drafts these; this is where they're refined afterward.

import { useEffect, useState } from 'react'
import { hasApiKey } from '../lib/anthropic.js'
import { getProfile, saveProfile } from '../lib/store.js'
import { isSignedIn } from '../lib/supabase.js'
import { getTrellisProjects, getTrellisExcluded, setTrellisExcluded } from '../lib/trellis.js'
import { DEFAULT_RUBRIC, DEFAULT_SELECT_COUNT } from '../pipeline/onboard.js'
import { normalizeScoreFloor } from '../pipeline/select.js'
import { normalizeTopics, normalizeSearchDays, normalizeTopicCap } from '../pipeline/topics.js'
import ChipGroup from './ChipGroup.jsx'
import ProfileInterview from './ProfileInterview.jsx'
import QueryFlags from './QueryFlags.jsx'
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
  // Re-interviewing an existing profile. It writes through the SAME save effect below, which
  // patches the profile record and nothing else — so rebuilding the search plan can never
  // touch her library (papers, digests, graph, seen ledger all live in other collections).
  const [interviewing, setInterviewing] = useState(false)
  // Synced PaperTrellis projects, shown below the manual list. PaperTrellis is the source
  // of truth for the projects themselves — no add/remove here, editing happens over there.
  // The STAR is Verastar's: it marks which of them the digest may consider. `excluded`
  // holds the un-starred ids (so a newly synced project defaults to starred).
  const [trellis, setTrellis] = useState([])
  const [excluded, setExcluded] = useState(new Set())

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
    if (isSignedIn()) {
      getTrellisProjects().then((c) => setTrellis(c?.projects ?? [])).catch(() => {})
      getTrellisExcluded().then(setExcluded).catch(() => {})
    }
  }, [])

  // Star toggle: flip membership in the exclusion set and persist it whole. The write is
  // the singleton row, so last-writer-wins matches every other profile-adjacent setting.
  function toggleStar(id) {
    setExcluded((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      setTrellisExcluded(next).catch(() => {})
      return next
    })
  }

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

  // A fresh draft lands in the editors, NOT straight in storage: the save effect above then
  // persists it exactly the way a hand edit is persisted. An empty field in the draft leaves
  // hers alone — a thin interview should never blank a list she already curated.
  function applyDraft(draft) {
    if (draft.northStars?.length) setStars(draft.northStars)
    if (draft.projects?.length) setProjects(draft.projects)
    if (draft.topics?.length) setTopics(draft.topics)
    if (draft.rubric?.criteria) setRubric((r) => ({ ...r, criteria: draft.rubric.criteria }))
    setInterviewing(false)
  }

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

      {interviewing ? (
        <div style={{ marginTop: 18, borderRadius: 12, border: '1px solid rgba(255,255,255,.1)', background: 'var(--surface-1)', padding: '18px 18px 20px' }}>
          <p style={{ margin: '0 0 4px', fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '.13em', color: 'var(--color-fg-faint)' }}>
            REBUILDING YOUR PROFILE
          </p>
          <p style={{ margin: '0 0 16px', fontSize: 12.5, lineHeight: 1.55, color: 'var(--color-fg-muted)' }}>
            The draft lands in the fields below for you to edit — your library, digests and
            seen-paper history aren't touched.
          </p>
          <ProfileInterview
            selectCount={rubric.selectCount}
            scoreFloor={rubric.scoreFloor}
            onDraft={applyDraft}
            onCancel={() => setInterviewing(false)}
            cancelLabel="Cancel"
          />
        </div>
      ) : (
        <div className="flex flex-wrap items-center" style={{ marginTop: 14, gap: 12 }}>
          <button
            onClick={() => setInterviewing(true)}
            disabled={!hasApiKey()}
            className="cursor-pointer"
            style={{ borderRadius: 9, padding: '8px 13px', fontSize: 12.5, fontWeight: 500, fontFamily: 'inherit', border: '1px solid rgba(239,143,91,.35)', background: 'rgba(239,143,91,.09)', color: 'var(--color-accent)', opacity: hasApiKey() ? 1 : 0.5 }}
          >
            ✶ Rebuild these with an interview
          </button>
          <span style={{ fontSize: 11.5, color: 'var(--color-fg-faint)' }}>
            {hasApiKey()
              ? 'A few questions, then a fresh draft you edit — nothing in your library changes.'
              : 'Add your Anthropic key in Settings to run the interview.'}
          </span>
        </div>
      )}

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

      {/* Signed in with an empty cache shows nothing — no nagging about a tool she may
          not use. Non-empty, the synced set is visible so she knows what the digest sees. */}
      {isSignedIn() && trellis.length > 0 && (
        <div style={{ marginTop: 16, padding: '13px 15px', borderRadius: 11, border: '1px solid var(--hairline)', background: 'var(--surface-1)' }}>
          <p style={{ margin: '0 0 10px', fontSize: 11, letterSpacing: '.13em', textTransform: 'uppercase', color: 'var(--color-fg-faint)', fontWeight: 600 }}>
            From PaperTrellis
          </p>
          <div className="flex flex-col" style={{ gap: 7 }}>
            {trellis.map((p) => {
              const starred = !excluded.has(p.id)
              return (
                <div key={p.id} className="flex items-center" style={{ gap: 9, opacity: starred ? 1 : 0.45 }}>
                  {/* The five-point outline star — the app's own mark, never a sparkle.
                      Filled gold = the digest considers this project; hollow = it doesn't. */}
                  <button
                    onClick={() => toggleStar(p.id)}
                    title={starred ? 'Considered in your digest — click to leave it out' : 'Left out of your digest — click to consider it'}
                    aria-label={starred ? `Stop considering ${p.title} in the digest` : `Consider ${p.title} in the digest`}
                    className="cursor-pointer flex items-center"
                    style={{ padding: 2, border: 0, background: 'transparent', color: starred ? 'var(--color-gold)' : 'var(--color-fg-faint)', flex: '0 0 auto' }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill={starred ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
                      <polygon points="12,3 14.47,9.6 21.51,9.91 15.99,14.3 17.88,21.09 12,17.2 6.12,21.09 8.01,14.3 2.49,9.91 9.53,9.6" />
                    </svg>
                  </button>
                  <span style={{ fontSize: 13, color: 'var(--color-fg-soft)' }}>{p.title}</span>
                  <span style={{ padding: '2px 8px', borderRadius: 999, background: 'rgba(143,189,230,.1)', fontSize: 10.5, fontWeight: 500, color: 'var(--color-registry)' }}>
                    {p.stage?.name}
                  </span>
                </div>
              )
            })}
          </div>
          <p style={{ margin: '10px 0 0', fontSize: 11.5, lineHeight: 1.5, color: 'var(--color-fg-faint)' }}>
            Pre-submission projects, synced from your PaperTrellis account — edit them there.
            Starred ones steer your digest; un-star a project to leave it out.
          </p>
        </div>
      )}

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
        <QueryFlags topics={topics} />
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
