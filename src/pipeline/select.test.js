// select.test.js — the score floor: the rule that a digest slot is earned, not filled.
// Locks the two things that make a thin day honest: nothing below the bar is ever
// padded in, and zero papers is a reportable outcome rather than a failure.

import { beforeEach, describe, it, expect, vi } from 'vitest'
import { extractStructured } from '../lib/anthropic.js'
import { fetchAbstractsByPmid } from './sources.js'
import {
  applyScoreFloor,
  applyPostReadFloor,
  normalizeScoreFloor,
  preReadFloor,
  floorSummary,
  readFitLabel,
  belowFloorNote,
  DEFAULT_SCORE_FLOOR,
  PRE_READ_MARGIN,
  SCALE,
  SELECTION_SCHEMA,
  SELECTION_BATCH_SIZE,
  SELECTION_PARSE_ATTEMPTS,
  selectCandidates,
} from './select.js'

vi.mock('../lib/anthropic.js', () => ({
  extractStructured: vi.fn(),
  MODELS: { triage: 'test-triage' },
}))

vi.mock('./sources.js', () => ({
  fetchAbstractsByPmid: vi.fn(),
}))

// Scored pools always arrive sorted highest-first from selectCandidates.
const pool = (...scores) => scores.map((score, i) => ({ id: `p${i}`, score }))

const candidates = (count) =>
  Array.from({ length: count }, (_, i) => ({
    id: String(i + 1),
    pmid: String(i + 1),
    title: `Paper ${i + 1}`,
    journal: 'Test Journal',
    year: '2026',
    pubtypes: ['Journal Article'],
  }))

describe('preReadFloor', () => {
  it('treats the margin as score uncertainty: score + 20 must reach the final bar', () => {
    expect(PRE_READ_MARGIN).toBe(20)
    expect(preReadFloor(70)).toBe(50)
    expect(preReadFloor(55)).toBe(35)
    expect(preReadFloor(10)).toBe(0)
  })
})

describe('applyPostReadFloor', () => {
  it('excludes successful papers whose after-reading score is below the bar', () => {
    const results = [
      { paper: { id: 'high' } },
      { paper: { id: 'low' } },
      { paper: { id: 'failed' }, error: 'fetch failed' },
      { paper: { id: 'retracted' }, error: 'retracted', retracted: true },
    ]
    const out = applyPostReadFloor(results, { high: { score: 92 }, low: { score: 12 } }, 55)
    expect(out).toMatchObject({ cleared: 1, excluded: 1, total: 2, floor: 55 })
    expect(out.kept.map((r) => r.paper.id)).toEqual(['high', 'failed'])
  })

  it('returns an empty digest when every read paper misses the bar', () => {
    const out = applyPostReadFloor([{ paper: { id: 'p' } }], { p: { score: 54 } }, 55)
    expect(out.kept).toEqual([])
    expect(out.cleared).toBe(0)
  })
})

