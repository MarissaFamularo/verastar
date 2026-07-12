// concepts.test.js — the deterministic filing guard. The reader's own projects leak into
// filing via the paper's Relevance line; the prompt bans them, and sanitizeFiling repairs
// any filing that still names a topic after a project (the model proposes; the code disposes).

import { describe, it, expect } from 'vitest'
import { sanitizeFiling } from './concepts.js'

const PROJECTS = ['Limb Preservation Program', 'COSMOS utilization study']

describe('sanitizeFiling', () => {
  it('passes a clean filing through untouched', () => {
    expect(sanitizeFiling({ concept: 'Pedal Bypass Patency', hub: 'CLTI Management' }, PROJECTS)).toEqual({
      concept: 'Pedal Bypass Patency',
      hub: 'CLTI Management',
    })
  })

  it('a project-named hub collapses onto the concept', () => {
    expect(
      sanitizeFiling({ concept: 'Minor-to-Major Amputation Progression', hub: 'Limb Preservation Program' }, PROJECTS),
    ).toEqual({ concept: 'Minor-to-Major Amputation Progression', hub: 'Minor-to-Major Amputation Progression' })
  })

  it('a project-named concept files directly under its hub', () => {
    expect(sanitizeFiling({ concept: 'Limb Preservation Program', hub: 'CLTI Management' }, PROJECTS)).toEqual({
      concept: 'CLTI Management',
      hub: 'CLTI Management',
    })
  })

  it('both banned falls back to Uncategorized', () => {
    expect(
      sanitizeFiling({ concept: 'COSMOS utilization study', hub: 'Limb Preservation Program' }, PROJECTS),
    ).toEqual({ concept: 'Uncategorized', hub: 'Uncategorized' })
  })

  it('matches case- and whitespace-insensitively', () => {
    expect(sanitizeFiling({ concept: '  limb preservation program ', hub: 'CLTI Management' }, PROJECTS)).toEqual({
      concept: 'CLTI Management',
      hub: 'CLTI Management',
    })
  })

  it('no projects → no-op', () => {
    expect(sanitizeFiling({ concept: 'A', hub: 'B' }, [])).toEqual({ concept: 'A', hub: 'B' })
  })
})
