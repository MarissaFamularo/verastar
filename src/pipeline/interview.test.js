// interview.test.js — the onboarding interview's pure layer. Three things are locked here,
// and each one is a real failure this replaced:
//
//   1. The query validator. The documented failure mode is a query that LOOKS rigorous
//      ("aortic aneurysm[tiab] AND (TEVAR OR EVAR) AND mortality") and returns zero papers.
//      A model writing queries will produce exactly that if nothing checks it, and it fails
//      silently — an empty topic reads like a quiet morning. Real working queries must pass.
//   2. Normalization. The draft arrives from a model; a malformed topic row must degrade to
//      an editable review screen, never take down the only path into the app.
//   3. Re-run safety. The user has a library. Re-interviewing patches the profile record and
//      nothing else — no dropped keys, no reset calibrations.
//
// No model call anywhere: nextQuestion's first turn and the fallback path are deterministic.

import { describe, it, expect } from 'vitest'
import {
  topicIssues,
  checkTopics,
  normalizeInterviewDraft,
  mergeInterviewProfile,
  transcriptText,
  answeredTurns,
  canDraft,
  outOfTurns,
  fallbackQuestion,
  nextQuestion,
  MAX_TURNS,
  MIN_TOPICS,
  MAX_TOPICS,
  OPENING_QUESTION,
  FALLBACK_QUESTIONS,
  INTERVIEW_FIELDS,
} from './interview.js'
import { DEFAULT_SELECT_COUNT, DEFAULT_RUBRIC } from './onboard.js'
import { DEFAULT_SCORE_FLOOR } from './select.js'

const codes = (query) => topicIssues(query).map((i) => i.code)

// A real-world queries.json, used here as fixtures. Measured against PubMed (30-day edat,
// 2026-07-26), the juxtaposed rows return a fraction of what their OR-joined equivalents do:
// the carotid row returned 2 results where its OR-joined form returned 128. PubMed ANDs
// juxtaposed words, so those rows are exactly the shape the `juxtaposed` flag exists to
// catch; the OR-joined rows remain the quality bar.
const PRODUCTION_OR_QUERIES = [
  'aortic aneurysm OR aortic dissection OR TEVAR OR EVAR',
  'peripheral artery disease OR limb ischemia OR diabetic foot OR wound healing amputation',
  'pelvic venous disease OR pelvic congestion syndrome OR ovarian vein embolization OR pelvic vein embolization',
]
const PRODUCTION_JUXTAPOSED_QUERIES = [
  'vascular surgery endovascular open repair outcomes',
  'carotid stenosis endarterectomy stenting stroke prevention',
  'machine learning OR artificial intelligence OR deep learning clinical medicine surgery',
  'large language model healthcare clinical OR ChatGPT clinical OR GPT-4 medical',
  'vascular surgery education residency training simulation',
  'surgical education residency training simulation competency assessment',
  'data science surgery predictive modeling clinical informatics',
]

