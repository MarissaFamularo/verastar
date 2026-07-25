// select.test.js — the score floor: the rule that a digest slot is earned, not filled.
// Locks the two things that make a thin day honest: nothing below the bar is ever
// padded in, and zero papers is a reportable outcome rather than a failure.

import { describe, it, expect } from 'vitest'
import { applyScoreFloor, normalizeScoreFloor, floorSummary, DEFAULT_SCORE_FLOOR } from './select.js'

// Scored pools always arrive sorted highest-first from selectCandidates.
const pool = (...scores) => scores.map((score, i) => ({ id: `p${i}`, score }))

describe('normalizeScoreFloor', () => {
  it('takes a usable number', () => {
    expect(normalizeScoreFloor(75)).toBe(75)
    expect(normalizeScoreFloor('80')).toBe(80)
    expect(normalizeScoreFloor(59.6)).toBe(60)
  })

  it('falls back to 60 for a profile that predates the field', () => {
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

  it('defaults the floor to 60 for an old profile', () => {
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
    expect(floorSummary({ total: 38, cleared: 4, picked: 4, floor: 60 })).toBe('4 of 38 cleared your bar today (score 60+).')
  })

  it('adds the cap when the ceiling trimmed further', () => {
    expect(floorSummary({ total: 38, cleared: 14, picked: 10, floor: 60 })).toContain('The top 10 made the digest.')
  })

  it('frames a zero day as the floor working, not a failure', () => {
    const msg = floorSummary({ total: 12, cleared: 0, picked: 0, floor: 70 })
    expect(msg).toContain('none reached 70')
    expect(msg).toContain('not an error')
  })

  it('stays silent when the floor changed nothing', () => {
    expect(floorSummary({ total: 6, cleared: 6, picked: 6, floor: 60 })).toBe('')
    expect(floorSummary({ total: 0, cleared: 0, picked: 0, floor: 60 })).toBe('')
    expect(floorSummary()).toBe('')
  })

  it('reports the cap even when every candidate cleared', () => {
    expect(floorSummary({ total: 20, cleared: 20, picked: 10, floor: 60 })).toBe('All 20 cleared your bar — the top 10 made the digest.')
  })
})
