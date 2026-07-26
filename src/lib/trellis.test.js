// trellis.test.js — locks the pure half of the PaperTrellis bridge: the prompt-line
// format the scorer and triage see, the pre-submission cut (the product rule: stage
// position < 7, closest-to-submission first), and the manual-first merge shape. The
// network/cache half (refresh/get) is deliberately untested — no supabase mocking.

import { describe, it, expect } from 'vitest'
import {
  SUBMISSION_POSITION,
  trellisProjectLine,
  preSubmission,
  trellisProjectLines,
  mergedProjects,
  consideredProjects,
} from './trellis.js'

const row = (fields) => ({
  id: 'p1',
  title: 'Pop Artery Aneurysm (COSMOS)',
  description: '',
  deadline_at: null,
  updated_at: '2026-07-20T00:00:00Z',
  stage: { name: 'Writing', position: 6 },
  ...fields,
})

describe('trellisProjectLine — one prompt-ready string', () => {
  it('title + stage only when description is empty and no deadline', () => {
    expect(trellisProjectLine(row())).toBe('Pop Artery Aneurysm (COSMOS) (Writing)')
  })

  it('appends the description after an em dash', () => {
    expect(trellisProjectLine(row({ description: 'Does anticoagulation decrease risk of ALI?' }))).toBe(
      'Pop Artery Aneurysm (COSMOS) (Writing) — Does anticoagulation decrease risk of ALI?',
    )
  })

  it('whitespace-only description counts as empty', () => {
    expect(trellisProjectLine(row({ description: '   ' }))).toBe('Pop Artery Aneurysm (COSMOS) (Writing)')
  })

  it('adds the due date between stage and description', () => {
    expect(trellisProjectLine(row({ deadline_at: '2026-08-01', description: 'Aim 2 draft.' }))).toBe(
      'Pop Artery Aneurysm (COSMOS) (Writing), due 2026-08-01 — Aim 2 draft.',
    )
  })

  it('trims a timestamp deadline down to the date', () => {
    expect(trellisProjectLine(row({ deadline_at: '2026-08-01T12:30:00Z' }))).toContain(', due 2026-08-01')
  })

  it('truncates a long description near 140 chars, on a word boundary, with an ellipsis', () => {
    const words = Array(40).fill('anticoagulation').join(' ') // far past the cap
    const line = trellisProjectLine(row({ description: words }))
    const desc = line.split(' — ')[1]
    expect(desc.length).toBeLessThanOrEqual(141) // 140 + the ellipsis
    expect(desc.endsWith('…')).toBe(true)
    expect(desc).not.toMatch(/anticoagulatio…$/) // cut fell on the word boundary
  })

  it('leaves a short description untouched — no ellipsis', () => {
    const line = trellisProjectLine(row({ description: 'Short.' }))
    expect(line.endsWith('Short.')).toBe(true)
  })
})

describe('preSubmission — the digest slice of the projects query', () => {
  it('keeps only stages below SUBMISSION_POSITION', () => {
    const rows = [
      row({ id: 'a', stage: { name: 'Writing', position: 6 } }),
      row({ id: 'b', stage: { name: 'Submission', position: SUBMISSION_POSITION } }),
      row({ id: 'c', stage: { name: 'Published', position: 9 } }),
      row({ id: 'd', stage: { name: 'Idea', position: 1 } }),
    ]
    expect(preSubmission(rows).map((p) => p.id)).toEqual(['a', 'd'])
  })

  it('drops rows with no joined stage', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b', stage: null }), row({ id: 'c', stage: undefined })]
    expect(preSubmission(rows).map((p) => p.id)).toEqual(['a'])
  })

  it('sorts closest-to-submission first, ties broken by most recent touch', () => {
    const rows = [
      row({ id: 'idea', stage: { name: 'Idea', position: 1 }, updated_at: '2026-07-25T00:00:00Z' }),
      row({ id: 'writing-old', stage: { name: 'Writing', position: 6 }, updated_at: '2026-07-01T00:00:00Z' }),
      row({ id: 'analysis', stage: { name: 'Analysis', position: 5 }, updated_at: '2026-07-10T00:00:00Z' }),
      row({ id: 'writing-new', stage: { name: 'Writing', position: 6 }, updated_at: '2026-07-24T00:00:00Z' }),
    ]
    expect(preSubmission(rows).map((p) => p.id)).toEqual(['writing-new', 'writing-old', 'analysis', 'idea'])
  })

  it('handles empty and absent input', () => {
    expect(preSubmission([])).toEqual([])
    expect(preSubmission(undefined)).toEqual([])
  })
})