describe('topicIssues — the queries that come back empty', () => {
  it('passes the OR-joined production queries clean', () => {
    for (const q of PRODUCTION_OR_QUERIES) expect(topicIssues(q)).toEqual([])
  })

  it('flags the juxtaposed production rows — measured half-dead against PubMed — and nothing else about them', () => {
    for (const q of PRODUCTION_JUXTAPOSED_QUERIES) expect(codes(q)).toEqual(['juxtaposed'])
  })

  it('a run of 5+ words inside ONE OR-alternate flags even when the query has ORs elsewhere', () => {
    expect(codes('machine learning OR deep learning clinical medicine surgery')).toContain('juxtaposed')
  })

  it('tolerates a 4-word single concept — "chronic limb threatening ischemia" is one idea, not four', () => {
    expect(codes('chronic limb threatening ischemia')).toEqual([])
    expect(codes('carotid stenosis endarterectomy stenting')).toEqual([])
  })

  it('counts words per OR-alternate, not across the whole query', () => {
    // 10 words total, but no alternate holds 5 — this is the healthy PAD row's shape
    expect(codes('peripheral artery disease OR limb ischemia OR wound healing amputation')).toEqual([])
  })

  it('does not count boolean operators as concept words', () => {
    // 5 raw tokens, but AND is an operator, not a concept — 4 concept words, under the bar
    expect(codes('diabetic foot AND revascularization outcomes')).not.toContain('juxtaposed')
  })

  it('flags a long AND chain — MeSH expansion turns it into zero results', () => {
    expect(codes('aortic aneurysm AND TEVAR AND mortality')).toContain('and-chain')
    expect(codes('carotid AND stenting AND stroke AND outcomes')).toContain('and-chain')
  })

  it('tolerates a SINGLE AND — two anchors joined is a query a user might write themselves', () => {
    expect(codes('diabetic foot AND revascularization')).not.toContain('and-chain')
  })

  it('does not mistake a lowercase "and" in prose for the boolean operator', () => {
    // No and-chain flag — but the five real words around it are still ANDed by PubMed
    // (lowercase "and" is a stopword), so the juxtaposed flag correctly fires.
    expect(codes('limb ischemia and wound healing outcomes')).toEqual(['juxtaposed'])
    expect(codes('limb ischemia and wound healing')).toEqual([])
  })

  it('flags any bracketed field tag — it switches term mapping off', () => {
    expect(codes('aortic aneurysm[tiab]')).toContain('field-tag')
    expect(codes('carotid stenosis[Title/Abstract] OR TEVAR')).toContain('field-tag')
    expect(codes('stroke[mh] OR carotid')).toContain('field-tag')
  })

  it('flags a single bare word as too broad to be a topic', () => {
    expect(codes('carotid')).toContain('bare-word')
    expect(codes('carotid stenosis')).not.toContain('bare-word')
  })

  it('flags an empty query and stops there', () => {
    expect(codes('')).toEqual(['empty'])
    expect(codes('   ')).toEqual(['empty'])
    expect(codes(null)).toEqual(['empty'])
    expect(codes(undefined)).toEqual(['empty'])
  })

  it('reports every fault in the worst case, not just the first', () => {
    const found = codes('aortic aneurysm[tiab] AND TEVAR AND mortality')
    expect(found).toContain('and-chain')
    expect(found).toContain('field-tag')
  })

  it('never throws on junk', () => {
    expect(() => topicIssues(42)).not.toThrow()
    expect(() => topicIssues({})).not.toThrow()
    expect(() => topicIssues([])).not.toThrow()
  })
})