describe('selectCandidates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchAbstractsByPmid.mockResolvedValue({})
  })

  it('keeps the structured response compact: id and score only', () => {
    const item = SELECTION_SCHEMA.properties.selections.items
    expect(item.required).toEqual(['id', 'score'])
    expect(Object.keys(item.properties)).toEqual(['id', 'score'])
    expect(item.additionalProperties).toBe(false)
  })

  it('fetches abstracts in one attributed batch and includes them with the right candidates', async () => {
    fetchAbstractsByPmid.mockResolvedValue({
      1: 'A randomized trial found improved limb outcomes.',
      2: 'A small descriptive imaging series.',
    })
    extractStructured.mockResolvedValue({ selections: [{ id: '1', score: 82 }, { id: '2', score: 24 }] })

    const result = await selectCandidates({ candidates: candidates(2), rubric: 'Prioritize limb outcomes.' })

    expect(fetchAbstractsByPmid).toHaveBeenCalledWith(['1', '2'])
    const prompt = extractStructured.mock.calls[0][0].content
    expect(prompt).toContain('[1] Paper 1')
    expect(prompt).toContain('Abstract: A randomized trial found improved limb outcomes.')
    expect(prompt.indexOf('improved limb outcomes')).toBeLessThan(prompt.indexOf('[2] Paper 2'))
    expect(result.map(({ id, score }) => ({ id, score }))).toEqual([{ id: '1', score: 82 }, { id: '2', score: 24 }])
  })

  it('uses an already attached abstract without refetching that PMID', async () => {
    const pool = candidates(2)
    pool[0].abstract = 'Already cached evidence.'
    extractStructured.mockResolvedValue({ selections: pool.map((c) => ({ id: c.id, score: 50 })) })

    await selectCandidates({ candidates: pool })

    expect(fetchAbstractsByPmid).toHaveBeenCalledWith(['2'])
    expect(extractStructured.mock.calls[0][0].content).toContain('Abstract: Already cached evidence.')
  })

  it(`batches pools at ${SELECTION_BATCH_SIZE} and merges ties in original pool order`, async () => {
    const pool = candidates(SELECTION_BATCH_SIZE * 2 + 5)
    extractStructured.mockImplementation(async ({ content }) => {
      const ids = [...content.matchAll(/^\[(\d+)\]/gm)].map((match) => match[1])
      return { selections: [...ids].reverse().map((id) => ({ id, score: id === '65' ? 99 : 50 })) }
    })

    const result = await selectCandidates({ candidates: pool })

    expect(extractStructured).toHaveBeenCalledTimes(3)
    expect(extractStructured.mock.calls.map(([args]) => [...args.content.matchAll(/^\[(\d+)\]/gm)].length)).toEqual([30, 30, 5])
    expect(result[0].id).toBe('65')
    expect(result.slice(1).map((c) => c.id)).toEqual(pool.slice(0, -1).map((c) => c.id))
  })

  it(`retries malformed/truncated structured output at most ${SELECTION_PARSE_ATTEMPTS} times`, async () => {
    extractStructured
      .mockRejectedValueOnce(new SyntaxError('Unexpected end of JSON input'))
      .mockResolvedValueOnce({ selections: [{ id: '1', score: 77 }] })

    await expect(selectCandidates({ candidates: candidates(1) })).resolves.toMatchObject([{ id: '1', score: 77 }])
    expect(extractStructured).toHaveBeenCalledTimes(2)
  })

  it('replaces raw parse failures with a friendly bounded error', async () => {
    extractStructured.mockRejectedValue(new SyntaxError('Unexpected token } in JSON at position 14'))

    await expect(selectCandidates({ candidates: candidates(1) })).rejects.toThrow(
      "We couldn't finish scoring these papers. Please try again.",
    )
    expect(extractStructured).toHaveBeenCalledTimes(SELECTION_PARSE_ATTEMPTS)
  })

  it('does not retry non-parse API failures and still returns a friendly error', async () => {
    extractStructured.mockRejectedValue(new Error('401 raw provider detail'))

    await expect(selectCandidates({ candidates: candidates(1) })).rejects.toThrow(
      "We couldn't finish scoring these papers. Please try again.",
    )
    expect(extractStructured).toHaveBeenCalledTimes(1)
  })

  it('assigns missing ids zero and clamps invalid model scores to the public 0–100 range', async () => {
    extractStructured.mockResolvedValue({ selections: [{ id: '1', score: 140 }, { id: '2', score: -4 }] })

    const result = await selectCandidates({ candidates: candidates(3) })

    expect(result.map(({ id, score }) => ({ id, score }))).toEqual([
      { id: '1', score: 100 },
      { id: '2', score: 0 },
      { id: '3', score: 0 },
    ])
  })
})

// The floor is only meaningful if the scale it filters on has fixed meanings. Measured
// against a real 68-paper pool, an un-anchored prompt put 35 papers at 0–8 and left the
// whole span 56–84 empty, so a floor of 60 admitted one paper. These lock the coupling
// between the two: the default bar has to sit at the bottom edge of the band the prompt
// calls the ordinary good-paper band, or the number is arbitrary again.
describe('the scoring scale is anchored to the floor', () => {
  const bandStarts = [...SCALE.matchAll(/^-\s*(\d+)[–-](\d+)\s*—/gm)].map((m) => Number(m[1]))

  it('defines bands across the whole range, not just the endpoints', () => {
    expect(bandStarts.length).toBeGreaterThanOrEqual(4)
  })

  it('starts a band exactly at the default floor — the bar is a band edge, not a guess', () => {
    expect(bandStarts).toContain(DEFAULT_SCORE_FLOOR)
  })

  it('tells the scorer the band at the floor is the ordinary one, not an exceptional one', () => {
    const atFloor = SCALE.split('\n').find((l) => l.trim().startsWith(`- ${DEFAULT_SCORE_FLOOR}`))
    expect(atFloor).toMatch(/ORDINARY BAND/i)
  })

  it('forbids scoring papers relative to the pool, which is what compressed it downward', () => {
    expect(SCALE).toMatch(/not (by ranking it )?against the other candidates|not against the field/i)
  })
})