describe('trellisProjectLines — cache to prompt lines', () => {
  it('maps cached rows through trellisProjectLine', () => {
    const cache = { projects: [row(), row({ id: 'p2', title: 'CLTI Registry', stage: { name: 'Analysis', position: 5 } })], syncedAt: 'x' }
    expect(trellisProjectLines(cache)).toEqual([
      'Pop Artery Aneurysm (COSMOS) (Writing)',
      'CLTI Registry (Analysis)',
    ])
  })

  it('empty for a missing or empty cache', () => {
    expect(trellisProjectLines(null)).toEqual([])
    expect(trellisProjectLines({ projects: [], syncedAt: null })).toEqual([])
  })
})

describe('mergedProjects — the shape the digest call sites pass on', () => {
  it('manual Active Work strings first, synced lines after', () => {
    const profile = { projects: ['Limb Preservation Program'] }
    const cache = { projects: [row()], syncedAt: 'x' }
    expect(mergedProjects(profile, cache)).toEqual([
      'Limb Preservation Program',
      'Pop Artery Aneurysm (COSMOS) (Writing)',
    ])
  })

  it('signed out / never synced: exactly the old manual list', () => {
    const profile = { projects: ['LPP', 'COSMOS'] }
    expect(mergedProjects(profile, { projects: [], syncedAt: null })).toEqual(['LPP', 'COSMOS'])
  })

  it('no profile at all still yields an array', () => {
    expect(mergedProjects(null, { projects: [], syncedAt: null })).toEqual([])
    expect(mergedProjects(undefined, { projects: [row()], syncedAt: 'x' })).toEqual([
      'Pop Artery Aneurysm (COSMOS) (Writing)',
    ])
  })
})

describe('the star — consideredProjects and the exclusion-aware merge', () => {
  const two = [row(), row({ id: 'p2', title: 'Frailty-CLTI Study', stage: { name: 'Analysis', position: 5 } })]

  it('no exclusions: every synced project is considered (the default is starred)', () => {
    expect(consideredProjects({ projects: two }, new Set())).toHaveLength(2)
    expect(consideredProjects({ projects: two }, undefined)).toHaveLength(2)
  })

  it('an excluded id drops out of the considered slice', () => {
    const kept = consideredProjects({ projects: two }, new Set(['p1']))
    expect(kept.map((p) => p.id)).toEqual(['p2'])
  })

  it('mergedProjects never feeds an un-starred project to the prompt', () => {
    const profile = { projects: ['Limb Preservation Program'] }
    expect(mergedProjects(profile, { projects: two }, new Set(['p2']))).toEqual([
      'Limb Preservation Program',
      'Pop Artery Aneurysm (COSMOS) (Writing)',
    ])
  })

  it('excluding everything leaves exactly the manual list — same shape as never syncing', () => {
    const profile = { projects: ['LPP'] }
    expect(mergedProjects(profile, { projects: two }, new Set(['p1', 'p2']))).toEqual(['LPP'])
  })

  it('a stale exclusion for a project no longer synced is harmless', () => {
    expect(consideredProjects({ projects: [row()] }, new Set(['gone-id']))).toHaveLength(1)
  })

  it('accepts a plain array of ids too — the store row round-trips as JSON', () => {
    expect(consideredProjects({ projects: two }, ['p1']).map((p) => p.id)).toEqual(['p2'])
  })
})