describe('checkTopics — the plan as a whole', () => {
  const rows = (n, q = 'carotid stenosis OR carotid endarterectomy') =>
    Array.from({ length: n }, (_, i) => ({ label: `T${i}`, query: `${q} ${i}` }))

  it('the full ten-topic plan flags exactly the juxtaposed rows, nothing else', () => {
    const plan = [...PRODUCTION_OR_QUERIES, ...PRODUCTION_JUXTAPOSED_QUERIES].map((query, i) => ({ label: `T${i}`, query }))
    const result = checkTopics(plan)
    expect(result.ok).toBe(false)
    expect(result.list).toEqual([]) // ten topics — the plan-level band is satisfied
    expect(result.rows).toHaveLength(PRODUCTION_JUXTAPOSED_QUERIES.length)
    for (const row of result.rows) expect(row.issues.map((i) => i.code)).toEqual(['juxtaposed'])
    expect(result.count).toBe(PRODUCTION_JUXTAPOSED_QUERIES.length)
  })

  it(`flags fewer than ${MIN_TOPICS}`, () => {
    const result = checkTopics(rows(4))
    expect(result.ok).toBe(false)
    expect(result.list.map((f) => f.code)).toEqual(['too-few'])
  })

  it(`flags more than ${MAX_TOPICS}`, () => {
    const result = checkTopics(rows(15))
    expect(result.list.map((f) => f.code)).toEqual(['too-many'])
  })

  it(`accepts exactly ${MIN_TOPICS} and exactly ${MAX_TOPICS} — the band is inclusive`, () => {
    expect(checkTopics(rows(MIN_TOPICS)).list).toEqual([])
    expect(checkTopics(rows(MAX_TOPICS)).list).toEqual([])
  })

  it('an empty plan says the digest would fall back to north stars, not "too few"', () => {
    expect(checkTopics([]).list.map((f) => f.code)).toEqual(['none'])
    expect(checkTopics(null).list.map((f) => f.code)).toEqual(['none'])
    expect(checkTopics(undefined).list.map((f) => f.code)).toEqual(['none'])
  })

  it('points at the offending row by index so the review screen can flag it in place', () => {
    const plan = [...rows(MIN_TOPICS)]
    plan[2] = { label: 'Carotid', query: 'carotid' }
    const result = checkTopics(plan)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].index).toBe(2)
    expect(result.rows[0].label).toBe('Carotid')
    expect(result.rows[0].issues.map((i) => i.code)).toEqual(['bare-word'])
  })

  it('counts every flag, row-level and list-level, for the summary line', () => {
    const plan = [
      { label: 'A', query: 'carotid' },
      { label: 'B', query: 'aortic[tiab] AND TEVAR AND mortality' },
    ]
    const result = checkTopics(plan)
    // bare-word + (field-tag, and-chain) + too-few
    expect(result.count).toBe(4)
    expect(result.ok).toBe(false)
  })

  it('every issue carries a message a human can act on', () => {
    const result = checkTopics([{ label: 'A', query: 'carotid' }])
    for (const row of result.rows) for (const i of row.issues) expect(i.message.length).toBeGreaterThan(10)
    for (const l of result.list) expect(l.message.length).toBeGreaterThan(10)
  })
})

describe('normalizeInterviewDraft — the model output is never trusted raw', () => {
  const good = {
    name: '  Dr. Famularo ',
    northStars: ['CLTI outcomes', '  carotid revascularization ', ''],
    projects: ['Limb Preservation Program'],
    topics: [
      { label: 'Aortic Disease', query: 'aortic aneurysm OR TEVAR' },
      { label: 'Carotid', query: 'carotid stenosis endarterectomy' },
    ],
    rubric: '  Prioritize practice-changing trials.  ',
  }

  it('trims and drops empties without reordering', () => {
    const draft = normalizeInterviewDraft(good)
    expect(draft.name).toBe('Dr. Famularo')
    expect(draft.northStars).toEqual(['CLTI outcomes', 'carotid revascularization'])
    expect(draft.rubric.criteria).toBe('Prioritize practice-changing trials.')
    expect(draft.topics).toEqual(good.topics)
  })

  it('leaves selectCount and scoreFloor at the defined defaults — the model never sets them', () => {
    const draft = normalizeInterviewDraft(good)
    expect(draft.rubric.selectCount).toBe(DEFAULT_SELECT_COUNT)
    expect(draft.rubric.scoreFloor).toBe(DEFAULT_SCORE_FLOOR)
  })

  it('carries HER calibrations through on a re-run instead of resetting them', () => {
    const draft = normalizeInterviewDraft(good, { selectCount: 6, scoreFloor: 72 })
    expect(draft.rubric.selectCount).toBe(6)
    expect(draft.rubric.scoreFloor).toBe(72)
  })

  it('a malformed draft degrades to an editable shape and never throws', () => {
    for (const junk of [null, undefined, 'nope', 42, [], {}]) {
      const draft = normalizeInterviewDraft(junk)
      expect(draft.name).toBe('Doctor')
      expect(draft.northStars).toEqual([])
      expect(draft.projects).toEqual([])
      expect(draft.topics).toEqual([])
      expect(draft.rubric.criteria).toBe(DEFAULT_RUBRIC)
      expect(draft.rubric.selectCount).toBe(DEFAULT_SELECT_COUNT)
    }
  })

  it('drops junk topic rows, keeps the usable ones, and de-dupes identical queries', () => {
    const draft = normalizeInterviewDraft({
      topics: [
        null,
        42,
        { label: '', query: '' },
        { label: 'Aortic', query: 'aortic aneurysm OR TEVAR' },
        { label: 'Aortic again', query: 'aortic aneurysm OR TEVAR' },
        { label: 'Label only' },
        'bare string topic',
      ],
    })
    expect(draft.topics).toEqual([
      { label: 'Aortic', query: 'aortic aneurysm OR TEVAR' },
      { label: 'Label only', query: 'Label only' },
      { label: 'bare string topic', query: 'bare string topic' },
    ])
  })

  it('accepts the config-file key names straight through (topic/query)', () => {
    const draft = normalizeInterviewDraft({ topics: [{ topic: 'Aortic Disease', query: 'aortic aneurysm OR TEVAR' }] })
    expect(draft.topics).toEqual([{ label: 'Aortic Disease', query: 'aortic aneurysm OR TEVAR' }])
  })

  it('a non-array northStars is not a crash', () => {
    expect(normalizeInterviewDraft({ northStars: 'CLTI' }).northStars).toEqual([])
  })
})