describe('normalizeScoreFloor', () => {
  it('takes a usable number', () => {
    expect(normalizeScoreFloor(75)).toBe(75)
    expect(normalizeScoreFloor('80')).toBe(80)
    expect(normalizeScoreFloor(59.6)).toBe(60)
  })

  it('falls back to the current default for a profile that predates the field', () => {
    expect(normalizeScoreFloor(undefined)).toBe(DEFAULT_SCORE_FLOOR)
    expect(normalizeScoreFloor(null)).toBe(DEFAULT_SCORE_FLOOR)
    expect(normalizeScoreFloor('')).toBe(DEFAULT_SCORE_FLOOR)
    expect(normalizeScoreFloor('abc')).toBe(DEFAULT_SCORE_FLOOR)
    expect(normalizeScoreFloor(NaN)).toBe(DEFAULT_SCORE_FLOOR)
  })

  it('clamps to the 0–100 score range', () => {
    expect(normalizeScoreFloor(-20)).toBe(0)
    expect(normalizeScoreFloor(1000)).toBe(100)
  })

  it('honors an explicit zero floor — that is opting out, not a missing value', () => {
    expect(normalizeScoreFloor(0)).toBe(0)
  })
})

describe('applyScoreFloor', () => {
  it('never pads below the floor — a thin day gets a short digest', () => {
    const out = applyScoreFloor(pool(91, 84, 40, 22, 10), { floor: 60, count: 10 })
    expect(out.picked.map((c) => c.score)).toEqual([91, 84])
    expect(out).toMatchObject({ cleared: 2, total: 5, floor: 60 })
  })

  it('caps a rich day at selectCount', () => {
    const out = applyScoreFloor(pool(95, 90, 85, 80, 75), { floor: 60, count: 3 })
    expect(out.picked).toHaveLength(3)
    expect(out.cleared).toBe(5)
  })

  it('keeps a candidate sitting exactly on the floor', () => {
    expect(applyScoreFloor(pool(60, 59), { floor: 60, count: 10 }).picked).toHaveLength(1)
  })

  it('returns nothing when nobody clears the bar', () => {
    const out = applyScoreFloor(pool(50, 40, 12), { floor: 60, count: 10 })
    expect(out.picked).toEqual([])
    expect(out).toMatchObject({ cleared: 0, total: 3 })
  })

  it('defaults the floor to 70 for an old profile', () => {
    expect(applyScoreFloor(pool(70, 55), { count: 10 }).picked.map((c) => c.score)).toEqual([70])
  })

  it('treats a missing or unusable count as no ceiling — the floor still holds', () => {
    expect(applyScoreFloor(pool(90, 80, 70), { floor: 60 }).picked).toHaveLength(3)
    expect(applyScoreFloor(pool(90, 80, 70), { floor: 60, count: 0 }).picked).toHaveLength(3)
  })

  it('scores a candidate with no score as 0 rather than letting it through', () => {
    expect(applyScoreFloor([{ id: 'x' }, { id: 'y', score: 88 }], { floor: 60, count: 10 }).picked).toEqual([
      { id: 'y', score: 88 },
    ])
  })

  it('handles an empty or missing pool', () => {
    expect(applyScoreFloor([], { floor: 60, count: 10 })).toMatchObject({ picked: [], cleared: 0, total: 0 })
    expect(applyScoreFloor(undefined, {})).toMatchObject({ picked: [], cleared: 0, total: 0 })
  })

  it('never mutates the pool it was given', () => {
    const scored = pool(90, 20)
    applyScoreFloor(scored, { floor: 60, count: 1 })
    expect(scored.map((c) => c.score)).toEqual([90, 20])
  })
})

