import { describe, expect, it } from 'vitest'
import { addMemoLabel, attachMemoToPaper, memoLabel } from './memoContext.js'

const memo = {
  id: 'memo:1',
  text: '  Frailty and limb salvage\nFollow up with the registry team.  ',
  createdAt: '2026-08-01T14:30:00.000Z',
}

describe('memo context actions', () => {
  it('uses the first non-empty memo line as the editable context label', () => {
    expect(memoLabel({ text: '\n  Frailty and limb salvage\nMore detail' })).toBe('Frailty and limb salvage')
  })

  it('adds projects without disturbing the rest of the profile', () => {
    const profile = { name: 'Marissa', projects: ['LPP'], northStars: ['CLTI'] }
    const result = addMemoLabel(profile, 'projects', 'Frailty registry')
    expect(result).toEqual({
      profile: { ...profile, projects: ['LPP', 'Frailty registry'] },
      added: true,
    })
  })

  it('does not add a case-only duplicate label', () => {
    const profile = { northStars: ['Limb salvage'] }
    expect(addMemoLabel(profile, 'northStars', ' limb SALVAGE ')).toEqual({ profile, added: false })
  })

  it('appends the full memo to paper notes and records its source id', () => {
    const result = attachMemoToPaper({ id: 'p1', notes: 'Read methods.' }, memo)
    expect(result.added).toBe(true)
    expect(result.paper.notes).toBe(
      'Read methods.\n\nMemo — 2026-08-01\nFrailty and limb salvage\nFollow up with the registry team.',
    )
    expect(result.paper.memoIds).toEqual(['memo:1'])
  })

  it('will not attach the same memo to the same paper twice', () => {
    const paper = { id: 'p1', notes: 'Already attached', memoIds: ['memo:1'] }
    expect(attachMemoToPaper(paper, memo)).toEqual({ paper, added: false })
  })
})