describe('mergeInterviewProfile — re-running the interview loses nothing', () => {
  const existing = {
    name: 'Dr. Famularo',
    northStars: ['old star'],
    projects: ['old project'],
    topics: [{ label: 'Old', query: 'old query' }],
    rubric: { criteria: 'old criteria', selectCount: 6, scoreFloor: 72 },
    search: { days: 7, perTopic: 15 },
    onboarded: true,
    // Fields the interview knows nothing about — a later version's, or hers.
    demo: false,
    libraryFolder: 'handle-ref',
    weekendRead: { lastRun: '2026-07-20' },
  }

  it('replaces only the fields the interview owns', () => {
    const merged = mergeInterviewProfile(existing, {
      name: 'Dr. F',
      northStars: ['new star'],
      topics: [{ label: 'New', query: 'new query OR other' }],
    })
    expect(merged.name).toBe('Dr. F')
    expect(merged.northStars).toEqual(['new star'])
    expect(merged.topics).toEqual([{ label: 'New', query: 'new query OR other' }])
    expect(merged.projects).toEqual(['old project']) // not in the patch -> untouched
  })

  it('keeps every unrelated key it has never heard of', () => {
    const merged = mergeInterviewProfile(existing, { northStars: ['new'] })
    expect(merged.demo).toBe(false)
    expect(merged.libraryFolder).toBe('handle-ref')
    expect(merged.weekendRead).toEqual({ lastRun: '2026-07-20' })
    expect(merged.search).toEqual({ days: 7, perTopic: 15 })
  })

  it('patches the rubric field-by-field so tuned numbers survive a criteria-only draft', () => {
    const merged = mergeInterviewProfile(existing, { rubric: { criteria: 'brand new criteria' } })
    expect(merged.rubric).toEqual({ criteria: 'brand new criteria', selectCount: 6, scoreFloor: 72 })
  })

  it('never invents a key outside the profile — library collections are unreachable from here', () => {
    const merged = mergeInterviewProfile(existing, {
      northStars: ['new'],
      // A draft that somehow carried library data cannot smuggle it into the profile record.
      papers: ['nope'],
      seen: ['nope'],
      digests: ['nope'],
      graphNodes: ['nope'],
      graphEdges: ['nope'],
    })
    for (const key of ['papers', 'seen', 'digests', 'graphNodes', 'graphEdges']) {
      expect(key in merged).toBe(false)
    }
    expect(INTERVIEW_FIELDS).not.toContain('papers')
  })

  it('an undefined patch value is not an erasure', () => {
    const merged = mergeInterviewProfile(existing, { name: undefined, topics: undefined })
    expect(merged.name).toBe('Dr. Famularo')
    expect(merged.topics).toEqual(existing.topics)
  })

  it('marks the profile onboarded, and works from nothing at all', () => {
    expect(mergeInterviewProfile(null, { name: 'Dr. New' })).toEqual({ name: 'Dr. New', onboarded: true })
    expect(mergeInterviewProfile(undefined, {}).onboarded).toBe(true)
    expect(mergeInterviewProfile('nope', {}).onboarded).toBe(true)
  })

  it('does not mutate the profile it was handed', () => {
    const before = JSON.parse(JSON.stringify(existing))
    mergeInterviewProfile(existing, { northStars: ['new'], rubric: { criteria: 'x' } })
    expect(existing).toEqual(before)
  })
})