describe('floorSummary', () => {
  it('says plainly how many cleared the bar', () => {
    expect(floorSummary({ total: 38, cleared: 4, picked: 4, floor: 60 })).toBe(
      'On title, abstract, and journal, 4 of 38 cleared your bar today (score 60+).',
    )
  })

  it('adds the cap when the ceiling trimmed further', () => {
    expect(floorSummary({ total: 38, cleared: 14, picked: 10, floor: 60 })).toContain('The top 10 made the digest.')
  })

  // The sentence has to name WHICH score it counted. The card carries a different 0–100
  // number (triage, post-read), and "4 of 38 cleared your bar (score 60+)" sitting above a
  // card marked 58 read as the app contradicting itself.
  it('names the pre-read screen it is counting, so the card score cannot read as a contradiction', () => {
    for (const args of [
      { total: 38, cleared: 4, picked: 4, floor: 60 },
      { total: 38, cleared: 14, picked: 10, floor: 60 },
      { total: 12, cleared: 0, picked: 0, floor: 70 },
      { total: 20, cleared: 20, picked: 10, floor: 60 },
    ]) {
      expect(floorSummary(args)).toContain('On title, abstract, and journal')
    }
  })

  // A zero day states the count and stops — the muted note slot already says it isn't an
  // error, and prose reassuring her that a short digest is legitimate reads as defensive.
  it('reports a zero day as a bare fact', () => {
    expect(floorSummary({ total: 12, cleared: 0, picked: 0, floor: 70 })).toBe(
      'On title, abstract, and journal, nothing cleared your bar today — 12 papers scored, none reached 70.',
    )
    expect(floorSummary({ total: 1, cleared: 0, picked: 0, floor: 60 })).toBe(
      'On title, abstract, and journal, nothing cleared your bar today — 1 paper scored, none reached 60.',
    )
  })

  it('stays silent when the floor changed nothing', () => {
    expect(floorSummary({ total: 6, cleared: 6, picked: 6, floor: 60 })).toBe('')
    expect(floorSummary({ total: 0, cleared: 0, picked: 0, floor: 60 })).toBe('')
    expect(floorSummary()).toBe('')
  })

  it('reports the cap even when every candidate cleared', () => {
    expect(floorSummary({ total: 20, cleared: 20, picked: 10, floor: 60 })).toBe(
      'On title, abstract, and journal, all 20 cleared your bar — the top 10 made the digest.',
    )
  })
})

// The card's number is triage's — written AFTER the paper was fetched and read — and it is
// not the number the floor filtered on. These two helpers are the whole defense against the
// digest appearing to contradict itself.
describe('readFitLabel', () => {
  it('marks the card score as a post-read judgment', () => {
    expect(readFitLabel({ score: 58 })).toBe('fit 58 after reading')
    expect(readFitLabel({ score: 0 })).toBe('fit 0 after reading')
  })

  it('drops the label rather than rendering a bare "after reading"', () => {
    expect(readFitLabel({ score: null })).toBe('')
    expect(readFitLabel({ score: undefined })).toBe('')
    expect(readFitLabel({})).toBe('')
    expect(readFitLabel()).toBe('')
    expect(readFitLabel({ score: 'abc' })).toBe('')
  })
})

describe('belowFloorNote', () => {
  // The pre-read screen let it through and reading it disagreed. That is signal about the
  // screen, not an error — and it is the case that made the digest look self-contradictory.
  it('states the disagreement when the post-read score came in under the bar', () => {
    expect(belowFloorNote({ score: 58, floor: 60 })).toBe('58 after reading — below your bar of 60.')
    expect(belowFloorNote({ score: 22, floor: 60 })).toBe('22 after reading — below your bar of 60.')
  })

  it('says nothing when reading agreed with the screen', () => {
    expect(belowFloorNote({ score: 84, floor: 60 })).toBe('')
  })

  // Same boundary applyScoreFloor uses: a score sitting exactly on the bar CLEARED it.
  it('treats a score exactly on the bar as clearing it', () => {
    expect(belowFloorNote({ score: 60, floor: 60 })).toBe('')
    expect(belowFloorNote({ score: 59, floor: 60 })).toBe('59 after reading — below your bar of 60.')
  })

  it('says nothing when there is no post-read score to report', () => {
    expect(belowFloorNote({ score: null, floor: 60 })).toBe('')
    expect(belowFloorNote({ score: undefined, floor: 60 })).toBe('')
    expect(belowFloorNote({ score: '', floor: 60 })).toBe('')
    expect(belowFloorNote({ floor: 60 })).toBe('')
    expect(belowFloorNote({ score: 'abc', floor: 60 })).toBe('')
  })

  // No bar loaded yet (or none configured) means no bar to be below — never invent one,
  // and never let '' or null coerce to a floor of 0 the way Number() would.
  it('says nothing when no floor is configured', () => {
    expect(belowFloorNote({ score: 12, floor: null })).toBe('')
    expect(belowFloorNote({ score: 12, floor: undefined })).toBe('')
    expect(belowFloorNote({ score: 12, floor: '' })).toBe('')
    expect(belowFloorNote({ score: 12 })).toBe('')
    expect(belowFloorNote()).toBe('')
  })

  // An explicit floor of 0 is opting out — nothing can be below it.
  it('reports nothing against a zero bar', () => {
    expect(belowFloorNote({ score: 0, floor: 0 })).toBe('')
  })
})