describe('transcript — turn accounting and the free paths', () => {
  const t = (n) => Array.from({ length: n }, (_, i) => ({ question: `Q${i}`, answer: `A${i}` }))

  it('renders Q/A pairs, marking what the user skipped rather than hiding it', () => {
    const text = transcriptText([
      { question: 'Your specialty?', answer: 'Vascular surgery' },
      { question: 'Journals?', answer: '   ' },
    ])
    expect(text).toBe('Q: Your specialty?\nA: Vascular surgery\n\nQ: Journals?\nA: (skipped)')
  })

  it('counts only answered turns toward being ready to draft', () => {
    expect(answeredTurns([{ question: 'a', answer: '' }, { question: 'b', answer: 'yes' }])).toBe(1)
    expect(canDraft([{ question: 'a', answer: 'yes' }])).toBe(false)
    expect(canDraft([{ question: 'a', answer: 'yes' }, { question: 'b', answer: 'yes' }])).toBe(true)
  })

  it(`runs out of turns at ${MAX_TURNS} questions asked, answered or not`, () => {
    expect(outOfTurns(t(MAX_TURNS - 1))).toBe(false)
    expect(outOfTurns(t(MAX_TURNS))).toBe(true)
    expect(outOfTurns([])).toBe(false)
  })

  it('handles a junk transcript without throwing', () => {
    expect(transcriptText(null)).toBe('')
    expect(answeredTurns('nope')).toBe(0)
    expect(outOfTurns(undefined)).toBe(false)
  })

  it('the scripted fallback never repeats a question already asked', () => {
    expect(fallbackQuestion([])).toBe(OPENING_QUESTION)
    const asked = [{ question: OPENING_QUESTION, answer: 'vascular surgery' }]
    expect(fallbackQuestion(asked)).toBe(FALLBACK_QUESTIONS[1])
    const all = FALLBACK_QUESTIONS.map((question) => ({ question, answer: 'x' }))
    expect(fallbackQuestion(all)).toBe('')
  })

  it('the scripted interview covers the checklist its prompt specifies', () => {
    expect(FALLBACK_QUESTIONS).toHaveLength(MAX_TURNS)
    const script = FALLBACK_QUESTIONS.join(' ').toLowerCase()
    for (const term of ['specialty', 'search', 'journal', 'design', 'llm', 'case report']) {
      expect(script).toContain(term)
    }
    // Never a form: one question mark per question.
    for (const q of FALLBACK_QUESTIONS) expect((q.match(/\?/g) || []).length).toBeLessThanOrEqual(2)
  })

  it('turn one asks the opening question with no model call at all', async () => {
    // No API key is set in this environment; if this touched the network it would throw.
    await expect(nextQuestion({ transcript: [] })).resolves.toEqual({
      ack: '',
      question: OPENING_QUESTION,
      done: false,
    })
  })

  it('a spent turn budget ends the interview without a model call', async () => {
    await expect(nextQuestion({ transcript: t(MAX_TURNS) })).resolves.toEqual({ ack: '', question: '', done: true })
  })

  it('a failed model call degrades to the scripted question instead of dead-ending', async () => {
    // getClient() throws without a key — the same shape as a rate limit or a bad key.
    const turn = await nextQuestion({ transcript: [{ question: OPENING_QUESTION, answer: 'vascular surgery' }] })
    expect(turn.question).toBe(FALLBACK_QUESTIONS[1])
    expect(turn.done).toBe(false)
    expect(turn.fallback).toBe(true)
  })
})
